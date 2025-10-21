const { Client } = require('pg');

async function seedSampleData() {
    console.log('🌱 Seeding sample trading data...');
    
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
        
        // Clear existing data
        await client.query('DELETE FROM tata_prices');
        console.log('🗑️ Cleared existing data');
        
        // Generate sample data for the last 7 days
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
        
        const markets = ['SOL_USDC', 'BTC_USDC', 'ETH_USDC'];
        const basePrices = { 'SOL_USDC': 100, 'BTC_USDC': 50000, 'ETH_USDC': 3000 };
        
        for (const market of markets) {
            console.log(`📊 Generating data for ${market}...`);
            
            const basePrice = basePrices[market];
            let currentPrice = basePrice;
            let currentTime = new Date(sevenDaysAgo);
            
            // Generate data every 5 minutes for 7 days
            const totalMinutes = 7 * 24 * 60; // 7 days in minutes
            const intervalMinutes = 5; // 5-minute intervals
            const totalIntervals = Math.floor(totalMinutes / intervalMinutes);
            
            const trades = [];
            
            for (let i = 0; i < totalIntervals; i++) {
                // Add some price volatility
                const volatility = 0.02; // 2% volatility
                const change = (Math.random() - 0.5) * volatility;
                currentPrice = currentPrice * (1 + change);
                
                // Ensure price doesn't go too low
                currentPrice = Math.max(currentPrice, basePrice * 0.5);
                
                // Generate 1-5 trades per interval
                const tradesInInterval = Math.floor(Math.random() * 5) + 1;
                
                for (let j = 0; j < tradesInInterval; j++) {
                    const tradePrice = currentPrice * (1 + (Math.random() - 0.5) * 0.01); // ±0.5% variation
                    const volume = Math.random() * 10 + 1; // 1-11 volume
                    
                    trades.push({
                        time: new Date(currentTime.getTime() + j * 60000), // j minutes offset
                        price: tradePrice,
                        volume: volume,
                        currency_code: market
                    });
                }
                
                currentTime = new Date(currentTime.getTime() + intervalMinutes * 60000);
            }
            
            // Insert trades in batches
            const batchSize = 1000;
            for (let i = 0; i < trades.length; i += batchSize) {
                const batch = trades.slice(i, i + batchSize);
                const values = batch.map(trade => 
                    `('${trade.time.toISOString()}', ${trade.price}, ${trade.volume}, '${trade.currency_code}')`
                ).join(',');
                
                await client.query(`
                    INSERT INTO tata_prices (time, price, volume, currency_code) 
                    VALUES ${values}
                `);
            }
            
            console.log(`✅ Inserted ${trades.length} trades for ${market}`);
        }
        
        // Refresh materialized views
        console.log('🔄 Refreshing materialized views...');
        await client.query('REFRESH MATERIALIZED VIEW klines_1m');
        await client.query('REFRESH MATERIALIZED VIEW klines_5m');
        await client.query('REFRESH MATERIALIZED VIEW klines_15m');
        await client.query('REFRESH MATERIALIZED VIEW klines_1h');
        await client.query('REFRESH MATERIALIZED VIEW klines_1w');
        
        console.log('✅ Materialized views refreshed');
        
        // Check results
        const klines1m = await client.query('SELECT COUNT(*) FROM klines_1m');
        const klines1h = await client.query('SELECT COUNT(*) FROM klines_1h');
        const totalTrades = await client.query('SELECT COUNT(*) FROM tata_prices');
        
        console.log('📊 Results:');
        console.log(`   Total trades: ${totalTrades.rows[0].count}`);
        console.log(`   1m klines: ${klines1m.rows[0].count}`);
        console.log(`   1h klines: ${klines1h.rows[0].count}`);
        
        console.log('🎉 Sample data seeding completed!');
        
    } catch (error) {
        console.error('❌ Error seeding data:', error);
    } finally {
        await client.end();
    }
}

seedSampleData().catch(console.error);
