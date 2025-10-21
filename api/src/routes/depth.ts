
import { Router } from "express";
import { RedisManager } from "../RedisManager";
import { GET_DEPTH } from "../types";

export const depthRouter = Router();

depthRouter.get("/", async (req, res) => {
    try {
        const { symbol } = req.query;
        const response = await RedisManager.getInstance().sendAndAwait({
            type: GET_DEPTH,
            data: {
                market: symbol as string
            }
        });

        res.json(response.payload);
    } catch (error: any) {
        console.error('Get depth error:', error?.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to get depth',
                message: error?.message || 'Engine timeout'
            });
        }
    }
});
