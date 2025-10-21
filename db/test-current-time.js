const { Client } = require('pg');

async function testCurrentTime() {
    console.log('🔍 Testing with Current Time...');
    
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
        
        // Use current time range
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        console.log('📅 Time range:');
        console.log(`   From: ${oneHourAgo}`);
        console.log(`   To: ${now}`);
        
        const query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2`;
        const result = await client.query(query, [oneHourAgo, now]);
        
        console.log('📈 Query result:');
        console.log(`   Rows returned: ${result.rows.length}`);
        
        if (result.rows.length > 0) {
            console.log('📊 Sample data:');
            result.rows.forEach((row, i) => {
                console.log(`   ${i + 1}. ${row.bucket} - O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
            });
            
            // Test the API mapping
            const mapped = result.rows.map(x => ({
                close: x.close.toString(),
                end: x.bucket,
                high: x.high.toString(),
                low: x.low.toString(),
                open: x.open.toString(),
                quoteVolume: (x.volume * x.close).toString(),
                start: x.bucket,
                trades: "1",
                volume: x.volume.toString(),
            }));
            
            console.log('📊 Mapped for API:');
            console.log(JSON.stringify(mapped, null, 2));
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

testCurrentTime().catch(console.error);
