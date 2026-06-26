import { Router } from "express";
import { RedisManager } from "../RedisManager";
import { ON_RAMP } from "../types";
import { authenticate } from "../middleware/authenticate";
import { requireRoles } from "../middleware/authorize";
import { createRateLimiter } from "../middleware/rateLimit";
import { parsePositiveNumber } from "../utils/validation";
import { auditLog } from "../utils/audit";

export const onRampRouter = Router();

const onRampLimiter = createRateLimiter({
    keyPrefix: "rl:onramp:write",
    max: 30,
    windowSeconds: 60,
    keyGenerator: (req) => req.auth?.userId || req.ip || "unknown",
});

onRampRouter.post("/", authenticate, requireRoles(["admin"]), onRampLimiter, async (req, res) => {
    const userId = req.auth!.userId;

    try {
        const amount = parsePositiveNumber(req.body?.amount, "amount");

        const response = await RedisManager.getInstance().sendAndAwait({
            type: ON_RAMP,
            data: {
                userId,
                amount: amount.toString()
            }
        });

        auditLog({
            event: "wallet.onramp",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: true,
            details: {
                amount,
                response: response.payload,
            },
        });
        
        res.json({ 
            success: true, 
            message: `Added ${amount} to user ${userId}`,
            userId,
            amount
        });
    } catch (error: any) {
        console.error("On-ramp error:", error?.message || error);
        auditLog({
            event: "wallet.onramp",
            level: "warn",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        // Don't crash - return error response
        if (!res.headersSent) {
            res.status(500).json({ 
                error: error?.message || "Failed to process on-ramp",
                details: "Engine may not be running or took too long to respond"
            });
        }
    }
});

