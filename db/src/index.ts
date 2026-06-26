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
    port:     Number(process.env.DB_PORT) || 5433,
});

async function main() {
    await pgClient.connect();
    console.log("Connected to PostgreSQL");

    const redisClient = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    await redisClient.connect();
    console.log("Connected to Redis");

    /* ─── Graceful Shutdown ─── */
    const shutdown = async () => {
        console.log("\nShutting down DB processor...");
        try {
            await redisClient.quit();
            await pgClient.end();
        } catch (e) {
            console.error("Error during shutdown:", e);
        }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    /* ─── Main Processing Loop ─── */
    while (true) {
        try {
            // brPop blocks until a message is available (no busy-wait)
            // Timeout of 0 = block indefinitely
            const response = await redisClient.brPop("db_processor", 0);
            
            if (!response) continue;
            
            const data: DbMessage = JSON.parse(response.element);
            
            if (data.type === "TRADE_ADDED") {
                await handleTradeAdded(data);
            }
            
            if (data.type === "ORDER_UPDATE") {
                await handleOrderUpdate(data);
            }
        } catch (error) {
            console.error("Error processing message:", error);
            // Brief pause before retrying to prevent tight error loops
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}


/* ═══════════════════════════════════════════════════════════════
   Message Handlers
   ═══════════════════════════════════════════════════════════════ */

async function handleTradeAdded(data: Extract<DbMessage, { type: "TRADE_ADDED" }>) {
    const price = data.data.price;
    const timestamp = new Date(data.data.timestamp);
    const quantity = parseFloat(data.data.quantity);
    const market = data.data.market;
    const isBuyerMaker = data.data.isBuyerMaker ?? false;
    
    const query = `
        INSERT INTO tata_prices (time, price, volume, currency_code, is_buyer_maker)
        VALUES ($1, $2, $3, $4, $5)
    `;
    const values = [timestamp, price, quantity, market, isBuyerMaker];
    
    try {
        await pgClient.query(query, values);
        console.log(`Trade: ${market} @ ${price}, vol: ${quantity}, maker: ${isBuyerMaker}`);
    } catch (error) {
        console.error("Error inserting trade:", error);
    }
}

async function handleOrderUpdate(data: Extract<DbMessage, { type: "ORDER_UPDATE" }>) {
    const { orderId, executedQty, market, price, quantity, side } = data.data;
    
    // Check if order exists
    const checkQuery = 'SELECT * FROM orders WHERE order_id = $1';
    const existingOrder = await pgClient.query(checkQuery, [orderId]);
    
    if (existingOrder.rows.length > 0) {
        // Update existing order
        const updateQuery = `
            UPDATE orders 
            SET executed_qty = $1, updated_at = NOW()
            WHERE order_id = $2
        `;
        try {
            await pgClient.query(updateQuery, [executedQty, orderId]);
        } catch (error) {
            console.error("Error updating order:", error);
        }
    } else {
        // Insert new order
        const insertQuery = `
            INSERT INTO orders (order_id, market, price, quantity, side, executed_qty, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `;
        try {
            await pgClient.query(insertQuery, [
                orderId,
                market || 'UNKNOWN',
                price || '0',
                quantity || '0',
                side || 'buy',
                executedQty
            ]);
        } catch (error) {
            console.error("Error inserting order:", error);
        }
    }
}

main();