import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { AuthRedis } from "./AuthRedis";
import { EmailService } from "./EmailService";
import {
    assignRole,
    countSessionsByUser,
    createSession,
    createUser,
    deleteOldestSessions,
    deleteSession,
    getActiveSessions,
    getSessionById,
    getUserByEmail,
    getUserById,
    getUserRoles,
    DbUser,
    DbSession,
} from "../db/AuthDb";

export type AuthenticatedUser = {
    userId: string;
    email: string;
    sessionId: string;
    roles: string[];
};

type AccessClaims = JwtPayload & {
    sub: string;
    email: string;
    sid: string;
    roles: string[];
    type: "access";
};

type RefreshClaims = JwtPayload & {
    sub: string;
    sid: string;
    type: "refresh";
};

/* ═══════════════════════════════════════════════════════════════
   Configuration
   ═══════════════════════════════════════════════════════════════ */

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "dev-access-secret-change-me";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "dev-refresh-secret-change-me";
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TOKEN_TTL_SECONDS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 7);
const WS_TICKET_TTL_SECONDS = 60;
const OTP_TTL_SECONDS = 300; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;  // Max verification attempts before lockout

/** Maximum concurrent sessions per user (exchange standard: 3) */
const MAX_SESSIONS_PER_USER = 3;

/** Number of failed login attempts before temporary lockout */
const MAX_FAILED_LOGINS = 5;

/** Lockout duration in seconds after exceeding failed login limit */
const LOCKOUT_DURATION_SECONDS = 15 * 60; // 15 minutes

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════ */

function hashToken(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string) {
    return email.trim().toLowerCase();
}

function normalizeRoles(roles: unknown): string[] {
    if (!Array.isArray(roles)) {
        return [];
    }

    return roles.filter((role) => typeof role === "string");
}

function parseClaims<T extends JwtPayload>(token: string, secret: string): T {
    return jwt.verify(token, secret, { algorithms: ["HS256"] }) as T;
}

/* ═══════════════════════════════════════════════════════════════
   AuthService
   ═══════════════════════════════════════════════════════════════ */

export class AuthService {
    private static instance: AuthService;

    private constructor() {
        if (process.env.NODE_ENV === "production") {
            if (ACCESS_TOKEN_SECRET === "dev-access-secret-change-me") {
                throw new Error("ACCESS_TOKEN_SECRET must be set in production");
            }
            if (REFRESH_TOKEN_SECRET === "dev-refresh-secret-change-me") {
                throw new Error("REFRESH_TOKEN_SECRET must be set in production");
            }
        }
    }

    public static getInstance() {
        if (!this.instance) {
            this.instance = new AuthService();
        }
        return this.instance;
    }

    public getRefreshTtlSeconds() {
        return REFRESH_TOKEN_TTL_SECONDS;
    }

    /* ─── Register ─── */

    public async register(email: string, password: string, meta?: { ip?: string; userAgent?: string }) {
        const normalizedEmail = normalizeEmail(email);
        this.validateCredentials(normalizedEmail, password);

        const existingUser = await getUserByEmail(normalizedEmail);
        if (existingUser) {
            throw new Error("Email is already registered");
        }

        const user = await createUser({
            id: crypto.randomUUID(),
            email: normalizedEmail,
            passwordHash: await bcrypt.hash(password, 12),
        });

        await assignRole(user.id, "user");

        // Send verification OTP
        await this.sendVerificationOTP(normalizedEmail);

        return {
            user: {
                id: user.id,
                email: user.email,
            },
            requiresVerification: true,
        };
    }

    /* ─── Login ─── */

    public async login(email: string, password: string, meta?: { ip?: string; userAgent?: string }) {
        const normalizedEmail = normalizeEmail(email);
        this.validateCredentials(normalizedEmail, password, true);

        // Check account lockout before anything else
        await this.checkAccountLockout(normalizedEmail);

        const user = await getUserByEmail(normalizedEmail);
        if (!user) {
            await this.recordFailedLogin(normalizedEmail);
            throw new Error("Invalid credentials");
        }

        this.ensureActiveUser(user);

        const isValidPassword = await bcrypt.compare(password, user.passwordHash);
        if (!isValidPassword) {
            await this.recordFailedLogin(normalizedEmail);
            throw new Error("Invalid credentials");
        }

        // Successful login — clear failed attempts
        await this.clearFailedLogins(normalizedEmail);

        const roles = await getUserRoles(user.id);
        const tokens = await this.issueTokens(user, roles, meta);

        return {
            user: {
                id: user.id,
                email: user.email,
                roles,
            },
            ...tokens,
        };
    }

    /* ─── Verify Access Token ─── */

    public verifyAccessToken(accessToken: string): AuthenticatedUser {
        const claims = parseClaims<AccessClaims>(accessToken, ACCESS_TOKEN_SECRET);

        if (claims.type !== "access" || !claims.sub || !claims.email || !claims.sid) {
            throw new Error("Invalid access token");
        }

        const roles = normalizeRoles(claims.roles);

        return {
            userId: claims.sub,
            email: claims.email,
            sessionId: claims.sid,
            roles,
        };
    }

    /* ─── Refresh ─── */

    public async refresh(refreshToken: string, meta?: { ip?: string; userAgent?: string }) {
        const claims = parseClaims<RefreshClaims>(refreshToken, REFRESH_TOKEN_SECRET);

        if (claims.type !== "refresh" || !claims.sub || !claims.sid) {
            throw new Error("Invalid refresh token");
        }

        const session = await getSessionById(claims.sid);

        if (!session || session.userId !== claims.sub) {
            throw new Error("Refresh session not found");
        }

        if (session.refreshTokenHash !== hashToken(refreshToken)) {
            // Token mismatch — possible token theft. Revoke the session.
            await deleteSession(claims.sid);
            throw new Error("Refresh token mismatch — session revoked");
        }

        const user = await getUserById(claims.sub);
        if (!user) {
            await deleteSession(claims.sid);
            throw new Error("User not found");
        }

        this.ensureActiveUser(user);

        const roles = await getUserRoles(user.id);

        // Rotate: delete old session, issue new tokens
        await deleteSession(claims.sid);
        const tokens = await this.issueTokens(user, roles, meta);

        return {
            user: {
                id: user.id,
                email: user.email,
                roles,
            },
            ...tokens,
        };
    }

    /* ─── Logout ─── */

    public async logout(refreshToken: string) {
        try {
            const claims = parseClaims<RefreshClaims>(refreshToken, REFRESH_TOKEN_SECRET);
            if (!claims.sid) {
                return;
            }
            await deleteSession(claims.sid);
        } catch {
            // Logout should be idempotent.
        }
    }

    /* ─── WebSocket Ticket ─── */

    public async createWsTicket(userId: string) {
        const user = await getUserById(userId);
        if (!user) {
            throw new Error("User not found");
        }

        this.ensureActiveUser(user);

        const client = await AuthRedis.getInstance().getClient();
        const ticket = crypto.randomUUID();

        await client.set(
            this.wsTicketKey(ticket),
            JSON.stringify({ userId, issuedAt: Date.now() }),
            { EX: WS_TICKET_TTL_SECONDS }
        );

        return {
            ticket,
            expiresIn: WS_TICKET_TTL_SECONDS,
        };
    }

    /* ─── Session Management ─── */

    public async getActiveSessions(userId: string): Promise<DbSession[]> {
        return getActiveSessions(userId);
    }

    public async revokeSession(sessionId: string, requestingUserId: string) {
        const session = await getSessionById(sessionId);
        if (!session || session.userId !== requestingUserId) {
            throw new Error("Session not found");
        }
        await deleteSession(sessionId);
    }

    /* ─── Email Verification OTP ─── */

    public async sendVerificationOTP(email: string) {
        const normalizedEmail = normalizeEmail(email);
        const emailService = EmailService.getInstance();
        const otp = emailService.generateOTP();

        const client = await AuthRedis.getInstance().getClient();
        await client.set(this.otpKey(normalizedEmail, "verify"), otp, { EX: OTP_TTL_SECONDS });
        await client.del(this.otpAttemptsKey(normalizedEmail, "verify"));

        await emailService.sendOTP(normalizedEmail, otp, "verify");
        return { sent: true };
    }

    public async verifyEmailOTP(email: string, otp: string, meta?: { ip?: string; userAgent?: string }) {
        const normalizedEmail = normalizeEmail(email);
        const client = await AuthRedis.getInstance().getClient();

        // Rate limit attempts
        const attemptsKey = this.otpAttemptsKey(normalizedEmail, "verify");
        const attempts = await client.incr(attemptsKey);
        if (attempts === 1) await client.expire(attemptsKey, OTP_TTL_SECONDS);
        if (attempts > OTP_MAX_ATTEMPTS) {
            throw new Error("Too many attempts. Please request a new code.");
        }

        const storedOtp = await client.get(this.otpKey(normalizedEmail, "verify"));
        if (!storedOtp || storedOtp !== otp.trim()) {
            throw new Error("Invalid or expired verification code");
        }

        // Mark email as verified
        const user = await getUserByEmail(normalizedEmail);
        if (!user) throw new Error("User not found");

        await this.markEmailVerified(user.id);

        // Clean up OTP keys
        await client.del(this.otpKey(normalizedEmail, "verify"));
        await client.del(attemptsKey);

        // Issue tokens (auto-login after verification)
        const roles = await getUserRoles(user.id);
        const tokens = await this.issueTokens(user, roles, meta);

        return {
            user: {
                id: user.id,
                email: user.email,
                roles,
            },
            ...tokens,
        };
    }

    /* ─── Forgot Password / Reset ─── */

    public async sendResetOTP(email: string) {
        const normalizedEmail = normalizeEmail(email);
        const user = await getUserByEmail(normalizedEmail);
        if (!user) {
            // Don't reveal whether email exists
            return { sent: true };
        }

        const emailService = EmailService.getInstance();
        const otp = emailService.generateOTP();

        const client = await AuthRedis.getInstance().getClient();
        await client.set(this.otpKey(normalizedEmail, "reset"), otp, { EX: OTP_TTL_SECONDS });
        await client.del(this.otpAttemptsKey(normalizedEmail, "reset"));

        await emailService.sendOTP(normalizedEmail, otp, "reset");
        return { sent: true };
    }

    public async resetPassword(email: string, otp: string, newPassword: string) {
        const normalizedEmail = normalizeEmail(email);
        this.validateCredentials(normalizedEmail, newPassword);

        const client = await AuthRedis.getInstance().getClient();

        // Rate limit
        const attemptsKey = this.otpAttemptsKey(normalizedEmail, "reset");
        const attempts = await client.incr(attemptsKey);
        if (attempts === 1) await client.expire(attemptsKey, OTP_TTL_SECONDS);
        if (attempts > OTP_MAX_ATTEMPTS) {
            throw new Error("Too many attempts. Please request a new code.");
        }

        const storedOtp = await client.get(this.otpKey(normalizedEmail, "reset"));
        if (!storedOtp || storedOtp !== otp.trim()) {
            throw new Error("Invalid or expired reset code");
        }

        const user = await getUserByEmail(normalizedEmail);
        if (!user) throw new Error("User not found");

        // Update password
        await this.updatePassword(user.id, newPassword);

        // Clean up
        await client.del(this.otpKey(normalizedEmail, "reset"));
        await client.del(attemptsKey);

        return { success: true };
    }

    private async markEmailVerified(userId: string) {
        const { pool } = await import("../db/pool");
        await pool.query(
            "UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = $1",
            [userId]
        );
    }

    private async updatePassword(userId: string, newPassword: string) {
        const { pool } = await import("../db/pool");
        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
            [hash, userId]
        );
    }

    /* ─── Private: Token Issuance ─── */

    private async issueTokens(user: DbUser, roles: string[], meta?: { ip?: string; userAgent?: string }) {
        const sessionId = crypto.randomUUID();

        const refreshSignOptions: SignOptions = {
            subject: user.id,
            expiresIn: REFRESH_TOKEN_TTL_SECONDS,
        };

        const refreshToken = jwt.sign(
            {
                type: "refresh",
                sid: sessionId,
            },
            REFRESH_TOKEN_SECRET,
            {
                ...refreshSignOptions,
                algorithm: "HS256",
            }
        );

        const accessSignOptions: SignOptions = {
            subject: user.id,
            expiresIn: ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
        };

        const accessToken = jwt.sign(
            {
                type: "access",
                email: user.email,
                sid: sessionId,
                roles,
            },
            ACCESS_TOKEN_SECRET,
            {
                ...accessSignOptions,
                algorithm: "HS256",
            }
        );

        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
        await createSession({
            sessionId,
            userId: user.id,
            refreshTokenHash: hashToken(refreshToken),
            expiresAt,
            ipAddress: meta?.ip,
            userAgent: meta?.userAgent,
        });

        // Enforce concurrent session limit — evict oldest if over limit
        const sessionCount = await countSessionsByUser(user.id);
        if (sessionCount > MAX_SESSIONS_PER_USER) {
            const evicted = await deleteOldestSessions(user.id, MAX_SESSIONS_PER_USER);
            if (evicted > 0) {
                console.log(`[AUTH] Evicted ${evicted} oldest session(s) for user ${user.id} (limit: ${MAX_SESSIONS_PER_USER})`);
            }
        }

        return {
            accessToken,
            refreshToken,
            expiresIn: ACCESS_TOKEN_TTL,
        };
    }

    /* ─── Private: Account Lockout ─── */

    private lockoutKey(email: string) {
        return `auth:lockout:${email}`;
    }

    private async checkAccountLockout(email: string) {
        try {
            const client = await AuthRedis.getInstance().getClient();
            const attempts = await client.get(this.lockoutKey(email));
            if (attempts && Number(attempts) >= MAX_FAILED_LOGINS) {
                const ttl = await client.ttl(this.lockoutKey(email));
                throw new Error(
                    `Account temporarily locked. Try again in ${Math.max(1, ttl)} seconds.`
                );
            }
        } catch (error: any) {
            // Re-throw lockout errors, swallow Redis connectivity issues
            if (error?.message?.startsWith("Account temporarily locked")) {
                throw error;
            }
            // If Redis is down, fail open (don't block logins)
        }
    }

    private async recordFailedLogin(email: string) {
        try {
            const client = await AuthRedis.getInstance().getClient();
            const key = this.lockoutKey(email);
            const current = await client.incr(key);
            if (current === 1) {
                // Set TTL on first failure
                await client.expire(key, LOCKOUT_DURATION_SECONDS);
            }
        } catch {
            // If Redis is down, skip lockout tracking
        }
    }

    private async clearFailedLogins(email: string) {
        try {
            const client = await AuthRedis.getInstance().getClient();
            await client.del(this.lockoutKey(email));
        } catch {
            // Non-critical
        }
    }

    /* ─── Private: Validation ─── */

    private ensureActiveUser(user: DbUser) {
        if (user.status !== "active") {
            throw new Error("User is not active");
        }
    }

    private validateCredentials(email: string, password: string, isLogin = false) {
        const isEmailLike = /^\S+@\S+\.\S+$/.test(email);
        if (!isEmailLike) {
            throw new Error("Invalid email address");
        }

        if (isLogin) {
            if (!password) {
                throw new Error("Password is required");
            }
            return;
        }

        // Registration: enforce password complexity
        if (password.length < 8) {
            throw new Error("Password must be at least 8 characters");
        }

        if (!/[a-zA-Z]/.test(password)) {
            throw new Error("Password must contain at least one letter");
        }

        if (!/[0-9]/.test(password)) {
            throw new Error("Password must contain at least one number");
        }
    }

    private wsTicketKey(ticket: string) {
        return `ws:ticket:${ticket}`;
    }

    private otpKey(email: string, purpose: string) {
        return `otp:${purpose}:${email}`;
    }

    private otpAttemptsKey(email: string, purpose: string) {
        return `otp:attempts:${purpose}:${email}`;
    }
}