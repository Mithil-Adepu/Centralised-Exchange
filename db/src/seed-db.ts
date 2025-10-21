const { Client } = require('pg');

const client = new Client({
    user: 'your_user',
    host: 'localhost',
    database: 'my_database',
    password: 'your_password',
    port: 5432,
});

async function initializeDB() {
    await client.connect();

    // Drop materialized views FIRST (they depend on the table)
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS klines_1m CASCADE;`);
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS klines_1h CASCADE;`);
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS klines_1w CASCADE;`);
    
    console.log("Dropped existing materialized views");

    // Now drop and create tata_prices table
    await client.query(`
        DROP TABLE IF EXISTS "tata_prices" CASCADE;
        CREATE TABLE "tata_prices"(
            time            TIMESTAMP WITH TIME ZONE NOT NULL,
            price           DOUBLE PRECISION,
            volume          DOUBLE PRECISION,
            currency_code   VARCHAR (10)
        );
        
        SELECT create_hypertable('tata_prices', 'time', 'price', 2);
    `);

    console.log("Created tata_prices hypertable");

    // Create orders table
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

    // Create materialized views
    await client.query(`
        CREATE MATERIALIZED VIEW klines_1m AS
        SELECT
            time_bucket('1 minute', time) AS bucket,
            first(price, time) AS open,
            max(price) AS high,
            min(price) AS low,
            last(price, time) AS close,
            sum(volume) AS volume,
            currency_code
        FROM tata_prices
        GROUP BY bucket, currency_code;
    `);

    console.log("Created klines_1m materialized view");

    await client.query(`
        CREATE MATERIALIZED VIEW klines_1h AS
        SELECT
            time_bucket('1 hour', time) AS bucket,
            first(price, time) AS open,
            max(price) AS high,
            min(price) AS low,
            last(price, time) AS close,
            sum(volume) AS volume,
            currency_code
        FROM tata_prices
        GROUP BY bucket, currency_code;
    `);

    console.log("Created klines_1h materialized view");

    await client.query(`
        CREATE MATERIALIZED VIEW klines_1w AS
        SELECT
            time_bucket('1 week', time) AS bucket,
            first(price, time) AS open,
            max(price) AS high,
            min(price) AS low,
            last(price, time) AS close,
            sum(volume) AS volume,
            currency_code
        FROM tata_prices
        GROUP BY bucket, currency_code;
    `);

    console.log("Created klines_1w materialized view");

    await client.end();
    console.log("Database initialized successfully");
}

initializeDB().catch(console.error);