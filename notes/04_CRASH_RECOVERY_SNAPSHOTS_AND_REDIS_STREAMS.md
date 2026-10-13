# Module 04 — Redis Streams, Atomic Snapshots & Zero-Loss Crash Recovery

> **Making an In-Memory Matching Engine Indestructible**  
> *"If all state lives in RAM, what happens when lightning strikes the data center, the OS kernels out of memory, or Docker restarts the container? Without an event-sourcing journal and atomic snapshots, all customer orders and balances vanish into oblivion. This module analyzes `engine/src/index.ts`, `engine/src/RedisManager.ts`, and the snapshot engine in `Engine.ts` line-by-line to explain how zero data loss is achieved in production."*

---

## 1. Evolution: Why Redis Streams Replaced Redis Lists

In early prototypes of this exchange (as seen in older notes), messages were consumed using simple Redis Lists:
```typescript
// THE OLD, FRAGILE APPROACH:
const response = await redisClient.brPop("messages", 1);
```

### Why Redis Lists (`brPop` / `rPush`) Fail in Production:
1. **At-Most-Once Delivery (Data Loss on Crash)**:
   When `brPop` executes, Redis **immediately pops and deletes** the message from the list.
   If the Engine crashes 1 microsecond later (before finishing order execution), that order is **gone forever**. The customer paid money, but their order vanished from the universe.
2. **No Acknowledgment Protocol**:
   Lists have no concept of "I received this, but I haven't finished processing it yet."
3. **No Consumer Tracking / Replay**:
   You cannot inspect unacknowledged in-flight messages or replay past events.

### The Modern Solution: Redis Streams (`XADD`, `XREADGROUP`, `XACK`)
Redis 5.0+ introduced **Streams**, an append-only commit log modeled after Apache Kafka:

```
Stream: "engine_messages"
[ 1712850000001-0 ] ──> [ 1712850000002-0 ] ──> [ 1712850000003-0 ]
       ▲                       ▲                       ▲
       │                       │                       │
   (Order 1)               (Order 2)               (Order 3)
   [ACKED]                 [ACKED]                 [PENDING] (In RAM)
```

1. **Messages Stay in the Stream**: `XREADGROUP` reads a message without deleting it from the log.
2. **Pending Entries List (PEL)**: Redis tracks which consumer owns each message. Until the consumer explicitly sends `XACK`, Redis knows the message is unconfirmed.
3. **Crash Recovery**: If the consumer process dies, the un-ACKed messages remain safely in the PEL. On reboot, the engine requests all pending messages and replays them!
4. **Log Trimming (`MAXLEN ~`)**: Using approximate trimming (`TRIM MAXLEN ~ 10000`), the stream retains the last 10,000 entries (plenty for crash recovery and audit) while bounding Redis memory consumption.

---

## 2. Bootstrapping the Consumer Group: `engine/src/index.ts` (Lines 1–40)

```typescript
const STREAM_NAME = "engine_messages";
const GROUP_NAME  = "engine_group";
const CONSUMER    = "engine-1";

async function main() {
    elog.info("ENGINE", "Booting matching engine...");
    const engine = new Engine();
    let isShuttingDown = false;

    const redisClient = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    await redisClient.connect();

    // ── Create consumer group (idempotent) ──
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
```

### Code Analysis:
- **`xGroupCreate` Arguments**:
  - `STREAM_NAME ("engine_messages")`: The target stream.
  - `GROUP_NAME ("engine_group")`: The consumer group identifier.
  - `"$" (The Offset)`: Tells Redis: "Only deliver messages published *after* this group was created."
  - `{ MKSTREAM: true }`: If the stream `engine_messages` does not exist yet in Redis, create it automatically.
- **Handling `BUSYGROUP`**:
  If the engine is restarting, the consumer group already exists in Redis. Redis throws an error containing `BUSYGROUP`. Our code intercepts this and continues peacefully without crashing.

---

## 3. The Graceful Shutdown Handler (Lines 42–60)

```typescript
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

process.on("SIGINT", shutdown);  // Ctrl + C in terminal
process.on("SIGTERM", shutdown); // Docker stop / Kubernetes pod termination
```

### Why `await engine.saveSnapshot()` is Critical:
- When you run `docker stop cex-engine` or redeploy on Kubernetes, the OS kernel sends a `SIGTERM` signal.
- In naive code, `saveSnapshot()` used fire-and-forget callbacks (`fs.writeFile`), and the process terminated before the disk write finished, corrupting or discarding the snapshot.
- In our engine, `saveSnapshot()` returns a `Promise<void>`. The `shutdown` handler **awaits** the disk flush to finish completely before closing the Redis connection and calling `process.exit(0)`.
- Docker gives containers a 10-second grace period before `SIGKILL`. Saving the snapshot takes ~5ms, ensuring clean state persistence every time.

---

## 4. Phase 1 of Startup: Crash Recovery & Poison Message Defense (Lines 61–109)

When the engine boots up, before accepting a single new order, it executes **Crash Recovery**:

```typescript
console.log("Checking for unacknowledged pending messages (crash recovery)...");
let pendingId = engine.getLastProcessedStreamId();

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
```

### The 3 Critical Engineering Concepts in This Loop:

#### 1. The ID Parameter (`"0"` vs. `">"`)
- Passing `id: ">"` tells Redis: "Give me brand new messages that have never been delivered to anyone."
- Passing `id: "0"` (or a specific stream ID) tells Redis: "Give me **pending messages** that were delivered to this consumer group previously but were never acknowledged with `XACK`!"
- If the server crashed mid-trade, the un-ACKed message is re-delivered here.

#### 2. The Poison Message Problem & Dead-Letter Queue (`engine_dlq`)
What happens if a corrupted, malformed JSON string entered the stream?
- If the engine tries to process it, `JSON.parse` or the business logic throws an uncaught error.
- If we don't acknowledge it, the engine crashes on reboot, reads it again, crashes again, and enters an **infinite reboot loop (crash loop backoff)**!
- **Our Defense**:
  1. The error is caught in `catch (error)`.
  2. The message is force-acknowledged (`xAck`) so it won't block the stream.
  3. The corrupted payload is pushed into Redis list `engine_dlq` along with error details and timestamp.
  4. The engine advances to the next message. The exchange remains operational!

---

## 5. Phase 2 of Startup: The Main Infinite Event Loop (Lines 110–155)

Once crash recovery finishes, the engine switches to live streaming mode:

```typescript
while (!isShuttingDown) {
    try {
        // XREADGROUP with ">" means: NEW messages only.
        // BLOCK 1000: wait up to 1 second before looping (zero busy-waiting).
        const response = await redisClient.xReadGroup(
            GROUP_NAME, CONSUMER,
            [{ key: STREAM_NAME, id: ">" }],
            { COUNT: 1, BLOCK: 1000 }
        );

        if (!response || response.length === 0) {
            continue; // Timeout with no message — recheck isShuttingDown
        }

        for (const { id, message: fields } of response[0].messages) {
            try {
                const payload = JSON.parse(fields.data);
                elog.debug("STREAM", `recv ${id} type=${payload.type}`);

                // 1. Process trade synchronously in RAM
                engine.process({ message: payload, clientId: fields.clientId });

                // 2. Acknowledge message only AFTER successful RAM processing
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
        if (!redisClient.isOpen) {
            console.log("Redis connection lost, waiting before retry...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
```

### Why `COUNT: 1`?
Why does the engine read 1 message at a time rather than batches of 100?
- **Strict Determinism**: Each order can mutate balances, trigger fills, and unlock price-improvement refunds.
- Processing one message at a time guarantees absolute sequential ordering without interleaving race conditions.
- **Latency**: Because Node.js handles events in microseconds, reading 1 message with `BLOCK: 1000` provides sub-millisecond end-to-end response times.

---

## 6. Atomic Disk Snapshots: `Engine.ts` (Lines 109–157)

In `engine/src/trade/Engine.ts`, state is periodically snapshotted to disk:

```typescript
// Snapshot every 30s — only if data changed
this._dirty = false;
setInterval(() => {
    if (this._dirty) {
        this._dirty = false; // Clear first — new trades during write re-set this!
        this.saveSnapshot();
    }
}, 1000 * 30);
```

### The `_dirty` Flag Clearing Trick:
Notice line 116:
```typescript
this._dirty = false; // Clear first — new trades during write re-set this
this.saveSnapshot();
```
- If you cleared `_dirty = false` *after* `saveSnapshot()` finished writing to disk, any trade that occurred during the 5ms disk write would be ignored, and its dirty state would be lost!
- By clearing `_dirty = false` **before** the write begins, any incoming trade during the async write immediately flips `_dirty = true` again, guaranteeing it will be captured in the very next 30-second interval.

---

### The Two-Phase Atomic File Rename:

```typescript
async saveSnapshot(): Promise<void> {
    const snapshotData = {
        version: SNAPSHOT_VERSION,
        lastProcessedStreamId: this.lastProcessedStreamId,
        orderbooks: this.orderbooks.map(o => o.getSnapshot()),
        balances: Array.from(this.balances.entries()),
        processedTxns: Array.from(this.processedTxns)
    };
    const tmpFile = "./snapshot.tmp.json";
    try {
        await fs.promises.writeFile(tmpFile, JSON.stringify(snapshotData));
        await fs.promises.rename(tmpFile, "./snapshot.json");
        elog.info("SNAPSHOT", `saved — offset=${this.lastProcessedStreamId}, orderbooks=${this.orderbooks.length}, accounts=${this.balances.size}`);
    } catch (err) {
        console.error("Snapshot save error:", err);
        this._dirty = true; // Mark dirty again so next interval retries
    }
}
```

```
Step 1: Write RAM state to temporary file:
        Memory ──> ./snapshot.tmp.json (Can take 5-10ms)
        (If power cuts here, existing ./snapshot.json remains intact!)

Step 2: Atomic OS Inode Rename:
        fs.rename("./snapshot.tmp.json", "./snapshot.json")
        (Microsecond atomic filesystem metadata update)
```

### Why Never Write Directly to `./snapshot.json`?
If you write directly to `./snapshot.json` with `fs.writeFile`, the operating system truncates the file to 0 bytes and begins writing chunks.
If the server suffers a sudden power loss or process kill mid-write:
- `./snapshot.json` is left with half a JSON document (syntax error).
- On reboot, JSON parsing fails, and **all exchange history is destroyed**.
- Writing to a `.tmp` file and performing an atomic OS rename (`rename(2)`) guarantees that `./snapshot.json` is always 100% valid.

---

## 7. The Redis Persistence Outbox: `engine/src/RedisManager.ts`

The Engine communicates with other services using `engine/src/RedisManager.ts`:

```typescript
export class RedisManager {
    private client: RedisClientType;
    private static instance: RedisManager;

    public pushMessage(message: DbMessage) {
        // XADD writes to the Redis Stream "db_processor"
        // "*" = auto-generate timestamp ID
        // TRIM MAXLEN ~ 10000 = keep ~10,000 entries
        this.client.xAdd(
            "db_processor",
            "*",
            { data: JSON.stringify(message) },
            { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } }
        ).catch((err) => console.error("RedisManager.pushMessage failed:", err));
    }

    public publishMessage(channel: string, message: WsMessage) {
        // Publishes to Redis Pub/Sub (depth.SOL_USDC, trade.SOL_USDC, ticker.SOL_USDC)
        this.client.publish(channel, JSON.stringify(message))
            .catch((err) => console.error(`Publish failed:`, err));
    }

    public sendToApi(clientId: string, message: MessageToApi) {
        // Replies directly to the API's ephemeral client channel
        this.client.publish(clientId, JSON.stringify(message))
            .catch((err) => console.error(`sendToApi failed:`, err));
    }
}
```

### Key Separation:
- **`pushMessage` (Stream)**: Used for database persistence (`db_processor`). Messages **must not be lost** even if the DB is down.
- **`publishMessage` & `sendToApi` (Pub/Sub)**: Used for real-time market data and client RPC replies. Fast, ephemeral, zero disk overhead.
