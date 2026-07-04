import fs from "fs";
import crypto from "crypto";
import { RedisManager } from "../RedisManager";
import { ORDER_UPDATE, TRADE_ADDED } from "../types/index";
import { CANCEL_ORDER, CREATE_ORDER, GET_BALANCES, GET_DEPTH, GET_OPEN_ORDERS, MessageFromApi, ON_RAMP, GET_TICKERS } from "../types/fromApi";
import { Fill, Order, Orderbook } from "./Orderbook";
import { TICKER_UPDATE } from "./events";
import { elog, short } from "./logger";
import {
    fromScaledToDecimal,
    multiplyScaled,
    scaleFromNumber,
    scaledToNumber,
    toScaledFromDecimal,
} from "./precision";

const SNAPSHOT_VERSION = 2;
// Scaled integer math (see docs/adr/0001-shared-types-and-precision.md).
export const BASE_CURRENCY = "USDC";

interface UserBalance {
    [key: string]: {
        available: number;
        locked: number;
    }
}

export class Engine {
    private orderbooks: Orderbook[] = [];
    private balances: Map<string, UserBalance> = new Map();
    private lastProcessedStreamId: string = "0-0";
    // De-dup for on-ramp credits: a replayed ON_RAMP must not mint funds twice.
    private processedTxns: Set<string> = new Set();

    constructor() {
        let snapshot = null
        try {
            if (process.env.WITH_SNAPSHOT) {
                snapshot = fs.readFileSync("./snapshot.json");
            }
        } catch (e) {
            console.log("No snapshot found");
        }

        if (snapshot) {
            const snapshotSnapshot = JSON.parse(snapshot.toString());
            const snapshotVersion = snapshotSnapshot.version ?? 1;
            const isScaled = snapshotVersion >= SNAPSHOT_VERSION;

            const normalizeOrder = (order: any): Order => ({
                price: isScaled ? order.price : toScaledFromDecimal(String(order.price ?? 0)),
                quantity: isScaled ? order.quantity : toScaledFromDecimal(String(order.quantity ?? 0)),
                orderId: order.orderId,
                filled: isScaled ? order.filled : toScaledFromDecimal(String(order.filled ?? 0)),
                side: order.side,
                userId: order.userId,
                timestamp: order.timestamp
            });

            this.orderbooks = (snapshotSnapshot.orderbooks || []).map((o: any) => new Orderbook(
                o.baseAsset,
                (o.bids || []).map(normalizeOrder),
                (o.asks || []).map(normalizeOrder),
                o.lastTradeId || 0,
                isScaled ? (o.currentPrice || 0) : toScaledFromDecimal(String(o.currentPrice ?? 0)),
                isScaled ? (o.lastPrice || 0) : toScaledFromDecimal(String(o.lastPrice ?? 0)),
                isScaled ? (o.firstPrice || 0) : toScaledFromDecimal(String(o.firstPrice ?? 0)),
                isScaled ? (o.high || 0) : toScaledFromDecimal(String(o.high ?? 0)),
                isScaled ? (o.low || 0) : toScaledFromDecimal(String(o.low ?? 0)),
                isScaled ? (o.volume || 0) : toScaledFromDecimal(String(o.volume ?? 0)),
                isScaled ? (o.quoteVolume || 0) : toScaledFromDecimal(String(o.quoteVolume ?? 0)),
                isScaled ? (o.trades || 0) : Number(o.trades ?? 0)
            ));

            if (snapshotSnapshot.balances) {
                if (isScaled) {
                    this.balances = new Map(snapshotSnapshot.balances);
                } else {
                    this.balances = new Map(snapshotSnapshot.balances.map(([userId, balance]: [string, UserBalance]) => {
                        const normalized: UserBalance = {};
                        for (const asset in balance) {
                            normalized[asset] = {
                                available: toScaledFromDecimal(String(balance[asset].available ?? 0)),
                                locked: toScaledFromDecimal(String(balance[asset].locked ?? 0))
                            };
                        }
                        return [userId, normalized];
                    }));
                }
            } else {
                this.setBaseBalances();
            }

            // Load last processed stream ID for crash recovery replay
            if (snapshotSnapshot.lastProcessedStreamId) {
                this.lastProcessedStreamId = snapshotSnapshot.lastProcessedStreamId;
            }

            // Restore on-ramp de-dup set so credits stay idempotent across restarts
            if (Array.isArray(snapshotSnapshot.processedTxns)) {
                this.processedTxns = new Set(snapshotSnapshot.processedTxns);
            }
        } else {
            this.orderbooks = [new Orderbook(`SOL`, [], [], 0, 0)];
            this.setBaseBalances();
        }
        elog.info("ENGINE", `Ready — ${this.orderbooks.length} orderbook(s) [${this.orderbooks.map(o => o.ticker()).join(", ")}], ${this.balances.size} balance account(s)${snapshot ? " (restored from snapshot)" : " (fresh state)"}, resumeOffset=${this.lastProcessedStreamId}`);

        // Snapshot every 30s — only if data changed.
        // _dirty is cleared BEFORE saveSnapshot() so any trades arriving
        // during the async disk write will set _dirty=true again and be
        // captured in the next interval. This prevents silent data gaps.
        this._dirty = false;
        setInterval(() => {
            if (this._dirty) {
                this._dirty = false; // Clear first — new trades during write re-set this
                this.saveSnapshot();
            }
        }, 1000 * 30);
    }

    private _dirty: boolean = false;

    /** Called by index.ts after each successful XACK so the snapshot records the offset. */
    public setLastProcessedStreamId(id: string) {
        this.lastProcessedStreamId = id;
    }

    /** Exposed so index.ts can start XREADGROUP from the correct offset after a crash. */
    public getLastProcessedStreamId(): string {
        return this.lastProcessedStreamId;
    }

    /**
     * Persist full engine state via atomic tmp-write + rename.
     * Returns a Promise so callers (notably graceful shutdown) can AWAIT completion —
     * previously this used fire-and-forget callbacks and `process.exit` raced the write,
     * so the shutdown snapshot was routinely lost despite logging "saved".
     */
    async saveSnapshot(): Promise<void> {
        const snapshotData = {
            version: SNAPSHOT_VERSION,
            lastProcessedStreamId: this.lastProcessedStreamId,
            orderbooks: this.orderbooks.map(o => o.getSnapshot()),
            balances: Array.from(this.balances.entries()),
            processedTxns: Array.from(this.processedTxns)
        };
        const tmpFile = "./snapshot.tmp.json";
        try {
            await fs.promises.writeFile(tmpFile, JSON.stringify(snapshotData));
            await fs.promises.rename(tmpFile, "./snapshot.json");
            elog.info("SNAPSHOT", `saved — offset=${this.lastProcessedStreamId}, orderbooks=${this.orderbooks.length}, accounts=${this.balances.size}`);
        } catch (err) {
            console.error("Snapshot save error:", err);
            this._dirty = true; // Mark dirty again so next interval retries
        }
    }

    process({ message, clientId }: { message: MessageFromApi, clientId: string }) {
        switch (message.type) {
            case CREATE_ORDER:
                try {
                    const { executedQty, fills, orderId } = this.createOrder(message.data.market, message.data.price, message.data.quantity, message.data.side, message.data.userId);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_PLACED",
                        payload: {
                            orderId,
                            executedQty,
                            fills
                        }
                    });
                } catch (e: any) {
                    elog.warn("ORDER", `REJECTED ${message.data.side} ${message.data.quantity} ${message.data.market} @ ${message.data.price} user=${short(message.data.userId)}: ${e?.message || e}`);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_REJECTED",
                        payload: {
                            reason: e.message || "Failed to create order"
                        }
                    });
                }
                break;
            case CANCEL_ORDER:
                try {
                    const orderId = message.data.orderId;
                    const cancelMarket = message.data.market;
                    const requestUserId = message.data.userId;
                    const cancelOrderbook = this.orderbooks.find(o => o.ticker() === cancelMarket);
                    const baseAsset = cancelMarket.split("_")[0];
                    const quoteAsset = cancelMarket.split("_")[1];

                    if (!cancelOrderbook) {
                        throw new Error("No orderbook found");
                    }

                    // Find order in both asks and bids
                    const order = cancelOrderbook.asks.find(o => o.orderId === orderId) || cancelOrderbook.bids.find(o => o.orderId === orderId);
                    if (!order) {
                        console.log("No order found");
                        throw new Error("No order found");
                    }

                    if (order.userId !== requestUserId) {
                        throw new Error("Unauthorized cancel request");
                    }

                    // Check if user balance exists
                    const userBalance = this.balances.get(order.userId);
                    if (!userBalance) {
                        console.log(`User balance not found for userId: ${order.userId}`);
                        throw new Error("User balance not found");
                    }

                    // Snapshot the filled quantity before cancellation to handle race conditions
                    const filledAtCancel = order.filled;
                    const remainingQty = order.quantity - filledAtCancel;

                    // Check if order is already fully filled
                    if (remainingQty <= 0) {
                        console.log("Order already fully filled - cannot cancel");
                        // Return success response indicating order was already filled
                        RedisManager.getInstance().sendToApi(clientId, {
                            type: "ORDER_CANCELLED",
                            payload: {
                                orderId: orderId,
                                executedQty: scaledToNumber(order.filled),
                                remainingQty: 0
                            }
                        });
                        return;
                    }

                    if (order.side === "buy") {
                        // Cancel the order from orderbook first
                        const price = cancelOrderbook.cancelBid(order);

                        // Calculate locked funds to unlock based on remaining quantity
                        const lockedAmount = multiplyScaled(remainingQty, order.price);

                        // Unlock quote currency (INR for buy orders)
                        userBalance[quoteAsset].available += lockedAmount;
                        userBalance[quoteAsset].locked -= lockedAmount;

                        if (price) {
                            this.sendUpdatedDepthAt(fromScaledToDecimal(price), cancelMarket);
                        }
                    } else {
                        // Cancel the order from orderbook first
                        const price = cancelOrderbook.cancelAsk(order);

                        // Unlock base asset (SOL for sell orders) based on remaining quantity
                        userBalance[baseAsset].available += remainingQty;
                        userBalance[baseAsset].locked -= remainingQty;

                        if (price) {
                            this.sendUpdatedDepthAt(fromScaledToDecimal(price), cancelMarket);
                        }
                    }

                    // Send real-time depth update after order cancellation
                    this.publishWsDepthUpdate(cancelMarket);

                    elog.info("CANCEL", `order=${short(orderId)} ${order.side.toUpperCase()} ${cancelMarket} unlocked=${fromScaledToDecimal(remainingQty)} (${order.side === "buy" ? quoteAsset : baseAsset}) user=${short(requestUserId)}`);

                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_CANCELLED",
                        payload: {
                            orderId,
                            executedQty: scaledToNumber(order.filled),
                            remainingQty: scaledToNumber(remainingQty)
                        }
                    });

                } catch (e: any) {
                    elog.error("CANCEL", `rejected: ${e?.message || e}`);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "CANCEL_ORDER_REJECTED",
                        payload: {
                            error: e?.message || "Failed to cancel order"
                        }
                    });
                }
                break;
            case GET_OPEN_ORDERS:
                try {
                    const openOrderbook = this.orderbooks.find(o => o.ticker() === message.data.market);
                    if (!openOrderbook) {
                        throw new Error("No orderbook found");
                    }
                    const openOrders = openOrderbook.getOpenOrders(message.data.userId).map(order => ({
                        orderId: order.orderId,
                        executedQty: scaledToNumber(order.filled),
                        price: fromScaledToDecimal(order.price),
                        quantity: fromScaledToDecimal(order.quantity),
                        side: order.side,
                        userId: order.userId,
                        timestamp: order.timestamp,
                    }));

                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "OPEN_ORDERS",
                        payload: openOrders
                    });
                } catch (e) {
                    elog.error("OPEN_ORDERS", `${(e as Error)?.message || e}`);
                    // Always reply — otherwise the API's sendAndAwait blocks for 10s.
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "OPEN_ORDERS",
                        payload: []
                    });
                }
                break;
            case ON_RAMP:
                try {
                    const userId = message.data.userId;
                    const amount = message.data.amount;
                    const credited = this.onRamp(userId, amount, message.data.txnId);

                    if (credited) {
                        elog.info("ONRAMP", `+${amount} ${BASE_CURRENCY} user=${short(userId)}${message.data.txnId ? ` txn=${short(message.data.txnId)}` : ""}`);
                    } else {
                        elog.warn("ONRAMP", `duplicate txn=${short(message.data.txnId)} ignored (already credited)`);
                    }

                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ON_RAMP_SUCCESS",
                        payload: {
                            userId,
                            amount: Number(amount)
                        }
                    });
                } catch (e) {
                    console.log("On-ramp error:", e);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ON_RAMP_FAILURE",
                        payload: {
                            userId: message.data.userId,
                            error: (e as Error)?.message || "Unknown on-ramp error"
                        }
                    });
                }
                break;
            case GET_DEPTH:
                try {
                    const market = message.data.market;
                    const orderbook = this.orderbooks.find(o => o.ticker() === market);
                    if (!orderbook) {
                        throw new Error("No orderbook found");
                    }
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "DEPTH",
                        payload: orderbook.getDepth()
                    });
                } catch (e) {
                    console.log(e);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "DEPTH",
                        payload: {
                            bids: [],
                            asks: []
                        }
                    });
                }
                break;
            case GET_BALANCES:
                try {
                    const userId = message.data.userId;
                    const balances = this.getUserBalances(userId);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "BALANCES",
                        payload: {
                            userId,
                            balances
                        }
                    });
                } catch (e) {
                    console.log(e);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "BALANCES",
                        payload: {
                            userId: message.data.userId,
                            balances: {}
                        }
                    });
                }
                break;
            case GET_TICKERS:
                try {
                    const market = message.data.market;

                    if (market) {
                        // Get single ticker for specific market
                        const orderbook = this.orderbooks.find(o => o.ticker() === market);
                        if (!orderbook) {
                            throw new Error("No orderbook found");
                        }
                        RedisManager.getInstance().sendToApi(clientId, {
                            type: "TICKERS",
                            payload: [orderbook.getTicker()]
                        });
                    } else {
                        // Get all tickers
                        const tickers = this.orderbooks.map(o => o.getTicker());
                        RedisManager.getInstance().sendToApi(clientId, {
                            type: "TICKERS",
                            payload: tickers
                        });
                    }
                } catch (e) {
                    console.log(e);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "TICKERS",
                        payload: []
                    });
                }
                break;
        }
    }

    private getUserBalances(userId: string) {
        const balances = this.balances.get(userId) || {};
        const normalized: UserBalance = {};

        for (const asset in balances) {
            normalized[asset] = {
                available: scaledToNumber(balances[asset].available),
                locked: scaledToNumber(balances[asset].locked),
            };
        }

        return normalized;
    }

    addOrderbook(orderbook: Orderbook) {
        this.orderbooks.push(orderbook);
    }

    createOrder(market: string, price: string, quantity: string, side: "buy" | "sell", userId: string) {

        const orderbook = this.orderbooks.find(o => o.ticker() === market)
        const baseAsset = market.split("_")[0];
        const quoteAsset = market.split("_")[1];

        if (!orderbook) {
            throw new Error("No orderbook found");
        }

        elog.info("ORDER", `RECV ${side.toUpperCase()} ${quantity} ${market} @ ${price} user=${short(userId)}`);

        // Input validation
        const numPrice = toScaledFromDecimal(price);
        const numQuantity = toScaledFromDecimal(quantity);
        if (!Number.isFinite(numPrice) || numPrice <= 0) throw new Error("Invalid price");
        if (!Number.isFinite(numQuantity) || numQuantity <= 0) throw new Error("Invalid quantity");
        if (side !== "buy" && side !== "sell") throw new Error("Invalid side");

        // Sanity bounds: prevent absurd prices and quantities per market
        // These are scaled integers: 1 unit = 0.000001 (6 decimal places)
        const MIN_PRICE = toScaledFromDecimal("0.01");       // $0.01 minimum
        const MAX_PRICE = toScaledFromDecimal("1000000");    // $1,000,000 maximum
        const MIN_QUANTITY = toScaledFromDecimal("0.000001"); // 0.000001 minimum
        const MAX_QUANTITY = toScaledFromDecimal("100000");   // 100,000 maximum per order

        if (numPrice < MIN_PRICE) throw new Error(`Price too low (minimum $0.01)`);
        if (numPrice > MAX_PRICE) throw new Error(`Price too high (maximum $1,000,000)`);
        if (numQuantity < MIN_QUANTITY) throw new Error(`Quantity too small (minimum 0.000001)`);
        if (numQuantity > MAX_QUANTITY) throw new Error(`Quantity too large (maximum 100,000 per order)`);

        this.checkAndLockFunds(baseAsset, quoteAsset, side, userId, price, quantity);

        const order: Order = {
            price: numPrice,
            quantity: numQuantity,
            orderId: crypto.randomUUID(),
            filled: 0,
            side,
            userId,
            timestamp: Date.now()
        };

        const { fills, executedQty } = orderbook.addOrder(order);
        this.updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty, numPrice);

        // ── Activity logging: each fill/trade, then the order's final disposition ──
        for (const fill of fills) {
            elog.info("TRADE", `#${fill.tradeId} ${fromScaledToDecimal(fill.qty)} ${market} @ ${fromScaledToDecimal(fill.price)} taker=${short(userId)}(${side}) maker=${short(fill.otherUserId)}`);
        }
        const execDecimal = fromScaledToDecimal(executedQty);
        const remaining = numQuantity - executedQty;
        if (remaining <= 0) {
            elog.info("ORDER", `FILLED order=${short(order.orderId)} executed=${execDecimal} ${market}`);
        } else if (executedQty > 0) {
            elog.info("BOOK", `PARTIAL+REST order=${short(order.orderId)} executed=${execDecimal}, resting=${fromScaledToDecimal(remaining)} ${market} @ ${price}`);
        } else {
            elog.info("BOOK", `RESTED ${side.toUpperCase()} ${quantity} ${market} @ ${price} order=${short(order.orderId)}`);
        }

        this.createDbTrades(fills, market, side);
        this.updateDbOrders(order, executedQty, fills, market);
        this.publisWsDepthUpdates(fills, fromScaledToDecimal(numPrice), side, market);
        this.publishWsTrades(fills, market, side);
        this.updateTicker(market, fills);

        // Mark dirty for snapshot
        this._dirty = true;

        const apiFills = fills.map((fill) => ({
            price: fromScaledToDecimal(fill.price),
            qty: scaledToNumber(fill.qty),
            tradeId: fill.tradeId,
        }));

        return { executedQty: scaledToNumber(executedQty), fills: apiFills, orderId: order.orderId };
    }

    updateDbOrders(order: Order, executedQty: number, fills: Fill[], market: string) {
        RedisManager.getInstance().pushMessage({
            type: ORDER_UPDATE,
            data: {
                orderId: order.orderId,
                executedQty: scaledToNumber(executedQty),
                market: market,
                price: fromScaledToDecimal(order.price),
                quantity: fromScaledToDecimal(order.quantity),
                side: order.side,
                userId: order.userId
            }
        });

        fills.forEach(fill => {
            RedisManager.getInstance().pushMessage({
                type: ORDER_UPDATE,
                data: {
                    orderId: fill.markerOrderId,
                    executedQty: scaledToNumber(fill.qty),
                    userId: fill.otherUserId,
                    market: market,
                    price: fromScaledToDecimal(fill.makerPrice),
                    quantity: fromScaledToDecimal(fill.makerQuantity),
                    side: fill.makerSide,
                }
            });
        });
    }

    createDbTrades(fills: Fill[], market: string, side: "buy" | "sell") {
        const isBuyerMaker = side === "sell";
        fills.forEach(fill => {
            const quoteQuantity = multiplyScaled(fill.qty, fill.price);
            RedisManager.getInstance().pushMessage({
                type: TRADE_ADDED,
                data: {
                    market: market,
                    id: fill.tradeId.toString(),
                    isBuyerMaker,
                    price: fromScaledToDecimal(fill.price),
                    quantity: fromScaledToDecimal(fill.qty),
                    quoteQuantity: fromScaledToDecimal(quoteQuantity),
                    timestamp: Date.now()
                }
            });
        });
    }

    publishWsTrades(fills: Fill[], market: string, side: "buy" | "sell") {
        const isBuyerMaker = side === "sell";
        fills.forEach(fill => {
            const timestamp = Date.now();
            const quoteQuantity = fromScaledToDecimal(multiplyScaled(fill.qty, fill.price));
            RedisManager.getInstance().publishMessage(`trade.${market}`, {
                stream: `trade.${market}`,
                data: {
                    e: "trade",
                    id: fill.tradeId,
                    price: fromScaledToDecimal(fill.price),
                    quantity: fromScaledToDecimal(fill.qty),
                    quoteQuantity,
                    timestamp,
                    isBuyerMaker,
                    symbol: market,
                }
            });
        });
    }

    sendUpdatedDepthAt(price: string, market: string) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }
        const depth = orderbook.getDepth();
        const updatedBids = depth?.bids.filter(x => x[0] === price);
        const updatedAsks = depth?.asks.filter(x => x[0] === price);

        RedisManager.getInstance().publishMessage(`depth.${market}`, {
            stream: `depth.${market}`,
            data: {
                a: updatedAsks.length ? updatedAsks : [[price, "0"]],
                b: updatedBids.length ? updatedBids : [[price, "0"]],
                e: "depth"
            }
        });
    }

    publisWsDepthUpdates(fills: Fill[], price: string, side: "buy" | "sell", market: string) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }
        const depth = orderbook.getDepth();
        if (side === "buy") {
            const fillPrices = new Set(fills.map((fill) => fromScaledToDecimal(fill.price)));
            const updatedAsks = depth?.asks.filter(x => fillPrices.has(x[0]));
            const updatedBid = depth?.bids.find(x => x[0] === price);
            RedisManager.getInstance().publishMessage(`depth.${market}`, {
                stream: `depth.${market}`,
                data: {
                    a: updatedAsks,
                    b: updatedBid ? [updatedBid] : [],
                    e: "depth"
                }
            });
        }
        if (side === "sell") {
            const fillPrices = new Set(fills.map((fill) => fromScaledToDecimal(fill.price)));
            const updatedBids = depth?.bids.filter(x => fillPrices.has(x[0]));
            const updatedAsk = depth?.asks.find(x => x[0] === price);
            RedisManager.getInstance().publishMessage(`depth.${market}`, {
                stream: `depth.${market}`,
                data: {
                    a: updatedAsk ? [updatedAsk] : [],
                    b: updatedBids,
                    e: "depth"
                }
            });
        }
    }

    /** Safely get or initialize a user's asset balance */
    private getOrInitBalance(userId: string, asset: string) {
        let userBal = this.balances.get(userId);
        if (!userBal) {
            userBal = {};
            this.balances.set(userId, userBal);
        }
        if (!userBal[asset]) {
            userBal[asset] = { available: 0, locked: 0 };
        }
        return userBal[asset];
    }

    updateBalance(userId: string, baseAsset: string, quoteAsset: string, side: "buy" | "sell", fills: Fill[], executedQty: number, limitPrice: number) {
        if (side === "buy") {
            fills.forEach(fill => {
                const fillValue = multiplyScaled(fill.qty, fill.price);
                // Funds were locked at the buyer's LIMIT price (qty × limitPrice).
                // When a fill executes at a better maker price, the difference must be
                // returned to available — otherwise it stays locked forever (fund leak).
                const lockedForFill = multiplyScaled(fill.qty, limitPrice);
                const improvement = lockedForFill - fillValue; // >= 0 for a buy

                // Seller receives quote currency (at execution price)
                this.getOrInitBalance(fill.otherUserId, quoteAsset).available += fillValue;
                // Buyer's locked quote currency releases the full amount locked for this qty
                this.getOrInitBalance(userId, quoteAsset).locked -= lockedForFill;
                // Buyer gets the price-improvement refunded to available
                if (improvement !== 0) {
                    this.getOrInitBalance(userId, quoteAsset).available += improvement;
                }
                // Seller's locked base asset decreases
                this.getOrInitBalance(fill.otherUserId, baseAsset).locked -= fill.qty;
                // Buyer receives base asset
                this.getOrInitBalance(userId, baseAsset).available += fill.qty;
            });
        } else {
            fills.forEach(fill => {
                const fillValue = multiplyScaled(fill.qty, fill.price);

                // Buyer's locked quote currency decreases
                this.getOrInitBalance(fill.otherUserId, quoteAsset).locked -= fillValue;
                // Seller receives quote currency
                this.getOrInitBalance(userId, quoteAsset).available += fillValue;
                // Buyer receives base asset
                this.getOrInitBalance(fill.otherUserId, baseAsset).available += fill.qty;
                // Seller's locked base asset decreases
                this.getOrInitBalance(userId, baseAsset).locked -= fill.qty;
            });
        }
    }

    checkAndLockFunds(baseAsset: string, quoteAsset: string, side: "buy" | "sell", userId: string, price: string, quantity: string) {
        const numPrice = toScaledFromDecimal(price);
        const numQuantity = toScaledFromDecimal(quantity);
        if (!Number.isFinite(numPrice) || !Number.isFinite(numQuantity)) {
            throw new Error("Invalid price or quantity");
        }
        const totalCost = multiplyScaled(numQuantity, numPrice);

        if (side === "buy") {
            const bal = this.getOrInitBalance(userId, quoteAsset);
            if (bal.available < totalCost) {
                throw new Error("Insufficient funds");
            }
            bal.available -= totalCost;
            bal.locked += totalCost;
        } else {
            const bal = this.getOrInitBalance(userId, baseAsset);
            if (bal.available < numQuantity) {
                throw new Error("Insufficient funds");
            }
            bal.available -= numQuantity;
            bal.locked += numQuantity;
        }
    }

    /**
     * Credit a user's base-currency balance. Idempotent when a txnId is supplied:
     * a replayed message with the same txnId is ignored so funds are never minted
     * twice (crash-recovery / at-least-once delivery safety).
     * @returns true if credited, false if skipped as a duplicate.
     */
    onRamp(userId: string, amount: string | number, txnId?: string): boolean {
        if (txnId && this.processedTxns.has(txnId)) {
            return false;
        }
        const scaledAmount = toScaledFromDecimal(amount.toString());
        if (!Number.isFinite(scaledAmount) || scaledAmount <= 0) {
            throw new Error("Invalid on-ramp amount");
        }
        const baseBalance = this.getOrInitBalance(userId, BASE_CURRENCY);
        baseBalance.available += scaledAmount;
        if (txnId) {
            this.processedTxns.add(txnId);
        }
        return true;
    }

    setBaseBalances() {
        // Test user: trader@cex.io — maps to UUID 00000000-0000-0000-0000-000000000009
        this.balances.set("00000000-0000-0000-0000-000000000009", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(1000000),   // 1M USDC
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(10000),     // 10K SOL
                locked: 0
            }
        });

        // Market Maker virtual traders
        this.balances.set("00000000-0000-0000-0000-000000000005", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("00000000-0000-0000-0000-000000000006", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("00000000-0000-0000-0000-000000000007", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("00000000-0000-0000-0000-000000000008", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        // Human demo login profiles (alice/bob/carol) — see db seed.
        // Each starts with 500K USDC + 5K SOL so they can trade immediately.
        for (const demoUserId of [
            "00000000-0000-0000-0000-000000000010", // alice@cex.io
            "00000000-0000-0000-0000-000000000011", // bob@cex.io
            "00000000-0000-0000-0000-000000000012", // carol@cex.io
        ]) {
            this.balances.set(demoUserId, {
                [BASE_CURRENCY]: {
                    available: scaleFromNumber(500000),
                    locked: 0
                },
                "SOL": {
                    available: scaleFromNumber(5000),
                    locked: 0
                }
            });
        }

        // trader2 / trader3 — mirror trader@cex.io (1M USDC + 10K SOL) for
        // testing order matching between two well-funded live accounts.
        for (const traderUserId of [
            "00000000-0000-0000-0000-000000000013", // trader2@cex.io
            "00000000-0000-0000-0000-000000000014", // trader3@cex.io
        ]) {
            this.balances.set(traderUserId, {
                [BASE_CURRENCY]: {
                    available: scaleFromNumber(1000000),
                    locked: 0
                },
                "SOL": {
                    available: scaleFromNumber(10000),
                    locked: 0
                }
            });
        }
    }

    updateTicker(market: string, fills: Fill[]) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }

        fills.forEach(fill => {
            const price = fill.price;
            const quantity = fill.qty;
            const quoteQuantity = multiplyScaled(price, quantity);

            // Update last price
            orderbook.lastPrice = price;

            if (orderbook.firstPrice === 0) {
                orderbook.firstPrice = price;
            }

            // Update high
            if (price > orderbook.high) {
                orderbook.high = price;
            }

            // Update low
            if (price < orderbook.low || orderbook.low === 0) {
                orderbook.low = price;
            }

            // Update volume (base asset volume)
            orderbook.volume += quantity;

            // Update quote volume (quote asset volume)
            orderbook.quoteVolume += quoteQuantity;

            // Update trades count
            orderbook.trades += 1;
        });

        // Single ticker publish (was 3x before — ticker+depth+setTimeout)
        this.publishWsTickerUpdate(market);
    }

    publishWsTickerUpdate(market: string) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }

        const ticker = orderbook.getTicker();

        const payload = {
            lastPrice: ticker.lastPrice,
            high: ticker.high,
            low: ticker.low,
            volume: ticker.volume,
            quoteVolume: ticker.quoteVolume,
            symbol: ticker.symbol,
            priceChange: ticker.priceChange,
            priceChangePercent: ticker.priceChangePercent,
            firstPrice: ticker.firstPrice,
            trades: ticker.trades,
            id: 0,
            e: "ticker" as const,
        };

        RedisManager.getInstance().publishMessage(`ticker.${market}`, {
            stream: `ticker.${market}`,
            data: payload,
        });

        RedisManager.getInstance().publishMessage("ticker.all", {
            stream: "ticker.all",
            data: payload,
        });
    }

    publishWsDepthUpdate(market: string) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }

        const depth = orderbook.getDepth();
        RedisManager.getInstance().publishMessage(`depth.${market}`, {
            stream: `depth.${market}`,
            data: {
                b: depth?.bids || [],
                a: depth?.asks || [],
                e: "depth",
                // Full book — tells clients to REPLACE local state, not merge,
                // so levels removed server-side (e.g. on cancel) don't linger.
                snapshot: true
            }
        });
    }


}