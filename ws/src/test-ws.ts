import WebSocket from "ws";

async function runWsTests() {
    console.log("Starting WS Tests...");
    const wsUrl = "ws://localhost:3001";
    const apiUrl = "http://localhost:3000/api/v1";

    // Register a new user for the API to place a trade
    console.log("1. Setting up API user...");
    const randomStr = Math.random().toString(36).substring(7);
    const testEmail = `test_${randomStr}@cex.io`;
    
    await fetch(`${apiUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: testEmail, password: "Test1234!" })
    });
    
    const loginRes = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: testEmail, password: "Test1234!" })
    });
    const loginData = await loginRes.json();
    const token = loginData.accessToken;

    // Add funds
    const onrampRes = await fetch(`${apiUrl}/wallet/razorpay/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ amount: 1000 })
    });
    const onrampData = await onrampRes.json();
    
    await fetch(`${apiUrl}/wallet/razorpay/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ 
            razorpay_order_id: onrampData.orderId,
            razorpay_payment_id: "pay_test123",
            razorpay_signature: "mock_signature"
        })
    });
    await new Promise(r => setTimeout(r, 500));

    // Connect WS
    console.log("2. Connecting to WebSocket...");
    const ws = new WebSocket(wsUrl);
    let depthReceived = false;
    let tradeReceived = false;

    ws.on('open', () => {
        console.log("WebSocket connected.");
        ws.send(JSON.stringify({
            method: "SUBSCRIBE",
            params: ["depth.SOL_USDC", "trade.SOL_USDC"]
        }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log("WS Message Received:", JSON.stringify(msg));
        
        if (msg.stream === "depth.SOL_USDC") depthReceived = true;
        if (msg.stream === "trade.SOL_USDC") tradeReceived = true;
    });

    // Wait a bit to ensure subscription is active
    await new Promise(r => setTimeout(r, 1000));

    // Place an order to trigger WS events
    console.log("3. Placing trade to trigger WS events...");
    await fetch(`${apiUrl}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ market: "SOL_USDC", price: 150, quantity: 1, side: "buy" })
    });

    // Wait for WS messages
    console.log("4. Waiting for WS messages...");
    for (let i = 0; i < 10; i++) {
        if (depthReceived && tradeReceived) {
            console.log("✅ Success! Both depth and trade messages received.");
            ws.close();
            return;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.error("❌ Failed: Did not receive expected WS messages in time.");
    console.log(`Status -> Depth: ${depthReceived}, Trade: ${tradeReceived}`);
    ws.close();
    process.exit(1);
}

runWsTests().catch(console.error);
