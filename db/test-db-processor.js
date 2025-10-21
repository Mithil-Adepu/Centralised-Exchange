const { createClient } = require('redis');

async function testDbProcessor() {
    console.log('🔍 Testing Database Processor...');
    
    const redisClient = createClient();
    await redisClient.connect();
    console.log('✅ Connected to Redis');
    
    // Check if there are messages in the db_processor queue
    const queueLength = await redisClient.lLen('db_processor');
    console.log(`📊 Messages in db_processor queue: ${queueLength}`);
    
    if (queueLength > 0) {
        console.log('📨 Found messages in queue!');
        
        // Peek at the first message without removing it
        const firstMessage = await redisClient.lIndex('db_processor', 0);
        console.log('📄 First message:', firstMessage);
        
        // Process a few messages
        for (let i = 0; i < Math.min(3, queueLength); i++) {
            const message = await redisClient.rPop('db_processor');
            if (message) {
                console.log(`📨 Message ${i + 1}:`, message);
            }
        }
    } else {
        console.log('❌ No messages in db_processor queue');
        console.log('💡 This means either:');
        console.log('   1. No trades are being created by Market Maker');
        console.log('   2. Engine is not sending TRADE_ADDED messages');
        console.log('   3. Messages are being processed too quickly');
    }
    
    // Check Redis channels for trade messages
    console.log('\n🔍 Checking Redis channels...');
    
    // Subscribe to all channels to see what's being published
    const subscriber = createClient();
    await subscriber.connect();
    
    subscriber.on('message', (channel, message) => {
        console.log(`📡 Channel: ${channel}`);
        console.log(`📨 Message: ${message}`);
    });
    
    // Subscribe to common channels
    await subscriber.subscribe('depth.TATA_INR');
    await subscriber.subscribe('ticker.TATA_INR');
    await subscriber.subscribe('trade.TATA_INR');
    
    console.log('👂 Listening for messages on Redis channels...');
    console.log('⏰ Waiting 10 seconds for messages...');
    
    setTimeout(async () => {
        await subscriber.disconnect();
        await redisClient.disconnect();
        console.log('✅ Test completed');
    }, 10000);
}

testDbProcessor().catch(console.error);
