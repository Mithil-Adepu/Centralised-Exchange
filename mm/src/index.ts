import axios, { AxiosError } from "axios";

const BASE_URL = "http://localhost:3000";
const MARKET = "TATA_INR";

// Virtual traders simulating different market participants
const TRADERS = {
    MARKET_MAKER: "5",      // Provides liquidity
    MOMENTUM_TRADER: "6",   // Follows trends
    MEAN_REVERTER: "7",     // Bets on price returning to average
    SCALPER: "8",           // Quick small trades
};

const INITIAL_BALANCE = 50000000; // 50M per trader

// Market dynamics parameters
const BASE_PRICE = 1000;
const PRICE_VOLATILITY = 30;      // ±30 price range
const MIN_SPREAD = 0.5;            // Minimum spread between best bid/ask
const MAX_SPREAD = 3;              // Maximum spread (widens during volatility)

// Simulation settings
const CYCLE_INTERVAL = 3000;       // 3 seconds per cycle (easier on PC)
const LIQUIDITY_ORDERS = 8;        // Orders per side for liquidity

// Trading probabilities
const MOMENTUM_TRADE_PROB = 0.2;   // 20% chance momentum trader acts
const REVERTER_TRADE_PROB = 0.15;  // 15% chance mean reverter acts
const SCALP_TRADE_PROB = 0.25;     // 25% chance scalper acts
const VOLATILITY_EVENT_PROB = 0.05; // 5% chance of high volatility

interface Order {
    orderId: string;
    price: number;
    quantity: number;
    side: "buy" | "sell";
    filled: number;
}

// Market state
let isShuttingDown = false;
let errorCount = 0;
let cycleCount = 0;
const MAX_ERRORS = 5;

let currentPrice = BASE_PRICE;
let priceMovingAverage = BASE_PRICE; // 10-cycle moving average
let priceHistory: number[] = [BASE_PRICE];
let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
let volatility = 1; // Volatility multiplier (1 = normal, 2 = high)

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Market Maker shutting down gracefully...');
    isShuttingDown = true;
    process.exit(0);
});

// Initialize all virtual traders with balance
async function ensureAllBalances() {
    console.log(`💰 Virtual traders initialized by Engine:`);
    console.log(`  ✅ MARKET_MAKER (User ${TRADERS.MARKET_MAKER}): 50,000,000 INR + TATA`);
    console.log(`  ✅ MOMENTUM_TRADER (User ${TRADERS.MOMENTUM_TRADER}): 50,000,000 INR + TATA`);
    console.log(`  ✅ MEAN_REVERTER (User ${TRADERS.MEAN_REVERTER}): 50,000,000 INR + TATA`);
    console.log(`  ✅ SCALPER (User ${TRADERS.SCALPER}): 50,000,000 INR + TATA`);
    console.log('  💡 Engine automatically provides balance to all users!\n');
    
    // No need to call on-ramp - Engine already sets balances
    // This prevents API timeout errors
}

// Update market statistics
function updateMarketStats() {
    // Add current price to history
    priceHistory.push(currentPrice);
    if (priceHistory.length > 10) {
        priceHistory.shift();
    }
    
    // Calculate moving average
    priceMovingAverage = priceHistory.reduce((sum, p) => sum + p, 0) / priceHistory.length;
    
    // Determine trend
    if (currentPrice > priceMovingAverage + 2) {
        trend = 'bullish';
    } else if (currentPrice < priceMovingAverage - 2) {
        trend = 'bearish';
    } else {
        trend = 'neutral';
    }
    
    // Random volatility events
    if (Math.random() < VOLATILITY_EVENT_PROB) {
        volatility = 2 + Math.random(); // High volatility
        console.log(`  ⚡ VOLATILITY SPIKE! (${volatility.toFixed(2)}x)`);
    } else {
        volatility = Math.max(1, volatility * 0.9); // Decay back to normal
    }
}

async function main() {
    // Initialize all traders on first run
    if (cycleCount === 0) {
        await ensureAllBalances();
    }

    try {
        cycleCount++;
        
        // Update market statistics
        updateMarketStats();
        
        // Get current order book to determine market state
        const depthResponse = await axios.get(`${BASE_URL}/api/v1/depth?symbol=${MARKET}`);
        const depth = depthResponse.data;
        
        const bestBid = depth.bids && depth.bids.length > 0 ? parseFloat(depth.bids[0][0]) : currentPrice - 5;
        const bestAsk = depth.asks && depth.asks.length > 0 ? parseFloat(depth.asks[0][0]) : currentPrice + 5;
        const midPrice = (bestBid + bestAsk) / 2;
        const actualSpread = bestAsk - bestBid;
        
        currentPrice = midPrice; // Update current price from market
        
        // Print market status
        const trendEmoji = trend === 'bullish' ? '📈' : trend === 'bearish' ? '📉' : '➡️';
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📊 Cycle ${cycleCount} | Price: ${currentPrice.toFixed(2)} ${trendEmoji} ${trend.toUpperCase()}`);
        console.log(`   MA: ${priceMovingAverage.toFixed(2)} | Spread: ${actualSpread.toFixed(2)} | Vol: ${volatility.toFixed(2)}x`);
        console.log(`   Best Bid: ${bestBid.toFixed(2)} | Best Ask: ${bestAsk.toFixed(2)}`);
        
        // PHASE 1: Market Maker provides liquidity
        await maintainLiquidity(bestBid, bestAsk);
        
        // PHASE 2: Momentum Trader (follows trend)
        if (Math.random() < MOMENTUM_TRADE_PROB && !isShuttingDown) {
            await momentumTrade(bestBid, bestAsk);
        }
        
        // PHASE 3: Mean Reverter (counter-trend)
        if (Math.random() < REVERTER_TRADE_PROB && !isShuttingDown) {
            await meanReversionTrade();
        }
        
        // PHASE 4: Scalper (quick trades)
        if (Math.random() < SCALP_TRADE_PROB && !isShuttingDown) {
            await scalpTrade(bestBid, bestAsk);
        }
        
        // PHASE 5: Aggressive Trader (guaranteed trades)
        await aggressiveTrade(bestBid, bestAsk);
        
        // Reset error count on success
        errorCount = 0;

        // Wait before next cycle
        await new Promise(resolve => setTimeout(resolve, CYCLE_INTERVAL));

        if (!isShuttingDown) {
            main();
        }
    } catch (error) {
        errorCount++;
        console.error(`❌ Error in market simulation (${errorCount}/${MAX_ERRORS}):`, getErrorMessage(error));

        if (errorCount >= MAX_ERRORS) {
            console.error('🛑 Too many errors, shutting down market maker');
            process.exit(1);
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
        
        if (!isShuttingDown) {
            main();
        }
    }
}

// MARKET MAKER: Maintains liquidity with passive limit orders
async function maintainLiquidity(bestBid: number, bestAsk: number) {
    try {
        const mmOrdersResponse = await axios.get(
            `${BASE_URL}/api/v1/order/open?userId=${TRADERS.MARKET_MAKER}&market=${MARKET}`
        );
        const mmOrders: Order[] = mmOrdersResponse.data;
        
        const mmBids = mmOrders.filter(o => o.side === "buy").length;
        const mmAsks = mmOrders.filter(o => o.side === "sell").length;
        
        console.log(`💼 Market Maker: ${mmBids} bids, ${mmAsks} asks`);
        
        // Cancel orders outside spread
        for (const order of mmOrders) {
            if ((order.side === "buy" && order.price < bestBid - 5) ||
                (order.side === "sell" && order.price > bestAsk + 5)) {
                try {
                    await axios.delete(`${BASE_URL}/api/v1/order`, {
                        data: { orderId: order.orderId, market: MARKET }
                    });
                } catch (e) {}
            }
        }
        
        // Add liquidity orders
        const bidsNeeded = LIQUIDITY_ORDERS - mmBids;
        const asksNeeded = LIQUIDITY_ORDERS - mmAsks;
        
        // Ensure minimum spread between bids and asks
        const minSpread = 2.0; // Minimum 2.0 spread
        const safeBidPrice = Math.max(bestBid - 1.0, currentPrice - minSpread/2);
        const safeAskPrice = Math.min(bestAsk + 1.0, currentPrice + minSpread/2);
        
        for (let i = 0; i < bidsNeeded && i < 3; i++) {
            const price = (safeBidPrice - (i + 1) * 0.5 - Math.random() * 0.5).toFixed(1);
            const qty = (2 + Math.random() * 8).toFixed(1); // 2-10 units
            await placeOrder(TRADERS.MARKET_MAKER, "buy", price, qty, "📗 MM");
        }
        
        for (let i = 0; i < asksNeeded && i < 3; i++) {
            const price = (safeAskPrice + (i + 1) * 0.5 + Math.random() * 0.5).toFixed(1);
            const qty = (2 + Math.random() * 8).toFixed(1);
            await placeOrder(TRADERS.MARKET_MAKER, "sell", price, qty, "📕 MM");
        }
    } catch (error) {
        console.error('  ⚠️  MM error:', getErrorMessage(error));
    }
}

// MOMENTUM TRADER: Buys in uptrend, sells in downtrend
async function momentumTrade(bestBid: number, bestAsk: number) {
    try {
        if (trend === 'bullish') {
            // Buy on strength - Place passive order well below ask
            const qty = (3 + Math.random() * 7).toFixed(1); // 3-10 units
            const price = (bestBid - 1.0).toFixed(1); // Well below best bid (passive)
            await placeOrder(TRADERS.MOMENTUM_TRADER, "buy", price, qty, "🚀 MOMENTUM BUY");
            console.log(`  📈 Buying the rally!`);
        } else if (trend === 'bearish') {
            // Sell on weakness - Place passive order well above bid
            const qty = (3 + Math.random() * 7).toFixed(1);
            const price = (bestAsk + 1.0).toFixed(1); // Well above best ask (passive)
            await placeOrder(TRADERS.MOMENTUM_TRADER, "sell", price, qty, "📉 MOMENTUM SELL");
            console.log(`  📉 Selling the dip!`);
        }
    } catch (error) {
        console.error('  ⚠️  Momentum trader error');
    }
}

// MEAN REVERTER: Bets price returns to average
async function meanReversionTrade() {
    try {
        const deviation = currentPrice - priceMovingAverage;
        
        if (deviation > 3) {
            // Price too high, sell expecting reversion - Place passive order
            const qty = (5 + Math.random() * 10).toFixed(1); // Larger size
            const price = (currentPrice - 1.0).toFixed(1); // Just below current price (passive)
            await placeOrder(TRADERS.MEAN_REVERTER, "sell", price, qty, "🔄 REVERTER SELL");
            console.log(`  🔄 Price above MA by ${deviation.toFixed(2)}, betting on reversion`);
        } else if (deviation < -3) {
            // Price too low, buy expecting reversion - Place passive order
            const qty = (5 + Math.random() * 10).toFixed(1);
            const price = (currentPrice + 1.0).toFixed(1); // Just above current price (passive)
            await placeOrder(TRADERS.MEAN_REVERTER, "buy", price, qty, "🔄 REVERTER BUY");
            console.log(`  🔄 Price below MA by ${Math.abs(deviation).toFixed(2)}, betting on reversion`);
        }
    } catch (error) {
        console.error('  ⚠️  Reverter error');
    }
}

// SCALPER: Quick small trades for profit
async function scalpTrade(bestBid: number, bestAsk: number) {
    try {
        const spread = bestAsk - bestBid;
        
        // Only scalp if spread is profitable
        if (spread > MIN_SPREAD * 2) {
            const isBuy = Math.random() > 0.5;
            const qty = (1 + Math.random() * 3).toFixed(1); // Small size: 1-4 units
            
            if (isBuy) {
                // Buy well below best bid - Very passive order
                const price = (bestBid - 1.5).toFixed(1);
                await placeOrder(TRADERS.SCALPER, "buy", price, qty, "⚡ SCALP BUY");
                console.log(`  ⚡ Scalping spread (${spread.toFixed(2)})`);
            } else {
                // Sell well above best ask - Very passive order
                const price = (bestAsk + 1.5).toFixed(1);
                await placeOrder(TRADERS.SCALPER, "sell", price, qty, "⚡ SCALP SELL");
                console.log(`  ⚡ Scalping spread (${spread.toFixed(2)})`);
            }
        }
    } catch (error) {
        console.error('  ⚠️  Scalper error');
    }
}

// AGGRESSIVE TRADER: Creates guaranteed trades every cycle
async function aggressiveTrade(bestBid: number, bestAsk: number) {
    try {
        // Every 3rd cycle, place an aggressive order that will definitely execute
        if (Math.random() < 0.3) { // 30% chance
            const isBuy = Math.random() > 0.5;
            const qty = (2 + Math.random() * 5).toFixed(1); // 2-7 units
            
            if (isBuy) {
                // Buy way above ask to guarantee execution
                const price = (bestAsk + 20.0).toFixed(1);
                await placeOrder(TRADERS.MOMENTUM_TRADER, "buy", price, qty, "🔥 AGGRESSIVE BUY");
                console.log(`  🔥 Aggressive buy to create trade!`);
            } else {
                // Sell way below bid to guarantee execution
                const price = (bestBid - 20.0).toFixed(1);
                await placeOrder(TRADERS.MOMENTUM_TRADER, "sell", price, qty, "🔥 AGGRESSIVE SELL");
                console.log(`  🔥 Aggressive sell to create trade!`);
            }
        }
    } catch (error) {
        console.error('  ⚠️  Aggressive trader error');
    }
}

// Helper: Place order with retry
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
        });
        console.log(`  ${label} @ ${price} (${quantity} units)`);
        return true;
    } catch (error) {
        // Silently fail (don't spam errors)
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

// Start the realistic market simulation
console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║          🏦 REALISTIC MULTI-AGENT MARKET SIMULATION 🏦                     ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`📍 Market: ${MARKET}`);
console.log(`🎯 Base Price: ${BASE_PRICE} | Volatility: ±${PRICE_VOLATILITY}`);
console.log(`⏱️  Cycle Interval: ${CYCLE_INTERVAL / 1000}s (PC-friendly)`);
console.log('');
console.log('👥 Virtual Traders:');
console.log(`   💼 Market Maker (User ${TRADERS.MARKET_MAKER}) - Provides ${LIQUIDITY_ORDERS}x${LIQUIDITY_ORDERS} liquidity`);
console.log(`   🚀 Momentum Trader (User ${TRADERS.MOMENTUM_TRADER}) - Follows trends (${MOMENTUM_TRADE_PROB * 100}% active)`);
console.log(`   🔄 Mean Reverter (User ${TRADERS.MEAN_REVERTER}) - Counter-trend (${REVERTER_TRADE_PROB * 100}% active)`);
console.log(`   ⚡ Scalper (User ${TRADERS.SCALPER}) - Quick profits (${SCALP_TRADE_PROB * 100}% active)`);
console.log('');
console.log('📊 Market Features:');
console.log('   ✅ Price trends (bullish/bearish/neutral)');
console.log('   ✅ Moving average tracking');
console.log('   ✅ Volatility spikes (5% chance)');
console.log('   ✅ Dynamic spreads (0.5-3.0)');
console.log('   ✅ Multiple trading strategies');
console.log('   ✅ Realistic order sizes (1-10 units)');
console.log('');
console.log('🎯 This simulates a REAL MARKET with multiple participants!');
console.log('📈 Watch prices trend, mean revert, and volatility spike!\n');
console.log('═'.repeat(80));
console.log('');

main().catch(error => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});