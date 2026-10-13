# Module 05 — API Gateway, Routing, Middleware & The Redis RPC Bridge

> **The Public Gateway of the Financial Exchange**  
> *"The API Server is the only public HTTP entry point into the exchange platform. It must be completely stateless, horizontally scalable, violently defensive against injection and DDoS attacks, and capable of translating asynchronous message queues into synchronous HTTP responses in microseconds. This module breaks down `api/src/index.ts`, `api/src/RedisManager.ts`, and the entire route hierarchy line-by-line."*

---

## 1. The Architectural Role of the API Server

In a microservices exchange, the API server has a strict architectural boundary:
1. **100% Stateless**: It stores **zero financial state** in its own memory. All orders live in the Matching Engine, and all historical data lives in TimescaleDB.
2. **Horizontally Scalable**: Because it is stateless, you can run 1 instance or 50 instances behind an Nginx load balancer without any shared memory or synchronization issues.
3. **The Protocol Translator**: Browsers and mobile apps talk **Synchronous HTTP REST / JSON**. The matching engine talks **Asynchronous Redis Streams**. The API Server bridges these two worlds using an ephemeral Pub/Sub RPC pattern.

---

## 2. The Middleware Pipeline & Server Entry Point: `api/src/index.ts`

Let us trace the middleware sequence configured in `api/src/index.ts` (lines 30–94):

```
Client Request
      │
      ▼
1. Fail-Fast Boot Check (Refuse to run in production with placeholder secrets)
      │
      ▼
2. Proxy Trust Resolution (Prevent X-Forwarded-For IP spoofing)
      │
      ▼
3. CORS Middleware (Origin whitelist + credentials support)
      │
      ▼
4. Body Parser (express.json with strict 1MB ceiling)
      │
      ▼
5. Request ID & Structured JSON Latency Logger (UUID tracing + durationMs)
      │
      ▼
6. Enterprise Security Headers (CSP, HSTS, X-Frame-Options DENY)
      │
      ▼
7. Route Handler Chain (authenticate ──> requireRoles ──> rateLimit ──> handler)
```

---

### 2.1 Fail-Fast Security Check (Lines 30–35)

```typescript
if (process.env.NODE_ENV === "production" && !isInternalTokenConfigured(process.env.INTERNAL_SERVICE_TOKEN)) {
    console.error("FATAL: INTERNAL_SERVICE_TOKEN is missing, too short (<32 chars), or a known placeholder. Set a strong secret before running in production.");
    process.exit(1);
}
```
**Why this exists**: The Market Maker bot uses `INTERNAL_SERVICE_TOKEN` to trade on behalf of system accounts. If an operator deploys to production with the default placeholder `"change-me"`, any attacker could bypass authentication and drain the exchange! The API refuses to boot if secrets are weak.

---

### 2.2 IP Proxy Trust Configuration (Lines 37–41)

```typescript
const trustProxyEnv = process.env.TRUST_PROXY;
app.set("trust proxy", trustProxyEnv === undefined ? 0 : (/^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv === "true"));
```
**The Threat Vector**: If `trust proxy` is set to `true` indiscriminately, any malicious user can send a forged HTTP header: `X-Forwarded-For: 1.1.1.1`. The API would believe the request came from `1.1.1.1`, completely bypassing IP-based rate limiting and account lockout guards. Defaulting to `0` (or an explicit hop count) prevents header spoofing.

---

### 2.3 Request Tracing & Structured Latency Logging (Lines 54–79)

```typescript
app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startedAt = Date.now();
    res.on("finish", () => {
        if (req.path === "/health") return;

        const durationMs = Date.now() - startedAt;
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs,
            requestId,
            ip: req.ip,
        }));
    });

    next();
});
```

#### Why Structured JSON Logging Matters:
- Every request is assigned an immutable `X-Request-Id` UUID sent back to the client.
- When `res.on("finish")` fires, the exact execution latency (`durationMs`) is calculated.
- Outputs single-line JSON so log ingestors (Datadog, ElasticSearch, CloudWatch) can parse and alert on high latencies ($>50\text{ms}$) in real time.

---

### 2.4 Hardened Security Headers (Lines 81–93)

```typescript
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("X-XSS-Protection", "0"); // Modern browsers use CSP instead
    if (process.env.NODE_ENV === "production") {
        res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; ... frame-ancestors 'none'");
    }
    next();
});
```
- **`X-Frame-Options: DENY`**: Protects against clickjacking by preventing other websites from embedding the exchange inside an iframe.
- **`Strict-Transport-Security` (HSTS)**: Forces modern browsers to communicate over HTTPS only for 2 years (`max-age=63072000`).

---

## 3. The Ephemeral Redis RPC Bridge: `api/src/RedisManager.ts`

This is one of the most intellectually elegant components in the entire exchange.  
**The Problem**: HTTP is synchronous (Request $\rightarrow$ Wait $\rightarrow$ Response). Redis Streams are asynchronous (Push to Stream $\rightarrow$ Engine processes whenever ready).  
How does the API send an order to the Redis Stream, wait for the Engine to execute it, and return the result to the waiting browser?

```typescript
export class RedisManager {
    private client: RedisClientType;
    private publisher: RedisClientType;
    private static instance: RedisManager;

    public sendAndAwait(message: MessageToEngine): Promise<MessageFromOrderbook> {
        const id = this.getRandomClientId(); // e.g. "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"

        return new Promise<MessageFromOrderbook>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.client.unsubscribe(id).catch(() => {});
                reject(new Error("Engine response timeout - is the engine running?"));
            }, 10000);

            // CRITICAL PATTERN: Await the subscription BEFORE pushing to the stream!
            this.client
                .subscribe(id, (msg) => {
                    clearTimeout(timeout);
                    this.client.unsubscribe(id).catch(() => {});
                    resolve(JSON.parse(msg));
                })
                .then(() => {
                    return this.publisher.xAdd(
                        "engine_messages",
                        "*",
                        { clientId: id, data: JSON.stringify(message) },
                        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } }
                    );
                })
                .catch((err) => {
                    clearTimeout(timeout);
                    this.client.unsubscribe(id).catch(() => {});
                    reject(err);
                });
        });
    }

    public getRandomClientId() {
        return crypto.randomUUID();
    }
}
```

```
API Server                                     Redis 7.0                            Matching Engine
    │                                              │                                       │
    │ 1. Subscribe to unique channel: "uuid-1"     │                                       │
    │─────────────────────────────────────────────>│                                       │
    │                                              │                                       │
    │ 2. XADD "engine_messages" { clientId: "uuid-1", data: ... }                          │
    │─────────────────────────────────────────────>│                                       │
    │                                              │ 3. XREADGROUP engine_messages         │
    │                                              │──────────────────────────────────────>│
    │                                              │                                       │
    │                                              │                                 [Matches Order]
    │                                              │                                       │
    │                                              │ 4. PUBLISH "uuid-1" { fills: ... }    │
    │                                              │<──────────────────────────────────────│
    │ 5. Message delivered on channel "uuid-1"     │                                       │
    │<─────────────────────────────────────────────│                                       │
    │                                              │                                       │
    │ 6. Unsubscribe "uuid-1" & resolve Promise    │                                       │
    ▼                                              ▼                                       ▼
```

### The Race Condition Fix: Why Subscribe First?
Notice lines 50–57:
```typescript
this.client.subscribe(id, (msg) => { ... })
    .then(() => {
        return this.publisher.xAdd("engine_messages", ...);
    })
```
- In early implementations, code pushed to the stream with `xAdd` and immediately called `subscribe(id)` on the next line without awaiting.
- Because Node.js and Redis are asynchronous, the Matching Engine processed the trade in **0.2 milliseconds** and published the reply to `uuid-1` **before the API client had finished establishing its subscription**!
- The reply was lost in the void, and the API request hung for 10 seconds until hitting `setTimeout`.
- **The Invariant**: Always establish the receiving subscription channel first; only push to the stream once the subscription is active.

---

## 4. Route Deep Dive: Orders (`api/src/routes/order.ts`)

### 4.1 Order Placement (`POST /api/v1/order`) (Lines 35–91)

```typescript
orderRouter.post("/", authenticate, requireRoles(["user", "admin"]), orderWriteLimiter, async (req, res) => {
    try {
        const { market, price, quantity, side } = req.body;
        const userId = req.auth!.userId;

        // Input sanitization and bounds checking
        const normalizedMarket = parseMarketSymbol(market);
        const normalizedPrice = parsePositiveNumber(price, "price");
        const normalizedQuantity = parsePositiveNumber(quantity, "quantity");
        const normalizedSide = parseOrderSide(side);

        const response = await RedisManager.getInstance().sendAndAwait({
            type: CREATE_ORDER,
            data: {
                market: normalizedMarket,
                price: normalizedPrice.toString(),
                quantity: normalizedQuantity.toString(),
                side: normalizedSide,
                userId,
            }
        });

        if (response.type === "ORDER_REJECTED") {
            return res.status(400).json({ error: "Order rejected", message: response.payload.reason });
        }

        auditLog({
            event: "order.create",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: true,
            details: { market: normalizedMarket, side: normalizedSide },
        });

        res.json(response.payload);
    } catch (error: any) { ... }
});
```

#### Defensive Mechanics:
1. **Role Enforcement**: `requireRoles(["user", "admin"])` blocks guest users or unverified accounts.
2. **Rate Limiting**: `orderWriteLimiter` limits accounts to 120 order actions per minute.
3. **Rejection Handling**: If the engine returns `ORDER_REJECTED` (e.g. insufficient funds or self-trade violation), the API responds with HTTP 400 and the exact error reason.
4. **Audit Logging**: Emits an immutable audit log entry for regulatory and compliance tracking.

---

### 4.2 Open Orders vs. Order History: Memory vs. Database (Lines 151–204)

Notice how the API distinguishes between **open** orders and **historical** orders:

```typescript
// GET /api/v1/order/open ── Queries the IN-MEMORY ENGINE
orderRouter.get("/open", authenticate, requireRoles(["user", "admin"]), orderReadLimiter, async (req, res) => {
    const response = await RedisManager.getInstance().sendAndAwait({
        type: GET_OPEN_ORDERS,
        data: { userId, market }
    });
    res.json(response.payload);
});

// GET /api/v1/order/history ── Queries POSTGRESQL TABLE
orderRouter.get("/history", authenticate, requireRoles(["user", "admin"]), orderReadLimiter, async (req, res) => {
    const dbResult = await pool.query(
        'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [userId]
    );
    res.json(orders);
});
```

#### Why Two Different Data Sources?
- **Active Open Orders**: Change every millisecond as trades execute. They must be fetched from **RAM** in the Matching Engine so the user sees real-time remaining quantities.
- **Historical Orders**: Once an order is fully filled or cancelled, it is purged from the engine's memory and permanently archived in PostgreSQL. Querying PostgreSQL for history offloads read traffic from the engine!

---

## 5. Market Data Endpoints: Klines, Depth & Trades

### 5.1 Candlestick / Klines Route (`api/src/routes/kline.ts`)
TradingView candlestick charts require aggregated Open, High, Low, Close, Volume (OHLCV) bars.  
The API serves this directly from PostgreSQL **Materialized Views**:

```typescript
const INTERVAL_MAP: Record<string, string> = {
    '1m':  'klines_1m',
    '5m':  'klines_5m',
    '15m': 'klines_15m',
    '1h':  'klines_1h',
    '4h':  'klines_4h',
    '1d':  'klines_1d',
    '1w':  'klines_1w',
};

const tableName = INTERVAL_MAP[interval as string];
const query = `SELECT * FROM ${tableName} WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
const result = await pool.query(query, [
    new Date(startUnix * 1000),
    new Date(endUnix * 1000),
    normalizedMarket,
]);
```
- Because TimescaleDB pre-aggregates these candles in materialized views, this SQL query takes **$<2\text{ms}$** to return thousands of candlestick bars.

---

### 5.2 Real-Time Trades Route (`api/src/routes/trades.ts`)
Fetches the most recent public tape from the `sol_usdc_prices` hypertable:
```typescript
const query = `
    SELECT time, trade_id, price, volume as quantity, currency_code as market, is_buyer_maker
    FROM sol_usdc_prices
    WHERE currency_code = $1
    ORDER BY time DESC
    LIMIT $2
`;
```
- Notice that `trade_id` is passed as a stable string ID, allowing client-side React stores to deduplicate trades without re-rendering existing list items.

---

## 6. Input Validation & Audit Logging (`validation.ts` & `audit.ts`)

### Strict Input Sanitization (`validation.ts`):
```typescript
export function parseMarketSymbol(value: unknown) {
    const symbol = parseRequiredString(value, "market").toUpperCase();
    if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(symbol)) {
        throw new Error("market must use BASE_QUOTE format, e.g. SOL_USDC");
    }
    return symbol;
}

export function parsePositiveNumber(value: unknown, fieldName: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${fieldName} must be a positive number`);
    }
    return parsed;
}
```
- Rejects SQL injection, invalid symbols, negative prices, and non-numeric characters before any message is dispatched to Redis.
