const { Client } = require('pg');

async function testAPIDirect() {
    console.log('🔍 Testing API Query Directly...');
    
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
        
        // Test the exact query from the API
        const market = 'TATA_INR';
        const interval = '1m';
        const startTime = 1729350000; // Current timestamp
        const endTime = 1729365000;
        
        console.log('📊 Parameters:');
        console.log(`   Market: ${market}`);
        console.log(`   Interval: ${interval}`);
        console.log(`   Start: ${new Date(startTime * 1000)}`);
        console.log(`   End: ${new Date(endTime * 1000)}`);
        
        let query;
        switch (interval) {
            case '1m':
                query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2`;
                break;
            case '5m':
                query = `SELECT * FROM klines_5m WHERE bucket >= $1 AND bucket <= $2`;
                break;
            case '1h':
                query = `SELECT * FROM klines_1h WHERE bucket >= $1 AND bucket <= $2`;
                break;
            default:
                console.log('❌ Invalid interval');
                return;
        }
        
        console.log('📊 Query:', query);
        
        const result = await client.query(query, [new Date(startTime * 1000), new Date(endTime * 1000)]);
        
        console.log('📈 Query result:');
        console.log(`   Rows returned: ${result.rows.length}`);
        
        if (result.rows.length > 0) {
            console.log('📊 Sample row:');
            const row = result.rows[0];
            console.log('   Raw data:', row);
            
            // Test the mapping logic
            const mapped = {
                close: row.close.toString(),
                end: row.bucket,
                high: row.high.toString(),
                low: row.low.toString(),
                open: row.open.toString(),
                quoteVolume: (row.volume * row.close).toString(),
                start: row.bucket,
                trades: "1",
                volume: row.volume.toString(),
            };
            
            console.log('📊 Mapped data:');
            console.log('   Mapped:', mapped);
        } else {
            console.log('❌ No data found in time range');
            
            // Check what data exists
            const allData = await client.query(`SELECT * FROM klines_1m ORDER BY bucket DESC LIMIT 5`);
            console.log('📊 Recent klines data:');
            allData.rows.forEach((row, i) => {
                console.log(`   ${i + 1}. ${row.bucket} - O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
            });
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

testAPIDirect().catch(console.error);
