import { Client } from 'pg';
import { createClient } from 'redis';  
import { DbMessage } from './types';

/* ═══════════════════════════════════════════════════════════════
   DB Processor — Consumes trade/order events from Redis
   
   Fixes applied:
   - brPop (blocking pop) instead of rPop + 100ms sleep
   - Environment variables for DB credentials
   - Graceful shutdown handler
   - Better error handling with retry
   ═══════════════════════════════════════════════════════════════ */

const pgClient = new Client({
    user:     process.env.DB_USER     || 'your_user',
    host:     process.env.DB_HOST     || 'localhost',
    database: process.env.DB_NAME     || 'my_database',
    password: process.env.DB_PASSWORD || 'your_password',
    port:     Number(process.env.DB_PORT) || 5432,
});

const DB_STREAM   = "db_processor";
const DB_GROUP    = "db_group";
const DB_CONSUMER = "db-processor-1";

/** Thrown for failures that will NEVER succeed on retry (bad data, not infra). */
class PermanentError extends Error {}

/** Parse + shape-validate a stream message. Bad JSON / unknown type = permanent. */
function parseAndValidate(raw: string): DbMessage {
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        throw new PermanentError(`Malformed JSON: ${String(e)}`);
    }
    if (data?.type !== "TRADE_ADDED" && data?.type !== "ORDER_UPDATE") {
        throw new PermanentError(`Unknown message type: ${data?.type}`);
    }
    return data as DbMessage;
}

/** Permanent = bad data (dead-letter + ack). Everything else = transient (retry). */
function isPermanent(err: unknown): boolean {
    return err instanceof PermanentError || err instanceof SyntaxError;
}

async function main() {
    await pgClient.connect();
    console.log("Connected to PostgreSQL");

    const redisClient = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    await redisClient.connect();
    console.log("Connected to Redis");

    // ── Create consumer group (idempotent) ──
    try {
        await redisClient.xGroupCreate(DB_STREAM, DB_GROUP, "$", { MKSTREAM: true });
        console.log(`Consumer group '${DB_GROUP}' created on stream '${DB_STREAM}'`);
    } catch (err: any) {
        if (err?.message?.includes("BUSYGROUP")) {
            console.log(`Consumer group '${DB_GROUP}' already exists — skipping creation`);
        } else {
            throw err;
        }
    }

    /* ─── Graceful Shutdown ─── */
    const shutdown = async () => {
        console.log("\nShutting down DB processor...");
        try {
            clearInterval(klineRefreshInterval);
            await redisClient.quit();
            await pgClient.end();
        } catch (e) {
            console.error("Error during shutdown:", e);
        }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    /* ─── Auto-refresh kline materialized views every 60s ─── */
    const KLINE_VIEWS = ["klines_1m", "klines_5m", "klines_15m", "klines_1h", "klines_4h", "klines_1d", "klines_1w"];

    async function refreshKlineViews() {
        for (const view of KLINE_VIEWS) {
            try {
                await pgClient.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view};`);
            } catch (err) {
                // CONCURRENTLY requires a unique index — fallback to regular refresh
                try {
                    await pgClient.query(`REFRESH MATERIALIZED VIEW ${view};`);
                } catch (fallbackErr) {
                    console.error(`Failed to refresh ${view}:`, fallbackErr);
                }
            }
        }
    }

    const klineRefreshInterval = setInterval(refreshKlineViews, 60_000); // Every 60 seconds
    console.log("Kline auto-refresh scheduled (every 60s)");

    /* ─── Crash recovery: replay pending unacknowledged messages first ─── */
    console.log("DB Processor: checking for pending messages (crash recovery)...");
    let pendingDone = false;
    while (!pendingDone) {
        const pending = await redisClient.xReadGroup(
            DB_GROUP, DB_CONSUMER,
            [{ key: DB_STREAM, id: "0" }],
            { COUNT: 10, BLOCK: 0 }
        );
        if (!pending || pending.length === 0 || pending[0].messages.length === 0) {
            console.log("DB Processor: no pending messages — crash recovery complete.");
            pendingDone = true;
            break;
        }
        for (const { id, message: fields } of pending[0].messages) {
            try {
                const data: DbMessage = parseAndValidate(fields.data);
                if (data.type === "TRADE_ADDED") await handleTradeAdded(data);
                if (data.type === "ORDER_UPDATE") await handleOrderUpdate(data);
                await redisClient.xAck(DB_STREAM, DB_GROUP, id); // Only ACK on success
            } catch (error) {
                if (isPermanent(error)) {
                    // Poison message would block startup forever — dead-letter + ACK.
                    console.error(`[REPLAY] Poison message ${id} — dead-lettering:`, error);
                    try {
                        await redisClient.lPush("db_processor_dlq", JSON.stringify({
                            id, fields, error: String(error), ts: Date.now(),
                        }));
                    } catch (dlqErr) {
                        console.error("[REPLAY] Failed to push to DLQ:", dlqErr);
                    }
                    await redisClient.xAck(DB_STREAM, DB_GROUP, id);
                } else {
                    console.error(`[REPLAY] Transient error on ${id} — will retry on next restart:`, error);
                    // Do NOT xAck — message stays pending and will be retried
                }
            }
        }
    }

    /* ─── Main Processing Loop ─── */
    while (true) {
        try {
            // XREADGROUP ">" = only NEW messages not yet delivered to any consumer.
            // BLOCK 0 = block indefinitely until a message arrives (no busy-wait).
            const response = await redisClient.xReadGroup(
                DB_GROUP, DB_CONSUMER,
                [{ key: DB_STREAM, id: ">" }],
                { COUNT: 1, BLOCK: 0 }
            );

            if (!response || response.length === 0) continue;

            for (const { id, message: fields } of response[0].messages) {
                try {
                    const data: DbMessage = parseAndValidate(fields.data);

                    if (data.type === "TRADE_ADDED") {
                        await handleTradeAdded(data);
                    }

                    if (data.type === "ORDER_UPDATE") {
                        await handleOrderUpdate(data);
                    }

                    // XACK: permanently removes message from the pending list.
                    // If we crash before this line, the message is re-delivered on restart.
                    await redisClient.xAck(DB_STREAM, DB_GROUP, id);
                } catch (error) {
                    if (isPermanent(error)) {
                        // Poison message (bad JSON, unknown type, missing fields):
                        // retrying will never succeed. Dead-letter the FULL message and
                        // XACK it so it stops looping the pending list forever.
                        console.error(`Poison message ${id} — dead-lettering:`, error);
                        try {
                            await redisClient.lPush("db_processor_dlq", JSON.stringify({
                                id, fields, error: String(error), ts: Date.now(),
                            }));
                        } catch (dlqErr) {
                            console.error("Failed to push to DLQ:", dlqErr);
                        }
                        await redisClient.xAck(DB_STREAM, DB_GROUP, id);
                    } else {
                        // Transient failure (e.g. DB briefly unavailable): do NOT XACK
                        // and do NOT DLQ — leave it pending so it retries on next read.
                        console.error(`Transient error on message ${id} — will retry:`, error);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        } catch (error) {
            console.error("Error reading from stream:", error);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}


/* ═══════════════════════════════════════════════════════════════
   Message Handlers
   ═══════════════════════════════════════════════════════════════ */

async function handleTradeAdded(data: Extract<DbMessage, { type: "TRADE_ADDED" }>) {
    const tradeId = data.data.id;
    const price = data.data.price;
    const timestamp = new Date(data.data.timestamp);
    const quantity = parseFloat(data.data.quantity);
    const market = data.data.market;
    const isBuyerMaker = data.data.isBuyerMaker ?? false;
    
    const query = `
        INSERT INTO sol_usdc_prices (time, trade_id, price, volume, currency_code, is_buyer_maker)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (time, trade_id) DO NOTHING
    `;
    const values = [timestamp, tradeId, price, quantity, market, isBuyerMaker];
    
    try {
        await pgClient.query(query, values);
        console.log(`Trade: ${market} @ ${price}, vol: ${quantity}, maker: ${isBuyerMaker}`);
    } catch (error) {
        console.error("Error inserting trade:", error);
        throw error; // Re-throw so outer loop skips XACK and retries this message
    }
}

async function handleOrderUpdate(data: Extract<DbMessage, { type: "ORDER_UPDATE" }>) {
    const { orderId, executedQty, market, price, quantity, side, userId } = data.data;
    
    if (!userId) {
        throw new PermanentError(`ORDER_UPDATE message is missing userId — orderId: ${orderId}`);
    }
    if (!orderId) {
        throw new PermanentError(`ORDER_UPDATE message is missing orderId`);
    }
    
    // Check if order exists
    const checkQuery = 'SELECT * FROM orders WHERE order_id = $1';
    const existingOrder = await pgClient.query(checkQuery, [orderId]);
    
    if (existingOrder.rows.length > 0) {
        // Update existing order. Maker fills arrive one ORDER_UPDATE per trade,
        // each carrying only THAT fill's qty — so accumulate rather than overwrite,
        // otherwise a maker filled across N trades ends with only the last fill's qty.
        const updateQuery = `
            UPDATE orders
            SET executed_qty = executed_qty + $1, updated_at = NOW()
            WHERE order_id = $2
        `;
        try {
            await pgClient.query(updateQuery, [executedQty, orderId]);
        } catch (error) {
            console.error("Error updating order:", error);
            throw error; // Re-throw so outer loop skips XACK and retries this message
        }
    } else {
        // Insert new order — all fields must be present
        if (!market || !price || !quantity || !side) {
            throw new PermanentError(`ORDER_UPDATE insert missing required fields — orderId: ${orderId}, market: ${market}, price: ${price}, quantity: ${quantity}, side: ${side}`);
        }
        const insertQuery = `
            INSERT INTO orders (order_id, user_id, market, price, quantity, side, executed_qty, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        `;
        try {
            await pgClient.query(insertQuery, [
                orderId,
                userId,
                market,
                price,
                quantity,
                side,
                executedQty
            ]);
        } catch (error) {
            console.error("Error inserting order:", error);
            throw error; // Re-throw so outer loop skips XACK and retries this message
        }
    }
}

main();