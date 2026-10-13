# CEX Mastery — Module 4: The API Server

> The API is the public face of the exchange. Every order you place, every balance you check, every login — it passes through here. It is intentionally stateless — all state lives in the engine and the database.

---

## The Middleware Chain: Every Request's Journey

When your browser sends `POST /api/v1/order`, the request passes through **middleware** in sequence before hitting the actual route handler. Think of it as a series of gatekeepers.

```
Browser → [CORS] → [JSON Parser] → [Security Headers] → [Route Handler]
                                                                ↓
                                                    [authenticate] → [requireRoles] → [rateLimiter] → [logic]
```

Each middleware calls `next()` to pass control to the next one. If something is wrong (invalid token, rate-limited), it calls `res.status(401).json(...)` **without** calling `next()`, stopping the chain.

---

## `authenticate.ts` — The JWT Gatekeeper

```typescript
export function authenticate(req: Request, res: Response, next: NextFunction) {
    // Special bypass: internal services (like market maker) can use a shared secret
    const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN;
    const providedInternalToken = req.header("x-internal-service-token");

    if (internalServiceToken && providedInternalToken === internalServiceToken) {
        req.auth = {
            userId: String(internalUserId),
            email: "internal-service@local",
            sessionId: "internal-service",
            roles: ["admin", "user"],  // All permissions
        };
        return next();
    }
```

**The internal service bypass**: the market maker (`mm/`) runs automated trading. It needs to place orders without a user login. By sending a known secret in `x-internal-service-token`, it bypasses JWT auth. This is safe only because this header is never exposed to browsers.

```typescript
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        return res.status(401).json({ error: "Missing Bearer access token" });
    }

    try {
        req.auth = AuthService.getInstance().verifyAccessToken(token);
        return next();
    } catch (error: any) {
        return res.status(401).json({ error: error?.message || "Invalid access token" });
    }
}
```

**How `extractBearerToken` works:**
```typescript
function extractBearerToken(header?: string) {
    const [scheme, token] = header.split(" ");
    // "Bearer eyJhbGci..." → scheme="Bearer", token="eyJhbGci..."
    if (scheme !== "Bearer" || !token) return null;
    return token;
}
```

The `Authorization: Bearer <token>` header format is the standard (RFC 6750). The `"Bearer"` prefix is a security signal — it distinguishes access tokens from other auth schemes (like `Basic` or `Digest`).

**After `authenticate` runs**: `req.auth` is populated with `{ userId, email, sessionId, roles }`. Route handlers access `req.auth.userId` to know who's making the request.

**What `verifyAccessToken` does** (in AuthService):
```typescript
public verifyAccessToken(accessToken: string): AuthenticatedUser {
    const claims = parseClaims<AccessClaims>(accessToken, ACCESS_TOKEN_SECRET);
    // ↑ jwt.verify() — cryptographically verifies the signature AND checks expiry
    
    if (claims.type !== "access" || !claims.sub || !claims.email || !claims.sid) {
        throw new Error("Invalid access token");
    }
    // ↑ Extra semantic validation beyond just the cryptographic check
```

`jwt.verify()` does two things simultaneously:
1. Verifies the token's **signature** (only someone with the secret could have signed it)
2. Checks the **expiry** (`exp` claim) — throws if expired

---

# CEX Mastery — Module 5: The Auth System

> Auth is the most complex, most security-critical part of the entire system. It protects user accounts, prevents unauthorized access, and manages multiple sessions.

---

## The Token Architecture

```
Login response:
  ├─ Access Token (JWT, in response body, stored in memory by frontend)
  │   ├─ Short-lived: 15 minutes
  │   ├─ Contains: userId, email, sessionId, roles
  │   └─ Sent in every API request as "Authorization: Bearer ..."
  │
  └─ Refresh Token (JWT, in HttpOnly cookie, never readable by JS)
      ├─ Long-lived: 7 days
      ├─ Contains: userId, sessionId
      └─ Sent automatically by browser on POST /auth/refresh
```

**Why this design?**

**Problem**: If you only use access tokens, they're either long-lived (risky if stolen) or short-lived (user has to log in every 15 minutes).

**Solution**: Access tokens are short-lived. Refresh tokens silently extend the session. The frontend auto-calls `/auth/refresh` when the access token expires — the user never notices.

**Why `HttpOnly` cookie for the refresh token?** JavaScript running in the browser cannot read `HttpOnly` cookies. This means even if an attacker injects malicious JavaScript (XSS attack), they cannot steal the refresh token. The access token IS readable by JS (it's in memory), but if stolen it expires in 15 minutes anyway.

---

## The Secrets

```typescript
const ACCESS_TOKEN_SECRET  = process.env.ACCESS_TOKEN_SECRET  || "dev-access-secret-change-me";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "dev-refresh-secret-change-me";
```

**Two separate secrets — why?**
- If you use one secret and it's compromised, an attacker can forge both access and refresh tokens
- With separate secrets, compromising the access secret doesn't let them forge refresh tokens (and vice versa)
- Also: if you ever need to invalidate all access tokens system-wide (security incident), you can rotate just the access secret without logging everyone out

**The startup guard:**
```typescript
private constructor() {
    if (ACCESS_TOKEN_SECRET === "dev-access-secret-change-me") {
        throw new Error("ACCESS_TOKEN_SECRET must be set and cannot be default");
    }
```
The **API server refuses to start** with default secrets. This is better than a warning because a warning might be missed.

---

## `register()` — Creating an Account

```typescript
public async register(email, password, meta?) {
    const normalizedEmail = normalizeEmail(email);
    // normalizeEmail = email.trim().toLowerCase()
    // "User@Gmail.COM " → "user@gmail.com"
    // Prevents duplicate accounts like "user@gmail.com" and "User@Gmail.com"
    
    this.validateCredentials(normalizedEmail, password);
    // Validates: email format, password length/complexity
    
    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) throw new Error("Email is already registered");
    
    const user = await createUser({
        id: crypto.randomUUID(),       // UUID v4 — globally unique
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, 12),
        //                              ↑ cost factor: 2^12 = 4096 iterations
    });
```

**bcrypt cost factor 12**: bcrypt is a **slow hashing algorithm** by design. "Slow" here means ~300ms on modern hardware. This is intentional: it makes brute-force attacks impractical. An attacker stealing your database and trying every common password would need 300ms per attempt × millions of passwords = years.

Cost factor 10 = ~100ms (standard), 12 = ~400ms (more secure), 14 = ~1.5s (very secure). 12 is the industry standard today.

```typescript
    await assignRole(user.id, "user");           // Every new user gets "user" role
    await this.sendVerificationOTP(normalizedEmail); // Send 6-digit code to email
    
    return { user: {...}, requiresVerification: true };
```

New users must verify their email before they can trade. This prevents fake accounts.

---

## `login()` — The Authentication Flow

```typescript
public async login(email, password, meta?) {
    const normalizedEmail = normalizeEmail(email);
    
    // 1. Check if account is locked (too many failed attempts)
    await this.checkAccountLockout(normalizedEmail);
    
    // 2. Find user by email
    const user = await getUserByEmail(normalizedEmail);
    if (!user) {
        await this.recordFailedLogin(normalizedEmail);  // Track failed attempt
        throw new Error("Invalid credentials");
        // ↑ NEVER say "email not found" — that lets attackers enumerate emails
    }
    
    // 3. Check account status (banned? deleted?)
    this.ensureActiveUser(user);
    
    // 4. Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
        await this.recordFailedLogin(normalizedEmail);
        throw new Error("Invalid credentials");
    }
    
    // 5. Success — clear failed attempts
    await this.clearFailedLogins(normalizedEmail);
    
    // 6. Issue tokens
    const roles = await getUserRoles(user.id);
    const tokens = await this.issueTokens(user, roles, meta);
    
    return { user: {...}, ...tokens };
}
```

**"Invalid credentials" for both wrong email AND wrong password**: This is deliberate. If you said "email not found," an attacker could enumerate which emails are registered by trying thousands of addresses.

**`recordFailedLogin` / `checkAccountLockout`**: These use Redis to track failed attempts per email:
```
Key: "failed_logins:{email}"
Value: count of failures
TTL: 15 minutes (resets automatically)
```

After 5 failures: lock the account for 15 minutes. An attacker trying passwords would need `5 attempts × 15 min per lockout` = only 20 attempts per 60 minutes. Much better than unlimited attempts.

---

## `issueTokens()` — Creating the JWT Pair

```typescript
private async issueTokens(user: DbUser, roles: string[], meta?) {
    // 1. Enforce max sessions per user
    const sessionCount = await countSessionsByUser(user.id);
    if (sessionCount >= MAX_SESSIONS_PER_USER) {
        await deleteOldestSessions(user.id, sessionCount - MAX_SESSIONS_PER_USER + 1);
        // ↑ Delete the oldest sessions to make room
    }
    
    // 2. Create a new session in the database
    const sessionId = crypto.randomUUID();
    const refreshToken = this.signRefreshToken(user.id, sessionId);
    
    await createSession({
        id: sessionId,
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),  // Store HASH, not the token itself
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    
    // 3. Sign both tokens
    const accessToken = this.signAccessToken(user, sessionId, roles);
    return { accessToken, refreshToken };
}
```

**Why store `refreshTokenHash` not the refresh token?** If someone hacks your database, they shouldn't be able to log in as every user. By storing only the SHA-256 hash of the refresh token, an attacker who steals the DB cannot use the stored values to authenticate — they'd need the original tokens which are only in the user's browser cookie.

**Max 3 sessions per user**: If you try to log in on a 4th device, the oldest session is deleted. This is standard practice. Netflix does the same. It prevents a single account from being active everywhere simultaneously.

---

## `refresh()` — Silent Token Renewal

```typescript
public async refresh(refreshToken: string, meta?) {
    const claims = parseClaims<RefreshClaims>(refreshToken, REFRESH_TOKEN_SECRET);
    // ↑ Verify signature AND expiry. Throws if expired (after 7 days)
    
    const session = await getSessionById(claims.sid);
    if (!session || session.userId !== claims.sub) {
        throw new Error("Refresh session not found");
    }
    
    // Critical security check: token rotation detection
    if (session.refreshTokenHash !== hashToken(refreshToken)) {
        await deleteSession(claims.sid);  // Revoke compromised session!
        throw new Error("Refresh token mismatch — session revoked");
    }
```

**Refresh Token Rotation + Theft Detection:**

When you refresh:
1. Old refresh token is deleted
2. New refresh token is issued
3. New token hash stored in DB

If an attacker steals your refresh token and uses it, the DB stores their new token. When YOU next try to refresh with your (now invalid) token:
- `session.refreshTokenHash !== hashToken(yourOldToken)` → mismatch!
- System detects possible theft, **revokes the session entirely**
- Both you and the attacker are logged out
- You get a "session revoked" error — you know to change your password

This is called **Refresh Token Rotation with Reuse Detection**.

---

## `createWsTicket()` — WebSocket Authentication Bridge

```typescript
public async createWsTicket(userId: string) {
    const client = await AuthRedis.getInstance().getClient();
    const ticket = crypto.randomUUID();  // Random UUID — unguessable
    
    await client.set(
        `ws:ticket:${ticket}`,           // Key in Redis
        JSON.stringify({ userId, issuedAt: Date.now() }),
        { EX: 60 }                       // Expires in 60 seconds
    );
    
    return { ticket, expiresIn: 60 };
}
```

**Flow**:
1. Browser calls `POST /auth/ws-ticket` (with valid access token)
2. API creates a one-time ticket (UUID) stored in Redis with 60s TTL
3. Browser connects to WS server and sends the ticket
4. WS server calls `TicketStore.consume(ticket)` — does `GETDEL` (get and delete atomically)
5. If ticket exists: user authenticated, ticket deleted (can't be reused)
6. If ticket missing/expired: connection rejected

**Why not just send the JWT to the WS server?**
- WS server would need the JWT signing secret → more places holding the secret
- The WS server is a separate process with no database access
- Tickets are simpler: just check if the UUID exists in Redis

---

## The OTP System

```typescript
const OTP_TTL_SECONDS = 300;  // 5 minutes
const OTP_MAX_ATTEMPTS = 5;   // 5 wrong guesses → locked

public async sendVerificationOTP(email: string) {
    const otp = emailService.generateOTP();  // 6-digit random number
    
    await client.set(`otp:verify:${email}`, otp, { EX: OTP_TTL_SECONDS });
    await client.del(`otp:attempts:verify:${email}`);  // Reset attempt counter
    
    await emailService.sendOTP(email, otp, "verify");
}
```

**OTP security model:**
- 6-digit = 1,000,000 possibilities
- 5 attempts max → 5/1,000,000 = 0.0005% brute-force success rate
- 5-minute TTL → even if you get lucky, OTP expired

```typescript
public async verifyEmailOTP(email, otp, meta?) {
    const attempts = Number(await client.incr(`otp:attempts:verify:${email}`));
    if (attempts > OTP_MAX_ATTEMPTS) {
        throw new Error("Too many failed attempts");
    }
    
    const storedOTP = await client.get(`otp:verify:${email}`);
    if (!storedOTP || storedOTP !== otp) {
        throw new Error("Invalid or expired OTP");
    }
    
    // Valid! Clean up.
    await client.del(`otp:verify:${email}`);
    await client.del(`otp:attempts:verify:${email}`);
```

**The `incr` before checking the OTP**: This is the right order. If you check first, then increment, an attacker could guess 5 times right before the last `incr`. By incrementing first, the 5th wrong guess IS the lockout.

---

# CEX Mastery — Module 6: The WebSocket Server

> The WS server is the real-time data pipeline. Everything live — prices, trades, order book updates — flows through here.

---

## Architecture Overview

```
ws/src/
  index.ts              ← WebSocket server bootstrap, auth handshake
  User.ts               ← One instance per connected browser tab
  UserManager.ts        ← Registry: connectionId → User
  SubscriptionManager.ts ← Redis Pub/Sub bridge
  TicketStore.ts        ← One-time ticket validation
```

---

## `index.ts` — Connection Handling

```typescript
const WS_PORT = Number(process.env.WS_PORT) || 3001;
const AUTH_MESSAGE_MAX_BYTES = 1024;       // Max 1KB for auth messages
const CONNECTION_WINDOW_MS = 60_000;       // 1-minute window
const MAX_CONNECTIONS_PER_WINDOW = 60;     // Max 60 new connections per IP per minute
```

**Why connection rate limiting?** Without it, an attacker can open thousands of WebSocket connections from one IP, consuming all server memory (each connection = memory for buffers, state). Rate limiting at the connection level stops this before resources are allocated.

```typescript
wss.on("connection", (ws, req) => {
    UserManager.getInstance().addUser(ws, "guest");
    //                                      ↑ Everyone starts as "guest" until they auth
    
    const clientIp = getClientIp(req);
    if (!checkConnectionLimit(clientIp)) {
        ws.send(JSON.stringify({ error: "Too many connection attempts" }));
        ws.close(4008, "Rate limit exceeded");
        //       ↑ 4000-4999 range = application-level close codes (custom)
        return;
    }
```

`addUser` is called **before** the rate limit check. Why? Because `UserManager.addUser` also registers the `close` handler. If you reject before adding the user, the `close` handler never fires, but that's okay — the user was never fully added.

Actually — this is slightly inconsistent. The user IS added to `UserManager` but then the connection is immediately closed. `UserManager.addUser` also calls `registerOnClose`, which will clean up when the socket closes. So the cleanup happens correctly.

**The auth message handler:**
```typescript
ws.on("message", async (rawMessage) => {
    if (rawDataByteLength(rawMessage) > AUTH_MESSAGE_MAX_BYTES) {
        ws.send(JSON.stringify({ error: "Payload too large" }));
        return;
    }
    
    const parsedMessage: TicketMessage = JSON.parse(rawDataToString(rawMessage));
    const ticket = parsedMessage.ticket || parsedMessage.params?.ticket;
    
    if (parsedMessage.method === "AUTH" && ticket) {
        if (!/^[0-9a-fA-F-]{36}$/.test(ticket)) {
            ws.send(JSON.stringify({ error: "Invalid ticket format" }));
            return;
        }
```

**The UUID regex `[0-9a-fA-F-]{36}`**: Validates that the ticket looks like a UUID before even hitting Redis. Prevents injection attacks where someone sends a malicious string as a "ticket."

```typescript
        const payload = await TicketStore.getInstance().consume(ticket);
        if (!payload) {
            ws.send(JSON.stringify({ error: "Invalid or expired ticket" }));
            return;
        }
        
        ws.send(JSON.stringify({ type: "AUTH_SUCCESS", userId: payload.userId }));
    }
});
```

After `AUTH_SUCCESS`, the browser subscribes to streams using `User.ts`'s message handler.

---

## `UserManager.ts` — The Connection Registry

```typescript
public addUser(ws: WebSocket, userId: string) {
    const id = crypto.randomUUID();  // Connection ID (NOT the real userId)
    const user = new User(id, ws, userId);
    this.users.set(id, user);        // Map: connectionId → User
    this.registerOnClose(ws, id);
    return user;
}

private registerOnClose(ws: WebSocket, id: string) {
    ws.on("close", () => {
        const user = this.users.get(id);
        if (user) user.destroy();           // Stop heartbeat timer
        this.users.delete(id);              // Remove from registry
        SubscriptionManager.getInstance().userLeft(id);  // Unsubscribe from all channels
    });
}
```

**Why a connection ID instead of userId?** One user (one account) can open multiple browser tabs. Each tab = one WebSocket connection = one connection ID. The `SubscriptionManager` maps stream subscriptions to connection IDs, so each tab subscribes independently and receives its own copy of messages.

`userLeft(id)` → `SubscriptionManager.unsubscribe` for all streams this connection was watching → if this was the last watcher of a channel, Redis subscription is dropped.

---

## `User.ts` — The WebSocket Wrapper

```typescript
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

export class User {
    private alive: boolean = true;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    
    private startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (!this.alive) {
                console.log(`User ${this.id}: no pong received, terminating`);
                this.ws.terminate();  // Force close
                this.destroy();
                return;
            }
            this.alive = false;   // Assume dead until proven alive
            this.ws.ping();       // Send ping
        }, HEARTBEAT_INTERVAL);
    }
    
    // When pong received:
    this.ws.on("pong", () => { this.alive = true; });
```

**The heartbeat protocol (Ping/Pong):**

Without heartbeats, a WebSocket connection can appear open but actually be dead (network cut, client crashed, NAT table expired). The server would keep it in memory forever.

**How it works:**
1. Every 30 seconds: server sends a **PING** frame to the client
2. Client's WebSocket library automatically responds with a **PONG** frame
3. If no PONG arrives before the next ping interval: `alive` is still `false` → terminate

`ws.terminate()` is a hard close (TCP RST) — no graceful handshake. `ws.close()` would attempt a graceful close, but if the connection is dead, it would hang.

**The logic pattern:**
```
Timer fires:
  if (!alive) → connection was dead last interval → kill it
  alive = false  → assume dead
  ws.ping()      → wait for pong to prove alive
```

This means a connection gets exactly ONE ping period (30s) to prove it's alive before being killed.

---

## `SubscriptionManager.ts` — The Redis/WS Bridge

The two Maps at the heart of the system:

```typescript
private subscriptions: Map<string, string[]> = new Map();
// connectionId → [streams I'm watching]
// Example: "abc-123" → ["trade.SOL_USDC", "depth.SOL_USDC", "ticker.SOL_USDC"]

private reverseSubscriptions: Map<string, string[]> = new Map();
// stream → [connectionIds watching it]
// Example: "trade.SOL_USDC" → ["abc-123", "def-456", "ghi-789", ...5000 more]
```

**Why keep both?** They answer different questions:
- "What is user X watching?" → `subscriptions.get(connectionId)` 
  - Used when user disconnects: unsubscribe from everything
- "Who is watching stream Y?" → `reverseSubscriptions.get(stream)`
  - Used when Redis publishes a message: who do I send it to?

```typescript
public subscribe(userId: string, subscription: string) {
    // Prevent duplicate subscriptions
    if (this.subscriptions.get(userId)?.includes(subscription)) return;
    
    // Limit per connection (prevent abuse: one user subscribing to 1000 streams)
    const currentSubs = this.subscriptions.get(userId) || [];
    if (currentSubs.length >= MAX_SUBSCRIPTIONS_PER_USER) {
        console.warn(`User ${userId} exceeded max subscriptions`);
        return;
    }
    
    this.subscriptions.set(userId, currentSubs.concat(subscription));
    this.reverseSubscriptions.set(subscription, [...].concat(userId));
    
    // Only subscribe to Redis if this is the FIRST watcher
    if (this.reverseSubscriptions.get(subscription)?.length === 1) {
        this.redisClient.subscribe(subscription, this.redisCallbackHandler);
    }
}
```

```typescript
public unsubscribe(userId: string, subscription: string) {
    // Remove from forward map
    this.subscriptions.set(userId, subscriptions.filter(s => s !== subscription));
    
    // Remove from reverse map
    this.reverseSubscriptions.set(subscription, reverseSubscriptions.filter(s => s !== userId));
    
    // If NO more watchers: unsubscribe from Redis
    if (this.reverseSubscriptions.get(subscription)?.length === 0) {
        this.reverseSubscriptions.delete(subscription);
        this.redisClient.unsubscribe(subscription);
    }
}
```

**The Redis subscription lifecycle:**
- First user subscribes to `"trade.SOL_USDC"` → Redis subscription created
- 999 more users subscribe → same Redis subscription, just added to reverse map
- All 1000 users unsubscribe → Redis subscription dropped
- No ghost subscriptions accumulate

**`userLeft(userId)`:**
```typescript
public userLeft(userId: string) {
    this.subscriptions.get(userId)?.forEach(s => this.unsubscribe(userId, s));
}
```
Calls `unsubscribe` for every stream this connection was watching. The cascade effect: if this was the last watcher of any stream, the Redis subscription is also dropped.

---

## Debugging the WebSocket System

### "Browser not receiving real-time updates"

Open browser DevTools → Network → WS tab. Click the WebSocket connection. Watch the Messages panel:
- Should see `SUBSCRIBE` messages going out
- Should see ticker/trade/depth messages coming in

If nothing coming in:
```bash
redis-cli SUBSCRIBE trade.SOL_USDC
# Place a trade. If you see the message here but browser doesn't → bug in WS server
# If you don't see it here → bug in engine (not publishing)
```

### "WebSocket connection drops every 30 seconds"

The heartbeat isn't getting a PONG. Possible causes:
- Proxy server stripping WebSocket control frames (common in corporate networks)
- Client-side firewall blocking pong
- High server load causing 30s+ delays

Check: `ws.terminate()` is being called in the heartbeat timer — add a console.log before it to confirm this is the cause.

### "Too many subscriptions" warning in WS logs

A user is subscribing without unsubscribing. Common bug: component mounts and subscribes, but `useEffect` cleanup doesn't unsubscribe. Check `SignalingManager.deRegisterCallback` is being called on component unmount.
