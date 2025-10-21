import { Router } from "express";
import { Client } from 'pg';

const pgClient = new Client({
    user: 'your_user',
    host: 'localhost',
    database: 'my_database',
    password: 'your_password',
    port: 5432,
});
pgClient.connect();

export const tradesRouter = Router();

tradesRouter.get("/", async (req, res) => {
    // Accept both 'market' and 'symbol' parameters for compatibility
    const market = (req.query.market || req.query.symbol) as string;
    
    if (!market) {
        return res.status(400).json({ error: "market or symbol parameter is required" });
    }

    try {
        // Query recent trades from tata_prices table
        const query = `
            SELECT 
                time,
                price,
                volume as quantity,
                currency_code as market
            FROM tata_prices
            WHERE currency_code = $1
            ORDER BY time DESC
            LIMIT 100
        `;
        
        const result = await pgClient.query(query, [market]);
        
        // Transform to exchange API format
        const trades = result.rows.map((row, idx) => ({
            id: idx,
            price: row.price.toString(),
            quantity: row.quantity.toString(),
            timestamp: new Date(row.time).getTime(),
            isBuyerMaker: Math.random() > 0.5  // We don't track this in DB, so random for now
        }));
        
        res.json(trades);
    } catch (err) {
        console.error("Error fetching trades:", err);
        res.status(500).json({ error: "Internal server error" });
    }
})
