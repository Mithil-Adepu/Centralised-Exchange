# Module 07 — Fiat Onramp & Payment Gateway Integration

> **The Bridge Between Traditional Banking and the Order Book**  
> *"An exchange cannot trade if traders cannot deposit funds. However, accepting fiat payments via gateways like Razorpay introduces massive financial fraud attack vectors: forged webhook signatures, replay attacks, race-condition double-crediting, and timing attacks. This module breaks down `api/src/routes/razorpay.ts`, `fiat_deposits` in PostgreSQL, and the frontend Razorpay modal line-by-line."*

---

## 1. The High-Level Fiat Ingestion Architecture

```
User (Browser)                 API Gateway (:3000)                PostgreSQL (DB)           Razorpay Servers         Matching Engine (RAM)
      │                                │                                │                          │                           │
      │ 1. POST /razorpay/create-order │                                │                          │                           │
      │    { amount: 5000 }            │                                │                          │                           │
      │───────────────────────────────>│                                │                          │                           │
      │                                │ 2. razorpay.orders.create()    │                          │                           │
      │                                │    amount: 500000 (paise)      │                          │                           │
      │                                │──────────────────────────────────────────────────────────>│                           │
      │                                │<──────────────────────────────────────────────────────────│                           │
      │                                │    Returns { id: "order_xyz" } │                          │                           │
      │                                │                                │                          │                           │
      │                                │ 3. INSERT INTO fiat_deposits   │                          │                           │
      │                                │    status: 'pending'           │                          │                           │
      │                                │───────────────────────────────>│                          │                           │
      │ 4. 200 OK: { orderId }         │                                │                          │                           │
      │<───────────────────────────────│                                │                          │                           │
      │                                                                                            │                           │
      │ 5. User completes UPI / Card payment on Razorpay Checkout Modal                            │                           │
      │───────────────────────────────────────────────────────────────────────────────────────────>│                           │
      │<───────────────────────────────────────────────────────────────────────────────────────────│                           │
      │    Returns { razorpay_payment_id, razorpay_signature }                                     │                           │
      │                                                                                            │                           │
      │ 6. POST /razorpay/verify                                                                   │                           │
      │    { order_id, payment_id, signature }                                                     │                           │
      │───────────────────────────────>│                                                           │                           │
      │                                │ 7. HMAC-SHA256 Timing-Safe Verification                   │                           │
      │                                │ 8. Atomic SQL Update:                                     │                           │
      │                                │    UPDATE fiat_deposits SET status = 'success'            │                           │
      │                                │    WHERE status = 'pending' (Prevents double credit!)     │                           │
      │                                │───────────────────────────────>│                          │                           │
      │                                │                                │                          │                           │
      │                                │ 9. XADD engine_messages { type: "ON_RAMP", amount: 5000 } │                           │
      │                                │──────────────────────────────────────────────────────────────────────────────────────>│
      │                                │                                                                                       │ Mints available
      │                                │<──────────────────────────────────────────────────────────────────────────────────────│ USDC in RAM
      │ 10. 200 OK: Success            │                                                                                       │
      │<───────────────────────────────│                                                                                       │
```

---

## 2. Order Creation: `create-order` Line-by-Line (Lines 34–85)

```typescript
razorpayRouter.post("/create-order", authenticate, requireRoles(["user", "admin"]), createOrderLimiter, async (req, res) => {
    const userId = req.auth!.userId;
    try {
        const amount = parsePositiveNumber(req.body?.amount, "amount");
        
        // Razorpay takes amount in paise (1 INR = 100 paise)
        const amountInPaise = Math.round(amount * 100);

        let order;
        if (process.env.NODE_ENV === "development") {
            order = { id: `order_${Date.now()}` };
        } else {
            order = await razorpay.orders.create({
                amount: amountInPaise,
                currency: "INR",
                receipt: `rcpt_${userId}_${Date.now()}`,
            });
        }

        if (!order || !order.id) {
            throw new Error("Failed to create Razorpay order");
        }

        // Save pending deposit in DB
        await pool.query(
            "INSERT INTO fiat_deposits (user_id, order_id, amount, status) VALUES ($1, $2, $3, $4)",
            [userId, order.id, amount, "pending"]
        );

        auditLog({
            event: "razorpay.create-order",
            requestId: req.requestId,
            userId,
            ip: req.ip,
            success: true,
            details: { amount, orderId: order.id },
        });

        res.json({ success: true, orderId: order.id, amount });
    } catch (error: any) { ... }
});
```

### Critical Details:
1. **Paise Conversion**: Razorpay operates in the smallest currency sub-unit (`paise`). 100 INR = 10,000 paise. Sending raw decimals would cause currency unit mismatches.
2. **State Machine Initialization**: A row is inserted into `fiat_deposits` with `status: 'pending'`. The exchange never trusts the client to tell it what the original amount was during verification; the amount is retrieved directly from this database record!

---

## 3. Cryptographic Verification & Side-Channel Defense: `verify` (Lines 87–157)

When the user completes payment on Razorpay's checkout widget, Razorpay returns:
- `razorpay_order_id`
- `razorpay_payment_id`
- `razorpay_signature`

```typescript
razorpayRouter.post("/verify", authenticate, requireRoles(["user", "admin"]), verifyLimiter, async (req, res) => {
    const userId = req.auth!.userId;
    try {
        const razorpay_order_id = parseRequiredString(req.body?.razorpay_order_id, "razorpay_order_id");
        const razorpay_payment_id = parseRequiredString(req.body?.razorpay_payment_id, "razorpay_payment_id");
        const razorpay_signature = parseRequiredString(req.body?.razorpay_signature, "razorpay_signature");

        const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_placeholder";
        
        // Construct the signature payload
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(body.toString())
            .digest("hex");

        // DEFENSE: Timing-Safe Buffer Comparison
        const expectedBuf = Buffer.from(expectedSignature, "hex");
        const receivedBuf = Buffer.from(razorpay_signature, "hex");
        const signaturesMatch =
            expectedBuf.length === receivedBuf.length &&
            crypto.timingSafeEqual(
                Uint8Array.from(expectedBuf),
                Uint8Array.from(receivedBuf)
            );

        if (!signaturesMatch) {
            throw new Error("Invalid signature");
        }
```

### What is a Timing Attack? (Why `crypto.timingSafeEqual` is Mandatory)
In standard JavaScript:
```javascript
expectedSignature === receivedSignature // INSECURE!
```
- The `===` operator compares strings byte-by-byte from left to right.
- As soon as it encounters a mismatch, it **terminates immediately**.
- An attacker can measure the execution time of HTTP requests using high-precision network timers:
  - If byte 0 matches, the request takes $1.02\text{ms}$.
  - If byte 0 fails, the request takes $1.00\text{ms}$.
- By measuring sub-microsecond timing differences, an attacker can deduce the HMAC signature byte-by-byte without ever knowing the secret key!
- `crypto.timingSafeEqual` runs in **constant time** ($O(N)$ execution time regardless of where the mismatch occurs), completely neutralizing timing side-channels.

---

## 4. Race-Condition Defense: Atomic Row Transition (Lines 114–124)

What happens if an attacker fires 10 simultaneous HTTP requests to `/verify` with the same valid Razorpay payment ID?
- If the code simply ran `SELECT * ... if (status === 'pending')` followed by `UPDATE ...`:
  - All 10 requests could run `SELECT` at the same instant and see `status = 'pending'`.
  - All 10 requests would credit the user's balance.
  - The attacker deposits ₹1,000 and receives ₹10,000 on the exchange!

### Our Code's Compare-and-Swap Atomic Transition:
```typescript
const dbResult = await pool.query(
    "UPDATE fiat_deposits SET status = $1, payment_id = $2, updated_at = NOW() WHERE order_id = $3 AND user_id = $4 AND status = 'pending' RETURNING amount",
    ["success", razorpay_payment_id, razorpay_order_id, userId]
);

if (dbResult.rowCount === 0) {
    throw new Error("Order not found, already processed, or doesn't belong to user");
}

const amount = dbResult.rows[0].amount;
```

1. The SQL query updates the record **only if `status = 'pending'`**.
2. PostgreSQL row-level locks guarantee that only **one single query** can perform the update.
3. The winning request receives `rowCount = 1` and proceeds to credit funds.
4. The remaining 9 parallel requests see `rowCount = 0` and are immediately rejected with HTTP 400!
5. **Double-spending is impossible**.

---

## 5. Dispatching to the Matching Engine (Lines 126–134)

Once the database row is atomically transitioned to `"success"`, the API dispatches the funds to the Matching Engine:

```typescript
const response = await RedisManager.getInstance().sendAndAwait({
    type: ON_RAMP,
    data: {
        userId,
        amount: amount.toString()
    }
});
```
- The Matching Engine receives `ON_RAMP`.
- Converts the amount to scaled integer (`5000` $\rightarrow$ `5000000000`).
- Increments `balances.get(userId).USDC.available`.
- The user can instantly begin trading with their deposited funds.
