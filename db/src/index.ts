import { Client } from 'pg';
import { createClient } from 'redis';  
import { DbMessage } from './types';

const pgClient = new Client({
    user: 'your_user',
    host: 'localhost',
    database: 'my_database',
    password: 'your_password',
    port: 5432,
});
pgClient.connect();

async function main() {
    const redisClient = createClient();
    await redisClient.connect();
    console.log("connected to redis");

    while (true) {
        const response = await redisClient.rPop("db_processor" as string)
        if (!response) {
            // Sleep for a short time to avoid busy-waiting
            await new Promise(resolve => setTimeout(resolve, 100));
        } else {
            const data: DbMessage = JSON.parse(response);
            
            if (data.type === "TRADE_ADDED") {
                console.log("adding trade");
                console.log(data);
                
                const price = data.data.price;
                const timestamp = new Date(data.data.timestamp);
                const quantity = parseFloat(data.data.quantity);
                const market = data.data.market;
                
                const query = 'INSERT INTO tata_prices (time, price, volume, currency_code) VALUES ($1, $2, $3, $4)';
                const values = [timestamp, price, quantity, market];
                
                try {
                    await pgClient.query(query, values);
                    console.log(`Trade inserted: ${market} @ ${price}, volume: ${quantity}`);
                } catch (error) {
                    console.error("Error inserting trade:", error);
                }
            }
            
            if (data.type === "ORDER_UPDATE") {
                console.log("updating order");
                console.log(data);
                
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
                        console.log(`Order updated: ${orderId}`);
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
                        console.log(`Order inserted: ${orderId}`);
                    } catch (error) {
                        console.error("Error inserting order:", error);
                    }
                }
            }
        }
    }
}

main();