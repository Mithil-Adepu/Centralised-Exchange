const { Client } = require('pg');

async function create5mKlines() {
    console.log('🔧 Creating 5-minute klines table...');
    
    const client = new Client({
        user: 'your_user',
        host: 'localhost',
        database: 'my_database',
        password: 'your_password',
        port: 5432,
    });
    
    try {
        await client.connect();
        console.log('✅ Connected to PostgreSQL');
        
        // Create 5-minute klines materialized view
        await client.query(`
            CREATE MATERIALIZED VIEW klines_5m AS
            SELECT
                time_bucket('5 minutes', time) AS bucket,
                first(price, time) AS open,
                max(price) AS high,
                min(price) AS low,
                last(price, time) AS close,
                sum(volume) AS volume,
                currency_code
            FROM tata_prices
            GROUP BY bucket, currency_code;
        `);
        
        console.log('✅ Created klines_5m materialized view');
        
        // Refresh all materialized views
        console.log('🔄 Refreshing all materialized views...');
        await client.query('REFRESH MATERIALIZED VIEW klines_1m');
        await client.query('REFRESH MATERIALIZED VIEW klines_5m');
        await client.query('REFRESH MATERIALIZED VIEW klines_1h');
        await client.query('REFRESH MATERIALIZED VIEW klines_1w');
        
        console.log('✅ All materialized views refreshed');
        
        // Check the results
        const klines1m = await client.query('SELECT COUNT(*) FROM klines_1m');
        const klines5m = await client.query('SELECT COUNT(*) FROM klines_5m');
        const klines1h = await client.query('SELECT COUNT(*) FROM klines_1h');
        
        console.log('📊 Results:');
        console.log(`   klines_1m: ${klines1m.rows[0].count} records`);
        console.log(`   klines_5m: ${klines5m.rows[0].count} records`);
        console.log(`   klines_1h: ${klines1h.rows[0].count} records`);
        
        if (klines1m.rows[0].count > 0) {
            console.log('🎉 Klines data is now available for charts!');
        } else {
            console.log('⚠️ No klines data found. Make sure trades are being created.');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

create5mKlines().catch(console.error);
