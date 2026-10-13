# Module 06 — Enterprise Authentication, Session Management & Security

> **Defense in Depth: Protecting User Accounts and Secrets**  
> *"In a cryptocurrency exchange, user credentials guard direct financial wealth. An authentication vulnerability doesn't just mean compromised profiles — it means millions of dollars drained in minutes. This module provides an exhaustive line-by-line breakdown of `api/src/auth/AuthService.ts`, `AuthRedis.ts`, `AuthDb.ts`, `sessionCleanup.ts`, `EmailService.ts`, and all security middlewares."*

---

## 1. The Threat Model & The Hybrid Token Architecture

Why can't an exchange simply use basic session cookies or standard JWTs?
1. **The Pure Cookie Trap (CSRF & WS Limitations)**:
   Plain cookies are vulnerable to Cross-Site Request Forgery (CSRF). Furthermore, browser WebSocket APIs (`new WebSocket(url)`) do not allow custom headers, and sending credentials in the URL query string leaks tokens into proxy and access logs.
2. **The Pure LocalStorage JWT Trap (XSS)**:
   Storing long-lived JWTs in browser `localStorage` means any Cross-Site Scripting (XSS) vulnerability in any third-party npm package can steal the user's permanent credential.
3. **The Unrevokable JWT Problem**:
   Standard stateless JWTs cannot be revoked until they expire. If a user's laptop is stolen, an attacker can use the token until expiration.

### The Solution: The Hybrid Rotating Session Model

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THE HYBRID TOKEN MODEL                          │
├───────────────────────────────┬────────────────────────────────────────┤
│ ACCESS TOKEN                  │ REFRESH TOKEN                          │
├───────────────────────────────┼────────────────────────────────────────┤
│ 15-Minute Short Lifespan      │ 7-Day Long Lifespan                    │
│ In-Memory / LocalStorage      │ HttpOnly; SameSite=None; Secure Cookie │
│ Carried in Authorization Header│ Carried automatically by browser      │
│ Verified statelessly by JWT   │ Verified statefully against PostgreSQL │
│ Used for HTTP API & Orders    │ Used ONLY to rotate tokens at /refresh │
└───────────────────────────────┴────────────────────────────────────────┘
```

---

## 2. Refresh Token Rotation & Theft Detection (BCP 195)

In `api/src/auth/AuthService.ts` (lines 211–259), refresh tokens are **single-use only**. Every single refresh operation destroys the old token and issues a new pair.

```typescript
public async refresh(refreshToken: string, meta?: { ip?: string; userAgent?: string }) {
    const claims = parseClaims<RefreshClaims>(refreshToken, REFRESH_TOKEN_SECRET);

    if (claims.type !== "refresh" || !claims.sub || !claims.sid) {
        throw new Error("Invalid refresh token");
    }

    // Atomic rotation: consume the session ONLY if the refresh-token hash matches.
    // This compare-and-swap prevents a double-spend when a client fires two
    // refreshes concurrently — only one DELETE can win.
    const consumedUserId = await consumeSession(claims.sid, hashToken(refreshToken));

    if (!consumedUserId) {
        // Either the session is expired, or the hash didn't match.
        // If the session still exists in DB with a different hash, this is a REUSED
        // (possibly stolen) token — revoke the entire session as a safety measure!
        const stale = await getSessionById(claims.sid);
        if (stale) {
            await deleteSession(claims.sid);
            throw new Error("Refresh token reuse detected — session revoked");
        }
        throw new Error("Refresh session not found");
    }

    // Issue brand new Access + Refresh token pair
    const roles = await getUserRoles(user.id);
    const tokens = await this.issueTokens(user, roles, meta);
    return { user: { id: user.id, email: user.email, roles }, ...tokens };
}
```

```
Normal Flow:
Client ──[Refresh Token 1]──> API ──> Deletes Token 1 from DB ──> Returns Token 2

Theft / Replay Attack Scenario:
Attacker intercepts Token 1.
Legitimate Client refreshes: Token 1 is deleted, Token 2 is issued to Client.
Attacker submits stolen Token 1:
API checks DB: "Token 1 hash does not match current DB session!"
API triggers ALARM: Token reuse detected!
API nukes the entire session: deleteSession(claims.sid)
Result: Attacker is blocked, and Client is forced to re-login. Breach contained!
```

---

## 3. Atomic Session Limits & Eviction: `AuthDb.ts` (Lines 148–190)

To prevent credential sharing and limit the blast radius of compromised accounts, the exchange limits each user to **3 concurrent active sessions**:

```typescript
export async function createSessionWithLimit(session: {
    sessionId: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
}, maxSessions: number): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Insert the new session
        await client.query(
            `INSERT INTO auth_sessions (session_id, user_id, refresh_token_hash, ip_address, user_agent, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [session.sessionId, session.userId, session.refreshTokenHash, session.ipAddress, session.userAgent, session.expiresAt]
        );

        // 2. Atomically prune all sessions except the newest `maxSessions`
        const pruned = await client.query(
            `DELETE FROM auth_sessions
             WHERE user_id = $1 AND expires_at > NOW()
               AND session_id NOT IN (
                   SELECT session_id FROM auth_sessions
                   WHERE user_id = $1 AND expires_at > NOW()
                   ORDER BY created_at DESC
                   LIMIT $2
               )`,
            [session.userId, maxSessions]
        );

        await client.query("COMMIT");
        return pruned.rowCount || 0;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}
```

### The TOCTOU Race Condition Eliminated:
- **What is TOCTOU?** Time-of-Check to Time-of-Use.
- If you check session count (`SELECT count(*)`) in one query and insert in a second query, two simultaneous logins from the same user both see `count = 2`, both insert, and the user ends up with 4 active sessions.
- In our code, the `INSERT` and `DELETE ... NOT IN (SELECT ... LIMIT 3)` execute inside a single atomic SQL transaction (`BEGIN ... COMMIT`).
- When the 4th device logs in, the oldest session is instantly evicted.

---

## 4. Brute-Force Defense: Account Lockout & Redis Rate Limiting

In `AuthService.ts` (lines 508–553), login attempts are guarded by a Redis-backed lockout state machine:

```typescript
private async checkAccountLockout(email: string) {
    const client = await AuthRedis.getInstance().getClient();
    const attempts = await client.get(this.lockoutKey(email));
    if (attempts && Number(attempts) >= MAX_FAILED_LOGINS) {
        const ttl = await client.ttl(this.lockoutKey(email));
        throw new Error(`Account temporarily locked. Try again in ${Math.max(1, ttl)} seconds.`);
    }
}

private async recordFailedLogin(email: string) {
    const client = await AuthRedis.getInstance().getClient();
    const key = this.lockoutKey(email);
    const current = await client.incr(key);
    if (current === 1) {
        // Set 15-minute TTL on first failed attempt
        await client.expire(key, LOCKOUT_DURATION_SECONDS);
    }
}
```

### The Rules:
- `MAX_FAILED_LOGINS = 5`: A user gets 5 incorrect password attempts.
- `LOCKOUT_DURATION_SECONDS = 900` (15 minutes).
- On the 5th failure, any subsequent login attempt throws HTTP 429 `"Account temporarily locked. Try again in X seconds"`.
- On successful login: `clearFailedLogins(email)` deletes the Redis counter.

---

## 5. One-Time 60-Second WebSocket Tickets (`/ws-ticket`)

WebSocket connections cannot pass standard `Authorization: Bearer` HTTP headers in browser JavaScript. Passing JWTs in the query parameter (`ws://localhost:3001?token=jwt`) is a security violation because URLs are logged in Nginx access logs, proxies, and browser history.

### The Ticket Exchange Protocol:

```
Browser Client                                REST API                                WebSocket Gateway
      │                                           │                                           │
      │ 1. POST /api/v1/auth/ws-ticket            │                                           │
      │    Header: Authorization: Bearer <jwt>    │                                           │
      │──────────────────────────────────────────>│                                           │
      │                                           │ Store in Redis:                           │
      │                                           │ SET ws:ticket:<uuid>                      │
      │                                           │ EX 60 seconds                             │
      │ 2. 200 OK: { ticket: "<uuid>" }           │                                           │
      │<──────────────────────────────────────────│                                           │
      │                                                                                       │
      │ 3. Connect as GUEST: new WebSocket("ws://localhost:3001")                             │
      │──────────────────────────────────────────────────────────────────────────────────────>│
      │                                                                                       │
      │ 4. First Message Sent: { method: "AUTH", params: { ticket: "<uuid>" } }               │
      │──────────────────────────────────────────────────────────────────────────────────────>│
      │                                                                                       │
      │                                                   5. Redis: GET & DEL ws:ticket:<uuid>│
      │                                                   (Single-use consume)                │
      │                                                   Upgrade connection to authenticated │
      │ 6. Receive: { type: "AUTH_SUCCESS", userId: "..." }                                   │
      │<──────────────────────────────────────────────────────────────────────────────────────│
```

```typescript
// api/src/auth/AuthService.ts
public async createWsTicket(userId: string) {
    const client = await AuthRedis.getInstance().getClient();
    const ticket = crypto.randomUUID();

    await client.set(
        this.wsTicketKey(ticket),
        JSON.stringify({ userId, issuedAt: Date.now() }),
        { EX: 60 } // 60-second TTL
    );

    return { ticket, expiresIn: 60 };
}
```

---

## 6. Email Verification & Password Reset with Cryptographic OTP

`AuthService.ts` and `EmailService.ts` provide secure OTP flows for signups and password recovery.

### The 6-Digit Cryptographic OTP:
```typescript
function generateOTP(): string {
    return crypto.randomInt(100000, 999999).toString();
}
```
- Uses `crypto.randomInt` (hardware-backed CSPRNG), **never** `Math.random()`!
- Produces a uniform distribution between $100,000$ and $999,999$.

### Critical Anti-Brute-Force Invariant (Lines 321–326):
```typescript
await client.set(this.otpKey(normalizedEmail, "verify"), otp, { EX: OTP_TTL_SECONDS });
// NOTE: deliberately do NOT reset the attempts counter here. Resetting it on
// every resend let an attacker refresh their guess budget indefinitely!
```
- If an attacker attempts to brute-force a 6-digit code, they get **5 guesses** (`OTP_MAX_ATTEMPTS = 5`).
- If an attacker repeatedly requests "Resend OTP", the attempts counter is **not reset**. This blocks automated guess-amplification attacks.

---

## 7. Role-Based Access Control (RBAC): `authorize.ts`

```typescript
export function requireRoles(allowedRoles: string[]) {
    return function authorize(req: Request, res: Response, next: NextFunction) {
        if (!req.auth) return res.status(401).json({ error: "Authentication required" });

        const userRoles = req.auth.roles || [];
        const hasRole = allowedRoles.some((role) => userRoles.includes(role));

        if (!hasRole) {
            return res.status(403).json({ error: "Forbidden: insufficient permissions" });
        }

        return next();
    };
}
```

- Any endpoint taking trading or balance actions requires `requireRoles(["user", "admin"])`.
- Internal services (Market Maker) are verified in `authenticate.ts` and granted both roles automatically.
