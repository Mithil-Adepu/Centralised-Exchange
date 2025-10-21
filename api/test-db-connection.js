const { Client } = require('pg');

async function testDbConnection() {
    console.log('🔍 Testing API Database Connection...');
    
    const client = new Client({
        user: 'your_user',
        host: 'localhost',
        database: 'my_database',
        password: 'your_password',
        port: 5432,
    });
    
    try {
        await client.connect();
        console.log('✅ API can connect to PostgreSQL');
        
        // Test klines query
        const query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2`;
        const startTime = new Date(1760350000 * 1000);
        const endTime = new Date(1760360000 * 1000);
        
        console.log(`📊 Testing query: ${query}`);
        console.log(`📅 Time range: ${startTime} to ${endTime}`);
        
        const result = await client.query(query, [startTime, endTime]);
        console.log(`📈 Query result: ${result.rows.length} records`);
        
        if (result.rows.length > 0) {
            console.log('📊 Sample record:', result.rows[0]);
        } else {
            console.log('❌ No records found in time range');
            
            // Check what data exists
            const allData = await client.query(`SELECT * FROM klines_1m ORDER BY bucket DESC LIMIT 5`);
            console.log('📊 Recent klines data:');
            allData.rows.forEach((row, i) => {
                console.log(`   ${i + 1}. ${row.bucket} - O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
            });
        }
        
    } catch (error) {
        console.error('❌ API database connection failed:', error.message);
        console.log('💡 Solutions:');
        console.log('   1. Start PostgreSQL service');
        console.log('   2. Check database credentials');
        console.log('   3. Verify database exists');
    } finally {
        await client.end();
    }
}

testDbConnection().catch(console.error);
