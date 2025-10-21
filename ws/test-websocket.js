const WebSocket = require('ws');

console.log('🔌 Testing WebSocket connection...');

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
    
    // Subscribe to TATA_INR depth updates
    const subscribeMsg = {
        method: "SUBSCRIBE",
        params: ["depth.TATA_INR"]
    };
    
    console.log('📤 Sending subscription:', subscribeMsg);
    ws.send(JSON.stringify(subscribeMsg));
});

ws.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('📨 Received message:', JSON.stringify(message, null, 2));
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
});

ws.on('close', (code, reason) => {
    console.log('🔌 WebSocket closed:', code, reason.toString());
});

// Keep alive for 30 seconds
setTimeout(() => {
    console.log('⏰ Test complete, closing connection');
    ws.close();
    process.exit(0);
}, 30000);
