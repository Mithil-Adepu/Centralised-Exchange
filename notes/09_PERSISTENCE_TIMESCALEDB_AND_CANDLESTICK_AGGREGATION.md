# Module 09 — Persistence Engine, TimescaleDB & Candlestick Aggregation

> **The Silent Accountant: Permanent Financial Records and Time-Series Charts**  
> *"The Matching Engine operates in RAM at microsecond speeds. However, tax authorities, regulators, traders, and candlestick charts require permanent historical records. Writing directly to a relational database inside the engine loop would destroy performance. This module examines `db/src/index.ts`, `db/src/seed-db.ts`, and TimescaleDB Hypertables line-by-line, detailing how asynchronous persistence and non-blocking continuous candlestick aggregation work."*

---

## 1. The Decoupled Producer/Consumer Pattern

The Matching Engine and the Database communicate through an asynchronous buffer:

```
┌─────────────────────────────────┐
│     MATCHING ENGINE (RAM)       │
│  - Executes trade in 200μs      │
│  - Does NOT wait for disk fsync │
└────────────────┬────────────────┘
                 │
                 │ XADD db_processor (Microsecond buffer)
                 ▼
┌─────────────────────────────────┐
│     REDIS STREAM: db_processor  │
│  - Durable buffer in Redis AOF  │
└────────────────┬────────────────┘
                 │
                 │ XREADGROUP db_group (Consumer group)
                 ▼
┌─────────────────────────────────┐
│     DB PROCESSOR WORKER         │
│  - Drains stream asynchronously │
│  - Retries transient DB outages │
│  - Dead-letters poison messages │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     TIMESCALEDB / POSTGRESQL    │
│  - Hypertables: sol_usdc_prices │
│  - Orders Table: orders         │
│  - 7 Kline Materialized Views   │
└─────────────────────────────────┘
```

### Why Decoupling is Mandatory:
- **Engine Latency**: An in-memory fill takes **$<0.5\text{ms}$**. A PostgreSQL `INSERT` takes **5ms–25ms**.
- If the engine waited for SQL queries, throughput would drop from 50,000 trades/sec to $<50$ trades/sec.
- **Fault Tolerance**: If PostgreSQL crashes, restarts, or undergoes schema migration, the stream simply accumulates in Redis. The matching engine continues trading without interruption. When PostgreSQL recovers, `db-processor` drains the backlog and catches up.

---

## 2. TimescaleDB Schema & Hypertables: `db/src/seed-db.ts`

Standard PostgreSQL tables slow down significantly as they grow past millions of rows because B-Tree indexes exceed RAM cache sizes. TimescaleDB transforms standard PostgreSQL tables into **Hypertables** partitioned automatically across time chunks.

### 2.1 The `sol_usdc_prices` Hypertable (Lines 151–166)

```sql
CREATE TABLE "sol_usdc_prices"(
    time            TIMESTAMP WITH TIME ZONE NOT NULL,
    trade_id        TEXT NOT NULL,
    price           DOUBLE PRECISION,
    volume          DOUBLE PRECISION,
    currency_code   VARCHAR (10),
    is_buyer_maker  BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (time, trade_id)
);

-- Convert to TimescaleDB Hypertable partitioned by time chunks
SELECT create_hypertable('sol_usdc_prices', 'time');

-- Automatically purge records older than 30 days to bound disk usage
SELECT add_retention_policy('sol_usdc_prices', INTERVAL '30 days');
```

#### Key Architecture Benefits:
1. **Time Chunking**: Timescale automatically splits rows into separate physical tables (chunks) based on timestamp. Inserts always write to the latest chunk, keeping active indexes hot in RAM.
2. **Automated 30-Day Retention**: Background workers drop expired chunks instantly via `DROP TABLE` at the OS file level instead of slow `DELETE FROM` vacuum queries.

---

### 2.2 The 7 Candlestick Materialized Views (Lines 187–208)

To feed TradingView candlestick charts, we aggregate raw trade ticks into standard intervals:
- `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`.

```typescript
const KLINE_INTERVALS = [
    { name: "klines_1m",  bucket: "1 minute" },
    { name: "klines_5m",  bucket: "5 minutes" },
    { name: "klines_15m", bucket: "15 minutes" },
    { name: "klines_1h",  bucket: "1 hour" },
    { name: "klines_4h",  bucket: "4 hours" },
    { name: "klines_1d",  bucket: "1 day" },
    { name: "klines_1w",  bucket: "1 week" },
];
```

#### The Aggregation SQL:
```sql
CREATE MATERIALIZED VIEW klines_1m AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    first(price, time)  AS open,   -- First price in time bucket
    max(price)          AS high,   -- Highest execution price
    min(price)          AS low,    -- Lowest execution price
    last(price, time)   AS close,  -- Last execution price
    sum(volume)         AS volume, -- Total base asset volume
    currency_code
FROM sol_usdc_prices
GROUP BY bucket, currency_code;

-- MANDATORY UNIQUE INDEX:
CREATE UNIQUE INDEX klines_1m_bucket_ccy_uidx ON klines_1m (bucket, currency_code);
```

### The Non-Blocking Concurrency Trick:
Notice lines 202–206 of `seed-db.ts`:
```typescript
await client.query(`CREATE UNIQUE INDEX ${name}_bucket_ccy_uidx ON ${name} (bucket, currency_code);`);
```
**Why is this unique index mandatory?**
- In PostgreSQL, refreshing a materialized view normally requires an `ACCESS EXCLUSIVE` table lock:
  `REFRESH MATERIALIZED VIEW klines_1m;`
  This lock blocks **all SELECT queries**. Every user loading charts in their browser would experience freezing!
- To run non-blocking refreshes without locking reads, you must use:
  `REFRESH MATERIALIZED VIEW CONCURRENTLY klines_1m;`
- PostgreSQL **strictly requires a UNIQUE index** on the view to support `CONCURRENTLY`. Without this index, `CONCURRENTLY` throws a syntax error.

---

## 3. The Stream Ingestion Loop: `db/src/index.ts`

### 3.1 Error Classification: Permanent vs. Transient (Lines 27–47)

```typescript
class PermanentError extends Error {}

function parseAndValidate(raw: string): DbMessage {
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        throw new PermanentError(`Malformed JSON: ${String(e)}`);
    }
    if (data?.type !== "TRADE_ADDED" && data?.type !== "ORDER_UPDATE") {
        throw new PermanentError(`Unknown message type: ${data?.type}`);
    }
    return data as DbMessage;
}

function isPermanent(err: unknown): boolean {
    return err instanceof PermanentError || err instanceof SyntaxError;
}
```

```
Is Error Permanent? (e.g. malformed JSON, corrupted struct)
    │
    ├─── YES ──> Dead-Letter Queue (db_processor_dlq) ──> XACK message
    │            (Advance loop; prevents consumer from crashing indefinitely)
    │
    └─── NO  ──> Transient failure (e.g. Postgres network blip, lock timeout)
                 (Do NOT XACK. Sleep 1s, retry message until DB returns!)
```

---

### 3.2 Maker Fill Accumulation: `handleOrderUpdate` (Lines 233–285)

When an order executes, `handleOrderUpdate` syncs the order state into PostgreSQL:

```typescript
async function handleOrderUpdate(data: Extract<DbMessage, { type: "ORDER_UPDATE" }>) {
    const { orderId, executedQty, market, price, quantity, side, userId } = data.data;

    const checkQuery = 'SELECT * FROM orders WHERE order_id = $1';
    const existingOrder = await pgClient.query(checkQuery, [orderId]);
    
    if (existingOrder.rows.length > 0) {
        // Maker fills arrive one ORDER_UPDATE per trade, each carrying ONLY that
        // fill's incremental quantity — so ACCUMULATE rather than overwrite!
        const updateQuery = `
            UPDATE orders
            SET executed_qty = executed_qty + $1, updated_at = NOW()
            WHERE order_id = $2
        `;
        await pgClient.query(updateQuery, [executedQty, orderId]);
    } else {
        // Insert new order row...
    }
}
```

#### The Subtlety of Partial Fills:
- Suppose Maker Bob placed a limit sell for 10 SOL.
- Taker 1 buys 2 SOL from Bob.
- Taker 2 buys 3 SOL from Bob.
- If you used `SET executed_qty = $1`, after Taker 2's fill, Bob's order record would report `executed_qty = 3` instead of $2 + 3 = 5$!
- By using `executed_qty = executed_qty + $1`, the database accumulates every incremental fill correctly.

---

## 4. Synthetic 30-Day Historical Price Generator (`seedHistoricalPrices`)

In `db/src/seed-db.ts` (lines 217–278), the platform generates 30 days of realistic synthetic market data so new installations have rich candlestick charts immediately:

```typescript
// Bounded random walk: drift slightly upward, ±0.3% per step
const drift = 0.00005; 
const volatility = 0.003;
const change = drift + (Math.random() - 0.5) * volatility;
price = Math.max(80, Math.min(300, price * (1 + change)));
```

- Simulates ~3 trades per minute ($30 \text{ days} \times 1,440 \text{ min/day} \times 3 \approx 130,000 \text{ trades}$).
- Uses batch inserts of 1,000 rows (`insertPriceBatch`) to seed the database in seconds.
- Automatically refreshes all 7 kline materialized views once seeding completes.
