# Module 03 — The Matching Engine Core State Machine & Balance Accounting

> **The Sovereign Ledger of the Exchange**  
> *"The Matching Engine is the sole stateful component in the entire platform. It is the judge, jury, and bank of the exchange. Every single user balance, resting order, fill, and cancelation is executed deterministically in this single memory space. This module examines `engine/src/trade/Engine.ts` line-by-line, revealing how atomic balance locking, double-entry settlement, and price-improvement refunds work with zero data loss."*

---

## 1. Engine State Architecture & Invariants

Inside `Engine.ts`, state is held in four private data structures:

```typescript
export class Engine {
    private orderbooks: Orderbook[] = [];
    private balances: Map<string, UserBalance> = new Map();
    private lastProcessedStreamId: string = "0-0";
    private processedTxns: Set<string> = new Set();
    private _dirty: boolean = false;
```

### The State Variables:

1. **`orderbooks: Orderbook[]`**: An array of `Orderbook` instances. Each orderbook represents one trading pair (e.g. `SOL_USDC`).
2. **`balances: Map<string, UserBalance>`**: The master ledger.
   The map key is `userId` (UUID). The value is an object mapping currency symbol $\rightarrow$ balance:
   ```typescript
   interface UserBalance {
       [asset: string]: {
           available: number; // Scaled integer free balance
           locked: number;    // Scaled integer balance locked in resting orders
       }
   }
   ```
3. **`lastProcessedStreamId: string`**: The exact Redis Stream message ID (e.g. `"1712850000000-0"`) that the engine processed most recently. This is saved in snapshots to enable deterministic crash recovery.
4. **`processedTxns: Set<string>`**: A deduplication registry of fiat/crypto deposit transaction IDs. If an `ON_RAMP` message is replayed during recovery, this set prevents funds from being minted twice.
5. **`_dirty: boolean`**: A flag indicating whether any state has mutated since the last snapshot. Prevents pointless disk I/O when the exchange is idle.

---

## 2. The Balance Life Cycle: Available vs. Locked

In financial exchanges, customer funds exist in one of two states:
$$\text{Total Balance} = \text{Available} + \text{Locked}$$

- **Available Balance**: Funds the user is free to withdraw, transfer, or commit to new orders.
- **Locked Balance**: Funds committed to open, resting limit orders on the order book. Locked funds **cannot** be spent on other orders or withdrawn.

```
                  ┌──────────────────────────────┐
                  │      User Deposited Funds    │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                     [ Available: 1000 USDC ]
                     [ Locked:       0 USDC ]
                                 │
            User places Buy 2 SOL @ $150 (Cost: $300)
                                 │
                                 ▼
                     [ Available:  700 USDC ]  <── Decreased by $300
                     [ Locked:     300 USDC ]  <── Increased by $300
                                 │
                 ┌───────────────┴───────────────┐
                 │                               │
        Order is Canceled               Order is Filled @ $150
                 │                               │
                 ▼                               ▼
      [ Available: 1000 USDC ]         [ Available:  700 USDC ]
      [ Locked:       0 USDC ]         [ Locked:       0 USDC ]
      (Funds returned to user)         [ Available SOL: +2 SOL]
                                       (USDC transferred to seller)
```

---

## 3. Order Ingestion: `createOrder` Line-by-Line (Lines 437–513)

When an order arrives, `createOrder` executes the following sequence:

```typescript
createOrder(market: string, price: string, quantity: string, side: "buy" | "sell", userId: string) {
    const orderbook = this.orderbooks.find(o => o.ticker() === market);
    const baseAsset = market.split("_")[0];   // "SOL"
    const quoteAsset = market.split("_")[1];  // "USDC"

    if (!orderbook) {
        throw new Error("No orderbook found");
    }

    // Step 1: Parse and validate numbers
    const numPrice = toScaledFromDecimal(price);
    const numQuantity = toScaledFromDecimal(quantity);
    if (!Number.isFinite(numPrice) || numPrice <= 0) throw new Error("Invalid price");
    if (!Number.isFinite(numQuantity) || numQuantity <= 0) throw new Error("Invalid quantity");
    if (side !== "buy" && side !== "sell") throw new Error("Invalid side");

    // Step 2: Sanity bounds enforcement
    const MIN_PRICE = toScaledFromDecimal("0.01");
    const MAX_PRICE = toScaledFromDecimal("1000000");
    const MIN_QUANTITY = toScaledFromDecimal("0.000001");
    const MAX_QUANTITY = toScaledFromDecimal("100000");

    if (numPrice < MIN_PRICE) throw new Error(`Price too low (minimum $0.01)`);
    if (numPrice > MAX_PRICE) throw new Error(`Price too high (maximum $1,000,000)`);
    if (numQuantity < MIN_QUANTITY) throw new Error(`Quantity too small (minimum 0.000001)`);
    if (numQuantity > MAX_QUANTITY) throw new Error(`Quantity too large (maximum 100,000 per order)`);

    // Step 3: Check and lock funds in RAM
    this.checkAndLockFunds(baseAsset, quoteAsset, side, userId, price, quantity);

    // Step 4: Construct Order object
    const order: Order = {
        price: numPrice,
        quantity: numQuantity,
        orderId: crypto.randomUUID(),
        filled: 0,
        side,
        userId,
        timestamp: Date.now()
    };

    // Step 5: Execute matching against Orderbook
    const { fills, executedQty } = orderbook.addOrder(order);

    // Step 6: Atomic balance settlement
    this.updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty, numPrice);

    // Step 7: Push asynchronous events to Redis
    this.createDbTrades(fills, market, side);
    this.updateDbOrders(order, executedQty, fills, market);
    this.publisWsDepthUpdates(fills, fromScaledToDecimal(numPrice), side, market);
    this.publishWsTrades(fills, market, side);
    this.updateTicker(market, fills);

    // Step 8: Mark state dirty for snapshot
    this._dirty = true;

    return { executedQty: scaledToNumber(executedQty), fills: apiFills, orderId: order.orderId };
}
```

---

## 4. Atomic Fund Locking: `checkAndLockFunds` (Lines 690–713)

Before an order can be matched, the engine must lock the required collateral:

```typescript
checkAndLockFunds(baseAsset: string, quoteAsset: string, side: "buy" | "sell", userId: string, price: string, quantity: string) {
    const numPrice = toScaledFromDecimal(price);
    const numQuantity = toScaledFromDecimal(quantity);
    if (!Number.isFinite(numPrice) || !Number.isFinite(numQuantity)) {
        throw new Error("Invalid price or quantity");
    }
    const totalCost = multiplyScaled(numQuantity, numPrice);

    if (side === "buy") {
        // Buyer needs Quote Currency (USDC) = quantity * price
        const bal = this.getOrInitBalance(userId, quoteAsset);
        if (bal.available < totalCost) {
            throw new Error("Insufficient funds");
        }
        bal.available -= totalCost;
        bal.locked += totalCost;
    } else {
        // Seller needs Base Asset (SOL) = quantity
        const bal = this.getOrInitBalance(userId, baseAsset);
        if (bal.available < numQuantity) {
            throw new Error("Insufficient funds");
        }
        bal.available -= numQuantity;
        bal.locked += numQuantity;
    }
}
```

### Critical Invariants:
1. **Atomic Pre-Locking**: Funds are locked **before** calling `orderbook.addOrder()`.
   If a user has 100 USDC and tries to buy 500 USDC worth of SOL, `checkAndLockFunds` throws `"Insufficient funds"` immediately. The orderbook is never touched.
2. **Buy vs. Sell Currency Requirements**:
   - To **BUY** `SOL_USDC`, you lock `USDC` (the quote currency) proportional to $\text{quantity} \times \text{limitPrice}$.
   - To **SELL** `SOL_USDC`, you lock `SOL` (the base currency) proportional to $\text{quantity}$.

---

## 5. Double-Entry Settlement & The Price-Improvement Refund (Lines 651–688)

Once `orderbook.addOrder()` returns the executed fills, `updateBalance` settles the trades between buyer and seller:

```typescript
updateBalance(
    userId: string, 
    baseAsset: string, 
    quoteAsset: string, 
    side: "buy" | "sell", 
    fills: Fill[], 
    executedQty: number, 
    limitPrice: number
) {
    if (side === "buy") {
        fills.forEach(fill => {
            const fillValue = multiplyScaled(fill.qty, fill.price);
            
            // Funds were locked at buyer's LIMIT price (qty * limitPrice).
            // When fill executes at a better maker price, the difference must be
            // returned to available — otherwise it stays locked forever (fund leak)!
            const lockedForFill = multiplyScaled(fill.qty, limitPrice);
            const improvement = lockedForFill - fillValue; // >= 0 for a buy

            // 1. Seller receives quote currency (at execution price)
            this.getOrInitBalance(fill.otherUserId, quoteAsset).available += fillValue;
            
            // 2. Buyer's locked quote currency releases the full amount locked for this qty
            this.getOrInitBalance(userId, quoteAsset).locked -= lockedForFill;
            
            // 3. Buyer gets the price-improvement refunded to available!
            if (improvement !== 0) {
                this.getOrInitBalance(userId, quoteAsset).available += improvement;
            }
            
            // 4. Seller's locked base asset decreases
            this.getOrInitBalance(fill.otherUserId, baseAsset).locked -= fill.qty;
            
            // 5. Buyer receives base asset
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
```

### The Mathematics of Price-Improvement Refund:

#### The Scenario:
- Alice places a limit buy: **10 SOL @ $160**.
- The engine pre-locks: $10 \times 160 = \mathbf{\$1,600\text{ USDC}}$ in Alice's `locked` balance.
- However, Bob already has a resting ask on the book: **10 SOL @ $150**.
- The trade matches at Bob's price: **10 SOL @ $150 = $1,500 USDC**.

#### What Happens Without the Refund Code?
- Seller Bob receives $\$1,500$ USDC.
- Alice receives $10$ SOL.
- Alice's locked balance is deducted by $\$1,500$.
- **Problem**: $\$100$ remains trapped in Alice's `locked` balance forever! Alice's account would show $\$100$ locked with zero open orders!

#### What Our Code Does:
```typescript
const lockedForFill = 10 * 160 = 1600;
const fillValue      = 10 * 150 = 1500;
const improvement    = 1600 - 1500 = 100;

// Alice's locked USDC drops by the FULL 1600 locked:
alice.locked -= 1600; // Locked returns to 0!

// The $100 price improvement is refunded to Alice's available USDC:
alice.available += 100;

// Seller Bob receives the actual trade value:
bob.available += 1500;
```
**Ledger Proof**:
- Initial Total USDC = Alice ($1,600$) + Bob ($0$) = $\$1,600$.
- Final Total USDC = Alice ($100$) + Bob ($1,500$) = $\$1,600$.
- Conservation of capital holds: $1600 = 1600$. Exactly zero money was created or lost!

---

## 6. Order Cancellation & Race Conditions (Lines 182–281)

When a trader requests order cancellation (`DELETE /api/v1/order`), the engine must handle tricky race conditions:

```typescript
case CANCEL_ORDER:
    try {
        const orderId = message.data.orderId;
        const cancelMarket = message.data.market;
        const requestUserId = message.data.userId;
        const cancelOrderbook = this.orderbooks.find(o => o.ticker() === cancelMarket);
        const baseAsset = cancelMarket.split("_")[0];
        const quoteAsset = cancelMarket.split("_")[1];

        if (!cancelOrderbook) throw new Error("No orderbook found");

        // 1. Locate order in asks or bids
        const order = cancelOrderbook.asks.find(o => o.orderId === orderId) || 
                      cancelOrderbook.bids.find(o => o.orderId === orderId);
        
        if (!order) throw new Error("No order found");

        // 2. Authorization check: Cannot cancel someone else's order!
        if (order.userId !== requestUserId) {
            throw new Error("Unauthorized cancel request");
        }

        const userBalance = this.balances.get(order.userId);
        if (!userBalance) throw new Error("User balance not found");

        // 3. Race condition check: Did the order fill between request and processing?
        const filledAtCancel = order.filled;
        const remainingQty = order.quantity - filledAtCancel;

        if (remainingQty <= 0) {
            // Order was already filled! Do not throw; return graceful confirmation.
            RedisManager.getInstance().sendToApi(clientId, {
                type: "ORDER_CANCELLED",
                payload: { orderId, executedQty: scaledToNumber(order.filled), remainingQty: 0 }
            });
            return;
        }

        // 4. Cancel from order book and unlock remaining funds
        if (order.side === "buy") {
            const price = cancelOrderbook.cancelBid(order);
            const lockedAmount = multiplyScaled(remainingQty, order.price);
            userBalance[quoteAsset].available += lockedAmount;
            userBalance[quoteAsset].locked -= lockedAmount;
            if (price) this.sendUpdatedDepthAt(fromScaledToDecimal(price), cancelMarket);
        } else {
            const price = cancelOrderbook.cancelAsk(order);
            userBalance[baseAsset].available += remainingQty;
            userBalance[baseAsset].locked -= remainingQty;
            if (price) this.sendUpdatedDepthAt(fromScaledToDecimal(price), cancelMarket);
        }

        this.publishWsDepthUpdate(cancelMarket);
        // ... reply ORDER_CANCELLED to API ...
```

### Critical Protections:
1. **Authorization Verification**: Trader Alice cannot pass Bob's `orderId` to cancel Bob's orders (`order.userId !== requestUserId`).
2. **Race-Condition Graceful Fallback**:
   If Alice clicks "Cancel" at the exact millisecond Charlie crosses Alice's order:
   - When the cancel message arrives, `remainingQty <= 0` because Charlie's trade already filled the order.
   - The engine does **not** crash or double-unlock. It reports `remainingQty: 0` back to the API.
3. **Exact Remaining Unlock**:
   If an order was for 10 SOL and 4 SOL filled earlier, `remainingQty = 6 SOL`. Only 6 SOL (or $6 \times \text{price}$ USDC) is unlocked. The 4 SOL that already filled remains settled.

---

## 7. Deposit Minting & Idempotency: `onRamp` (Lines 715–735)

When fiat is deposited via Razorpay, the engine mints available USDC:

```typescript
onRamp(userId: string, amount: string | number, txnId?: string): boolean {
    if (txnId && this.processedTxns.has(txnId)) {
        return false; // Skip duplicate!
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
```

### Crash-Recovery Deduplication:
Why is `txnId` tracked in `processedTxns`?
- Suppose user Alice deposits $500 USDC (`txnId: "pay_123"`).
- The engine credits Alice's balance.
- 5 seconds later, the engine crashes before writing a snapshot.
- On reboot, the engine replays pending messages from Redis Streams.
- The `ON_RAMP` message for `pay_123` is replayed.
- `this.processedTxns.has("pay_123")` evaluates to **`true`**!
- The replay returns `false` without incrementing Alice's balance a second time.
- **Idempotency guaranteed**.

---

## 8. Real-Time Ticker Aggregation: `updateTicker` (Lines 833–873)

Whenever a trade fills, the engine updates 24-hour market metrics:

```typescript
updateTicker(market: string, fills: Fill[]) {
    const orderbook = this.orderbooks.find(o => o.ticker() === market);
    if (!orderbook) return;

    fills.forEach(fill => {
        const price = fill.price;
        const quantity = fill.qty;
        const quoteQuantity = multiplyScaled(price, quantity);

        orderbook.lastPrice = price;
        if (orderbook.firstPrice === 0) orderbook.firstPrice = price;

        if (price > orderbook.high) orderbook.high = price;
        if (price < orderbook.low || orderbook.low === 0) orderbook.low = price;

        orderbook.volume += quantity;          // Cumulative base volume (SOL)
        orderbook.quoteVolume += quoteQuantity; // Cumulative quote volume (USDC)
        orderbook.trades += 1;                  // Cumulative trade count
    });

    this.publishWsTickerUpdate(market);
}
```

These metrics are published to Redis channels:
- `ticker.SOL_USDC`: Market-specific stream.
- `ticker.all`: Exchange-wide overview stream.
- Browsers receive updated 24h High, 24h Low, 24h Volume, and 24h Percentage Change in real time.
