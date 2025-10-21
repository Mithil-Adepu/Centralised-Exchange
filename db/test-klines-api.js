const { Client } = require('pg');

async function testKlinesAPI() {
    console.log('🔍 Testing Klines API Query...');
    
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
        
        // Test the exact query that the API uses
        const query = `SELECT * FROM klines_1m WHERE bucket >= $1 AND bucket <= $2`;
        const startTime = new Date(1704067200 * 1000);
        const endTime = new Date(1704153600 * 1000);
        
        console.log('📊 Query:', query);
        console.log('📅 Start time:', startTime);
        console.log('📅 End time:', endTime);
        
        const result = await client.query(query, [startTime, endTime]);
        
        console.log('📈 Query result:');
        console.log(`   Rows returned: ${result.rows.length}`);
        
        if (result.rows.length > 0) {
            console.log('📊 Sample row:');
            const row = result.rows[0];
            console.log('   Fields:', Object.keys(row));
            console.log('   Data:', row);
        }
        
        // Test with current time range
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        console.log('\n🕐 Testing with current time range:');
        console.log('   From:', oneHourAgo);
        console.log('   To:', now);
        
        const result2 = await client.query(query, [oneHourAgo, now]);
        console.log(`   Rows returned: ${result2.rows.length}`);
        
        if (result2.rows.length > 0) {
            console.log('📊 Sample row:');
            const row = result2.rows[0];
            console.log('   Fields:', Object.keys(row));
            console.log('   Data:', row);
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

testKlinesAPI().catch(console.error);
