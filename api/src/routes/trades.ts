import { Router } from "express";
import { pool } from "../db/pool";
import { parseMarketSymbol, parsePositiveNumber } from "../utils/validation";
import { createRateLimiter } from "../middleware/rateLimit";

export const tradesRouter = Router();

const publicReadLimiter = createRateLimiter({
    keyPrefix: "rl:trades:read",
    max: 600,
    windowSeconds: 60,
    keyGenerator: (req) => req.ip || "unknown",
});

tradesRouter.get("/", publicReadLimiter, async (req, res) => {
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
                trade_id,
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

        const trades = result.rows.map((row) => {
            const price = Number(row.price);
            const quantity = Number(row.quantity);
            const quoteQuantity = Number.isFinite(price) && Number.isFinite(quantity)
                ? (price * quantity).toString()
                : "0";

            return {
                // Stable trade id from the DB — not a per-response array index
                // (an index breaks client dedup/keys as new trades arrive).
                id: row.trade_id,
                price: row.price.toString(),
                quantity: row.quantity.toString(),
                quoteQuantity,
                timestamp: new Date(row.time).getTime(),
                isBuyerMaker: Boolean(row.is_buyer_maker)
            };
        });
        
        res.json(trades);
    } catch (err) {
        console.error(JSON.stringify({ event: "trades.fetch.error", message: (err as Error).message, stack: (err as Error).stack }));
        res.status(500).json({ error: "Internal server error" });
    }
});
