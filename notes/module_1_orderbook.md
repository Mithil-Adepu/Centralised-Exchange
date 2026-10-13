# CEX Mastery — Module 1: Precision & The Order Book

> Read this like a textbook. Every question you might have is answered here. Every design decision is explained.

---

## Why Money Needs Special Math

Before touching any exchange code, you must understand **why floating-point is forbidden in financial systems**.

Open a browser console right now and type:
```js
0.1 + 0.2   // → 0.30000000000000004
```

That's a rounding error from how CPUs represent decimal numbers in binary. For a calculator app, fine. For an exchange where `$100.50 × 3.7 SOL = $371.85` must be **exact**, this is catastrophic. A $0.0000000001 error per trade, 1 million trades per day = you're generating or losing real money from thin air.

**The solution: scaled integers.**

---

## File: `precision.ts` — The Math Foundation

```
path: engine/src/trade/precision.ts
```

### The Scale Factor

```typescript
export const SCALE = 1_000_000;  // One million
const SCALE_DIGITS = 6;
const SCALE_BIG = BigInt(SCALE); // For BigInt math
```

**SCALE = 1,000,000 means:**
- `$100.50` is stored as `100500000`  (multiply by 1M)
- `3.7 SOL` is stored as `3700000`   (multiply by 1M)
- The engine **never works with decimals**. Only whole integers.

Why 1,000,000 specifically? It gives you 6 decimal places of precision, which is standard for crypto exchanges (Bitcoin prices go to 0.000001 satoshi). If you needed more precision, you'd use a bigger SCALE.

---

### `toScaledFromDecimal(value: string): number`

**Purpose**: Convert a human-readable string like `"100.50"` → internal integer `100500000`

```typescript
export function toScaledFromDecimal(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return NaN;

  const negative = trimmed.startsWith("-");
  const normalized = negative ? trimmed.slice(1) : trimmed;
  
  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  //   ↑ "100"           ↑ "50"    ← for "100.50"
  
  const whole = wholeRaw || "0";

  // Validate: only digits allowed in each part
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fracRaw)) return NaN;

  // Pad or truncate fractional part to exactly SCALE_DIGITS chars
  const frac = (fracRaw + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  //      ↑ "50" → "500000" (padded to 6 digits)
  //      or "1234567" → "123456" (truncated to 6 digits)

  const scaled = Number(whole) * SCALE + Number(frac);
  // = 100 * 1000000 + 500000 = 100500000 ✓
  
  return negative ? -scaled : scaled;
}
```

**The clever padding trick:**
```
"50" + "000000" = "500000"  → .slice(0, 6) → "500000"   → 0.50 ✓
"5"  + "000000" = "5000000" → .slice(0, 6) → "500000"   → 0.50? NO! 
```
Wait — `"5"` means 0.5 (half a dollar), and `"5000000".slice(0,6)` = `"500000"` = 500000. 500000/1000000 = 0.5. ✓

Let's verify: `"0.5"` → fracRaw = `"5"`, `"5" + "000000"` = `"5000000"`, `.slice(0,6)` = `"500000"`, value = `0 × 1000000 + 500000` = `500000`. And `500000 / 1000000 = 0.5`. ✓

**What if you pass `"100.1234567"` (7 decimal places)?**
`"1234567".slice(0,6)` = `"123456"` — silently **truncates** to 6 decimals. This is intentional: the engine defines the precision of the exchange. Any price more precise than 6 decimals is truncated, not rounded.

---

### `fromScaledToDecimal(value: number): string`

**Purpose**: Convert internal integer `100500000` → human-readable `"100.5"`

```typescript
export function fromScaledToDecimal(value: number): string {
  const abs = Math.abs(value);
  const whole = Math.floor(abs / SCALE);     // 100500000 / 1000000 = 100
  const frac = abs % SCALE;                  // 100500000 % 1000000 = 500000

  if (frac === 0) return `${sign}${whole}`;  // No decimals needed

  const fracStr = frac
    .toString()              // "500000"
    .padStart(SCALE_DIGITS, "0")  // already 6 chars, no padding needed
    .replace(/0+$/, "");     // trim trailing zeros: "500000" → "5"

  return `${sign}${whole}.${fracStr}`;  // "100.5"
}
```

**Why trim trailing zeros?** `"100.500000"` is ugly. `"100.5"` is correct and clean. The underlying value is the same.

**What if frac = 0?** Return `"100"` not `"100."` — that would be invalid.

---

### `multiplyScaled(a: number, b: number): number`

**Purpose**: Multiply two scaled integers together correctly.

```typescript
export function multiplyScaled(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) / SCALE_BIG);
}
```

**Why this is hard:** If `qty = 3700000` (3.7 SOL) and `price = 100500000` ($100.50):
```
qty × price = 3700000 × 100500000 = 371,850,000,000,000
```
This is `3.718 × 10^14` — which exceeds JavaScript's safe integer range (`Number.MAX_SAFE_INTEGER = 9×10^15`, so technically fine here, but larger numbers would overflow). 

More critically, after multiplying, the result is `price × qty` which in scaled terms is `actualPrice × actualQty × SCALE²`. You need to **divide by SCALE once** to get back to a result in scaled terms:
```
(3.7 × 100.5) × SCALE = 371.85 × 1000000 = 371850000
```

BigInt is used because regular JavaScript integers would lose precision for very large trades.

---

### `percentChangeScaled(current, first): string`

```typescript
export function percentChangeScaled(current: number, first: number): string {
  const diff = current - first;
  const percentScaled = Number((BigInt(diff) * BigInt(10000)) / BigInt(first));
  return formatDecimalWithScale(percentScaled, 2);
}
```

**Why multiply by 10000?** Percent with 2 decimal places means we need 4 decimal digits of precision in the integer space. `(diff/first) × 100 × 100` gives us percentage with 2 decimals, as an integer. Then `formatDecimalWithScale(result, 2)` converts it back.

Example: SOL went from $100 to $102.50:
- `diff = 2500000, first = 100000000`
- `percentScaled = (2500000 × 10000) / 100000000 = 250`
- `formatDecimalWithScale(250, 2)` → `"2.50"` → "2.50% gain" ✓

---

## File: `Orderbook.ts` — The Heart of the Exchange

```
path: engine/src/trade/Orderbook.ts
```

### The Data Model

```typescript
export interface Order {
    price: number;     // SCALED integer — e.g. 100500000 means $100.50
    quantity: number;  // SCALED integer — e.g. 3700000 means 3.7 SOL
    orderId: string;   // UUID, generated by Engine.createOrder()
    filled: number;    // SCALED integer — how much has been executed
    side: "buy" | "sell";
    userId: string;    // Who placed this order
    timestamp: number; // Date.now() — for FIFO ordering
}
```

**`filled` starts at 0 and grows toward `quantity` as the order matches.** When `filled >= quantity`, the order is completely done and gets removed from the book.

---

### The Depth Cache — The Key Performance Decision

```typescript
private depthBids: Record<string, number> = Object.create(null);
private depthAsks: Record<string, number> = Object.create(null);
```

**What problem does this solve?**

The order book stores individual orders. You might have 50 buy orders all at $100.50:
```
bids = [
  {price: 100500000, quantity: 1000000, userId: "A"},
  {price: 100500000, quantity: 2000000, userId: "B"},
  {price: 100500000, quantity: 500000,  userId: "C"},
  ... (47 more)
]
```

When a user looks at the order book UI, they don't see individual orders — they see aggregated depth:
```
Bids: [["100.5", "3.5"], ...]   ← 3.5 SOL total at $100.50
```

**Without the cache**: every depth request → scan all orders → O(n) where n = total orders.
**With the cache**: `depthBids["100500000"] = 3500000` → O(1) lookup, O(k) to format output where k = distinct price levels.

**`Object.create(null)` vs `{}`:**
A regular `{}` in JavaScript has a prototype chain. If you used a price like `"constructor"` or `"toString"` as a key, you'd get JavaScript built-in functions instead of your value. `Object.create(null)` creates an orphan object with no prototype — pure key-value map. Safer and slightly faster.

---

### `rebuildDepth()` — Reconciliation

```typescript
private rebuildDepth() {
    this.depthBids = Object.create(null);
    this.depthAsks = Object.create(null);
    
    for (const order of this.bids) {
        const remaining = order.quantity - order.filled;
        if (remaining > 0) {
            this.applyDepthDelta("bids", order.price, remaining);
        }
    }
    // ... same for asks
}
```

This is called once in the **constructor** when loading from a snapshot. It rebuilds the depth cache from scratch by re-scanning all orders. After that, `applyDepthDelta` keeps it updated incrementally with every operation.

**Why not just always rebuild?** That would be O(n) per operation. Incremental deltas are O(1) per operation.

---

### `applyDepthDelta(side, price, delta)` — The Incremental Updater

```typescript
private applyDepthDelta(side: "bids" | "asks", price: number, delta: number) {
    if (!Number.isFinite(delta) || Math.abs(delta) < EPSILON) return;

    const key = price.toString();
    const book = side === "bids" ? this.depthBids : this.depthAsks;
    const next = (book[key] || 0) + delta;

    if (next <= EPSILON) {
        delete book[key];  // Price level empty → remove it
        return;
    }

    book[key] = next;
}
```

**When delta is positive**: adding liquidity (new order placed or partially unfilled order remains)
**When delta is negative**: removing liquidity (order filled or cancelled)

`EPSILON = 0` here, meaning any value ≤ 0 clears the price level. In practice this should be a tiny non-zero value to handle floating point edge cases, but since we're in integer math, exact zero is correct.

**Example flow:**
```
Initial: depthBids["100500000"] = 3500000  (3.5 SOL at $100.50)
New buy order placed for 2.0 SOL at $100.50:
→ applyDepthDelta("bids", 100500000, +2000000)
→ depthBids["100500000"] = 5500000  (5.5 SOL now)

Trade fills 1.0 SOL from that price:
→ applyDepthDelta("asks", 100500000, -1000000)
→ depthAsks["100500000"] = ...  (ask side updates)
```

---

### `addOrder(order)` — The Main Entry Point

```typescript
addOrder(order: Order): { executedQty: number, fills: Fill[] } {
    if (order.side === "buy") {
        const {executedQty, fills} = this.matchBid(order);
        order.filled = executedQty;
        const remaining = order.quantity - executedQty;
        
        if (remaining <= 0) {
            return { executedQty, fills };  // Fully filled, don't add to book
        }
        
        this.bids.push(order);
        this.bids.sort((a, b) => {
            if (b.price !== a.price) return b.price - a.price; // Higher price FIRST
            return a.timestamp - b.timestamp;                    // Earlier time FIRST
        });
        this.applyDepthDelta("bids", order.price, remaining);
        return { executedQty, fills };
    }
```

**The sorting rule explained:**
- For bids (buyers): Higher price = more willing to pay = better bid = front of queue
- If two bids have the same price: whoever placed it **earlier** gets priority — this is FIFO

This means if you and I both want to buy SOL at $100.50 and someone comes to sell:
- If I placed my order at 9:00:00 AM and you placed yours at 9:00:01 AM
- I get filled first, then you

This is exactly how real exchanges work (NYSE, Binance, all of them).

**Why sort after push instead of maintaining sorted insertion?** This is a simplification. Production exchanges use more sophisticated data structures (skip lists, balanced trees) that maintain sort order on insert in O(log n). A simple sort after every order is O(n log n) — acceptable for a teaching project, not for a production exchange doing millions of orders per second.

---

### `matchBid(order)` — Finding Sellers for a Buyer

```typescript
matchBid(order: Order): {fills: Fill[], executedQty: number} {
    const fills: Fill[] = [];
    let executedQty = 0;

    for (let i = 0; i < this.asks.length; i++) {
        // Self-trade prevention
        if (this.asks[i].userId === order.userId) continue;
        
        if (this.asks[i].price <= order.price && executedQty < order.quantity) {
            const filledQty = Math.min(
                order.quantity - executedQty,  // How much we STILL need
                this.asks[i].quantity          // How much this ask offers
            );
            executedQty += filledQty;
            this.asks[i].filled += filledQty;
            this.applyDepthDelta("asks", this.asks[i].price, -filledQty);
            
            fills.push({
                price: this.asks[i].price,      // Fill at ASK price (maker sets price)
                qty: filledQty,
                tradeId: this.lastTradeId++,    // Increment global trade counter
                otherUserId: this.asks[i].userId,
                markerOrderId: this.asks[i].orderId
            });
        }
    }
    
    // Remove fully filled asks
    for (let i = 0; i < this.asks.length; i++) {
        if (this.asks[i].filled >= this.asks[i].quantity) {
            this.asks.splice(i, 1);
            i--;
        }
    }
    
    return { fills, executedQty };
}
```

**Critical questions answered:**

**Q: Why `asks[i].price` in the fill, not `order.price`?**
The MAKER sets the price. The maker is whoever put their order in the book first (the ask in this case). The taker (the buyer) agrees to pay at least that price. This is called **maker-taker pricing** — it's universal in exchanges.

**Q: Why does the loop not break after matching one ask?**
One buy order might match against **multiple** asks. If you want to buy 10 SOL:
- Ask 1: 3 SOL at $100 → fill 3 SOL
- Ask 2: 5 SOL at $100.50 → fill 5 SOL
- Ask 3: 4 SOL at $101 → fill 2 SOL (only 2 more needed)
This is called **sweeping the book**.

**Q: What's `this.lastTradeId++`?**
Every trade on the exchange gets a globally unique, ever-increasing ID. This is the trade sequence number. The `++` happens after the value is read (post-increment) so the first fill gets ID 0, next gets 1, etc.

**Q: The two loops — why not combine?**
The first loop: find and execute all matches.
The second loop: clean up fully-filled orders.
You can't do them in one pass because you're modifying the array (`splice`) while iterating — a classic off-by-one bug if done carelessly. The two-pass approach is safer and clearer.

---

### `getDepth()` — Serving the UI

```typescript
getDepth() {
    const bids: [string, string][] = [];
    const asks: [string, string][] = [];

    for (const price in this.depthBids) {
        bids.push([
            fromScaledToDecimal(Number(price)),
            fromScaledToDecimal(this.depthBids[price])
        ]);
    }
    // ... same for asks
    return { bids, asks };
}
```

**Output format**: `[["price_string", "quantity_string"], ...]`

Why strings instead of numbers? JSON precision loss. `JSON.stringify(100500000) → "100500000"` (fine). But after going through the network and being parsed, there could be precision issues with floats. Strings are unambiguous. The frontend parses them explicitly with `parseFloat()`.

---

### `getTicker()` — The 24h Stats Panel

```typescript
getTicker() {
    const priceChange = this.lastPrice - this.firstPrice;
    return {
        firstPrice: fromScaledToDecimal(this.firstPrice),  // Price at start of period
        high: fromScaledToDecimal(this.high),              // Highest trade price
        lastPrice: fromScaledToDecimal(this.lastPrice),    // Most recent trade price
        low: fromScaledToDecimal(this.low),                // Lowest trade price
        priceChange: fromScaledToDecimal(priceChange),     // lastPrice - firstPrice
        priceChangePercent: percentChangeScaled(this.lastPrice, this.firstPrice),
        quoteVolume: fromScaledToDecimal(this.quoteVolume), // Total $ traded
        symbol: this.ticker(),                              // "SOL_USDC"
        trades: this.trades.toString(),                     // Total trades count
        volume: fromScaledToDecimal(this.volume)            // Total SOL traded
    }
}
```

`firstPrice` is not the opening price at midnight — it's the price of the **first ever trade** (or restart). A proper exchange would reset this daily. This is a simplification. `volume` tracks base asset (SOL), `quoteVolume` tracks quote asset ($). Both are updated on every fill by `Engine.updateTicker()`.

---

## Debugging the Order Book

### Scenario: "A trade should have happened but didn't"

Step 1: Add this log at the top of `matchBid`:
```typescript
console.log(`Matching buy at ${order.price} against ${this.asks.length} asks`);
this.asks.forEach((a, i) => console.log(`  Ask[${i}]: price=${a.price}, qty=${a.quantity}, user=${a.userId}`));
```

Step 2: Check if self-trade prevention fired:
```typescript
if (this.asks[i].userId === order.userId) {
    console.log(`⚠️ Self-trade prevented: user ${order.userId}`);
    continue;
}
```

Step 3: Check price condition:
```typescript
console.log(`Price check: ask=${this.asks[i].price} <= bid=${order.price}? ${this.asks[i].price <= order.price}`);
```

### Scenario: "Depth shows wrong quantity"

Call `this.rebuildDepth()` and compare before/after. If they differ, the delta tracking has a bug.

### Scenario: "Order cancelled but funds not returned"

Check `cancelBid` / `cancelAsk` — they return the price. The price is then used by `Engine.process` to call `sendUpdatedDepthAt`. The balance unlock happens in `Engine.process`, not in Orderbook.
