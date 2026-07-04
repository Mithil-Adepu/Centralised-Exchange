import { DEPTH_UPDATE, TICKER_UPDATE } from "./trade/events";
import { RedisClientType, createClient } from "redis";
import { ORDER_UPDATE, TRADE_ADDED } from "./types";
import { WsMessage } from "./types/toWs";
import { MessageToApi } from "./types/toApi";

type DbMessage = {
    type: typeof TRADE_ADDED,
    data: {
        id: string,
        isBuyerMaker: boolean,
        price: string,
        quantity: string,
        quoteQuantity: string,
        timestamp: number,
        market: string
    }
} | {
    type: typeof ORDER_UPDATE,
    data: {
        orderId: string,
        executedQty: number,
        market?: string,
        price?: string,
        quantity?: string,
        side?: "buy" | "sell",
        userId?: string,
    }
}

export class RedisManager {
    private client: RedisClientType;
    private static instance: RedisManager;

    constructor() {
        this.client = createClient({
            url: process.env.REDIS_URL || "redis://localhost:6379",
        });
        this.client.on("error", (err) => {
            console.error("Engine Redis error:", err);
        });
        this.client.connect().catch((err) => {
            console.error("Engine Redis connection failed:", err);
        });
    }

    public static getInstance() {
        if (!this.instance)  {
            this.instance = new RedisManager();
        }
        return this.instance;
    }
  
    public pushMessage(message: DbMessage) {
        // XADD writes to the Redis Stream. "*" = auto-generate a timestamp-based ID.
        // The DB Processor will XACK this ID after successfully writing to Postgres,
        // so if it crashes mid-write the message is automatically re-delivered.
        // MAXLEN ~10000: approximate trim keeps ~10min of messages at peak load;
        // prevents stream from growing forever and exhausting Redis RAM.
        // Errors are logged (not swallowed) so DB-write loss is visible, and the
        // rejection is handled so it can never crash the engine process.
        this.client.xAdd(
            "db_processor",
            "*",
            { data: JSON.stringify(message) },
            { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } }
        ).catch((err) => console.error("RedisManager.pushMessage (db_processor) failed:", err));
    }

    public publishMessage(channel: string, message: WsMessage) {
        this.client.publish(channel, JSON.stringify(message))
            .catch((err) => console.error(`RedisManager.publishMessage (${channel}) failed:`, err));
    }

    public sendToApi(clientId: string, message: MessageToApi) {
        this.client.publish(clientId, JSON.stringify(message))
            .catch((err) => console.error(`RedisManager.sendToApi (${clientId}) failed:`, err));
    }
}