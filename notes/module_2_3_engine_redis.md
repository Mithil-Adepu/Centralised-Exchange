# CEX Mastery — Module 2: The Matching Engine (Engine.ts)

> The Engine is the only stateful process. Everything else is stateless. It is the single source of truth for all balances and all open orders.

---

## Architecture Principle: Single-Threaded By Design

The Engine runs in a **single Node.js process** and processes messages **one at a time**, sequentially. This is not a limitation — it's a fundamental design choice.

**Why single-threaded?**

Imagine two orders arriving at the same millisecond:
- Order A: buy 5 SOL
- Order B: also buy 5 SOL
- Available: only 5 SOL for sale

If both run concurrently, both might "see" 5 SOL available and both get filled — you've now oversold. This is a race condition.

**The solution**: process everything through a single queue. No concurrent execution. No locks needed. No race conditions possible.

Redis serves as the queue. The engine pops one message at a time. This pattern is called **event sourcing** — all state changes come from a serialized event stream.

---

## File: `engine/src/index.ts` — The Process Entry Point

```typescript
const response = await redisClient.brPop("messages", 1);
//                                        ↑            ↑
//                                  queue name    timeout (1s)
```

`brPop` = **Blocking Right Pop**. This is the key operation:
- It **blocks** the process — no CPU usage, the OS kernel sleeps the process
- When a message arrives in the `"messages"` list: the OS wakes the process instantly
- The `1` second timeout means: if nothing arrives in 1 second, return `null` and re-check

**What happens during that 1-second idle?** The `isShuttingDown` flag is checked. This allows graceful shutdown even when no messages are flowing.

```typescript
const shutdown = async () => {
    if (isShuttingDown) return;  // Prevent double-shutdown
    isShuttingDown = true;
    
    engine.saveSnapshot();       // Save all state to disk before dying
    await redisClient.disconnect();
    process.exit(0);
};
process.on('SIGINT', shutdown);  // Ctrl+C
process.on('SIGTERM', shutdown); // Docker stop
```

`SIGTERM` is what Docker sends when you run `docker stop`. Without handling it, Docker would wait 10 seconds then send `SIGKILL` (which you can't catch) — losing the snapshot. Handling `SIGTERM` means you get to save state before exiting.

---

## File: `Engine.ts` — The State Machine

### The State

```typescript
export class Engine {
    private orderbooks: Orderbook[] = [];          // One per market
    private balances: Map<string, UserBalance> = new Map();
    //                  ↑ userId     ↑ { SOL: {available, locked}, USDC: {available, locked} }
    private _dirty: boolean = false;               // Has anything changed since last snapshot?
}
```

The `_dirty` flag is an optimization. The engine only writes a snapshot to disk when `_dirty === true`. Without this, it would write to disk every 30 seconds even if nothing happened — wasting I/O.

---

### The Constructor — Loading State

```typescript
constructor() {
    let snapshot = null;
    try {
        if (process.env.WITH_SNAPSHOT) {
            snapshot = fs.readFileSync("./snapshot.json");
        }
    } catch (e) {
        console.log("No snapshot found");
    }
```

`WITH_SNAPSHOT` environment variable controls whether the engine tries to load a previous snapshot. Why not always load? Because in testing, you want a fresh state. In production, you always want to resume from where you left off.

**The version migration system:**
```typescript
const SNAPSHOT_VERSION = 2;
const snapshotVersion = snapshotSnapshot.version ?? 1;
const isScaled = snapshotVersion >= SNAPSHOT_VERSION;

const normalizeOrder = (order: any): Order => ({
    price: isScaled ? order.price : toScaledFromDecimal(String(order.price ?? 0)),
    ...
});
```

**Why?** Version 1 snapshots stored prices as decimal floats (`"100.5"`). Version 2 stores them as scaled integers (`100500000`). When loading an old snapshot, the engine converts automatically. This is **backwards compatibility** — you can upgrade the engine without losing old data.

This is standard practice in any system with persistent state. Schema migrations for databases do the same thing.

---

### The Snapshot Timer

```typescript
this._dirty = false;
setInterval(() => {
    if (this._dirty) {
        this.saveSnapshot();
        this._dirty = false;
    }
}, 1000 * 30);  // Every 30 seconds
```

**Why 30 seconds?** Trade-off between:
- Shorter interval: less data loss on crash, but more I/O
- Longer interval: less I/O, but you could lose up to 30 seconds of trades on a crash

30 seconds is reasonable for a teaching project. Production exchanges use **write-ahead logging** (WAL) or **event sourcing replay** — they never lose a single trade regardless of when a crash happens.

**The atomic write:**
```typescript
saveSnapshot() {
    const snapshotData = { version: SNAPSHOT_VERSION, orderbooks: ..., balances: ... };
    const tmpFile = "./snapshot.tmp.json";
    
    fs.writeFile(tmpFile, JSON.stringify(snapshotData), (err) => {
        if (err) { console.error(err); return; }
        fs.rename(tmpFile, "./snapshot.json", (renameErr) => { ... });
    });
}
```

**Why write to `.tmp` then rename?** `rename` is an atomic OS operation. The file system guarantees you either see the old file or the new file — never a half-written corrupt file. If the process crashes mid-write to `.tmp`, the old `snapshot.json` is still intact.

---

### `process(message)` — The Switch Statement

```typescript
process({ message, clientId }: {message: MessageFromApi, clientId: string}) {
    switch (message.type) {
        case CREATE_ORDER: ...
        case CANCEL_ORDER: ...
        case GET_OPEN_ORDERS: ...
        case ON_RAMP: ...
        case GET_DEPTH: ...
        case GET_BALANCES: ...
        case GET_TICKERS: ...
    }
}
```

**`clientId`** is a UUID generated by the API's `RedisManager.getRandomClientId()`. It's the "return address" — after processing, the engine publishes the result to a Redis channel named after this ID. The API, which subscribed to that channel, receives the response.

This is the **correlation pattern** — matching requests to responses in an async system.

---

### `createOrder()` — The Most Important Function

```typescript
createOrder(market, price, quantity, side, userId) {
    const orderbook = this.orderbooks.find(o => o.ticker() === market);
    const baseAsset = market.split("_")[0];   // "SOL" from "SOL_USDC"
    const quoteAsset = market.split("_")[1];  // "USDC" from "SOL_USDC"
```

**Market format**: always `"{base}_{quote}"`. The base is what you're buying/selling. The quote is what you're pricing it in. `SOL_USDC` means "buy/sell SOL, price denominated in USDC."

**Step 1: Validate inputs**
```typescript
const numPrice = toScaledFromDecimal(price);
const numQuantity = toScaledFromDecimal(quantity);
if (!Number.isFinite(numPrice) || numPrice <= 0) throw new Error("Invalid price");
if (!Number.isFinite(numQuantity) || numQuantity <= 0) throw new Error("Invalid quantity");
```
Inputs come as strings (from JSON). Convert to scaled integers. Reject invalid inputs before touching any state.

**Step 2: Lock funds before matching**
```typescript
this.checkAndLockFunds(baseAsset, quoteAsset, side, userId, price, quantity);
```
This is called **BEFORE** `orderbook.addOrder()`. If the user doesn't have enough funds, throw immediately — don't even attempt to match. This prevents oversell.

**Step 3: Create the order object**
```typescript
const order: Order = {
    price: numPrice,
    quantity: numQuantity,
    orderId: crypto.randomUUID(),  // Guaranteed globally unique
    filled: 0,
    side,
    userId,
    timestamp: Date.now()
};
```

**Step 4: Match against the book**
```typescript
const { fills, executedQty } = orderbook.addOrder(order);
```

**Step 5: Update balances based on fills**
```typescript
this.updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty);
```

**Step 6: Propagate results**
```typescript
this.createDbTrades(fills, market, side);    // → Redis → DB processor → PostgreSQL
this.updateDbOrders(order, executedQty, ...); // → Redis → DB processor → PostgreSQL
this.publisWsDepthUpdates(fills, ...);        // → Redis → WS → browsers (order book)
this.publishWsTrades(fills, market, side);    // → Redis → WS → browsers (trade feed)
this.updateTicker(market, fills);             // → Redis → WS → browsers (ticker)
this._dirty = true;                           // Flag for snapshot
```

**Step 7: Return to API**
```typescript
return { executedQty: scaledToNumber(executedQty), fills: apiFills, orderId: order.orderId };
// Engine sends this to RedisManager.sendToApi(clientId, ...)
// API is waiting on that Redis channel and resolves its Promise
```

---

### `checkAndLockFunds()` — The Balance Guard

```typescript
checkAndLockFunds(baseAsset, quoteAsset, side, userId, price, quantity) {
    const totalCost = multiplyScaled(numQuantity, numPrice);  // qty × price = total $

    if (side === "buy") {
        const bal = this.getOrInitBalance(userId, quoteAsset);  // Check USDC balance
        if (bal.available < totalCost) throw new Error("Insufficient funds");
        bal.available -= totalCost;  // Deduct from available
        bal.locked += totalCost;     // Add to locked (collateral)
    } else {
        const bal = this.getOrInitBalance(userId, baseAsset);   // Check SOL balance
        if (bal.available < numQuantity) throw new Error("Insufficient funds");
        bal.available -= numQuantity;
        bal.locked += numQuantity;
    }
}
```

**Buy order** (you want SOL, you're spending USDC):
- Lock `price × quantity` USDC. You're reserving the money you'll spend.
- When the trade fills, locked USDC goes to the seller.

**Sell order** (you want to sell SOL for USDC):
- Lock `quantity` SOL. You're reserving the asset you'll deliver.
- When the trade fills, locked SOL goes to the buyer.

**What "locked" means**: funds that have been reserved as collateral for an open order. You can't spend locked funds on another order. This prevents double-spending.

---

### `updateBalance()` — The Settlement Engine

When a trade fills, this is called to settle the exchange of assets:

```typescript
updateBalance(userId, baseAsset, quoteAsset, side, fills, executedQty) {
    if (side === "buy") {
        fills.forEach(fill => {
            const fillValue = multiplyScaled(fill.qty, fill.price);  // $ value of this fill
            
            // Seller receives USDC (their sell generated value)
            this.getOrInitBalance(fill.otherUserId, quoteAsset).available += fillValue;
            
            // Buyer's locked USDC decreases (used up their reserved funds)
            this.getOrInitBalance(userId, quoteAsset).locked -= fillValue;
            
            // Seller's locked SOL decreases (they delivered their asset)
            this.getOrInitBalance(fill.otherUserId, baseAsset).locked -= fill.qty;
            
            // Buyer receives SOL (what they bought)
            this.getOrInitBalance(userId, baseAsset).available += fill.qty;
        });
    }
```

**The 4-line settlement per fill:**
1. `seller.USDC.available += fillValue` — seller gets paid
2. `buyer.USDC.locked -= fillValue` — buyer's reserved funds consumed
3. `seller.SOL.locked -= fill.qty` — seller's reserved SOL consumed
4. `buyer.SOL.available += fill.qty` — buyer receives their SOL

**This is atomic** (because the engine is single-threaded). Either all 4 updates happen or none do. No partial states.

---

### `updateTicker()` — Maintaining 24h Stats

```typescript
updateTicker(market: string, fills: Fill[]) {
    fills.forEach(fill => {
        orderbook.lastPrice = fill.price;         // Most recent trade price

        if (orderbook.firstPrice === 0) {
            orderbook.firstPrice = fill.price;    // First trade ever → set as reference
        }

        if (fill.price > orderbook.high) orderbook.high = fill.price;
        if (fill.price < orderbook.low || orderbook.low === 0) orderbook.low = fill.price;

        orderbook.volume += fill.qty;                          // Total SOL traded
        orderbook.quoteVolume += multiplyScaled(fill.qty, fill.price); // Total $ traded
        orderbook.trades += 1;
    });

    this.publishWsTickerUpdate(market);  // Push to WS → all browsers watching this market
}
```

**Note**: This is a "session" ticker — it accumulates from the moment the engine started (or loaded from snapshot). A proper 24h rolling window would require a time-based reset mechanism. This is a known simplification.

**`orderbook.low === 0` check**: The first trade after startup sets both `high` and `low`. Without the `=== 0` check, `low` would never update (because 0 < any real price).

---

### `publishWsTrades()` — Real-time Trade Feed

```typescript
publishWsTrades(fills: Fill[], market: string, side: "buy" | "sell") {
    const isBuyerMaker = side === "sell";
    //                            ↑
    // If the incoming order is a SELL, the existing buy (bid) was the maker
    // The maker is whoever was in the book first
```

**Why `isBuyerMaker = side === "sell"`?**
- Maker = whoever was resting in the book (placed order first, waiting)
- Taker = whoever just came in and triggered the match

If a sell order comes in and matches against existing bids → the **bid was the maker** → buyer is the maker → `isBuyerMaker = true`.
If a buy order comes in and matches against existing asks → the **ask was the maker** → seller is the maker → `isBuyerMaker = false`.

This flag is used in charting (green/red candle direction) and fee calculation.

---

### `publisWsDepthUpdates()` — Surgical Depth Updates

```typescript
publisWsDepthUpdates(fills: Fill[], price: string, side, market) {
    if (side === "buy") {
        const fillPrices = new Set(fills.map(fill => fromScaledToDecimal(fill.price)));
        const updatedAsks = depth.asks.filter(x => fillPrices.has(x[0]));
        //    ↑ Only sends the asks that were hit (modified)
        const updatedBid = depth.bids.find(x => x[0] === price);
        //    ↑ The new bid at this price (the unfilled remainder, if any)
```

**Why not send the entire depth every time?** A full depth update might be 200 rows × 2 numbers × 2 sides = 800 values of data. If there are 5000 browsers watching, that's 4 million values per trade. Instead, this sends only the **changed price levels** — often just 2-4 rows.

The frontend's `Depth.tsx` component applies these delta updates to its local copy of the order book.

---

## The Data Flow: Complete Picture

When `createOrder()` runs successfully, this happens simultaneously across the system:

```
Engine.createOrder()
  │
  ├─▶ RedisManager.pushMessage("db_processor", TRADE_ADDED)
  │     └─▶ DB Processor writes to TimescaleDB (async)
  │
  ├─▶ RedisManager.pushMessage("db_processor", ORDER_UPDATE × (1 + fills))  
  │     └─▶ DB Processor upserts order row in PostgreSQL (async)
  │
  ├─▶ RedisManager.publishMessage("trade.SOL_USDC", {...})
  │     └─▶ WS Server → all browsers subscribed to trade.SOL_USDC
  │
  ├─▶ RedisManager.publishMessage("depth.SOL_USDC", {changed rows only})
  │     └─▶ WS Server → all browsers watching the order book
  │
  ├─▶ RedisManager.publishMessage("ticker.SOL_USDC", {...})
  │     └─▶ WS Server → all browsers showing the price ticker
  │
  └─▶ RedisManager.sendToApi(clientId, ORDER_PLACED)
        └─▶ API RedisManager resolves the waiting Promise → HTTP response
```

**All of this happens synchronously within `createOrder()`** — the Redis publish/push calls are fire-and-forget (they don't `await`). The engine moves on immediately. The DB writes and WS broadcasts happen asynchronously in their own processes.

---

# CEX Mastery — Module 3: The Redis Message Bus

> Redis is the nervous system of this exchange. Two completely different communication patterns are implemented using just one technology.

---

## Pattern 1: Request/Response (API ↔ Engine)

**File**: `api/src/RedisManager.ts`

```typescript
export class RedisManager {
    private client: RedisClientType;    // Used for subscribing
    private publisher: RedisClientType; // Used for publishing
```

**Why TWO Redis clients?** In Redis, a client that's in "subscribe" mode cannot send other commands. It's in a dedicated receive loop. So: one client for publishing/sending commands, one client for subscribing/receiving.

```typescript
public sendAndAwait(message: MessageToEngine) {
    return new Promise<MessageFromOrderbook>((resolve, reject) => {
        const id = this.getRandomClientId();  // Random UUID as "return address"
        
        const timeout = setTimeout(() => {
            this.client.unsubscribe(id);
            reject(new Error('Engine response timeout'));
        }, 10000);
        
        // Subscribe to a temporary channel named after our UUID
        this.client.subscribe(id, (message) => {
            clearTimeout(timeout);
            this.client.unsubscribe(id);  // Clean up subscription immediately
            resolve(JSON.parse(message));
        });
        
        // Send the message to the engine via the "messages" queue
        this.publisher.lPush("messages", JSON.stringify({ clientId: id, message }));
    });
}
```

**The sequence:**
1. API generates UUID `"abc-123"`
2. API subscribes to Redis channel `"abc-123"`
3. API pushes `{ clientId: "abc-123", message: {...} }` to `"messages"` list
4. Engine pops from `"messages"`, processes the request
5. Engine calls `RedisManager.sendToApi("abc-123", result)`
6. Engine's RedisManager publishes result to channel `"abc-123"`
7. API's subscription callback fires, resolves the Promise
8. HTTP response returned to browser

**The timeout**: if the engine is down or overloaded, the API doesn't hang forever. After 10 seconds, the Promise rejects with a clear error message. The browser gets a 500 response instead of spinning forever.

**The temporary subscription**: the channel `"abc-123"` exists only for this one request. After receiving the response, the API immediately unsubscribes. This prevents memory leaks from accumulating subscriptions.

---

## Pattern 2: Real-time Fan-out (Engine → Browsers)

**File**: `engine/src/RedisManager.ts`

```typescript
public publishMessage(channel: string, message: WsMessage) {
    this.client.publish(channel, JSON.stringify(message));
}
```

The engine publishes to named channels:
- `"trade.SOL_USDC"` → trade events
- `"depth.SOL_USDC"` → order book changes
- `"ticker.SOL_USDC"` → price ticker updates
- `"ticker.all"` → ticker updates (broadcast to markets list)

**File**: `ws/src/SubscriptionManager.ts`

```typescript
public subscribe(userId: string, subscription: string) {
    // Track: userId → [subscriptions]
    this.subscriptions.set(userId, currentSubs.concat(subscription));
    // Track: subscription → [userIds]
    this.reverseSubscriptions.set(subscription, [...].concat(userId));
    
    // Only subscribe to Redis if first user for this channel
    if (this.reverseSubscriptions.get(subscription)?.length === 1) {
        this.redisClient.subscribe(subscription, this.redisCallbackHandler);
    }
}
```

**The deduplication insight**: if 5000 browsers are watching SOL/USDC, we only subscribe to Redis ONCE for `"trade.SOL_USDC"`. The single callback then loops over all 5000 users. This is far more efficient than 5000 separate Redis subscriptions.

```typescript
private redisCallbackHandler = (message: string, channel: string) => {
    const parsedMessage = JSON.parse(message);
    const subscribers = this.reverseSubscriptions.get(channel);
    
    subscribers?.forEach(userId => {
        const user = UserManager.getInstance().getUser(userId);
        if (user) {
            user.emit(parsedMessage);  // → ws.send(JSON.stringify(message))
        }
    });
}
```

**`userId` here is actually a connection ID** (UUID generated by `UserManager.addUser()`), not the real user ID. Each browser tab gets its own connection ID. This means one logged-in user with 3 tabs = 3 connection IDs = receives 3 copies of every message. The `SubscriptionManager.subscriptions` Map uses this connection ID as the key.

---

## Pattern 3: Queue (Engine → DB)

**File**: `engine/src/RedisManager.ts`

```typescript
public pushMessage(message: DbMessage) {
    this.client.lPush("db_processor", JSON.stringify(message));
}
```

Redis `lPush` = **Left Push** — adds to the left (front) of a list.
Redis `brPop` in DB processor = **Blocking Right Pop** — pops from the right.

This makes it a FIFO queue: first pushed = first processed. Events are written to the database in the same order they happened in the engine.

**Why not publish/subscribe for DB writes?** Pub/Sub is fire-and-forget. If the DB processor is down when a trade happens, the trade data is **lost**. A Redis list (queue) persists the messages until they're consumed. The DB processor can restart and catch up.

---

## The Singleton Pattern: Why It Appears Everywhere

```typescript
export class RedisManager {
    private static instance: RedisManager;
    
    private constructor() { /* private — can't call new RedisManager() */ }
    
    public static getInstance() {
        if (!this.instance) {
            this.instance = new RedisManager();
        }
        return this.instance;
    }
}
```

This appears in `RedisManager`, `SubscriptionManager`, `UserManager`, `AuthService`, `TicketStore`. **Why?**

A Redis connection is expensive to create (TCP handshake, auth). You don't want a new connection every time you need Redis. The Singleton ensures the entire process uses **one** connection object, created once.

`private constructor()` makes it impossible to accidentally write `new RedisManager()` somewhere — the only way to get it is `RedisManager.getInstance()`.

**Thread safety note**: Node.js is single-threaded, so there's no risk of two threads creating two instances simultaneously. In Java/Go, you'd need to add a mutex lock here.

---

## Debugging the Message Bus

### "Orders not processing, UI hangs"
```bash
# Check if engine is receiving messages
redis-cli LLEN messages        # Queue length — should be 0 if engine is running
redis-cli LRANGE messages 0 5  # Peek at first 5 messages in queue
```

### "Real-time updates not appearing in browser"
```bash
# Watch what's being published
redis-cli SUBSCRIBE trade.SOL_USDC
# Then place a trade — you should see the message appear here
```

### "DB not recording trades"
```bash
redis-cli LLEN db_processor     # How many messages pending?
redis-cli LRANGE db_processor_dlq 0 -1  # Any failed messages?
```

### "API timeout errors"
```bash
# Check if engine is alive
redis-cli LLEN messages         # Is it backed up?
# Also: the engine's console output shows each message type processed
```
