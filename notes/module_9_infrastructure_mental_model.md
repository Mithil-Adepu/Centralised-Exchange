# CEX Mastery — Module 9: Infrastructure & The Full Mental Model

> After this module, you will have a complete mental model of the entire system. You'll be able to trace any bug from browser to database and back.

---

## Docker Compose — The Orchestration Layer

Each service runs in its own container. Containers communicate via Docker's internal network, not via `localhost`.

```yaml
services:
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
```

**`healthcheck`**: Docker polls the container every 5 seconds. Other services with `depends_on: condition: service_healthy` won't start until this passes. Without this, the engine might start before Redis is ready, fail to connect, and crash.

---

### Network Communication

```yaml
# In api service:
environment:
  REDIS_URL: redis://redis:6379      # NOT localhost
  DB_HOST: postgres

# In engine service:
environment:
  REDIS_URL: redis://redis:6379
```

**Docker internal DNS**: every service name becomes a resolvable hostname inside the Docker network. `redis` resolves to the Redis container's IP. `postgres` resolves to the PostgreSQL container's IP.

**Why 6379, not 6380?** Inside the Docker network, containers communicate on the container's **internal** port. The `ports: "6380:6379"` mapping exposes 6380 on your **host machine** (so you can use `redis-cli` from your Mac/PC), but other containers use the internal port 6379.

---

### `depends_on` — Startup Order

```yaml
engine:
  depends_on:
    redis:
      condition: service_healthy  # Wait for Redis healthcheck to pass
    
api:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
```

**Without `depends_on`**: Docker starts all containers simultaneously. The API might start before PostgreSQL is ready, fail to connect, and crash immediately. With `depends_on`, Docker enforces a safe startup sequence.

**Note**: `depends_on` only waits for the container to be healthy, not for the app inside to be fully initialized. Your app still needs retry logic for connections.

---

### Environment Strategy: Three Files

| File | Purpose | Committed to Git? |
|------|---------|------------------|
| `.env.example` | Template with all variables, no values | ✅ Yes |
| `.env.docker` | Values for Docker Compose | ❌ No (in .gitignore) |
| `.env` | Values for local development | ❌ No |

**Never commit `.env` files** — they contain real secrets (JWT secrets, DB passwords). If committed, anyone with repo access has your credentials. The `.env.example` acts as documentation.

**The `docker-compose.yml` loads `.env.docker`:**
```yaml
env_file:
  - .env.docker
```

Each service can also override specific variables in its own `environment:` block.

---

## The Rate Limiter — How It Works

**File**: `api/src/middleware/rateLimit.ts`

```typescript
export function createRateLimiter({ keyPrefix, max, windowSeconds, keyGenerator }) {
    return async function(req: Request, res: Response, next: NextFunction) {
        const key = `${keyPrefix}:${keyGenerator(req)}`;
        //  e.g.  "rl:klines:read:192.168.1.1"
        
        const current = await redis.incr(key);   // Atomically increment counter
        if (current === 1) {
            await redis.expire(key, windowSeconds); // First hit: set TTL
        }
        
        if (current > max) {
            res.setHeader("X-RateLimit-Limit", max);
            res.setHeader("X-RateLimit-Remaining", 0);
            res.setHeader("Retry-After", windowSeconds);
            return res.status(429).json({ error: "Too many requests" });
        }
        
        res.setHeader("X-RateLimit-Remaining", max - current);
        next();
    };
}
```

**Why Redis `INCR` for rate limiting?**

`INCR` is atomic — it increments a value and returns the result in a single operation. If two requests arrive simultaneously:
- Request A: INCR → 1 (first, gets count=1)
- Request B: INCR → 2 (second, gets count=2)
- Both get their actual position — no lost counts

If you used GET + SET (non-atomic), two simultaneous requests could both GET "0", both SET "1", and both think they're the first request. The count would be wrong.

**`expire` on first hit**: the TTL is set when the counter is created (count = 1). After `windowSeconds`, Redis deletes the key automatically, resetting the counter. No cron job needed.

**The `X-RateLimit-*` headers**: standard HTTP headers that tell clients how many requests they have left. Well-behaved clients can backoff gracefully before hitting 429.

---

## Ports Reference

| Service | Internal Port | Host Port | Use |
|---------|--------------|-----------|-----|
| Next.js frontend | 3000 | 3000 | Browser access |
| API server | 9000 | 9000 | REST API |
| WS server | 3001 | 3001 | WebSocket |
| Redis | 6379 | 6380 | `redis-cli` from host |
| PostgreSQL | 5432 | 5433 | DB clients from host |

---

## The Complete System Mental Model

This is the most important diagram to have in your head:

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (Next.js)                        │
│                                                                  │
│  ┌─────────────────┐    ┌───────────────────────────────────┐  │
│  │  HTTP (REST)    │    │  WebSocket (real-time)            │  │
│  │  httpClient.ts  │    │  SignalingManager.ts (singleton)   │  │
│  └────────┬────────┘    └──────────────────┬────────────────┘  │
└───────────┼──────────────────────────────────┼──────────────────┘
            │ HTTP :9000                       │ WS :3001
            ▼                                  ▼
┌───────────────────────┐       ┌─────────────────────────────┐
│    API Server         │       │     WebSocket Server         │
│    (Express)          │       │     (ws library)             │
│                       │       │                              │
│  • Auth routes        │       │  • UserManager               │
│  • Order routes       │       │  • SubscriptionManager       │
│  • Kline routes       │       │  • TicketStore               │
│  • Depth routes       │       │  • Heartbeat (ping/pong)     │
│  • Auth middleware    │       │                              │
│  • Rate limiter       │       └──────────────┬───────────────┘
│  • RedisManager       │                      │
└──────────┬────────────┘                      │ Redis SUBSCRIBE
           │                                   │ (depth/trade/ticker)
           │ Redis lPush("messages")           │
           ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                           REDIS                                  │
│                                                                  │
│  Lists:          "messages"        ← API → Engine requests      │
│                  "db_processor"    ← Engine → DB writes         │
│                  "db_processor_dlq"← Failed DB messages          │
│                                                                  │
│  Pub/Sub:        "trade.SOL_USDC"  ← Engine → WS               │
│                  "depth.SOL_USDC"  ← Engine → WS               │
│                  "ticker.SOL_USDC" ← Engine → WS               │
│                  "ticker.all"      ← Engine → WS               │
│                  "{clientId}"      ← Engine → API (response)   │
│                                                                  │
│  Keys (TTL):     "session:{id}"    ← Auth sessions             │
│                  "ws:ticket:{id}"  ← WS one-time tickets       │
│                  "otp:verify:{email}" ← Email OTPs             │
│                  "rl:{prefix}:{ip}" ← Rate limit counters      │
└─────────────────────────────────────────────────────────────────┘
           │ brPop("messages")                  │
           ▼                                    │ lPush("db_processor")
┌─────────────────────────┐          ▼
│      Engine             │   ┌─────────────────────────┐
│                         │   │     DB Processor         │
│  • Orderbook (in-mem)  │   │                         │
│  • Balances (in-mem)   │   │  • Consumes db_processor │
│  • Snapshot to disk    │   │  • Writes to PostgreSQL  │
│  • RedisManager:       │   │  • DLQ for failures      │
│    - sendToApi()       │   │                         │
│    - publishMessage()  │   └────────────┬────────────┘
│    - pushMessage()     │                │
└─────────────────────────┘                │
                                          │ SQL
                                          ▼
                             ┌────────────────────────┐
                             │     TimescaleDB         │
                             │     (PostgreSQL)        │
                             │                        │
                             │  • sol_prices          │
                             │  • klines_1m/5m/...    │
                             │  • orders              │
                             │  • users               │
                             │  • sessions            │
                             └────────────────────────┘
```

---

## The Six Most Important Things to Know

### 1. The Engine is the Single Source of Truth

All balances and open orders live in the engine's memory. The database is a read-optimized copy. If the DB says a user has $500 but the engine says $600, the engine is correct.

### 2. Redis is the Nervous System

All inter-service communication goes through Redis. If Redis goes down, the entire system stops processing new orders (engine can't receive messages), real-time updates stop (WS server can't receive publishes), and auth stops working (session lookups fail).

### 3. Everything Asynchronous to DB is Eventual

When a trade executes, the engine updates its in-memory state instantly. The DB write happens asynchronously. For a brief moment (~milliseconds), the DB doesn't reflect the trade. This is fine for an exchange — the engine is authoritative for anything real-time. The DB serves history and analytics.

### 4. WebSocket Auth Uses One-Time Tickets

You can't send a JWT over WebSocket in a URL (it would appear in logs). Instead: get a 60-second ticket from the API (HTTP, fully secured), send the ticket over WS, server validates and discards it. The ticket can only be used once.

### 5. The Scaling Bottleneck is the Engine

Everything else (API, WS, DB Processor) can be horizontally scaled (run multiple instances). The engine cannot — it's stateful and single-threaded by design. To scale it, you'd need to partition markets across multiple engine instances (different engine handles SOL, BTC, ETH...).

### 6. Precision Never Compromises

All financial math uses scaled integers internally. The boundary between scaled and decimal happens in exactly two places: `toScaledFromDecimal` (user input → engine) and `fromScaledToDecimal` (engine → API/frontend). Never do financial math with floats.

---

## Complete Debugging Flowchart

### Order not executing

```
User places order → API → (no response?) → Check Redis LLEN messages
                                           → Engine down? Check engine logs
                                          
                  → API → order placed → Check engine logs for "Insufficient funds"
                                      → Check engine balances via GET /api/v1/balances
                                      → Check orderbook via GET /api/v1/depth
```

### Real-time data not updating

```
Missing updates → Check browser WS tab in DevTools (Network)
                → Are messages arriving? 
                  Yes → Bug in callback registration (check deRegisterCallback)
                  No  → redis-cli SUBSCRIBE trade.SOL_USDC
                        → Messages here? 
                          Yes → WS server bug
                          No  → Engine not publishing (check engine logs)
```

### Chart data wrong/missing

```
Wrong chart → Check GET /api/v1/klines response in Network tab
           → Are values correct?
             No  → TimescaleDB data issue (query klines_1h directly)
             Yes → ChartManager.ts parsing issue
```

### Authentication failing

```
Login fails → Check for "Invalid credentials" (wrong password)
           → Check for lockout message (too many attempts)
           → Check API logs for bcrypt errors (DB connection?)
           
Token invalid → Check token expiry (jwt.io to decode)
             → Check ACCESS_TOKEN_SECRET matches between API restarts
             
WS auth failing → Check ticket TTL (60s) — was it used fast enough?
               → Check redis-cli GET ws:ticket:{uuid}
```

### Database not recording

```
Trades not in DB → redis-cli LLEN db_processor (queue backing up?)
                → redis-cli LRANGE db_processor_dlq 0 -1 (errors?)
                → Check DB processor logs
                → Check PostgreSQL connection from DB processor
```

---

## What You Should Now Be Able to Do

After studying all 9 modules, you should be able to:

1. **Open any file** in the codebase and understand what every function does and why
2. **Trace a request** from browser click → API → Redis → Engine → Redis → API → browser
3. **Trace a real-time update** from trade execution → Redis PUBLISH → WS server → browser
4. **Diagnose any bug** using the debugging guides — check Redis, check logs, check the right layer
5. **Modify any feature** — add a new order type, a new auth flow, a new chart type — because you understand the patterns
6. **Explain the design decisions** — why single-threaded engine, why two-token auth, why scaled integers, why separate processes

You built this system. Now you understand it.
