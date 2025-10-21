const { Client } = require('pg');

async function testDbConnection() {
    console.log('🔍 Testing Database Connection...');
    
    const pgClient = new Client({
        user: 'your_user',
        host: 'localhost',
        database: 'my_database',
        password: 'your_password',
        port: 5432,
    });
    
    try {
        await pgClient.connect();
        console.log('✅ Connected to PostgreSQL');
        
        // Check if tata_prices table exists
        const tableCheck = await pgClient.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'tata_prices'
            );
        `);
        
        console.log('📊 tata_prices table exists:', tableCheck.rows[0].exists);
        
        if (tableCheck.rows[0].exists) {
            // Check if there's any data
            const dataCheck = await pgClient.query('SELECT COUNT(*) FROM tata_prices');
            console.log('📈 Records in tata_prices:', dataCheck.rows[0].count);
            
            // Show recent trades
            const recentTrades = await pgClient.query(`
                SELECT * FROM tata_prices 
                ORDER BY time DESC 
                LIMIT 5
            `);
            
            if (recentTrades.rows.length > 0) {
                console.log('📊 Recent trades:');
                recentTrades.rows.forEach((trade, i) => {
                    console.log(`   ${i + 1}. ${trade.time} - ${trade.price} (${trade.volume})`);
                });
            } else {
                console.log('❌ No trades found in tata_prices table');
            }
        }
        
        // Check klines tables
        const klinesCheck = await pgClient.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name LIKE 'klines_%'
        `);
        
        console.log('📊 Klines tables:', klinesCheck.rows.map(r => r.table_name));
        
        if (klinesCheck.rows.length > 0) {
            // Check klines_1m data
            const klines1m = await pgClient.query('SELECT COUNT(*) FROM klines_1m');
            console.log('📈 Records in klines_1m:', klines1m.rows[0].count);
        }
        
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        console.log('\n💡 Possible solutions:');
        console.log('   1. Start PostgreSQL service');
        console.log('   2. Create database: CREATE DATABASE my_database;');
        console.log('   3. Check credentials in db/src/index.ts');
    } finally {
        await pgClient.end();
    }
}

testDbConnection().catch(console.error);
