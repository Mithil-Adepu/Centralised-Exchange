import { Client } from 'pg'; 

const client = new Client({
    user: process.env.DB_USER || 'your_user',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'my_database',
    password: process.env.DB_PASSWORD || 'your_password',
    port: Number(process.env.DB_PORT) || 5433,
});
client.connect().then(() => {
    console.log("DB: Connected to PostgreSQL for view refresh");
}).catch((err) => {
    console.error("DB: PostgreSQL connection failed:", err);
});

async function refreshViews() {

    await client.query('REFRESH MATERIALIZED VIEW klines_1m');
    await client.query('REFRESH MATERIALIZED VIEW klines_5m');
    await client.query('REFRESH MATERIALIZED VIEW klines_15m');
    await client.query('REFRESH MATERIALIZED VIEW klines_1h');
    await client.query('REFRESH MATERIALIZED VIEW klines_4h');
    await client.query('REFRESH MATERIALIZED VIEW klines_1d');
    await client.query('REFRESH MATERIALIZED VIEW klines_1w');

    console.log("Materialized views refreshed successfully");
}

refreshViews().catch(console.error);

setInterval(() => {
    refreshViews()
}, 1000 * 10 );