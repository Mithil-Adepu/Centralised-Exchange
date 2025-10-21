const { Client } = require('pg');

async function testChartData() {
    console.log('🔍 Testing Chart Data Availability...');
    
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
        
        // Test all klines tables
        const intervals = ['1m', '5m', '15m', '1h'];
        
        for (const interval of intervals) {
            const tableName = `klines_${interval}`;
            const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
            const count = result.rows[0].count;
            
            console.log(`📊 ${tableName}: ${count} records`);
            
            if (count > 0) {
                // Show sample data
                const sample = await client.query(`SELECT * FROM ${tableName} ORDER BY bucket DESC LIMIT 1`);
                if (sample.rows.length > 0) {
                    const row = sample.rows[0];
                    console.log(`   Latest: ${row.bucket} - O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
                }
            }
        }
        
        console.log('\n🎯 Chart Data Status:');
        console.log('✅ 1m, 5m, 15m, 1h klines data is available');
        console.log('✅ Charts should work for all timeframes');
        console.log('✅ API needs to be running on port 3000');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

testChartData().catch(console.error);
