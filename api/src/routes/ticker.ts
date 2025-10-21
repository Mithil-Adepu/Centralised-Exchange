import { Router } from "express";
import { RedisManager } from "../RedisManager";
import { GET_TICKERS } from "../types";

export const tickersRouter = Router();

tickersRouter.get("/", async (req, res) => {
    try {
        const { symbol } = req.query;
        
        const response = await RedisManager.getInstance().sendAndAwait({
            type:  GET_TICKERS,
            data: {
                market: symbol as string | undefined
            }
        });
        
        res.json(response.payload);
    } catch (error: any) {
        console.error('Get tickers error:', error?.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to get tickers',
                message: error?.message || 'Engine timeout'
            });
        }
    }
});