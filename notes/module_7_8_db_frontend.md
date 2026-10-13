# CEX Mastery — Module 7: The DB Processor & Database

> The DB processor is the silent accountant. Every trade that happens in memory gets permanently recorded here. It's also the source for the chart data.

---

## Why a Separate Process?

The engine processes orders at maximum speed. Writing to a database on every trade would slow it down — database writes involve:
- Network round-trip to PostgreSQL
- SQL parsing and execution
- Disk flush

That's typically 5-50ms per operation. If the engine had to wait for this, throughput would be limited to 20-200 trades per second. By decoupling into a separate process:
- Engine: pushes to Redis list (microseconds), moves on immediately
- DB processor: consumes the list independently at database speed
- If DB is slow: queue backs up in Redis. Engine keeps running.
- If DB goes down: queue accumulates. When DB recovers, processor catches up.

This is the **Producer/Consumer** pattern with Redis as the buffer.

---

## `db/src/index.ts` — Line by Line

```typescript
const pgClient = new Client({
    user:     process.env.DB_USER     || 'your_user',
    host:     process.env.DB_HOST     || 'localhost',
    database: process.env.DB_NAME     || 'my_database',
    password: process.env.DB_PASSWORD || 'your_password',
    port:     Number(process.env.DB_PORT) || 5433,
});
```

**Why `pg.Client` not `pg.Pool`?** A `Pool` manages multiple connections for high concurrency. The DB processor is single-threaded and processes one message at a time — one connection is exactly right. A pool would waste connections.

**Port 5433 not 5432**: In Docker, the host port is 5433 (mapped to container's 5432). When running outside Docker, use 5433. Inside Docker network, use 5432. The `docker-compose.yml` sets the correct env vars for each case.

---

### The Main Loop

```typescript
while (true) {
    try {
        const response = await redisClient.brPop("db_processor", 0);
        //                                                          ↑ timeout=0 means block forever
```

`timeout = 0` is different from the engine's `timeout = 1`. The engine needs to re-check `isShuttingDown` every second. The DB processor doesn't have that need — it can block forever and rely on `SIGTERM` to wake it up (the `await` will be interrupted).

Actually, `SIGTERM` won't interrupt an `await` that's waiting on Redis. The process.on('SIGTERM') handler just calls `shutdown()`. The `brPop` will keep waiting until a message arrives. This is a subtle issue — in practice, Docker wait a few seconds before SIGKILL, so it's acceptable.

---

### The Dead-Letter Queue (DLQ)

```typescript
} catch (error) {
    console.error("Error processing message:", error);
    
    try {
        const rawMsg = JSON.stringify({ error: String(error), ts: Date.now() });
        await redisClient.lPush("db_processor_dlq", rawMsg);
    } catch (dlqErr) {
        console.error("Failed to push to DLQ:", dlqErr);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));  // 1s backoff
}
```

**What the DLQ does**: Instead of silently dropping failed messages (which would mean losing trade data), they're pushed to a "dead-letter queue" — a separate Redis list for inspection.

**Why 1 second sleep on error?** If the DB is down, every message will fail. Without the sleep, the loop would spin at 10,000+ iterations per second, flooding the logs and wasting CPU. 1 second pause = manageable retry rate.

**Inspecting the DLQ:**
```bash
redis-cli LRANGE db_processor_dlq 0 -1
# Returns all failed messages as JSON strings
```

**Replaying DLQ messages** (manual recovery):
```bash
# Move first DLQ message back to main queue
redis-cli LMOVE db_processor_dlq db_processor RIGHT LEFT
```

---

### `handleTradeAdded()` — Writing Trades to TimescaleDB

```typescript
async function handleTradeAdded(data) {
    const query = `
        INSERT INTO sol_prices (time, price, volume, currency_code, is_buyer_maker)
        VALUES ($1, $2, $3, $4, $5)
    `;
    await pgClient.query(query, [timestamp, price, quantity, market, isBuyerMaker]);
}
```

**`$1, $2, $3...`**: Parameterized query. The values are passed separately, never string-concatenated into the SQL. This prevents SQL injection — if `price` were `"0; DROP TABLE sol_prices"`, the DB would try to insert the literal string, not execute the SQL.

**TimescaleDB**: `sol_prices` is a **hypertable** — a TimescaleDB abstraction that partitions data by time automatically. Under the hood, it creates a new partition (called a "chunk") every interval (e.g., 1 week). Queries for recent data only touch recent partitions, not the entire table.

**Continuous Aggregates** (defined in the seed SQL, read from the DB):
```sql
-- This view is auto-maintained by TimescaleDB
CREATE MATERIALIZED VIEW klines_1m
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 minute', time) AS bucket,
    first(price, time) AS open,
    max(price) AS high,
    min(price) AS low,
    last(price, time) AS close,
    sum(volume) AS volume,
    currency_code
FROM sol_prices
GROUP BY bucket, currency_code;
```

Every time a new row is inserted into `sol_prices`, TimescaleDB automatically updates these views. The 1m, 5m, 15m, 1h, 4h, 1d, 1w candlestick data is always fresh — no cron jobs, no manual refresh.

When the frontend requests chart data:
```
GET /api/v1/klines?market=SOL_USDC&interval=1h&startTime=...&endTime=...
```
The API queries `klines_1h` directly — already aggregated, extremely fast.

---

### `handleOrderUpdate()` — The Upsert Pattern

```typescript
async function handleOrderUpdate(data) {
    const checkQuery = 'SELECT * FROM orders WHERE order_id = $1';
    const existingOrder = await pgClient.query(checkQuery, [orderId]);
    
    if (existingOrder.rows.length > 0) {
        // Update existing order's executedQty
        await pgClient.query(`UPDATE orders SET executed_qty = $1, updated_at = NOW() WHERE order_id = $2`, 
            [executedQty, orderId]);
    } else {
        // Insert new order
        await pgClient.query(`INSERT INTO orders (...) VALUES (...)`, [...]);
    }
}
```

**Why this pattern?** When an order is created in the engine, two DB messages are sent:
1. `ORDER_UPDATE` for the new order (contains all fields: market, price, quantity, side, userId)
2. `ORDER_UPDATE` for each resting order that was partially/fully filled (only orderId + executedQty)

The SELECT → branch handles both cases: new orders get inserted, existing orders get their fill amount updated.

**A note on consistency**: The engine sends these messages and moves on. The DB processor might process them with a small delay. During that window, the DB doesn't reflect the latest state. This is **eventual consistency** — the engine is the source of truth; the DB eventually catches up.

---

# CEX Mastery — Module 8: The Frontend

> The frontend is a real-time data display machine. It receives live data via WebSocket and renders it efficiently. Understanding it requires understanding React's lifecycle, Zustand state, and the WebSocket client.

---

## The Architecture

```
Browser
  │
  ├─ SignalingManager (Singleton)    ← One WS connection, shared by all components
  │    └─ Callbacks map              ← Components register/deregister here
  │
  ├─ Zustand Stores                  ← Global reactive state
  │    ├─ useAuthStore               ← User session, tokens
  │    ├─ useThemeStore              ← Dark/light mode
  │    └─ useMarketStore             ← Current market selection
  │
  ├─ httpClient.ts                   ← REST API calls (Promise-based)
  │
  └─ ChartManager.ts                 ← Wraps lightweight-charts library
```

---

## `SignalingManager.ts` — The WebSocket Client Singleton

### State Fields

```typescript
private ws: WebSocket | null = null;
private bufferedMessages: any[] = [];
// ↑ Messages sent while WS was connecting/disconnected
// Flushed when connection opens

private callbacks: Record<string, [Function, string][]> = {};
// ↑ { "trade.SOL_USDC": [[fn1, "id1"], [fn2, "id2"]] }
// Multiple components can subscribe to same stream

private subscriptions: Set<string> = new Set();
// ↑ All active stream subscriptions
// Used to RE-SUBSCRIBE after reconnection

private initialized: boolean = false;
// ↑ true only after AUTH_SUCCESS (or connection open if not logged in)
```

---

### Connection Lifecycle

```typescript
private connect() {
    this.ws = new WebSocket(wsBaseUrl);
    this.init();  // Attach event handlers
}
```

```typescript
this.ws.onopen = () => {
    this.reconnectAttempts = 0;  // Reset counter on success
    
    if (!isAuthenticated()) {
        this.initialized = true;      // Guests: immediately ready
        this.flushPendingMessages();   // Send buffered subscriptions
        return;
    }
    
    this.authenticateSocket();  // Logged-in users: get a ticket first
};
```

**Why `initialized = true` AFTER auth, not after `onopen`?**
The server won't accept `SUBSCRIBE` messages before authentication. If a component subscribes to `trade.SOL_USDC` before auth completes, we'd buffer those `SUBSCRIBE` messages. After `AUTH_SUCCESS`, `flushPendingMessages()` sends them all.

---

### Authentication Flow

```typescript
private async authenticateSocket() {
    const { ticket } = await getWsTicket();
    //                         ↑ POST /auth/ws-ticket → gets a 60-second one-time UUID
    
    this.ws.send(JSON.stringify({ method: "AUTH", params: { ticket } }));
    // ↑ Server verifies ticket in Redis, responds with AUTH_SUCCESS
}
```

`getWsTicket()` is an HTTP call to the API. It requires a valid access token (from `useAuthStore`). The response is a UUID that can only be used once and expires in 60 seconds.

---

### Reconnection Strategy

```typescript
this.ws.onclose = () => {
    this.initialized = false;
    this.handleReconnect();
};

private handleReconnect() {
    if (this.reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) return;
    
    this.reconnectAttempts++;
    this.reconnectTimeout = setTimeout(() => {
        this.connect();
    }, WS_RECONNECT_DELAY);
}
```

After reconnection, `flushPendingMessages()` is called, which re-sends all current `subscriptions` to the server:
```typescript
private flushPendingMessages() {
    this.bufferedMessages.forEach(m => this.ws?.send(JSON.stringify(m)));
    this.bufferedMessages = [];
    
    this.subscriptions.forEach(sub => {
        this.ws?.send(JSON.stringify({ method: "SUBSCRIBE", params: [sub] }));
    });
}
```

**This is critical**: after a reconnect, the WS server has no memory of what you were subscribed to. The `subscriptions` Set is the client's record of "what I should be watching." It re-subscribes automatically.

---

### The Callback System

```typescript
public registerCallback(type: string, callback: Function, id: string) {
    this.callbacks[type] = this.callbacks[type] || [];
    // Deregister same id first (prevent duplicate registration)
    this.callbacks[type] = this.callbacks[type].filter(([, cbId]) => cbId !== id);
    this.callbacks[type].push([callback, id]);
}

public deRegisterCallback(type: string, id: string) {
    this.callbacks[type] = this.callbacks[type].filter(([, cbId]) => cbId !== id);
}
```

**`id` serves as an idempotency key** — registering the same callback ID twice replaces the old one. Without this, React's `useEffect` would register a new callback every render without removing the old one.

**How components use it:**
```typescript
// In TradeView.tsx:
useEffect(() => {
    const sm = SignalingManager.getInstance();
    
    sm.registerCallback(`trade.${market}`, (trade) => {
        // Update chart with new trade
        updateCurrentCandle(trade.price);
    }, `TRADE-${market}`);  // ID is unique per market
    
    sm.sendMessage({ method: "SUBSCRIBE", params: [`trade.${market}`] });
    
    return () => {
        // Cleanup when component unmounts or market changes
        sm.deRegisterCallback(`trade.${market}`, `TRADE-${market}`);
        sm.sendMessage({ method: "UNSUBSCRIBE", params: [`trade.${market}`] });
    };
}, [market]);
```

**The `return () => {}` in `useEffect`** is the cleanup function. React calls it when:
- The component unmounts (navigating away)
- The dependency array changes (`market` changes → old cleanup runs, new effect runs)

Without this cleanup: old callbacks pile up → multiple callbacks fire on each message → chart updates multiple times → bugs.

---

### Message Parsing

```typescript
this.ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    // Auth messages
    if (message.type === "AUTH_SUCCESS") { ... }
    
    // Stream messages
    if (message.stream && message.data) {
        const [type, ...rest] = message.stream.split('.');
        const symbol = rest.join('.');  // Handles "SOL_USDC" with dots
        
        switch (type) {
            case 'ticker': this.triggerCallbacks(`ticker.${symbol}`, message.data); break;
            case 'depth':  this.triggerCallbacks(`depth.${symbol}`, message.data);  break;
            case 'trade': {
                const trade = normalizeTradeMessage(message.data);
                if (trade) this.triggerCallbacks(`trade.${symbol}`, trade);
                break;
            }
        }
    }
};
```

**`normalizeTradeMessage`** handles field name variations. The WS server sends `price`, `quantity`, `isBuyerMaker`. But it also supports Binance-compatible format (`p`, `q`, `m`). The normalizer accepts both — useful if you ever want to swap the data source.

---

## `ChartManager.ts` — The Chart Engine

### Why `lightweight-charts`?

TradingView's `lightweight-charts` library is specifically designed for financial data:
- Hardware-accelerated canvas rendering (not SVG) — can render thousands of candles smoothly
- Built-in support for candlestick, line, area, bar series
- Time-aware: understands Unix timestamps, handles gaps correctly

### Initialization

```typescript
export class ChartManager {
    private chart: IChartApi;
    private series: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
    private lastUpdateTime: UTCTimestamp = 0 as UTCTimestamp;
    
    constructor(container: HTMLElement, data: KLine[], layout: {background: string, color: string}, type: ChartType = "candlestick") {
        this.chart = createChart(container, {
            layout: { background: { color: layout.background }, textColor: layout.color },
            width: container.clientWidth,
            height: container.clientHeight,
            ...
        });
        
        if (type === "line") {
            this.series = this.chart.addLineSeries({ color: "#F0B90B" });
            this.series.setData(data.map(d => ({ time: d.startTime, value: d.close })));
        } else {
            this.series = this.chart.addCandlestickSeries({ ... });
            this.series.setData(data.map(d => ({ ...d, time: d.startTime })));
        }
    }
```

The chart is attached to a real DOM element (`container`). `width: container.clientWidth` makes it fill its parent. This is why the container div must have explicit dimensions in CSS.

### Real-time Updates

```typescript
update(updatedCandle: KLine) {
    if (this.lastUpdateTime === updatedCandle.startTime) {
        // Same candle: update current bar
        this.series.update({
            time: updatedCandle.startTime,
            open: updatedCandle.open,
            high: updatedCandle.high,
            low: updatedCandle.low,
            close: updatedCandle.close,
        });
    } else {
        // New time bucket: add new bar
        this.lastUpdateTime = updatedCandle.startTime;
        this.series.update({ time: updatedCandle.startTime, ... });
    }
}
```

`series.update()` is lightweight-charts' incremental update. It only re-renders the most recent candle (O(1)) rather than re-drawing the entire chart (O(n)).

---

## The TradeView + Chart Data Flow (Complete)

```
1. Component mounts: useEffect fires
2. Fetch klines from API: GET /api/v1/klines?market=SOL_USDC&interval=1h
3. Initialize ChartManager with historical klines
4. Subscribe to trade.SOL_USDC via SignalingManager
5. Every trade arrives via WebSocket:
   a. Parse trade price
   b. Compute bucket = floor(tradeTime / intervalMs) * intervalMs
   c. If bucket === currentCandle.time: update (high, low, close)
   d. If bucket > currentCandle.time: new candle started → chartManager.update(newCandle)
6. Component unmounts: unsubscribe, destroy ChartManager
```

### The Bucket Calculation

```typescript
function bucketTimestamp(unixSeconds: number, interval: string): UTCTimestamp {
    const intervalMs = INTERVAL_TO_MS[interval] / 1000;  // In seconds
    return Math.floor(unixSeconds / intervalMs) * intervalMs as UTCTimestamp;
}
```

Example with 1h interval:
```
Trade at 14:37:45 UTC = 1735900665 unix seconds
intervalMs = 3600 seconds
floor(1735900665 / 3600) * 3600 = floor(482194.6...) * 3600 = 482194 * 3600 = 1735898400
= 14:00:00 UTC ← The 14:00 candle
```

All trades between 14:00:00 and 14:59:59 map to the same bucket time (14:00:00). This is how OHLCV candles are built from raw trades.

---

## Zustand Stores — React State Done Right

### Why Zustand, not useState?

`useState` is local to a component. To share state between unrelated components (e.g., the Appbar showing the user's name while the OrderForm checks their balance), you'd need **prop drilling** (passing data through many component levels) or React Context.

Zustand gives you a **global store** that any component can read from or update, without the boilerplate of Redux.

```typescript
// useAuthStore.ts
export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            user: null,
            accessToken: null,
            isLoggedIn: false,
            
            setUser: (user) => set({ user, isLoggedIn: true }),
            setAccessToken: (token) => set({ accessToken: token }),
            logout: () => set({ user: null, accessToken: null, isLoggedIn: false }),
        }),
        { name: "auth-storage", storage: createJSONStorage(() => sessionStorage) }
        //                              ↑ Persists to sessionStorage — survives refresh,
        //                                but cleared when tab is closed
    )
);
```

**`persist` middleware**: wraps the store so state is automatically saved to and loaded from storage. When the page refreshes, the store rehydrates from sessionStorage. Users stay logged in across page refreshes.

**Why sessionStorage not localStorage?** Access tokens should expire when the browser tab is closed. sessionStorage is cleared when the tab closes. localStorage persists indefinitely — a security risk if someone uses a shared computer.

---

## Debugging the Frontend

### "WebSocket messages not reaching components"

```javascript
// Add to browser console:
const sm = SignalingManager.getInstance();
sm.registerCallback("trade.SOL_USDC", (data) => console.log("TRADE:", data), "debug-1");
// You should see trades logged. If not, WS is not receiving data.
```

### "Chart not updating with live prices"

Add a log in the `useEffect` trade callback:
```typescript
sm.registerCallback(`trade.${market}`, (trade) => {
    console.log("📈 Trade received:", trade.price, "bucket:", bucketTimestamp(...));
    // Is this being called? Is the bucket calculation correct?
}, `TRADE-CHART-${market}`);
```

### "Order placed successfully but balance not updated"

Balance refresh happens via `GET /api/v1/balances` (REST). Check if the component is re-fetching after order success. In `SwapUI.tsx`, the success callback should trigger a balance refresh.

### "Old trades appear after switching markets"

The `market` is a dependency in the `useEffect`. When it changes:
1. Cleanup function runs → unsubscribes from old market, deregisters callbacks
2. Effect runs again → subscribes to new market, fetches new klines

If you see stale data: check that `market` is in the dependency array and the cleanup is correctly removing callbacks.
