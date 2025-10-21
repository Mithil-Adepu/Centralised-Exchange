import { Router } from "express";
import { RedisManager } from "../RedisManager";
import { CREATE_ORDER, CANCEL_ORDER, ON_RAMP, GET_OPEN_ORDERS } from "../types";

export const orderRouter = Router();

orderRouter.post("/", async (req, res) => {
    try {
        const { market, price, quantity, side, userId } = req.body;
        console.log({ market, price, quantity, side, userId })
        
        const response = await RedisManager.getInstance().sendAndAwait({
            type: CREATE_ORDER,
            data: {
                market,
                price,
                quantity,
                side,
                userId
            }
        });
        res.json(response.payload);
    } catch (error: any) {
        console.error('Create order error:', error?.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to create order', 
                message: error?.message || 'Engine timeout'
            });
        }
    }
});

orderRouter.delete("/", async (req, res) => {
    try {
        const { orderId, market } = req.body;
        const response = await RedisManager.getInstance().sendAndAwait({
            type: CANCEL_ORDER,
            data: {
                orderId,
                market
            }
        });
        res.json(response.payload);
    } catch (error: any) {
        console.error('Cancel order error:', error?.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to cancel order',
                message: error?.message || 'Engine timeout'
            });
        }
    }
});

orderRouter.get("/open", async (req, res) => {
    try {
        const response = await RedisManager.getInstance().sendAndAwait({
            type: GET_OPEN_ORDERS,
            data: {
                userId: req.query.userId as string,
                market: req.query.market as string
            }
        });
        res.json(response.payload);
    } catch (error: any) {
        console.error('Get open orders error:', error?.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to get open orders',
                message: error?.message || 'Engine timeout'
            });
        }
    }
});