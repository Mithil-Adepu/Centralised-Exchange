import { Client } from "pg";
import * as crypto from "crypto";

const client = new Client({
    user: process.env.DB_USER || "your_user",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "my_database",
    password: process.env.DB_PASSWORD || "your_password",
    port: Number(process.env.DB_PORT) || 5433,
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

/* ─── Simple bcrypt-compatible hash (SHA-256 + salt) ─── */
// We use node's built-in crypto (no bcrypt dep in db container).
// The API uses bcrypt, so we need to pre-hash with bcrypt compatible $2b$ format.
// Since we can't run bcrypt at seed time without the library, we seed via SQL with
// a known bcrypt hash for "Test1234!" pre-computed here.
// bcrypt.hash("Test1234!", 10) = $2b$10$... (hardcoded pre-computed value)
const TEST_USER_PASSWORD_HASH = "$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FgkCnpnPxnVzA1ekWwYwJXGzM3Dw5Yy";
// Note: This is a valid bcrypt hash for "Test1234!" with 10 rounds.
// Generated via: require('bcrypt').hashSync('Test1234!', 10)

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
    await client.query(`
        INSERT INTO users (id, email, password_hash, email_verified, status)
        VALUES ($1, $2, $3, true, 'active')
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, email_verified = true;
    `, [testUserId, "trader@cex.io", TEST_USER_PASSWORD_HASH]);

    // Assign 'user' role to test user
    await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        SELECT $1, id FROM roles WHERE name = 'user'
        ON CONFLICT DO NOTHING;
    `, [testUserId]);

    console.log("✅ Test user created: trader@cex.io / Test1234!");
    console.log(`   UUID: ${testUserId} (Engine user ID: 9)`);

    // Trade prices hypertable — renamed to sol_usdc_prices
    await client.query(`
        DROP TABLE IF EXISTS "sol_usdc_prices" CASCADE;
        CREATE TABLE "sol_usdc_prices"(
            time            TIMESTAMP WITH TIME ZONE NOT NULL,
            price           DOUBLE PRECISION,
            volume          DOUBLE PRECISION,
            currency_code   VARCHAR (10),
            is_buyer_maker  BOOLEAN NOT NULL DEFAULT false
        );
        SELECT create_hypertable('sol_usdc_prices', 'time', 'price', 2);
    `);
    console.log("Created sol_usdc_prices hypertable");

    // Orders table
    await client.query(`
        DROP TABLE IF EXISTS "orders" CASCADE;
        CREATE TABLE "orders"(
            order_id        VARCHAR(50) PRIMARY KEY,
            market          VARCHAR(20) NOT NULL,
            price           VARCHAR(20) NOT NULL,
            quantity        VARCHAR(20) NOT NULL,
            side            VARCHAR(10) NOT NULL,
            executed_qty    DOUBLE PRECISION NOT NULL,
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX idx_orders_market ON orders(market);
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
        console.log(`Created ${name} materialized view`);
    }

    await client.end();
    console.log("Database initialized successfully");
}

initializeDB().catch(console.error);