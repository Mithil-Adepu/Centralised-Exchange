import { Client } from 'pg';
import { Router } from "express";
import { RedisManager } from "../RedisManager";

const pgClient = new Client({
    user: 'your_user',
    host: 'localhost',
    database: 'my_database',
    password: 'your_password',
    port: 5432,
});

// Connect to database with error handling
pgClient.connect().then(() => {
    console.log('✅ API connected to PostgreSQL');
}).catch((err) => {
    console.error('❌ API database connection failed:', err.message);
});

export const klineRouter = Router();

klineRouter.get("/", async (req, res) => {
    // Accept both 'market' and 'symbol' parameters for compatibility
    const market = (req.query.market || req.query.symbol) as string;
    const { interval, startTime, endTime } = req.query;

    if (!market) {
        return res.status(400).json({ error: "market or symbol parameter is required" });
    }

    if (!interval || !startTime || !endTime) {
        return res.status(400).json({ error: "interval, startTime, and endTime are required" });
    }

    let query;
    switch (interval) {
        case '1m':
            query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
            break;
        case '5m':
            query = `SELECT * FROM klines_5m WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
            break;
        case '15m':
            query = `SELECT * FROM klines_15m WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
            break;
        case '1h':
            query = `SELECT * FROM klines_1h WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
            break;
        case '1w':
            query = `SELECT * FROM klines_1w WHERE bucket >= $1 AND bucket <= $2 AND currency_code = $3`;
            break;
        default:
            return res.status(400).send('Invalid interval');
    }

    try {
        console.log(`📊 Querying klines: ${interval} for ${market} from ${new Date(Number(startTime) * 1000)} to ${new Date(Number(endTime) * 1000)}`);
        
        //@ts-ignore
        const result = await pgClient.query(query, [new Date(Number(startTime) * 1000), new Date(Number(endTime) * 1000), market]);
        
        console.log(`📈 Found ${result.rows.length} klines records`);
        
        const klinesData = result.rows.map(x => ({
            close: x.close.toString(),
            end: x.bucket,
            high: x.high.toString(),
            low: x.low.toString(),
            open: x.open.toString(),
            quoteVolume: (x.volume * x.close).toString(), // Calculate quote volume
            start: x.bucket, // Use bucket as start time
            trades: "1", // Default trades count
            volume: x.volume.toString(),
        }));
        
        console.log(`📊 Returning ${klinesData.length} klines to frontend`);
        res.json(klinesData);
    } catch (err: any) {
        console.error('❌ Klines query error:', err);
        res.status(500).json({ error: 'Database query failed', details: err.message });
    }
});