# Module 10 — Algorithmic Market Maker & High-Frequency Liquidity Simulation

> **Solving the Cold-Start Problem: Simulating Real-World Order Book Microstructure**  
> *"An exchange with no liquidity is a ghost town. If a user visits the exchange and sees an empty order book, they cannot trade. Professional exchanges employ algorithmic market makers to quote bids and asks continuously. This module dissects `mm/src/index.ts` line-by-line, detailing how 4 distinct trading archetypes simulate realistic market depth, volatility, and order flow."*

---

## 1. The Financial Problem: Cold-Start & The Bid-Ask Spread

In any two-sided financial exchange, you face the **chicken-and-egg problem**:
- Traders won't trade unless there is deep liquidity and tight spreads.
- Liquidity providers won't provide liquidity unless there are active traders.

### What is Market Making?
A Market Maker (MM) simultaneously posts **passive limit buy orders (bids)** below the current market price and **passive limit sell orders (asks)** above the current market price.
- If a buyer arrives with an aggressive market buy order, they fill against the MM's resting ask.
- If a seller arrives with an aggressive market sell order, they fill against the MM's resting bid.
- The MM profits from the **bid-ask spread** ($P_{\text{ask}} - P_{\text{bid}}$) while providing the public service of immediate price discovery and trade execution.

---

## 2. The 4 Virtual Trader Archetypes: `mm/src/index.ts` (Lines 8–16)

Instead of a single bot placing random orders, `mm/` simulates **4 distinct financial market participants**, each configured with a fixed UUID seeded in PostgreSQL and the Matching Engine:

```typescript
const TRADERS = {
    MARKET_MAKER:    "00000000-0000-0000-0000-000000000005",
    MOMENTUM_TRADER: "00000000-0000-0000-0000-000000000006",
    MEAN_REVERTER:   "00000000-0000-0000-0000-000000000007",
    SCALPER:         "00000000-0000-0000-0000-000000000008",
};
```

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THE 4 TRADING ARCHETYPES                        │
├─────────────────┬──────────────────────────────────────────────────────┤
│ 1. Market Maker │ Deep 20-level order book laddering.                  │
│                 │ Quotes tight spreads. Cancels drifted resting orders.│
├─────────────────┼──────────────────────────────────────────────────────┤
│ 2. Momentum     │ Trend follower. Calculates 20-period Moving Average. │
│    Trader       │ Buys when trending UP; Sells when trending DOWN.     │
├─────────────────┼──────────────────────────────────────────────────────┤
│ 3. Mean         │ Counter-trend arbitrageur. Sells when price stretches│
│    Reverter     │ too high; Buys when price crashes below average.     │
├─────────────────┼──────────────────────────────────────────────────────┤
│ 4. Scalper      │ High-frequency opportunist. Injects micro-orders     │
│                 │ whenever the spread widens beyond $0.10.             │
└─────────────────┴──────────────────────────────────────────────────────┘
```

---

## 3. Order Book Laddering Geometry: `maintainLiquidity` (Lines 187–236)

How does the Market Maker create an institutional-looking depth chart?

```typescript
async function maintainLiquidity(bestBid: number, bestAsk: number) {
    const mmOrdersResponse = await axios.get(
        `${BASE_URL}/api/v1/order/open?userId=${TRADERS.MARKET_MAKER}&market=${MARKET}`,
        { headers: internalHeaders(TRADERS.MARKET_MAKER) }
    );
    const mmOrders: Order[] = mmOrdersResponse.data;
    
    // Proportional spacing so book depth scales with price
    const innerOffset = currentPrice * INNER_OFFSET_PCT; // ~0.04% ($0.06 @ $150)
    const levelStep   = currentPrice * LEVEL_STEP_PCT;   // ~0.09% ($0.135 @ $150)
    const maxDistance = levelStep * LIQUIDITY_ORDERS + innerOffset;

    // STEP 1: Prune / Cancel stale orders that drifted too far from the market
    for (const order of mmOrders) {
        if ((order.side === "buy"  && order.price < bestBid - maxDistance) ||
            (order.side === "sell" && order.price > bestAsk + maxDistance)) {
            await axios.delete(`${BASE_URL}/api/v1/order`, {
                data: { orderId: order.orderId, market: MARKET },
                headers: internalHeaders(TRADERS.MARKET_MAKER),
            });
        }
    }

    // STEP 2: Place new ladder levels
    const bidsNeeded = Math.min(LIQUIDITY_ORDERS - mmBids, 8);
    const asksNeeded = Math.min(LIQUIDITY_ORDERS - mmAsks, 8);

    // Quantity increases with distance from mid-price (realistic depth shape)
    const levelQty = (i: number) => (10 + i * 4 + Math.random() * 25).toFixed(2);

    for (let i = 0; i < bidsNeeded; i++) {
        const price = (currentPrice - innerOffset - (i + 1) * levelStep - Math.random() * levelStep * 0.3).toFixed(2);
        await placeOrder(TRADERS.MARKET_MAKER, "buy", price, levelQty(i), "📗");
    }

    for (let i = 0; i < asksNeeded; i++) {
        const price = (currentPrice + innerOffset + (i + 1) * levelStep + Math.random() * levelStep * 0.3).toFixed(2);
        await placeOrder(TRADERS.MARKET_MAKER, "sell", price, levelQty(i), "📕");
    }
}
```

### The Mathematics of Real Market Depth:
1. **Geometric Spacing**:
   Fixed-dollar spacing ($0.10 steps) breaks if Bitcoin is at $60,000 or Dogecoin is at $0.10. Spacing based on percentages (`INNER_OFFSET_PCT = 0.0004`, `LEVEL_STEP_PCT = 0.0009`) guarantees realistic depth regardless of asset price.
2. **Volumetric Wedge**:
   Notice: `levelQty(i) = 10 + i * 4 + random`.
   - Level 0 (near the spread): 10–35 SOL.
   - Level 10 (far from spread): 50–75 SOL.
   - Level 20 (deep in book): 90–115 SOL.
   - In real financial markets, the further you move from the current market price, the thicker the available liquidity. This creates the classic **Depth Chart Wedge** in the UI!
3. **Stale Order Pruning**:
   If the market drifts from $150 to $165, resting bids placed at $145 are now too far away. The bot identifies orders exceeding `maxDistance` and calls `DELETE /api/v1/order` to cancel them, freeing up capital to post new orders near the current price.

---

## 4. Momentum & Mean Reversion Dynamics

### 4.1 Trend Following: `momentumTrade` (Lines 238–250)

```typescript
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
}
```
- Tracks a rolling 20-cycle Moving Average (`priceMovingAverage`).
- If `trend === 'bullish'`, the Momentum Trader submits aggressive buys (`bestBid - 0.05`), reinforcing the upward momentum.

---

### 4.2 Counter-Trend Arbitrage: `meanReversionTrade` (Lines 252–265)

```typescript
async function meanReversionTrade() {
    const deviation = currentPrice - priceMovingAverage;
    if (deviation > 0.5) {
        // Price has stretched too far above average — sell to pull it down!
        const qty = (5 + Math.random() * 25).toFixed(2);
        const price = (currentPrice - 0.03).toFixed(2);
        await placeOrder(TRADERS.MEAN_REVERTER, "sell", price, qty, "🔄 REV SELL");
    } else if (deviation < -0.5) {
        // Price has crashed too far below average — buy to pull it up!
        const qty = (5 + Math.random() * 25).toFixed(2);
        const price = (currentPrice + 0.03).toFixed(2);
        await placeOrder(TRADERS.MEAN_REVERTER, "buy", price, qty, "🔄 REV BUY");
    }
}
```
- Real markets exhibit mean reversion: prices rarely move in a straight line forever.
- When deviation exceeds $\$0.50$, the Mean Reverter trades counter-trend, creating organic oscillation in candlestick charts.

---

## 5. Aggressive Takers & Burst Events (Lines 284–315)

In an exchange, trades only happen when orders **cross the spread**. If bots only placed passive limit orders, the spread would sit static, and zero trades would print!

### Guaranteed Fill Engine: `aggressiveTrade` & `burstTrade`:
```typescript
async function aggressiveTrade(bestBid: number, bestAsk: number) {
    if (Math.random() < AGGRESSIVE_TRADE_PROB) { // 70% probability
        const isBuy = Math.random() > 0.5;
        const qty = (3 + Math.random() * 15).toFixed(2);
        if (isBuy) {
            // Price is strictly HIGHER than bestAsk -> Guaranteed immediate fill!
            const price = (bestAsk + (1 + Math.random() * 3)).toFixed(2);
            await placeOrder(TRADERS.MOMENTUM_TRADER, "buy", price, qty, "🔥 AGG BUY");
        } else {
            // Price is strictly LOWER than bestBid -> Guaranteed immediate fill!
            const price = (bestBid - (1 + Math.random() * 3)).toFixed(2);
            await placeOrder(TRADERS.MOMENTUM_TRADER, "sell", price, qty, "🔥 AGG SELL");
        }
    }
}
```

- When `isBuy` is true, the order price is set to `bestAsk + $1.00`.
- This order **crosses the spread**, consumes the resting liquidity from the Market Maker's book, prints a fill, triggers real-time WebSocket trade broadcasts, and updates the candlestick charts!

---

## 6. Authentication Bypass for Internal Services (Lines 48–53)

How do these 4 virtual traders place orders without going through the public user registration and login endpoints?

```typescript
function internalHeaders(userId: string) {
    return {
        "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
        "X-Internal-User-Id": userId,
    };
}
```

1. The Market Maker runs in the same private Docker network as the API.
2. It attaches the shared secret `X-Internal-Service-Token`.
3. The API's `authenticate.ts` verifies this token and grants role permissions, setting `req.auth.userId = header("x-internal-user-id")`.
4. This allows the bot to trade on behalf of all 4 virtual trader accounts with zero login overhead.
