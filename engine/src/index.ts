import { createClient } from "redis";
import { Engine } from "./trade/Engine";
import { elog } from "./trade/logger";

const STREAM_NAME = "engine_messages";
const GROUP_NAME  = "engine_group";
const CONSUMER    = "engine-1";

async function main() {
    elog.info("ENGINE", "Booting matching engine...");
    const engine = new Engine();
    let isShuttingDown = false;

    // Create Redis client with error handling
    const redisClient = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379",
    });
    
    redisClient.on("error", (err) => {
        console.error("Redis error:", err);
    });

    redisClient.on("reconnecting", () => {
        console.log("Redis reconnecting...");
    });

    await redisClient.connect();
    console.log("Connected to redis");

    // ── Create consumer group (idempotent: ignore error if already exists) ──
    try {
        await redisClient.xGroupCreate(STREAM_NAME, GROUP_NAME, "$", { MKSTREAM: true });
        console.log(`Consumer group '${GROUP_NAME}' created on stream '${STREAM_NAME}'`);
    } catch (err: any) {
        if (err?.message?.includes("BUSYGROUP")) {
            console.log(`Consumer group '${GROUP_NAME}' already exists — skipping creation`);
        } else {
            throw err;
        }
    }

    // ── Graceful shutdown handler ──
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log("\nShutting down gracefully...");
        try {
            await engine.saveSnapshot();
            console.log("Snapshot saved on shutdown.");
        } catch (e) {
            console.error("Failed to save snapshot on shutdown:", e);
        }
        await redisClient.disconnect();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // ── Crash recovery: replay any pending (unacknowledged) messages first ──
    // These are messages the Engine read before a crash but never XACK'd.
    console.log("Checking for unacknowledged pending messages (crash recovery)...");
    let pendingId = engine.getLastProcessedStreamId();
    
    // "0" or a specific ID means: give me pending messages starting from this offset.
    // We keep reading pending messages until there are none left, then switch to ">".
    let replayDone = false;
    while (!isShuttingDown && !replayDone) {
        const pending = await redisClient.xReadGroup(
            GROUP_NAME, CONSUMER,
            [{ key: STREAM_NAME, id: pendingId === "0-0" ? "0" : pendingId }],
            { COUNT: 10, BLOCK: 0 }
        );

        if (!pending || pending.length === 0 || pending[0].messages.length === 0) {
            console.log("No pending messages — crash recovery complete.");
            replayDone = true;
            break;
        }

        for (const { id, message: fields } of pending[0].messages) {
            try {
                const payload = JSON.parse(fields.data);
                elog.info("REPLAY", `Reprocessing pending ${id} type=${payload.type}`);
                engine.process({ message: payload, clientId: fields.clientId });
                await redisClient.xAck(STREAM_NAME, GROUP_NAME, id);
                engine.setLastProcessedStreamId(id);
                pendingId = id;
            } catch (error) {
                console.error(`[REPLAY] Poison message ${id} failed — moving to DLQ:`, error);
                // Force-acknowledge the broken message so the loop can advance past it.
                // Push to DLQ for manual inspection — never silently discard.
                try {
                    await redisClient.xAck(STREAM_NAME, GROUP_NAME, id);
                    await redisClient.lPush("engine_dlq", JSON.stringify({
                        id,
                        fields,
                        error: String(error),
                        ts: Date.now()
                    }));
                } catch (dlqErr) {
                    console.error(`[REPLAY] Failed to push ${id} to DLQ:`, dlqErr);
                }
                pendingId = id; // Advance past this message regardless
            }
        }
    }

    // ── Main processing loop: read new messages with ">" ──
    while (!isShuttingDown) {
        try {
            // XREADGROUP with ">" means: give me NEW messages not yet delivered to any consumer.
            // BLOCK 1000ms: wait up to 1 second for a message before looping (no busy-wait).
            const response = await redisClient.xReadGroup(
                GROUP_NAME, CONSUMER,
                [{ key: STREAM_NAME, id: ">" }],
                { COUNT: 1, BLOCK: 1000 }
            );

            if (!response || response.length === 0) {
                // Timeout — no new message. Loop continues cleanly.
                continue;
            }

            for (const { id, message: fields } of response[0].messages) {
                try {
                    const payload = JSON.parse(fields.data);
                    elog.debug("STREAM", `recv ${id} type=${payload.type}`);

                    // Process the trade synchronously in RAM (single-threaded Node.js guarantee)
                    engine.process({ message: payload, clientId: fields.clientId });

                    // XACK: marks this message as successfully processed.
                    // If we crash BEFORE this line, the message stays in "pending"
                    // and will be re-processed on next startup (crash recovery above).
                    await redisClient.xAck(STREAM_NAME, GROUP_NAME, id);
                    engine.setLastProcessedStreamId(id);
                    elog.debug("STREAM", `ack ${id}`);
                } catch (error) {
                    console.error(`Error processing message ${id}:`, error);
                    // Do NOT XACK — message stays pending and will be retried on restart.
                }
            }
        } catch (error) {
            console.error("Error reading from stream:", error);
            
            // If Redis connection lost, wait before retry
            if (!redisClient.isOpen) {
                console.log("Redis connection lost, waiting before retry...");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});