const { Client } = require('pg');

async function testFrontendLogic() {
    console.log('🔍 Testing Frontend Logic...');
    
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
        
        // Use the exact same logic as the frontend
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgo = now - (7 * 24 * 60 * 60);
        
        console.log('📅 Frontend timestamps:');
        console.log(`   Now: ${now} (${new Date(now * 1000)})`);
        console.log(`   Seven days ago: ${sevenDaysAgo} (${new Date(sevenDaysAgo * 1000)})`);
        
        // Test the API query
        const query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2`;
        const result = await client.query(query, [new Date(sevenDaysAgo * 1000), new Date(now * 1000)]);
        
        console.log('📈 Query result:');
        console.log(`   Rows returned: ${result.rows.length}`);
        
        if (result.rows.length > 0) {
            console.log('📊 Sample data:');
            result.rows.forEach((row, i) => {
                console.log(`   ${i + 1}. ${row.bucket} - O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
            });
        } else {
            console.log('❌ No data found');
            
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

testFrontendLogic().catch(console.error);
