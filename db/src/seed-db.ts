import { Client } from "pg";
import * as crypto from "crypto";

const client = new Client({
    user: process.env.DB_USER || "your_user",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "my_database",
    password: process.env.DB_PASSWORD || "your_password",
    port: Number(process.env.DB_PORT) || 5432,
});

/* ─── Kline intervals for materialized view generation ─── */
const KLINE_INTERVALS = [
    { name: "klines_1m", bucket: "1 minute" },
    { name: "klines_5m", bucket: "5 minutes" },
    { name: "klines_15m", bucket: "15 minutes" },
    { name: "klines_1h", bucket: "1 hour" },
    { name: "klines_4h", bucket: "4 hours" },
    { name: "klines_1d", bucket: "1 day" },
    { name: "klines_1w", bucket: "1 week" },
];

/* ─── Pre-computed bcrypt hash for the seeded demo password "Test1234!" ─── */
// The db container has no bcrypt dep, so we hardcode a bcrypt hash the API's
// bcryptjs can verify. Verified: bcryptjs.compareSync("Test1234!", HASH) === true.
// (The previous hardcoded value did NOT match "Test1234!" — login always failed.)
const TEST_USER_PASSWORD_HASH = "$2a$10$T0Wyl2KiVY1v.UYI3cnYb.kJTUS/exuFukMIgZtscVH9aawBN.snW";

async function initializeDB() {
    await client.connect();

    // Drop materialized views first (they depend on sol_usdc_prices)
    for (const { name } of KLINE_INTERVALS) {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${name} CASCADE;`);
    }
    console.log("Dropped existing materialized views");

    // Auth tables
    await client.query(`
        DROP TABLE IF EXISTS auth_sessions CASCADE;
        DROP TABLE IF EXISTS user_roles CASCADE;
        DROP TABLE IF EXISTS roles CASCADE;
        DROP TABLE IF EXISTS users CASCADE;

        CREATE TABLE users(
            id              UUID PRIMARY KEY,
            email           TEXT NOT NULL UNIQUE,
            password_hash   TEXT NOT NULL,
            email_verified  BOOLEAN NOT NULL DEFAULT false,
            status          TEXT NOT NULL DEFAULT 'active',
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE roles(
            id              SERIAL PRIMARY KEY,
            name            TEXT NOT NULL UNIQUE
        );

        CREATE TABLE user_roles(
            user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, role_id)
        );

        CREATE TABLE auth_sessions(
            session_id          UUID PRIMARY KEY,
            user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            refresh_token_hash  TEXT NOT NULL,
            ip_address          TEXT,
            user_agent          TEXT,
            created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at          TIMESTAMP WITH TIME ZONE NOT NULL
        );

        CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
        
        DROP TABLE IF EXISTS fiat_deposits CASCADE;
        CREATE TABLE fiat_deposits(
            id              SERIAL PRIMARY KEY,
            user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            order_id        TEXT NOT NULL UNIQUE,
            payment_id      TEXT,
            amount          DOUBLE PRECISION NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX idx_fiat_deposits_user ON fiat_deposits(user_id);
        CREATE INDEX idx_fiat_deposits_order ON fiat_deposits(order_id);
    `);

    await client.query(`
        INSERT INTO roles (name)
        VALUES ('user'), ('admin')
        ON CONFLICT DO NOTHING;
    `);
    console.log("Created auth tables");

    // Seed test user: trader@cex.io / Test1234!
    // Engine assigns this user id "9" in snapshot.json for wallet balances
    const testUserId = "00000000-0000-0000-0000-000000000009";
    
    // Seed virtual traders (UUIDs match engine & mm)
    const mmUser = "00000000-0000-0000-0000-000000000005";
    const momUser = "00000000-0000-0000-0000-000000000006";
    const revUser = "00000000-0000-0000-0000-000000000007";
    const scalpUser = "00000000-0000-0000-0000-000000000008";

    // Extra human demo profiles — all share the password "Test1234!".
    // Their UUIDs match the starting balances seeded in engine setBaseBalances().
    const aliceUser = "00000000-0000-0000-0000-000000000010";
    const bobUser = "00000000-0000-0000-0000-000000000011";
    const carolUser = "00000000-0000-0000-0000-000000000012";
    const trader2User = "00000000-0000-0000-0000-000000000013";
    const trader3User = "00000000-0000-0000-0000-000000000014";

    const usersToInsert = [
        [testUserId, "trader@cex.io"],
        [mmUser, "mm@cex.io"],
        [momUser, "momentum@cex.io"],
        [revUser, "reverter@cex.io"],
        [scalpUser, "scalper@cex.io"],
        [aliceUser, "alice@cex.io"],
        [bobUser, "bob@cex.io"],
        [carolUser, "carol@cex.io"],
        [trader2User, "trader2@cex.io"],
        [trader3User, "trader3@cex.io"],
    ];

    for (const [id, email] of usersToInsert) {
        await client.query(`
            INSERT INTO users (id, email, password_hash, email_verified, status)
            VALUES ($1, $2, $3, true, 'active')
            ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, email_verified = true;
        `, [id, email, TEST_USER_PASSWORD_HASH]);
        
        // Assign 'user' role
        await client.query(`
            INSERT INTO user_roles (user_id, role_id)
            SELECT $1, id FROM roles WHERE name = 'user'
            ON CONFLICT DO NOTHING;
        `, [id]);
    }

    console.log("✅ Login profiles created (password: Test1234!):");
    console.log("   trader@cex.io, trader2@cex.io, trader3@cex.io, alice@cex.io, bob@cex.io, carol@cex.io");

    // Trade prices hypertable — renamed to sol_usdc_prices
    await client.query(`
        DROP TABLE IF EXISTS "sol_usdc_prices" CASCADE;
        CREATE TABLE "sol_usdc_prices"(
            time            TIMESTAMP WITH TIME ZONE NOT NULL,
            trade_id        TEXT NOT NULL,
            price           DOUBLE PRECISION,
            volume          DOUBLE PRECISION,
            currency_code   VARCHAR (10),
            is_buyer_maker  BOOLEAN NOT NULL DEFAULT false,
            PRIMARY KEY (time, trade_id)
        );
        SELECT create_hypertable('sol_usdc_prices', 'time');
    `);
    console.log("Created sol_usdc_prices hypertable");

    // Orders table
    await client.query(`
        DROP TABLE IF EXISTS "orders" CASCADE;
        CREATE TABLE "orders"(
            order_id        VARCHAR(50) PRIMARY KEY,
            user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            market          VARCHAR(20) NOT NULL,
            price           VARCHAR(20) NOT NULL,
            quantity        VARCHAR(20) NOT NULL,
            side            VARCHAR(10) NOT NULL,
            executed_qty    DOUBLE PRECISION NOT NULL,
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX idx_orders_market ON orders(market);
        CREATE INDEX idx_orders_user ON orders(user_id);
        CREATE INDEX idx_orders_created_at ON orders(created_at);
    `);
    console.log("Created orders table");

    // Create all kline materialized views via loop
    for (const { name, bucket } of KLINE_INTERVALS) {
        await client.query(`
            CREATE MATERIALIZED VIEW ${name} AS
            SELECT
                time_bucket('${bucket}', time) AS bucket,
                first(price, time) AS open,
                max(price) AS high,
                min(price) AS low,
                last(price, time) AS close,
                sum(volume) AS volume,
                currency_code
            FROM sol_usdc_prices
            GROUP BY bucket, currency_code;
        `);
        // A UNIQUE index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY.
        // Without it, the concurrent refresh throws and the fallback takes an
        // ACCESS EXCLUSIVE lock that blocks all kline reads during refresh.
        // (bucket, currency_code) is the natural grouping key and is unique per row.
        await client.query(`CREATE UNIQUE INDEX ${name}_bucket_ccy_uidx ON ${name} (bucket, currency_code);`);
        console.log(`Created ${name} materialized view (+ unique index)`);
    }

    // Seed 30 days of historical SOL/USDC price data for charts
    await seedHistoricalPrices();

    await client.end();
    console.log("Database initialized successfully");
}

/**
 * Generates 30 days of synthetic SOL/USDC 1-minute trade data.
 * Uses a bounded random walk to simulate realistic price movement.
 */
async function seedHistoricalPrices() {
    console.log("Seeding 30 days of historical SOL/USDC price data...");

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const startMs = now - thirtyDaysMs;
    const intervalMs = 60 * 1000; // 1 minute candle = multiple trades

    // Start price around $130, end near $150 with realistic walk
    let price = 130.0;
    const tradesPerCandle = 3; // ~3 trades per minute
    const BATCH_SIZE = 1000;
    const buffer: any[][] = [];

    let tradeId = 1;

    for (let t = startMs; t < now; t += intervalMs) {
        for (let i = 0; i < tradesPerCandle; i++) {
            // Bounded random walk: drift slightly upward, ±0.3% per step
            const drift = 0.00005; // slight upward trend
            const volatility = 0.003;
            const change = drift + (Math.random() - 0.5) * volatility;
            price = Math.max(80, Math.min(300, price * (1 + change)));

            const tradeTime = new Date(t + i * (intervalMs / tradesPerCandle));
            const volume = 0.01 + Math.random() * 5; // 0.01 to 5 SOL
            const isBuyerMaker = Math.random() > 0.5;

            buffer.push([
                tradeTime.toISOString(),
                `seed-${tradeId++}`,
                price.toFixed(6),
                volume.toFixed(6),
                "SOL_USDC",
                isBuyerMaker,
            ]);

            if (buffer.length >= BATCH_SIZE) {
                await insertPriceBatch(buffer);
                buffer.length = 0;
            }
        }
    }

    // Insert remaining rows
    if (buffer.length > 0) {
        await insertPriceBatch(buffer);
    }

    console.log(`✅ Seeded ${tradeId - 1} historical trades (30 days @ 3 trades/min)`);

    // Refresh all materialized views now that data is present
    const KLINE_VIEWS = ["klines_1m", "klines_5m", "klines_15m", "klines_1h", "klines_4h", "klines_1d", "klines_1w"];
    for (const view of KLINE_VIEWS) {
        await client.query(`REFRESH MATERIALIZED VIEW ${view};`);
        console.log(`Refreshed ${view}`);
    }
}

async function insertPriceBatch(rows: any[][]) {
    if (rows.length === 0) return;

    const values: any[] = [];
    const placeholders = rows.map((row, i) => {
        const base = i * 6;
        values.push(...row);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    }).join(", ");

    await client.query(
        `INSERT INTO sol_usdc_prices (time, trade_id, price, volume, currency_code, is_buyer_maker)
         VALUES ${placeholders}
         ON CONFLICT (time, trade_id) DO NOTHING`,
        values
    );
}

initializeDB().catch(console.error);