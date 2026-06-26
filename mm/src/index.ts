import axios, { AxiosError } from "axios";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "";
const MARKET = "SOL_USDC";

// Virtual traders simulating different market participants
const TRADERS = {
    MARKET_MAKER: "5",      // Provides liquidity
    MOMENTUM_TRADER: "6",   // Follows trends
    MEAN_REVERTER: "7",     // Bets on price returning to average
    SCALPER: "8",           // Quick small trades
};

const INITIAL_BALANCE = 50000000; // 50M per trader

// Market dynamics parameters — SOL/USDC realistic
const BASE_PRICE = 150;
const PRICE_VOLATILITY = 8;       // ±8 USDC range
const MIN_SPREAD = 0.05;          // Minimum 5 cents spread
const MAX_SPREAD = 0.5;           // Max 50 cents spread

// High-frequency simulation settings
const CYCLE_INTERVAL = 500;       // 500ms cycles — near HFT
const LIQUIDITY_ORDERS = 12;      // Deep book: 12 levels per side

// Trading probabilities — cranked up for candle generation
const MOMENTUM_TRADE_PROB = 0.60;
const REVERTER_TRADE_PROB = 0.35;
const SCALP_TRADE_PROB = 0.70;
const VOLATILITY_EVENT_PROB = 0.18;
const BURST_EVENT_PROB = 0.35;
const AGGRESSIVE_TRADE_PROB = 0.70;

interface Order {
    orderId: string;
    price: number;
    quantity: number;
    side: "buy" | "sell";
    filled: number;
}

function internalHeaders(userId: string) {
    return {
        "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
        "X-Internal-User-Id": userId,
    };
}

// Market state
let isShuttingDown = false;
let errorCount = 0;
let cycleCount = 0;
const MAX_ERRORS = 5;

let currentPrice = BASE_PRICE;
let priceMovingAverage = BASE_PRICE;
let priceHistory: number[] = [BASE_PRICE];
let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
let volatility = 1;

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Market Maker shutting down gracefully...');
    isShuttingDown = true;
    process.exit(0);
});

async function ensureAllBalances() {
    console.log(`💰 Virtual traders initialized by Engine:`);
    console.log(`  ✅ MARKET_MAKER (User ${TRADERS.MARKET_MAKER}): 50,000,000 USDC + SOL`);
    console.log(`  ✅ MOMENTUM_TRADER (User ${TRADERS.MOMENTUM_TRADER}): 50,000,000 USDC + SOL`);
    console.log(`  ✅ MEAN_REVERTER (User ${TRADERS.MEAN_REVERTER}): 50,000,000 USDC + SOL`);
    console.log(`  ✅ SCALPER (User ${TRADERS.SCALPER}): 50,000,000 USDC + SOL`);
    console.log('  💡 Engine automatically provides balance to all users!\n');
}

function updateMarketStats() {
    priceHistory.push(currentPrice);
    if (priceHistory.length > 20) priceHistory.shift();
    
    priceMovingAverage = priceHistory.reduce((sum, p) => sum + p, 0) / priceHistory.length;
    
    if (currentPrice > priceMovingAverage + 0.3) {
        trend = 'bullish';
    } else if (currentPrice < priceMovingAverage - 0.3) {
        trend = 'bearish';
    } else {
        trend = 'neutral';
    }
    
    // Random volatility events
    if (Math.random() < VOLATILITY_EVENT_PROB) {
        volatility = 2.2 + Math.random() * 1.4;
        console.log(`  ⚡ VOLATILITY SPIKE! (${volatility.toFixed(2)}x)`);
    } else {
        volatility = Math.max(1, volatility * 0.86);
    }

    // Micro price walk — drift ±0.01-0.30 each cycle for realistic movement
    const drift = (Math.random() - 0.5) * 0.6 * volatility;
    currentPrice = Math.max(BASE_PRICE - PRICE_VOLATILITY, Math.min(BASE_PRICE + PRICE_VOLATILITY, currentPrice + drift));
}

async function main() {
    if (cycleCount === 0) {
        await ensureAllBalances();
    }

    try {
        const cycleStartedAt = Date.now();
        cycleCount++;
        
        updateMarketStats();
        
        const depthResponse = await axios.get(`${BASE_URL}/api/v1/depth?symbol=${MARKET}`);
        const depth = depthResponse.data;
        
        const bestBid = depth.bids && depth.bids.length > 0 ? parseFloat(depth.bids[0][0]) : currentPrice - 0.5;
        const bestAsk = depth.asks && depth.asks.length > 0 ? parseFloat(depth.asks[0][0]) : currentPrice + 0.5;
        const midPrice = (bestBid + bestAsk) / 2;
        const actualSpread = bestAsk - bestBid;
        
        if (midPrice > 0 && Number.isFinite(midPrice)) {
            currentPrice = midPrice;
        }
        
        // Print status every 10 cycles to reduce log noise
        if (cycleCount % 10 === 0) {
            const trendEmoji = trend === 'bullish' ? '📈' : trend === 'bearish' ? '📉' : '➡️';
            console.log(`📊 #${cycleCount} | SOL: $${currentPrice.toFixed(2)} ${trendEmoji} | Spread: ${actualSpread.toFixed(3)} | Vol: ${volatility.toFixed(1)}x`);
        }
        
        // PHASE 1: Market Maker provides deep liquidity
        await maintainLiquidity(bestBid, bestAsk);
        
        // PHASE 2: Momentum Trader
        if (Math.random() < MOMENTUM_TRADE_PROB && !isShuttingDown) {
            await momentumTrade(bestBid, bestAsk);
        }
        
        // PHASE 3: Mean Reverter
        if (Math.random() < REVERTER_TRADE_PROB && !isShuttingDown) {
            await meanReversionTrade();
        }
        
        // PHASE 4: Scalper
        if (Math.random() < SCALP_TRADE_PROB && !isShuttingDown) {
            await scalpTrade(bestBid, bestAsk);
        }
        
        // PHASE 5: Aggressive Trader — guaranteed fills
        await aggressiveTrade(bestBid, bestAsk);

        // PHASE 6: Burst mode
        if (Math.random() < BURST_EVENT_PROB && !isShuttingDown) {
            await burstTrade(bestBid, bestAsk);
        }
        
        errorCount = 0;

        // Dynamic wait
        const jitter = 0.65 + Math.random() * 0.95;
        const delayMs = Math.max(200, Math.floor((CYCLE_INTERVAL / volatility) * jitter));
        await new Promise(resolve => setTimeout(resolve, delayMs));

        if (!isShuttingDown) {
            main();
        }
    } catch (error) {
        errorCount++;
        console.error(`❌ Error (${errorCount}/${MAX_ERRORS}):`, getErrorMessage(error));

        if (errorCount >= MAX_ERRORS) {
            console.error('🛑 Too many errors, shutting down');
            process.exit(1);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (!isShuttingDown) {
            main();
        }
    }
}

async function maintainLiquidity(bestBid: number, bestAsk: number) {
    try {
        const mmOrdersResponse = await axios.get(
            `${BASE_URL}/api/v1/order/open?userId=${TRADERS.MARKET_MAKER}&market=${MARKET}`,
            { headers: internalHeaders(TRADERS.MARKET_MAKER) }
        );
        const mmOrders: Order[] = mmOrdersResponse.data;
        
        const mmBids = mmOrders.filter(o => o.side === "buy").length;
        const mmAsks = mmOrders.filter(o => o.side === "sell").length;
        
        // Cancel stale orders far from price
        for (const order of mmOrders) {
            if ((order.side === "buy" && order.price < bestBid - 3) ||
                (order.side === "sell" && order.price > bestAsk + 3)) {
                try {
                    await axios.delete(`${BASE_URL}/api/v1/order`, {
                        data: { orderId: order.orderId, market: MARKET },
                        headers: internalHeaders(TRADERS.MARKET_MAKER),
                    });
                } catch (e) {}
            }
        }
        
        // Add liquidity levels
        const bidsNeeded = Math.min(LIQUIDITY_ORDERS - mmBids, 5);
        const asksNeeded = Math.min(LIQUIDITY_ORDERS - mmAsks, 5);
        
        for (let i = 0; i < bidsNeeded; i++) {
            const price = (currentPrice - 0.10 - (i + 1) * 0.08 - Math.random() * 0.05).toFixed(2);
            const qty = (1 + Math.random() * 15).toFixed(2);
            await placeOrder(TRADERS.MARKET_MAKER, "buy", price, qty, "📗");
        }
        
        for (let i = 0; i < asksNeeded; i++) {
            const price = (currentPrice + 0.10 + (i + 1) * 0.08 + Math.random() * 0.05).toFixed(2);
            const qty = (1 + Math.random() * 15).toFixed(2);
            await placeOrder(TRADERS.MARKET_MAKER, "sell", price, qty, "📕");
        }
    } catch (error) {
        console.error('  ⚠️  MM error:', getErrorMessage(error));
    }
}

async function momentumTrade(bestBid: number, bestAsk: number) {
    try {
        if (trend === 'bullish') {
            const qty = (0.5 + Math.random() * 5).toFixed(2);
            const price = (bestBid - 0.05).toFixed(2);
            await placeOrder(TRADERS.MOMENTUM_TRADER, "buy", price, qty, "🚀 MOM BUY");
        } else if (trend === 'bearish') {
            const qty = (0.5 + Math.random() * 5).toFixed(2);
            const price = (bestAsk + 0.05).toFixed(2);
            await placeOrder(TRADERS.MOMENTUM_TRADER, "sell", price, qty, "📉 MOM SELL");
        }
    } catch (error) {}
}

async function meanReversionTrade() {
    try {
        const deviation = currentPrice - priceMovingAverage;
        if (deviation > 0.5) {
            const qty = (1 + Math.random() * 8).toFixed(2);
            const price = (currentPrice - 0.03).toFixed(2);
            await placeOrder(TRADERS.MEAN_REVERTER, "sell", price, qty, "🔄 REV SELL");
        } else if (deviation < -0.5) {
            const qty = (1 + Math.random() * 8).toFixed(2);
            const price = (currentPrice + 0.03).toFixed(2);
            await placeOrder(TRADERS.MEAN_REVERTER, "buy", price, qty, "🔄 REV BUY");
        }
    } catch (error) {}
}

async function scalpTrade(bestBid: number, bestAsk: number) {
    try {
        const spread = bestAsk - bestBid;
        if (spread > MIN_SPREAD * 2) {
            const isBuy = Math.random() > 0.5;
            const qty = (0.2 + Math.random() * 2).toFixed(2);
            if (isBuy) {
                const price = (bestBid - 0.02).toFixed(2);
                await placeOrder(TRADERS.SCALPER, "buy", price, qty, "⚡ SCALP");
            } else {
                const price = (bestAsk + 0.02).toFixed(2);
                await placeOrder(TRADERS.SCALPER, "sell", price, qty, "⚡ SCALP");
            }
        }
    } catch (error) {}
}

async function aggressiveTrade(bestBid: number, bestAsk: number) {
    try {
        if (Math.random() < AGGRESSIVE_TRADE_PROB) {
            const isBuy = Math.random() > 0.5;
            const qty = (0.5 + Math.random() * 4).toFixed(2);
            if (isBuy) {
                const price = (bestAsk + (1 + Math.random() * 3)).toFixed(2);
                await placeOrder(TRADERS.MOMENTUM_TRADER, "buy", price, qty, "🔥 AGG BUY");
            } else {
                const price = (bestBid - (1 + Math.random() * 3)).toFixed(2);
                await placeOrder(TRADERS.MOMENTUM_TRADER, "sell", price, qty, "🔥 AGG SELL");
            }
        }
    } catch (error) {}
}

async function burstTrade(bestBid: number, bestAsk: number) {
    try {
        const steps = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < steps; i++) {
            const isBuy = Math.random() > 0.5;
            const qty = (0.5 + Math.random() * 6).toFixed(2);
            if (isBuy) {
                const price = (bestAsk + (0.5 + Math.random() * 2)).toFixed(2);
                await placeOrder(TRADERS.SCALPER, "buy", price, qty, "💥 BURST");
            } else {
                const price = (bestBid - (0.5 + Math.random() * 2)).toFixed(2);
                await placeOrder(TRADERS.SCALPER, "sell", price, qty, "💥 BURST");
            }
        }
    } catch (error) {}
}

async function placeOrder(
    userId: string, 
    side: "buy" | "sell", 
    price: string, 
    quantity: string,
    label: string
): Promise<boolean> {
    try {
        await axios.post(`${BASE_URL}/api/v1/order`, {
            market: MARKET,
            price: price,
            quantity: quantity,
            side: side,
            userId: userId
        }, {
            headers: internalHeaders(userId),
        });
        return true;
    } catch (error) {
        return false;
    }
}

function getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        return axiosError.response?.data 
            ? JSON.stringify(axiosError.response.data)
            : axiosError.message;
    }
    return error instanceof Error ? error.message : String(error);
}

// Start
console.log('╔═══════════════════════════════════════════════════╗');
console.log('║   🏦 SOL/USDC HIGH-FREQUENCY MARKET MAKER 🏦    ║');
console.log('╚═══════════════════════════════════════════════════╝\n');
console.log(`📍 Market: ${MARKET} | Base: $${BASE_PRICE} | ±$${PRICE_VOLATILITY}`);
console.log(`⏱️  Cycle: ${CYCLE_INTERVAL}ms | Liquidity: ${LIQUIDITY_ORDERS} levels/side`);
console.log('═'.repeat(55) + '\n');

main().catch(error => {
    console.error('💥 Fatal:', error);
    process.exit(1);
});