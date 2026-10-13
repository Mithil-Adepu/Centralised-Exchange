# Module 08 — Real-Time WebSocket Gateway & Pub/Sub Multiplexing

> **Delivering Millisecond Financial Market Data to the World**  
> *"When a market order fills, thousands of traders must see the order book depth collapse and the trade tape update in real time. Polling an HTTP endpoint is far too slow and resource-heavy. This module breaks down `ws/src/index.ts`, `TicketStore.ts`, `UserManager.ts`, `User.ts`, and `SubscriptionManager.ts` line-by-line, detailing the complete bidirectional WebSocket gateway."*

---

## 1. High-Level Gateway Architecture

The WebSocket microservice (`ws/`) acts as a high-concurrency fan-out broker between internal Redis Pub/Sub channels and external browser WebSockets:

```
                      ┌──────────────────────────────────────────────┐
                      │              REDIS 7.0 PUB/SUB               │
                      │  - depth.SOL_USDC                            │
                      │  - trade.SOL_USDC                            │
                      │  - ticker.SOL_USDC                           │
                      └──────────────────────┬───────────────────────┘
                                             │
                       Single Redis Pub/Sub  │ Subscription
                       (Multiplexed Channel) │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │             SubscriptionManager              │
                      │  - subscriptions: User -> [channels]         │
                      │  - reverseSubscriptions: Channel -> [Users]  │
                      └──────────────────────┬───────────────────────┘
                                             │
                      Fan-Out Broadcast to   │ Matching Connections
                      Active Sockets         │
                                             ▼
                 ┌───────────────────────────┴───────────────────────────┐
                 │                                                       │
                 ▼                                                       ▼
        ┌──────────────────┐                                    ┌──────────────────┐
        │  User Connection │                                    │  User Connection │
        │  (Trader Alice)  │                                    │  (Trader Bob)    │
        └──────────────────┘                                    └──────────────────┘
```

---

## 2. Handshake Security & Ticket Consumption: `ws/src/index.ts` & `TicketStore.ts`

### 2.1 Connection Throttling & Payload Caps (Lines 5–74)

```typescript
const WS_PORT = Number(process.env.WS_PORT) || 3001;
const AUTH_MESSAGE_MAX_BYTES = 1024; // 1 KB max for auth frame
const CONNECTION_WINDOW_MS = 60_000;
const MAX_CONNECTIONS_PER_WINDOW = 60; // Max 60 connections per minute per IP

function checkConnectionLimit(ip: string) {
    const now = Date.now();
    const current = connectionCounters.get(ip);
    if (!current || current.resetAt <= now) {
        connectionCounters.set(ip, { count: 1, resetAt: now + CONNECTION_WINDOW_MS });
        return true;
    }
    current.count += 1;
    return current.count <= MAX_CONNECTIONS_PER_WINDOW;
}
```

#### Why These Limits Matter:
1. **DDoS Defense**: Prevents a rogue client from opening 5,000 WebSocket connections per second to exhaust system file descriptors (`ulimit -n`).
2. **Memory Exhaustion Guard**: Malicious clients often attempt to send 100MB string buffers as their initial frame to crash the Node.js process with an Out-of-Memory (OOM) error. If the incoming buffer exceeds 1,024 bytes (`AUTH_MESSAGE_MAX_BYTES`), it is rejected immediately.

---

### 2.2 Atomic Ticket Validation (Lines 102–136)

```typescript
ws.on("message", async (rawMessage) => {
    try {
        if (rawDataByteLength(rawMessage) > AUTH_MESSAGE_MAX_BYTES) {
            ws.send(JSON.stringify({ error: "Payload too large" }));
            return;
        }

        const parsedMessage: TicketMessage = JSON.parse(rawDataToString(rawMessage));
        const ticket = parsedMessage.ticket || parsedMessage.params?.ticket;

        if (parsedMessage.method === "AUTH" && ticket) {
            // Validate UUID regex to block injection
            if (!/^[0-9a-fA-F-]{36}$/.test(ticket)) {
                ws.send(JSON.stringify({ error: "Invalid ticket format" }));
                return;
            }

            // ATOMIC REDIS CONSUME (GET & DEL in one command!)
            const payload = await TicketStore.getInstance().consume(ticket);
            if (!payload) {
                ws.send(JSON.stringify({ error: "Invalid or expired ticket" }));
                return;
            }

            // Upgrade the connection from 'guest' to the user's real UUID
            UserManager.getInstance().upgradeUserId(ws, payload.userId);

            ws.send(JSON.stringify({
                type: "AUTH_SUCCESS",
                userId: payload.userId,
            }));
        }
    } catch (error) { ... }
});
```

---

### 2.3 `TicketStore.ts` — Atomic Single-Use Consumption

```typescript
// ws/src/TicketStore.ts (Line 39)
const raw = await this.redisClient.getDel(`ws:ticket:${ticket}`);
```

- **`GETDEL`**: A native Redis 6.2+ command that returns the key's value and **deletes it in the exact same microsecond atomic instruction**.
- **The Guarantee**: A WebSocket ticket can never be re-used. Once consumed, any attempt to use the same ticket again receives `null`.

---

## 3. Client Lifecycle & Dead Connection Detection: `ws/src/User.ts`

In production, client devices go through tunnels, lose Wi-Fi, or close laptop lids without sending a TCP `FIN` packet. The server is left holding a **zombie connection** that consumes RAM and file descriptors indefinitely.

`User.ts` (lines 89–103) solves this using an active **Ping/Pong Heartbeat**:

```typescript
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

export class User {
    private alive: boolean = true;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    private addListeners() {
        // When browser answers with a pong, mark as alive
        this.ws.on("pong", () => {
            this.alive = true;
        });
    }

    private startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (!this.alive) {
                // Connection failed to reply to the previous ping — terminate!
                console.log(`💀 User ${this.id}: no pong received, terminating`);
                this.ws.terminate(); // Force-closes TCP socket
                this.destroy();      // Clears interval timer
                return;
            }

            // Assume dead until proven alive by the next pong
            this.alive = false;
            this.ws.ping();
        }, HEARTBEAT_INTERVAL);
    }
}
```

```
Time 0s:   Server sends PING ──> Client replies PONG ──> alive = true
Time 30s:  Server sends PING ──> (Client wifi drops, no reply!)
Time 60s:  Server checks: alive is still false!
           Server executes ws.terminate(). Socket is purged from RAM.
```

---

## 4. Reverse Index Multiplexing: `ws/src/SubscriptionManager.ts`

When 1,000 users subscribe to `depth.SOL_USDC`, should the WebSocket service create 1,000 separate subscriptions to Redis?  
**No!** Creating 1,000 subscriptions for the same channel would flood Redis with duplicate network packets and exhaust connection bandwidth.

`SubscriptionManager.ts` implements **Reference-Counted Reverse-Index Multiplexing**:

```typescript
export class SubscriptionManager {
    private subscriptions: Map<string, string[]> = new Map();         // User -> [Channels]
    private reverseSubscriptions: Map<string, string[]> = new Map();  // Channel -> [Users]

    public subscribe(userId: string, subscription: string) {
        // Prevent duplicate subscriptions
        if (this.subscriptions.get(userId)?.includes(subscription)) return;

        // Enforce per-user limit
        const currentSubs = this.subscriptions.get(userId) || [];
        if (currentSubs.length >= MAX_SUBSCRIPTIONS_PER_USER) return;

        this.subscriptions.set(userId, currentSubs.concat(subscription));
        this.reverseSubscriptions.set(
            subscription,
            (this.reverseSubscriptions.get(subscription) || []).concat(userId)
        );
        
        // CRITICAL INVARIANT: Only subscribe to Redis if this is the FIRST subscriber!
        if (this.reverseSubscriptions.get(subscription)?.length === 1) {
            this.redisClient.subscribe(subscription, this.redisCallbackHandler);
        }
    }
```

### The Fan-Out Dispatcher (Lines 68–82):

```typescript
private redisCallbackHandler = (message: string, channel: string) => {
    try {
        const parsedMessage = JSON.parse(message);
        const subscribers = this.reverseSubscriptions.get(channel);
        
        // Fast in-memory iteration over local clients
        subscribers?.forEach(userId => {
            const user = UserManager.getInstance().getUser(userId);
            if (user) {
                user.emit(parsedMessage);
            }
        });
    } catch (err) {
        console.error("Redis callback parse error:", err);
    }
}
```

### The Automatic Teardown Invariant (Lines 84–97):

```typescript
public unsubscribe(userId: string, subscription: string) {
    // ... remove user from reverseSubscriptions ...
    
    // If NO users are listening to this channel anymore, unsubscribe from Redis!
    if (this.reverseSubscriptions.get(subscription)?.length === 0) {
        this.reverseSubscriptions.delete(subscription);
        this.redisClient.unsubscribe(subscription);
    }
}
```

- When 100 users watch `SOL_USDC`, only **1 single packet** travels from Redis to the WebSocket service.
- The WebSocket service copies the JSON buffer to each client's TCP socket in local RAM.
- When the last user navigates away, the subscription is unsubscribed from Redis, conserving network I/O.
