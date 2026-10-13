# Module 02 — The Order Book & Matching Engine Algorithms

> **The Heart of Price Discovery**  
> *"An order book is a living financial auction. It balances the greed of sellers with the fear of buyers, matching them with microsecond precision under the strict law of Price-Time Priority. This module conducts a comprehensive, line-by-line inspection of `engine/src/trade/Orderbook.ts`, exploring every loop, condition, edge-case, and architectural decision."*

---

## 1. What is an Order Book? Core Concepts & Mental Model

An Order Book is a dual-sided queue of resting limit orders for a specific trading pair (e.g. `SOL_USDC`):
- **Bids (Buy Orders)**: Traders offering to buy SOL for USDC. Buyers want to pay as **little** as possible. The best bid is the **highest** price someone is willing to pay.
- **Asks (Sell Orders)**: Traders offering to sell SOL for USDC. Sellers want to receive as **much** as possible. The best ask is the **lowest** price someone is willing to accept.
- **The Spread**: The gap between the best ask and the best bid:
  $$\text{Spread} = \text{Best Ask} - \text{Best Bid}$$
  In a healthy market, the Best Ask is strictly greater than the Best Bid ($\text{Spread} > 0$).
  When an incoming order crosses the spread ($\text{Bid Price} \ge \text{Ask Price}$), a **trade (fill)** occurs immediately!

```
                    ASKS (Sellers) — Sorted Ascending
                    ┌───────────────────────────────┐
                    │  $150.30  │  10.0 SOL         │
                    │  $150.20  │   5.5 SOL         │
                    │  $150.10  │   2.0 SOL         │ <── Best Ask ($150.10)
                    └───────────────────────────────┘
  SPREAD = $0.20 ──> ═══════════════════════════════
                    ┌───────────────────────────────┐
                    │  $149.90  │   4.0 SOL         │ <── Best Bid ($149.90)
                    │  $149.80  │   8.0 SOL         │
                    │  $149.70  │  15.0 SOL         │
                    └───────────────────────────────┘
                    BIDS (Buyers)  — Sorted Descending
```

### The Universal Rule: Price-Time Priority (FIFO)
Every professional financial exchange matches orders using **Price-Time Priority**:
1. **Price Priority**:
   - For buyers: Higher bids execute before lower bids.
   - For sellers: Lower asks execute before higher asks.
2. **Time Priority (Tie-Breaker)**:
   - If two traders submit orders at the exact same price, the order that was placed **earlier** in time executes first.
   - You cannot jump the queue without paying a more aggressive price.

---

## 2. Data Structures: `Order` and `Fill` Interfaces (Lines 4–23)

```typescript
export interface Order {
    price: number;       // Scaled integer price (e.g. 150000000)
    quantity: number;    // Scaled integer total size (e.g. 2000000 = 2 SOL)
    orderId: string;     // Unique UUID
    filled: number;      // Scaled integer executed quantity so far
    side: "buy" | "sell";
    userId: string;      // User UUID
    timestamp: number;   // Epoch millisecond timestamp for FIFO priority
}

export interface Fill {
    price: number;           // Execution price (maker's resting price)
    qty: number;             // Matched quantity
    tradeId: number;         // Incrementing trade sequence ID
    otherUserId: string;     // Counterparty user ID
    markerOrderId: string;   // Counterparty resting order ID
    makerPrice: number;      // Original price of the resting maker
    makerQuantity: number;   // Original total quantity of resting maker
    makerSide: "buy" | "sell";
}
```

### Key Design Decisions:
- **`filled` on the Order**: Rather than modifying `quantity`, we track cumulative fills (`order.filled`).
  $$\text{Remaining Quantity} = \text{order.quantity} - \text{order.filled}$$
  This maintains the historical audit trail of the original order size without needing a separate lookup.
- **The `maker*` attributes in `Fill`**: When a trade matches, the settlement system needs to know which party was the **Maker** (the passive trader whose order was resting on the book) and who was the **Taker** (the aggressive trader who crossed the spread). This is essential for:
  - Charging different Maker vs Taker fee tiers.
  - Correctly updating order records in PostgreSQL.

---

## 3. Orderbook State & Constructor (Lines 25–70)

```typescript
export class Orderbook {
    private static readonly EPSILON = 0;
    bids: Order[];
    asks: Order[];
    baseAsset: string;
    quoteAsset: string = BASE_CURRENCY;
    lastTradeId: number;
    currentPrice: number;
    lastPrice: number;
    firstPrice: number;
    high: number;
    low: number;
    volume: number;
    quoteVolume: number;
    trades: number;
    private depthBids: Record<string, number> = Object.create(null);
    private depthAsks: Record<string, number> = Object.create(null);
```

### What is `Object.create(null)`?
Notice lines 40–41:
```typescript
private depthBids: Record<string, number> = Object.create(null);
```
Why not `{}`?
- Standard JavaScript objects inherit from `Object.prototype`, which includes properties like `toString`, `valueOf`, `constructor`, `hasOwnProperty`.
- If an order price happened to match `"toString"`, checking `depthBids["toString"]` would return a function instead of a number!
- `Object.create(null)` creates a dictionary with **no prototype chain**, completely eliminating prototype pollution attacks and overhead.

---

## 4. The High-Speed Depth Cache: `applyDepthDelta` (Lines 93–127)

```typescript
private applyDepthDelta(side: "bids" | "asks", price: number, delta: number) {
    if (!Number.isFinite(delta) || Math.abs(delta) < Orderbook.EPSILON) {
        return;
    }

    const key = price.toString();
    const book = side === "bids" ? this.depthBids : this.depthAsks;
    const next = (book[key] || 0) + delta;

    if (next <= Orderbook.EPSILON) {
        delete book[key];
        return;
    }

    book[key] = next;
}
```

### The Performance Problem It Solves:
Every time an order arrives or fills, the exchange must broadcast the current **Order Book Depth** to thousands of WebSocket clients.
- If you calculate depth by scanning and summing all 5,000 orders in `this.bids` every millisecond, your time complexity is $O(N)$ on every trade.
- Instead, our engine maintains an **incremental hash-map cache** (`depthBids` and `depthAsks`).
- When 1.5 SOL fills at $150:
  `applyDepthDelta("asks", 150000000, -1500000)`
- The dictionary is updated in **$O(1)$ constant time**.
- If `next <= 0`, `delete book[key]` deletes the price level entirely, so empty levels are automatically cleaned up.

---

## 5. Order Ingestion: `addOrder` (Lines 129–180)

When a new order enters the book, `addOrder` orchestrates its execution:

```typescript
addOrder(order: Order): { executedQty: number, fills: Fill[] } {
    if (order.side === "buy") {
        // Step 1: Match against resting asks
        const { executedQty, fills } = this.matchBid(order); 
        order.filled = executedQty;
        const remaining = order.quantity - executedQty;

        // Step 2: If fully filled, return immediately
        if (remaining <= Orderbook.EPSILON) {
            return { executedQty, fills };
        }

        // Step 3: If partially filled or unfilled, rest on the book
        this.bids.push(order);

        // Step 4: Sort bids: Higher price first, earlier timestamp first (FIFO)
        this.bids.sort((a, b) => {
            if (b.price !== a.price) {
                return b.price - a.price;  // Higher price first
            }
            return a.timestamp - b.timestamp;  // Earlier time first
        });

        // Step 5: Update the depth cache with the remaining quantity
        this.applyDepthDelta("bids", order.price, remaining);

        return { executedQty, fills };
    } else {
        // Symmetric logic for sells matching against bids...
    }
}
```

### The 5-Step Order Journey:
1. **Taker Execution First**: An order always tries to match immediately against opposite resting orders.
2. **Short-Circuit on Immediate Fill**: If `remaining <= 0`, the order is completely satisfied. It never touches `this.bids` or `this.asks`. This saves CPU cycles and avoids array insertion overhead.
3. **Queue Insertion**: If quantity remains, the order becomes a **Maker** (resting liquidity).
4. **FIFO Priority Sorting**:
   - `b.price - a.price`: Higher prices sort to the front (index 0).
   - `a.timestamp - b.timestamp`: If prices match, smaller timestamp (earlier in time) sits first.
5. **Depth Notification**: The resting remainder is added to `depthBids`.

---

## 6. The Core Matching Algorithm: `matchBid` (Lines 182–223)

Let us examine the exact matching loop for buy orders line-by-line:

```typescript
matchBid(order: Order): { fills: Fill[], executedQty: number } {
    const fills: Fill[] = [];
    let executedQty = 0;

    for (let i = 0; i < this.asks.length; i++) {
        // Condition 1: Asks are sorted ascending — early break optimization
        if (this.asks[i].price > order.price) break;

        // Condition 2: Self-trade prevention (STP)
        if (this.asks[i].userId === order.userId) {
            continue;
        }

        if (executedQty < order.quantity) {
            const remaining = this.asks[i].quantity - this.asks[i].filled;
            const filledQty = Math.min((order.quantity - executedQty), remaining);
            
            executedQty += filledQty;
            this.asks[i].filled += filledQty;
            this.applyDepthDelta("asks", this.asks[i].price, -filledQty);
            
            fills.push({
                price: this.asks[i].price, // Executes at MAKER's price!
                qty: filledQty,
                tradeId: this.lastTradeId++,
                otherUserId: this.asks[i].userId,
                markerOrderId: this.asks[i].orderId,
                makerPrice: this.asks[i].price,
                makerQuantity: this.asks[i].quantity,
                makerSide: "sell",
            });
        }
    }

    // Garbage Collection: Purge fully filled asks from the book
    for (let i = 0; i < this.asks.length; i++) {
        if (this.asks[i].filled >= this.asks[i].quantity - Orderbook.EPSILON) {
            this.asks.splice(i, 1);
            i--;
        }
    }

    return { fills, executedQty };
}
```

### Deep Dive into Every Line:

#### 1. The Early Break Optimization (Line 188)
```typescript
if (this.asks[i].price > order.price) break;
```
Because `this.asks` is kept sorted in ascending order ($150.00, 150.10, 150.20\dots$):
- If the buyer's limit price is $\$150.05$, once the loop reaches $\$150.10$, it knows with 100% mathematical certainty that no subsequent ask in the array can match.
- The `break` statement exits immediately. If there are 10,000 resting asks, the engine does not inspect the other 9,998 orders!

#### 2. Self-Trade Prevention (STP) (Lines 190–193)
```typescript
if (this.asks[i].userId === order.userId) {
    continue;
}
```
**Why is Self-Trading Forbidden?**
- In traditional finance and regulated crypto, **wash trading** (trading with yourself to create artificial volume or manipulate the tape) is strictly illegal.
- In our engine, if Alice has a resting sell order at $150 and Alice submits a buy order at $150:
  - If they matched, Alice would pay trading fees to herself, waste engine throughput, and skew the candlestick charts.
  - With `continue`, the engine skips Alice's own resting ask and matches against the next seller in line!

#### 3. Execution at the Maker's Price (Line 202)
```typescript
price: this.asks[i].price
```
**Critical Exchange Rule**: The trade price is **ALWAYS the price of the resting order (the Maker)**, NOT the incoming order (the Taker)!
- *Example*: Bob placed an ask at $\$150.00$.
- Alice sends an aggressive limit buy at $\$152.00$ ("buy up to \$152").
- The trade executes at **$\$150.00$**!
- Alice gets a $\$2.00$ **price improvement**. She wanted to pay up to $\$152$, but the engine filled her at Bob's $\$150$.

#### 4. Array Compaction / Splice Loop (Lines 213–218)
```typescript
for (let i = 0; i < this.asks.length; i++) {
    if (this.asks[i].filled >= this.asks[i].quantity - Orderbook.EPSILON) {
        this.asks.splice(i, 1);
        i--;
    }
}
```
- Fully filled orders are removed from memory.
- `i--` compensates for the array shift caused by `splice(i, 1)`.

---

## 7. The Matching Algorithm for Sells: `matchAsk` (Lines 225–266)

The logic for `matchAsk` is the exact mirror image of `matchBid`:

```typescript
matchAsk(order: Order): { fills: Fill[], executedQty: number } {
    const fills: Fill[] = [];
    let executedQty = 0;

    for (let i = 0; i < this.bids.length; i++) {
        // Bids are sorted descending — break once bid price is lower than ask price
        if (this.bids[i].price < order.price) break;

        // Self-trade prevention
        if (this.bids[i].userId === order.userId) {
            continue;
        }

        if (executedQty < order.quantity) {
            const remaining = this.bids[i].quantity - this.bids[i].filled;
            const amountRemaining = Math.min(order.quantity - executedQty, remaining);
            executedQty += amountRemaining;
            this.bids[i].filled += amountRemaining;
            this.applyDepthDelta("bids", this.bids[i].price, -amountRemaining);
            
            fills.push({
                price: this.bids[i].price, // Executes at Maker's bid price!
                qty: amountRemaining,
                tradeId: this.lastTradeId++,
                otherUserId: this.bids[i].userId,
                markerOrderId: this.bids[i].orderId,
                makerPrice: this.bids[i].price,
                makerQuantity: this.bids[i].quantity,
                makerSide: "buy",
            });
        }
    }

    for (let i = 0; i < this.bids.length; i++) {
        if (this.bids[i].filled >= this.bids[i].quantity - Orderbook.EPSILON) {
            this.bids.splice(i, 1);
            i--;
        }
    }

    return { fills, executedQty };
}
```

Notice:
- Bids are sorted descending ($149.90, 149.80, 149.70\dots$).
- `if (this.bids[i].price < order.price) break;`: If the incoming ask is at $\$150.00$, and the best resting bid is $\$149.90$, it breaks immediately on index 0! No match.

---

## 8. Order Cancellation: `cancelBid` & `cancelAsk` (Lines 302–326)

```typescript
cancelBid(order: Order) {
    const index = this.bids.findIndex(x => x.orderId === order.orderId);
    if (index !== -1) {
        const price = this.bids[index].price;
        const remaining = this.bids[index].quantity - this.bids[index].filled;
        if (remaining > Orderbook.EPSILON) {
            this.applyDepthDelta("bids", price, -remaining);
        }
        this.bids.splice(index, 1);
        return price;
    }
}
```

### Cancellation Invariants:
1. **Remaining Calculation**: Only the unexecuted portion (`quantity - filled`) is removed from the depth table. If an order was originally 10 SOL and 6 SOL already filled, only 4 SOL is deducted from `depthBids`.
2. **Returns Price**: Returns `price` to caller (`Engine.ts`) so the engine knows which specific price level changed and can push an incremental depth delta over WebSocket.

---

## 9. Comprehensive Execution Walkthrough Example

Let us step through a complete scenario in slow motion:

### Initial State: Empty Book

#### Step 1: Alice places Limit Sell 5 SOL @ $150
- `addOrder`: `side === "sell"`.
- `matchAsk`: `bids` is empty $\rightarrow$ loop doesn't run. `executedQty = 0`.
- `order.filled = 0`, `remaining = 5 SOL`.
- Order pushed to `asks`.
- `depthAsks["150000000"] = 5000000`.
- Book state:
  - Asks: `[ { user: Alice, price: 150, qty: 5, filled: 0 } ]`
  - Bids: `[]`

#### Step 2: Bob places Limit Sell 10 SOL @ $151
- `addOrder`: `side === "sell"`.
- `matchAsk`: `bids` is empty $\rightarrow$ 0 fills.
- Order pushed to `asks`.
- Sorted: $150 sits at index 0, $151 sits at index 1.
- Book state:
  - Asks: `[ Alice (5 @ $150), Bob (10 @ $151) ]`

#### Step 3: Charlie places Limit Buy 8 SOL @ $151
- `addOrder`: `side === "buy"`.
- `matchBid` begins:
  - **Iteration 0 (Alice's order)**:
    - Alice's ask: $\$150 \le \$151$ (matches!).
    - Alice remaining: 5 SOL. Charlie wants: 8 SOL.
    - `filledQty = min(8, 5) = 5 SOL`.
    - Alice filled becomes: $0 + 5 = 5$ (fully filled!).
    - `executedQty = 5 SOL`.
    - Fill 1 generated: **5 SOL @ $150** (Alice's price).
  - **Iteration 1 (Bob's order)**:
    - Bob's ask: $\$151 \le \$151$ (matches!).
    - Bob remaining: 10 SOL. Charlie still needs: $8 - 5 = 3\text{ SOL}$.
    - `filledQty = min(3, 10) = 3 SOL`.
    - Bob filled becomes: $0 + 3 = 3\text{ SOL}$ (7 SOL remaining).
    - `executedQty = 5 + 3 = 8 SOL`.
    - Fill 2 generated: **3 SOL @ $151** (Bob's price).
- Splice loop runs:
  - Alice's order is fully filled ($5 \ge 5$) $\rightarrow$ spliced out of `asks`!
  - Bob's order has 7 SOL left $\rightarrow$ remains at index 0 of `asks`.
- Charlie's order:
  - `remaining = 8 - 8 = 0`.
  - Charlie's order does NOT rest on the book.
- Final Book State:
  - Asks: `[ Bob (7 SOL remaining @ $151) ]`
  - Bids: `[]`
  - Total executed trades: 2 trades (5 SOL @ $150, 3 SOL @ $151).

---

## 10. Complexity Analysis & High-Throughput Scaling Tradeoffs

| Operation | Current Implementation | Complexity | Production C++/Rust Standard |
|---|---|---|---|
| **Best Bid / Best Ask Lookup** | `this.bids[0]`, `this.asks[0]` | $O(1)$ | $O(1)$ |
| **Match Order** | Array scan + splice | $O(M + K)$ ($M$ fills, $K$ spliced) | $O(M)$ via Linked List |
| **Insert Resting Order** | `push()` + `sort()` | $O(N \log N)$ | $O(\log P)$ via B-Tree / Red-Black Tree |
| **Cancel Order** | `findIndex()` + `splice()` | $O(N)$ | $O(1)$ via Hash Map index |

### Engineering Retrospective:
For a Node.js microservice handling up to thousands of orders per second, keeping sorted arrays with $N \le 2000$ active orders per market is fast because modern JavaScript V8 engines perform vectorized sequential memory scans extremely well. In Module 13, we will analyze how to upgrade this to a B-Tree + doubly linked list for 100,000+ orders/sec.
