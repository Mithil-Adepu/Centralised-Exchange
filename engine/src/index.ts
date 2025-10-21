import { createClient } from "redis";
import { Engine } from "./trade/Engine";

async function main() {
    const engine = new Engine(); 
    let isShuttingDown = false;

    // Create Redis client with error handling
    const redisClient = createClient();
    
    redisClient.on('error', (err) => {
        console.error('Redis error:', err);
    });

    redisClient.on('reconnecting', () => {
        console.log('Redis reconnecting...');
    });

    await redisClient.connect();
    console.log("Connected to redis");

    // Graceful shutdown handler
    process.on('SIGINT', async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log('\nShutting down gracefully...');
        engine.saveSnapshot();
        await redisClient.disconnect();
        process.exit(0);
    });

    // Main processing loop with blocking pop
    while (!isShuttingDown) {
        try {
            // Use brPop (blocking right pop) with 1 second timeout
            // This blocks until a message arrives or timeout occurs
            const response = await redisClient.brPop("messages", 1);
            
            if (response) {
                // response.element contains the actual message
                const message = JSON.parse(response.element);
                console.log(`Processing message type: ${message.message?.type}`);
                engine.process(message);
            }
            // If no response (timeout), loop continues without CPU waste
        } catch (error) {
            console.error('Error processing message:', error);
            console.error('Error details:', error);
            
            // If Redis connection lost, wait before retry
            if (!redisClient.isOpen) {
                console.log('Redis connection lost, waiting before retry...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});