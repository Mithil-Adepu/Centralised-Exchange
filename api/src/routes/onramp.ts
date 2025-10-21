import { Router } from "express";
import { RedisManager } from "../RedisManager";
import { ON_RAMP } from "../types";

export const onRampRouter = Router();

onRampRouter.post("/", async (req, res) => {
    const { userId, amount } = req.body;
    
    if (!userId || !amount) {
        return res.status(400).json({ error: "userId and amount are required" });
    }

    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: "amount must be a positive number" });
    }

    try {
        const response = await RedisManager.getInstance().sendAndAwait({
            type: ON_RAMP,
            data: {
                userId,
                amount: amount.toString()
            }
        });
        
        res.json({ 
            success: true, 
            message: `Added ${amount} to user ${userId}`,
            userId,
            amount
        });
    } catch (error: any) {
        console.error("On-ramp error:", error?.message || error);
        // Don't crash - return error response
        if (!res.headersSent) {
            res.status(500).json({ 
                error: error?.message || "Failed to process on-ramp",
                details: "Engine may not be running or took too long to respond"
            });
        }
    }
});

