import { Router } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { pool } from "../db/pool";
import { RedisManager } from "../RedisManager";
import { ON_RAMP } from "../types";
import { authenticate } from "../middleware/authenticate";
import { requireRoles } from "../middleware/authorize";
import { createRateLimiter } from "../middleware/rateLimit";
import { parsePositiveNumber, parseRequiredString } from "../utils/validation";
import { auditLog } from "../utils/audit";

export const razorpayRouter = Router();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder",
});

const createOrderLimiter = createRateLimiter({
    keyPrefix: "rl:razorpay:create",
    max: 10,
    windowSeconds: 60,
    keyGenerator: (req) => req.auth?.userId || req.ip || "unknown",
});

razorpayRouter.post("/create-order", authenticate, requireRoles(["user", "admin"]), createOrderLimiter, async (req, res) => {
    const userId = req.auth!.userId;
    try {
        const amount = parsePositiveNumber(req.body?.amount, "amount");
        
        // Razorpay takes amount in paise (1 INR = 100 paise)
        const amountInPaise = Math.round(amount * 100);

        let order;
        if (process.env.NODE_ENV === "development") {
            order = { id: `order_${Date.now()}` };
        } else {
            order = await razorpay.orders.create({
                amount: amountInPaise,
                currency: "INR",
                receipt: `rcpt_${userId}_${Date.now()}`,
            });
        }

        if (!order || !order.id) {
            throw new Error("Failed to create Razorpay order");
        }

        // Save pending deposit in DB
        await pool.query(
            "INSERT INTO fiat_deposits (user_id, order_id, amount, status) VALUES ($1, $2, $3, $4)",
            [userId, order.id, amount, "pending"]
        );

        auditLog({
            event: "razorpay.create-order",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: true,
            details: { amount, orderId: order.id },
        });

        res.json({ success: true, orderId: order.id, amount });
    } catch (error: any) {
        auditLog({
            event: "razorpay.create-order",
            level: "warn",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        res.status(500).json({ error: error?.message || "Failed to create order" });
    }
});

razorpayRouter.post("/verify", authenticate, requireRoles(["user", "admin"]), async (req, res) => {
    const userId = req.auth!.userId;
    try {
        const razorpay_order_id = parseRequiredString(req.body?.razorpay_order_id, "razorpay_order_id");
        const razorpay_payment_id = parseRequiredString(req.body?.razorpay_payment_id, "razorpay_payment_id");
        const razorpay_signature = parseRequiredString(req.body?.razorpay_signature, "razorpay_signature");

        const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder";
        
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(body.toString())
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            // For mock/development without real razorpay, we might want to bypass signature check if the signature is "mock_signature"
            if (process.env.NODE_ENV !== "development" || razorpay_signature !== "mock_signature") {
                throw new Error("Invalid signature");
            }
        }

        // Update DB status to success
        const dbResult = await pool.query(
            "UPDATE fiat_deposits SET status = $1, payment_id = $2, updated_at = NOW() WHERE order_id = $3 AND user_id = $4 AND status = 'pending' RETURNING amount",
            ["success", razorpay_payment_id, razorpay_order_id, userId]
        );

        if (dbResult.rowCount === 0) {
            throw new Error("Order not found, already processed, or doesn't belong to user");
        }

        const amount = dbResult.rows[0].amount;

        // Send ON_RAMP to engine
        const response = await RedisManager.getInstance().sendAndAwait({
            type: ON_RAMP,
            data: {
                userId,
                amount: amount.toString()
            }
        });

        auditLog({
            event: "razorpay.verify",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: true,
            details: { amount, orderId: razorpay_order_id, paymentId: razorpay_payment_id },
        });

        res.json({ success: true, message: `Successfully added ${amount} to wallet` });
    } catch (error: any) {
        auditLog({
            event: "razorpay.verify",
            level: "warn",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        res.status(400).json({ error: error?.message || "Payment verification failed" });
    }
});
