import fs from "fs";
import crypto from "crypto";
import { RedisManager } from "../RedisManager";
import { ORDER_UPDATE, TRADE_ADDED } from "../types/index";
import { CANCEL_ORDER, CREATE_ORDER, GET_BALANCES, GET_DEPTH, GET_OPEN_ORDERS, MessageFromApi, ON_RAMP, GET_TICKERS } from "../types/fromApi";
import { Fill, Order, Orderbook } from "./Orderbook";
import { TICKER_UPDATE } from "./events";
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
        } else {
            this.orderbooks = [new Orderbook(`SOL`, [], [], 0, 0)];
            this.setBaseBalances();
        }
        // Snapshot every 30s (was 3s) — only if data changed
        this._dirty = false;
        setInterval(() => {
            if (this._dirty) {
                this.saveSnapshot();
                this._dirty = false;
            }
        }, 1000 * 30);
    }

    private _dirty: boolean = false;

    saveSnapshot() {
        const snapshotData = {
            version: SNAPSHOT_VERSION,
            orderbooks: this.orderbooks.map(o => o.getSnapshot()),
            balances: Array.from(this.balances.entries())
        };
        // Async write — don't block the event loop
        fs.writeFile("./snapshot.json", JSON.stringify(snapshotData), (err) => {
            if (err) console.error("Snapshot write error:", err);
        });
    }

    process({ message, clientId }: {message: MessageFromApi, clientId: string}) {
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
                } catch (e) {
                    console.log(e);
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_CANCELLED",
                        payload: {
                            orderId: "",
                            executedQty: 0,
                            remainingQty: 0
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
                        
                        // Unlock base asset (TATA for sell orders) based on remaining quantity
                        userBalance[baseAsset].available += remainingQty;
                        userBalance[baseAsset].locked -= remainingQty;
                        
                        if (price) {
                            this.sendUpdatedDepthAt(fromScaledToDecimal(price), cancelMarket);
                        }
                    }

                    // Send real-time depth update after order cancellation
                    this.publishWsDepthUpdate(cancelMarket);
                    
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_CANCELLED",
                        payload: {
                            orderId,
                            executedQty: scaledToNumber(order.filled),
                            remainingQty: scaledToNumber(remainingQty)
                        }
                    });
                    
                } catch (e) {
                    console.log("Error while cancelling order:");
                    console.log(e);
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
                } catch(e) {
                    console.log(e);
                }
                break;
            case ON_RAMP:
                try {
                    const userId = message.data.userId;
                    const amount = message.data.amount;
                    this.onRamp(userId, amount);
                    
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
                        type: "ON_RAMP_SUCCESS",
                        payload: {
                            userId: message.data.userId,
                            amount: Number(message.data.amount)
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

        // Input validation
        const numPrice = toScaledFromDecimal(price);
        const numQuantity = toScaledFromDecimal(quantity);
        if (!Number.isFinite(numPrice) || numPrice <= 0) throw new Error("Invalid price");
        if (!Number.isFinite(numQuantity) || numQuantity <= 0) throw new Error("Invalid quantity");
        if (side !== "buy" && side !== "sell") throw new Error("Invalid side");

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
        this.updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty);

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
            }
        });

        fills.forEach(fill => {
            RedisManager.getInstance().pushMessage({
                type: ORDER_UPDATE,
                data: {
                    orderId: fill.markerOrderId,
                    executedQty: scaledToNumber(fill.qty)
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

    updateBalance(userId: string, baseAsset: string, quoteAsset: string, side: "buy" | "sell", fills: Fill[], executedQty: number) {
        if (side === "buy") {
            fills.forEach(fill => {
                const fillValue = multiplyScaled(fill.qty, fill.price);

                // Seller receives quote currency
                this.getOrInitBalance(fill.otherUserId, quoteAsset).available += fillValue;
                // Buyer's locked quote currency decreases
                this.getOrInitBalance(userId, quoteAsset).locked -= fillValue;
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

    onRamp(userId: string, amount: string | number) {
        const scaledAmount = toScaledFromDecimal(amount.toString());
        if (!Number.isFinite(scaledAmount) || scaledAmount <= 0) {
            throw new Error("Invalid on-ramp amount");
        }
        const baseBalance = this.getOrInitBalance(userId, BASE_CURRENCY);
        baseBalance.available += scaledAmount;
    }

    setBaseBalances() {
        // Test user: trader@cex.io — huge balance for testing
        this.balances.set("9", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(1000000),   // 1M USDC
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(10000),     // 10K SOL
                locked: 0
            }
        });

        // Legacy frontend test users
        this.balances.set("1", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(10000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(10000000),
                locked: 0
            }
        });

        this.balances.set("2", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(10000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(10000000),
                locked: 0
            }
        });

        // Market Maker virtual traders
        this.balances.set("5", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("6", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("7", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });

        this.balances.set("8", {
            [BASE_CURRENCY]: {
                available: scaleFromNumber(50000000),
                locked: 0
            },
            "SOL": {
                available: scaleFromNumber(50000000),
                locked: 0
            }
        });
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
                e: "depth"
            }
        });
    }


}