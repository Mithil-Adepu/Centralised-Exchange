const { Client } = require('pg');

async function checkKlines() {
    console.log('🔍 Checking Klines Tables...');
    
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
        
        // Check if klines tables exist
        const tablesCheck = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name LIKE 'klines_%'
        `);
        
        console.log('📊 Klines tables found:', tablesCheck.rows.map(r => r.table_name));
        
        if (tablesCheck.rows.length > 0) {
            // Check klines_1m data
            const klines1m = await client.query('SELECT COUNT(*) FROM klines_1m');
            console.log('📈 Records in klines_1m:', klines1m.rows[0].count);
            
            if (klines1m.rows[0].count > 0) {
                // Show sample klines data
                const sampleKlines = await client.query(`
                    SELECT * FROM klines_1m 
                    ORDER BY bucket DESC 
                    LIMIT 5
                `);
                
                console.log('📊 Sample klines_1m data:');
                sampleKlines.rows.forEach((kline, i) => {
                    console.log(`   ${i + 1}. ${kline.bucket} - O:${kline.open} H:${kline.high} L:${kline.low} C:${kline.close} V:${kline.volume}`);
                });
            }
            
            // Check klines_1h data
            const klines1h = await client.query('SELECT COUNT(*) FROM klines_1h');
            console.log('📈 Records in klines_1h:', klines1h.rows[0].count);
            
            // Check klines_1w data
            const klines1w = await client.query('SELECT COUNT(*) FROM klines_1w');
            console.log('📈 Records in klines_1w:', klines1w.rows[0].count);
        } else {
            console.log('❌ No klines tables found!');
            console.log('💡 Need to run: npm run seed:db');
        }
        
        // Check if we need to create 5m klines
        const klines5m = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'klines_5m'
            );
        `);
        
        console.log('📊 klines_5m table exists:', klines5m.rows[0].exists);
        
        if (!klines5m.rows[0].exists) {
            console.log('💡 Need to create klines_5m table for 5-minute charts');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkKlines().catch(console.error);
