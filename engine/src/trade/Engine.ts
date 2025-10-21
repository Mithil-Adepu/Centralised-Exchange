import fs from "fs";
import { RedisManager } from "../RedisManager";
import { ORDER_UPDATE, TRADE_ADDED } from "../types/index";
import { CANCEL_ORDER, CREATE_ORDER, GET_DEPTH, GET_OPEN_ORDERS, MessageFromApi, ON_RAMP,GET_TICKERS } from "../types/fromApi";
import { Fill, Order, Orderbook } from "./Orderbook";
import { TICKER_UPDATE } from "./events";
//TODO: Avoid floats everywhere, use a decimal similar to the PayTM project for every currency
export const BASE_CURRENCY = "INR";

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
            this.orderbooks = snapshotSnapshot.orderbooks.map((o: any) => new Orderbook(
                o.baseAsset, 
                o.bids, 
                o.asks, 
                o.lastTradeId, 
                o.currentPrice,
                o.lastPrice,
                o.firstPrice,
                o.high,
                o.low,
                o.volume,
                o.quoteVolume,
                o.trades
            ));
            // Restore balances from snapshot
            if (snapshotSnapshot.balances) {
                this.balances = new Map(snapshotSnapshot.balances);
            } else {
                // Fallback: set base balances if snapshot doesn't have them
                this.setBaseBalances();
            }
        } else {
            this.orderbooks = [new Orderbook(`TATA`, [], [], 0, 0)];
            this.setBaseBalances();
        }
        setInterval(() => {
            this.saveSnapshot();
        }, 1000 * 3);
    }

    saveSnapshot() {
        const snapshotSnapshot = {
            orderbooks: this.orderbooks.map(o => o.getSnapshot()),
            balances: Array.from(this.balances.entries())
        }
        fs.writeFileSync("./snapshot.json", JSON.stringify(snapshotSnapshot));
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
                                executedQty: order.filled,
                                remainingQty: 0
                            }
                        });
                        return;
                    }

                    if (order.side === "buy") {
                        // Cancel the order from orderbook first
                        const price = cancelOrderbook.cancelBid(order);
                        
                        // Calculate locked funds to unlock based on remaining quantity
                        const lockedAmount = remainingQty * order.price;
                        
                        // Unlock quote currency (INR for buy orders)
                        userBalance[quoteAsset].available += lockedAmount;
                        userBalance[quoteAsset].locked -= lockedAmount;
                        
                        if (price) {
                            this.sendUpdatedDepthAt(price.toString(), cancelMarket);
                        }
                    } else {
                        // Cancel the order from orderbook first
                        const price = cancelOrderbook.cancelAsk(order);
                        
                        // Unlock base asset (TATA for sell orders) based on remaining quantity
                        userBalance[baseAsset].available += remainingQty;
                        userBalance[baseAsset].locked -= remainingQty;
                        
                        if (price) {
                            this.sendUpdatedDepthAt(price.toString(), cancelMarket);
                        }
                    }

                    // Send real-time depth update after order cancellation
                    this.publishWsDepthUpdate(cancelMarket);
                    
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ORDER_CANCELLED",
                        payload: {
                            orderId,
                            executedQty: order.filled,
                            remainingQty: remainingQty
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
                    const openOrders = openOrderbook.getOpenOrders(message.data.userId);

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
                    const amount = Number(message.data.amount);
                    this.onRamp(userId, amount);
                    
                    RedisManager.getInstance().sendToApi(clientId, {
                        type: "ON_RAMP_SUCCESS",
                        payload: {
                            userId,
                            amount
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

        this.checkAndLockFunds(baseAsset, quoteAsset, side, userId, quoteAsset, price, quantity);

        const order: Order = {
            price: Number(price),
            quantity: Number(quantity),
            orderId: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
            filled: 0,
            side,
            userId,
            timestamp: Date.now()
        }
        
        const { fills, executedQty } = orderbook.addOrder(order);
        this.updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty);

        this.createDbTrades(fills, market, userId);
        this.updateDbOrders(order, executedQty, fills, market);
        this.publisWsDepthUpdates(fills, price, side, market);
        this.publishWsTrades(fills, userId, market);
        this.updateTicker(market, fills);
        
        // Send real-time depth update whenever orderbook changes
        this.publishWsDepthUpdate(market);
        
        // Send immediate updates for faster broadcasting
        setTimeout(() => {
            this.publishWsDepthUpdate(market);
            this.publishWsTickerUpdate(market);
        }, 50); // 50ms delay for immediate update
        
        return { executedQty, fills, orderId: order.orderId };
    }

    updateDbOrders(order: Order, executedQty: number, fills: Fill[], market: string) {
        RedisManager.getInstance().pushMessage({
            type: ORDER_UPDATE,
            data: {
                orderId: order.orderId,
                executedQty: executedQty,
                market: market,
                price: order.price.toString(),
                quantity: order.quantity.toString(),
                side: order.side,
            }
        });

        fills.forEach(fill => {
            RedisManager.getInstance().pushMessage({
                type: ORDER_UPDATE,
                data: {
                    orderId: fill.markerOrderId,
                    executedQty: fill.qty
                }
            });
        });
    }

    createDbTrades(fills: Fill[], market: string, userId: string) {
        fills.forEach(fill => {
            RedisManager.getInstance().pushMessage({
                type: TRADE_ADDED,
                data: {
                    market: market,
                    id: fill.tradeId.toString(),
                    isBuyerMaker: fill.otherUserId === userId, // TODO: Is this right?
                    price: fill.price,
                    quantity: fill.qty.toString(),
                    quoteQuantity: (fill.qty * Number(fill.price)).toString(),
                    timestamp: Date.now()
                }
            });
        });
    }

    publishWsTrades(fills: Fill[], userId: string, market: string) {
        fills.forEach(fill => {
            RedisManager.getInstance().publishMessage(`trade.${market}`, {
                stream: `trade.${market}`,
                data: {
                    e: "trade",
                    t: fill.tradeId,
                    m: fill.otherUserId === userId, // TODO: Is this right?
                    p: fill.price,
                    q: fill.qty.toString(),
                    s: market,
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
            const updatedAsks = depth?.asks.filter(x => fills.map(f => f.price).includes(x[0].toString()));
            const updatedBid = depth?.bids.find(x => x[0] === price);
            console.log("publish ws depth updates")
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
           const updatedBids = depth?.bids.filter(x => fills.map(f => f.price).includes(x[0].toString()));
           const updatedAsk = depth?.asks.find(x => x[0] === price);
           console.log("publish ws depth updates")
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

    updateBalance(userId: string, baseAsset: string, quoteAsset: string, side: "buy" | "sell", fills: Fill[], executedQty: number) {
        if (side === "buy") {
            fills.forEach(fill => {
                // Update quote asset balance
                //@ts-ignore
                this.balances.get(fill.otherUserId)[quoteAsset].available = this.balances.get(fill.otherUserId)?.[quoteAsset].available + (fill.qty * fill.price);

                //@ts-ignore
                this.balances.get(userId)[quoteAsset].locked = this.balances.get(userId)?.[quoteAsset].locked - (fill.qty * fill.price);

                // Update base asset balance

                //@ts-ignore
                this.balances.get(fill.otherUserId)[baseAsset].locked = this.balances.get(fill.otherUserId)?.[baseAsset].locked - fill.qty;

                //@ts-ignore
                this.balances.get(userId)[baseAsset].available = this.balances.get(userId)?.[baseAsset].available + fill.qty;

            });
            
        } else {
            fills.forEach(fill => {
                // Update quote asset balance
                //@ts-ignore
                this.balances.get(fill.otherUserId)[quoteAsset].locked = this.balances.get(fill.otherUserId)?.[quoteAsset].locked - (fill.qty * fill.price);

                //@ts-ignore
                this.balances.get(userId)[quoteAsset].available = this.balances.get(userId)?.[quoteAsset].available + (fill.qty * fill.price);

                // Update base asset balance

                //@ts-ignore
                this.balances.get(fill.otherUserId)[baseAsset].available = this.balances.get(fill.otherUserId)?.[baseAsset].available + fill.qty;

                //@ts-ignore
                this.balances.get(userId)[baseAsset].locked = this.balances.get(userId)?.[baseAsset].locked - (fill.qty);

            });
        }
    }

    checkAndLockFunds(baseAsset: string, quoteAsset: string, side: "buy" | "sell", userId: string, asset: string, price: string, quantity: string) {
        if (side === "buy") {
            if ((this.balances.get(userId)?.[quoteAsset]?.available || 0) < Number(quantity) * Number(price)) {
                throw new Error("Insufficient funds");
            }
            //@ts-ignore
            this.balances.get(userId)[quoteAsset].available = this.balances.get(userId)?.[quoteAsset].available - (Number(quantity) * Number(price));
            
            //@ts-ignore
            this.balances.get(userId)[quoteAsset].locked = this.balances.get(userId)?.[quoteAsset].locked + (Number(quantity) * Number(price));
        } else {
            if ((this.balances.get(userId)?.[baseAsset]?.available || 0) < Number(quantity)) {
                throw new Error("Insufficient funds");
            }
            //@ts-ignore
            this.balances.get(userId)[baseAsset].available = this.balances.get(userId)?.[baseAsset].available - (Number(quantity));
            
            //@ts-ignore
            this.balances.get(userId)[baseAsset].locked = this.balances.get(userId)?.[baseAsset].locked + Number(quantity);
        }
    }

    onRamp(userId: string, amount: number) {
        const userBalance = this.balances.get(userId);
        if (!userBalance) {
            this.balances.set(userId, {
                [BASE_CURRENCY]: {
                    available: amount,
                    locked: 0
                }
            });
        } else {
            userBalance[BASE_CURRENCY].available += amount;
        }
    }

    setBaseBalances() {
        // Frontend test users
        this.balances.set("1", {
            [BASE_CURRENCY]: {
                available: 10000000,
                locked: 0
            },
            "TATA": {
                available: 10000000,
                locked: 0
            }
        });

        this.balances.set("2", {
            [BASE_CURRENCY]: {
                available: 10000000,
                locked: 0
            },
            "TATA": {
                available: 10000000,
                locked: 0
            }
        });

        // Market Maker virtual traders (larger balances for high-frequency trading)
        this.balances.set("5", {
            [BASE_CURRENCY]: {
                available: 50000000,
                locked: 0
            },
            "TATA": {
                available: 50000000,
                locked: 0
            }
        });

        this.balances.set("6", {
            [BASE_CURRENCY]: {
                available: 50000000,
                locked: 0
            },
            "TATA": {
                available: 50000000,
                locked: 0
            }
        });

        this.balances.set("7", {
            [BASE_CURRENCY]: {
                available: 50000000,
                locked: 0
            },
            "TATA": {
                available: 50000000,
                locked: 0
            }
        });

        this.balances.set("8", {
            [BASE_CURRENCY]: {
                available: 50000000,
                locked: 0
            },
            "TATA": {
                available: 50000000,
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
            const price = Number(fill.price);
            const quantity = fill.qty;
            const quoteQuantity = price * quantity;

            // Update last price
            orderbook.lastPrice = fill.price;

            // Update high
            if (price > Number(orderbook.high)) {
                orderbook.high = fill.price;
            }

            // Update low
            if (price < Number(orderbook.low) || orderbook.low === "0") {
                orderbook.low = fill.price;
            }

            // Update volume (base asset volume)
            orderbook.volume = (Number(orderbook.volume) + quantity).toString();

            // Update quote volume (quote asset volume)
            orderbook.quoteVolume = (Number(orderbook.quoteVolume) + quoteQuantity).toString();

            // Update trades count
            orderbook.trades = (Number(orderbook.trades) + 1).toString();
        });

        // Publish ticker update
        this.publishWsTickerUpdate(market);
        
        // Also send depth update when ticker changes
        this.publishWsDepthUpdate(market);
        
        // Send immediate ticker update for faster broadcasting
        setTimeout(() => {
            this.publishWsTickerUpdate(market);
        }, 100); // 100ms delay for immediate update
    }

    publishWsTickerUpdate(market: string) {
        const orderbook = this.orderbooks.find(o => o.ticker() === market);
        if (!orderbook) {
            return;
        }

        const ticker = orderbook.getTicker();
        
        RedisManager.getInstance().publishMessage(`ticker.${market}`, {
            stream: `ticker.${market}`,
            data: {
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
                e: "ticker"
            }
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