import { Router } from "express";
import { pool } from "../db/pool";
import { parseMarketSymbol, parsePositiveNumber } from "../utils/validation";

export const tradesRouter = Router();

tradesRouter.get("/", async (req, res) => {
    const market = (req.query.market || req.query.symbol) as string;
    
    if (!market) {
        return res.status(400).json({ error: "market or symbol parameter is required" });
    }

    let normalizedMarket: string;
    try {
        normalizedMarket = parseMarketSymbol(market);
    } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Invalid market" });
    }

    let limit = 100;
    if (req.query.limit !== undefined) {
        try {
            limit = Math.min(parsePositiveNumber(req.query.limit, "limit"), 500);
        } catch (error: any) {
            return res.status(400).json({ error: error?.message || "Invalid limit" });
        }
    }

    try {
        const query = `
            SELECT 
                time,
                price,
                volume as quantity,
                currency_code as market,
                is_buyer_maker
            FROM sol_usdc_prices
            WHERE currency_code = $1
            ORDER BY time DESC
            LIMIT $2
        `;
        
        const result = await pool.query(query, [normalizedMarket, limit]);
        
        const trades = result.rows.map((row, idx) => {
            const price = Number(row.price);
            const quantity = Number(row.quantity);
            const quoteQuantity = Number.isFinite(price) && Number.isFinite(quantity)
                ? (price * quantity).toString()
                : "0";

            return {
                id: idx,
                price: row.price.toString(),
                quantity: row.quantity.toString(),
                quoteQuantity,
                timestamp: new Date(row.time).getTime(),
                isBuyerMaker: Boolean(row.is_buyer_maker)
            };
        });
        
        res.json(trades);
    } catch (err) {
        console.error("Error fetching trades:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
