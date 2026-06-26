async function testAPI() {
    console.log("Starting API Tests...");
    const baseUrl = "http://localhost:3000/api/v1";

    try {
        console.log("1. Registering a new user...");
        const randomStr = Math.random().toString(36).substring(7);
        const testEmail = `test_${randomStr}@cex.io`;
        
        const registerRes = await fetch(`${baseUrl}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: testEmail, password: "Test1234!" })
        });
        
        if (!registerRes.ok) throw new Error(`Register failed: ${await registerRes.text()}`);
        console.log("Register successful!");

        console.log("2. Logging in with new user...");
        const loginRes = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: testEmail, password: "Test1234!" })
        });
        
        if (!loginRes.ok) {
            console.error(`Login failed: ${await loginRes.text()}`);
            return;
        }
        
        const loginData = await loginRes.json();
        const token = loginData.accessToken;
        console.log("Login successful! Token received.");

        // 2. Fetch User Profile
        const meRes = await fetch(`${baseUrl}/auth/me`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!meRes.ok) throw new Error("Failed to fetch /auth/me");
        console.log("Fetch /auth/me successful!");

        // 3. Wallet Balances
        console.log("3. Fetching balances...");
        const balanceRes = await fetch(`${baseUrl}/wallet/balances`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!balanceRes.ok) throw new Error(`Balance fetch failed: ${await balanceRes.text()}`);
        console.log("Balances:", await balanceRes.json());

        // 4. Create Razorpay Onramp
        console.log("4. Creating fiat onramp order...");
        const onrampRes = await fetch(`${baseUrl}/wallet/razorpay/create-order`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ amount: 1000 })
        });
        if (!onrampRes.ok) {
            console.error(`Onramp create failed: ${await onrampRes.text()}`);
            return;
        } 
        const onrampData = await onrampRes.json();
        console.log("Onramp order created:", onrampData);

        // 5. Verify Razorpay Payment (mock signature)
        console.log("5. Verifying payment...");
        const verifyRes = await fetch(`${baseUrl}/wallet/razorpay/verify`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ 
                razorpay_order_id: onrampData.orderId,
                razorpay_payment_id: "pay_test123",
                razorpay_signature: "mock_signature"
            })
        });
        if (!verifyRes.ok) {
            console.error(`Verify failed: ${await verifyRes.text()}`);
            return;
        }
        console.log("Payment verified:", await verifyRes.json());

        // Wait a bit for engine to process ON_RAMP
        await new Promise(r => setTimeout(r, 1000));

        // 6. Check Balances again
        const bal2 = await fetch(`${baseUrl}/wallet/balances`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        console.log("Balances after onramp:", await bal2.json());

        // 7. Place a trade order
        console.log("7. Placing a trade order...");
        const orderRes = await fetch(`${baseUrl}/order`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ 
                market: "SOL_USDC", 
                price: 150, 
                quantity: 1, 
                side: "buy" 
            })
        });
        if (!orderRes.ok) {
            console.error(`Order creation failed: ${await orderRes.text()}`);
        } else {
            console.log("Order created:", await orderRes.json());
        }

        console.log("All integration tests finished.");
    } catch (e) {
        console.error("Test Error:", e);
    }
}

testAPI();
