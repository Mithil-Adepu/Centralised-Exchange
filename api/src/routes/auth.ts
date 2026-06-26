import { Router } from "express";
import { AuthService } from "../auth/AuthService";
import { authenticate } from "../middleware/authenticate";
import { requireRoles } from "../middleware/authorize";
import { createRateLimiter } from "../middleware/rateLimit";
import { auditLog } from "../utils/audit";
import { parseRequiredString } from "../utils/validation";

const REFRESH_COOKIE_NAME = "refreshToken";

const authAttemptLimiter = createRateLimiter({
    keyPrefix: "rl:auth:attempt",
    max: 20,
    windowSeconds: 60,
});

const authRefreshLimiter = createRateLimiter({
    keyPrefix: "rl:auth:refresh",
    max: 40,
    windowSeconds: 60,
});

const wsTicketLimiter = createRateLimiter({
    keyPrefix: "rl:auth:ws-ticket",
    max: 30,
    windowSeconds: 60,
    keyGenerator: (req) => req.auth?.userId || req.ip || "unknown",
});

/* ═══════════════════════════════════════════════════════════════
   Cookie Helpers
   ═══════════════════════════════════════════════════════════════ */

function getCookieValue(cookieHeader: string | undefined, name: string) {
    if (!cookieHeader) {
        return null;
    }

    const pairs = cookieHeader.split(";").map(part => part.trim());
    const cookie = pairs.find(part => part.startsWith(`${name}=`));
    if (!cookie) {
        return null;
    }

    return decodeURIComponent(cookie.slice(name.length + 1));
}

function setRefreshCookie(res: any, token: string, maxAgeSeconds: number) {
    const isSecure = process.env.NODE_ENV === "production";
    const parts = [
        `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
        "HttpOnly",
        "Path=/api/v1/auth",
        "SameSite=Strict",
        "Priority=High",
        `Max-Age=${maxAgeSeconds}`,
    ];

    if (isSecure) {
        parts.push("Secure");
    }

    res.setHeader("Set-Cookie", parts.join("; "));
}

function clearRefreshCookie(res: any) {
    const isSecure = process.env.NODE_ENV === "production";
    const parts = [
        `${REFRESH_COOKIE_NAME}=`,
        "HttpOnly",
        "Path=/api/v1/auth",
        "SameSite=Strict",
        "Priority=High",
        "Max-Age=0",
    ];

    if (isSecure) {
        parts.push("Secure");
    }

    res.setHeader("Set-Cookie", parts.join("; "));
}

function getRefreshTokenFromRequest(req: any) {
    if (typeof req.body?.refreshToken === "string" && req.body.refreshToken.length > 0) {
        return req.body.refreshToken;
    }

    return getCookieValue(req.headers.cookie, REFRESH_COOKIE_NAME);
}

/** Extract client metadata for session tracking */
function getRequestMeta(req: any) {
    return {
        ip: req.ip || req.socket?.remoteAddress || "unknown",
        userAgent: req.headers["user-agent"] || "unknown",
    };
}

/* ═══════════════════════════════════════════════════════════════
   Auth Router
   ═══════════════════════════════════════════════════════════════ */

export const authRouter = Router();

/* ─── Register ─── */
authRouter.post("/register", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        const password = parseRequiredString(req.body?.password, "password");

        const payload = await AuthService.getInstance().register(email, password);

        auditLog({
            event: "auth.register",
            requestId: req.requestId,
            ip: req.ip,
            success: true,
            details: { email },
        });

        return res.status(201).json({
            user: payload.user,
            requiresVerification: true,
        });
    } catch (error: any) {
        auditLog({
            event: "auth.register",
            level: "warn",
            requestId: req.requestId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        return res.status(400).json({ error: error?.message || "Failed to register" });
    }
});

/* ─── Login ─── */
authRouter.post("/login", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        const password = parseRequiredString(req.body?.password, "password");
        const meta = getRequestMeta(req);

        const payload = await AuthService.getInstance().login(email, password, meta);
        setRefreshCookie(res, payload.refreshToken, AuthService.getInstance().getRefreshTtlSeconds());

        auditLog({
            event: "auth.login",
            requestId: req.requestId,
            userId: payload.user.id,
            ip: req.ip,
            success: true,
            details: { email: payload.user.email },
        });

        return res.json({
            user: payload.user,
            accessToken: payload.accessToken,
            expiresIn: payload.expiresIn,
        });
    } catch (error: any) {
        // Distinguish lockout (429) from bad credentials (401)
        const isLockout = error?.message?.startsWith("Account temporarily locked");
        const statusCode = isLockout ? 429 : 401;

        auditLog({
            event: "auth.login",
            level: "warn",
            requestId: req.requestId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        return res.status(statusCode).json({ error: error?.message || "Invalid credentials" });
    }
});

/* ─── Refresh ─── */
authRouter.post("/refresh", authRefreshLimiter, async (req, res) => {
    try {
        const refreshToken = getRefreshTokenFromRequest(req);
        if (!refreshToken) {
            return res.status(401).json({ error: "Missing refresh token" });
        }

        const meta = getRequestMeta(req);
        const payload = await AuthService.getInstance().refresh(refreshToken, meta);
        setRefreshCookie(res, payload.refreshToken, AuthService.getInstance().getRefreshTtlSeconds());

        auditLog({
            event: "auth.refresh",
            requestId: req.requestId,
            userId: payload.user.id,
            ip: req.ip,
            success: true,
        });

        return res.json({
            user: payload.user,
            accessToken: payload.accessToken,
            expiresIn: payload.expiresIn,
        });
    } catch (error: any) {
        auditLog({
            event: "auth.refresh",
            level: "warn",
            requestId: req.requestId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        return res.status(401).json({ error: error?.message || "Invalid refresh token" });
    }
});

/* ─── Logout ─── */
authRouter.post("/logout", async (req, res) => {
    const refreshToken = getRefreshTokenFromRequest(req);

    if (refreshToken) {
        await AuthService.getInstance().logout(refreshToken);
    }

    auditLog({
        event: "auth.logout",
        requestId: req.requestId,
        userId: req.auth?.userId,
        ip: req.ip,
        success: true,
    });

    clearRefreshCookie(res);
    return res.json({ success: true });
});

/* ─── Verify Email OTP (completes signup) ─── */
authRouter.post("/verify-otp", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        const otp = parseRequiredString(req.body?.otp, "otp");
        const meta = getRequestMeta(req);

        const payload = await AuthService.getInstance().verifyEmailOTP(email, otp, meta);
        setRefreshCookie(res, payload.refreshToken, AuthService.getInstance().getRefreshTtlSeconds());

        auditLog({
            event: "auth.verify-otp",
            requestId: req.requestId,
            userId: payload.user.id,
            ip: req.ip,
            success: true,
        });

        return res.json({
            user: payload.user,
            accessToken: payload.accessToken,
            expiresIn: payload.expiresIn,
        });
    } catch (error: any) {
        auditLog({
            event: "auth.verify-otp",
            level: "warn",
            requestId: req.requestId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        return res.status(400).json({ error: error?.message || "Verification failed" });
    }
});

/* ─── Resend Verification OTP ─── */
authRouter.post("/resend-otp", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        await AuthService.getInstance().sendVerificationOTP(email);

        auditLog({
            event: "auth.resend-otp",
            requestId: req.requestId,
            ip: req.ip,
            success: true,
            details: { email },
        });

        return res.json({ sent: true });
    } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Failed to send OTP" });
    }
});

/* ─── Forgot Password ─── */
authRouter.post("/forgot-password", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        await AuthService.getInstance().sendResetOTP(email);

        auditLog({
            event: "auth.forgot-password",
            requestId: req.requestId,
            ip: req.ip,
            success: true,
            details: { email },
        });

        // Always return success (don't reveal if email exists)
        return res.json({ sent: true });
    } catch (error: any) {
        return res.json({ sent: true }); // Still don't reveal
    }
});

/* ─── Reset Password ─── */
authRouter.post("/reset-password", authAttemptLimiter, async (req, res) => {
    try {
        const email = parseRequiredString(req.body?.email, "email");
        const otp = parseRequiredString(req.body?.otp, "otp");
        const newPassword = parseRequiredString(req.body?.newPassword, "newPassword");

        await AuthService.getInstance().resetPassword(email, otp, newPassword);

        auditLog({
            event: "auth.reset-password",
            requestId: req.requestId,
            ip: req.ip,
            success: true,
            details: { email },
        });

        return res.json({ success: true });
    } catch (error: any) {
        auditLog({
            event: "auth.reset-password",
            level: "warn",
            requestId: req.requestId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });
        return res.status(400).json({ error: error?.message || "Reset failed" });
    }
});

/* ─── Current User ─── */
authRouter.get("/me", authenticate, requireRoles(["user", "admin"]), (req, res) => {
    return res.json({
        user: {
            id: req.auth!.userId,
            email: req.auth!.email,
            sessionId: req.auth!.sessionId,
            roles: req.auth!.roles,
        },
    });
});

/* ─── WebSocket Ticket ─── */
authRouter.post("/ws-ticket", authenticate, requireRoles(["user", "admin"]), wsTicketLimiter, async (req, res) => {
    try {
        const payload = await AuthService.getInstance().createWsTicket(req.auth!.userId);

        auditLog({
            event: "auth.ws-ticket",
            requestId: req.requestId,
            userId: req.auth!.userId,
            ip: req.ip,
            success: true,
        });

        return res.json(payload);
    } catch (error: any) {
        auditLog({
            event: "auth.ws-ticket",
            level: "warn",
            requestId: req.requestId,
            userId: req.auth?.userId,
            ip: req.ip,
            success: false,
            details: { message: error?.message || "unknown" },
        });

        return res.status(400).json({ error: error?.message || "Failed to issue ticket" });
    }
});

/* ─── List Active Sessions ─── */
authRouter.get("/sessions", authenticate, requireRoles(["user", "admin"]), async (req, res) => {
    try {
        const sessions = await AuthService.getInstance().getActiveSessions(req.auth!.userId);

        // Redact sensitive fields before sending to client
        const sanitized = sessions.map((s) => ({
            sessionId: s.sessionId,
            ipAddress: s.ipAddress,
            userAgent: s.userAgent,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            isCurrent: s.sessionId === req.auth!.sessionId,
        }));

        return res.json({ sessions: sanitized });
    } catch (error: any) {
        return res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

/* ─── Revoke a Session ─── */
authRouter.delete("/sessions/:sessionId", authenticate, requireRoles(["user", "admin"]), async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (sessionId === req.auth!.sessionId) {
            return res.status(400).json({ error: "Cannot revoke your current session. Use logout instead." });
        }

        await AuthService.getInstance().revokeSession(sessionId, req.auth!.userId);

        auditLog({
            event: "auth.session-revoke",
            requestId: req.requestId,
            userId: req.auth!.userId,
            ip: req.ip,
            success: true,
            details: { revokedSessionId: sessionId },
        });

        return res.json({ success: true });
    } catch (error: any) {
        return res.status(404).json({ error: error?.message || "Session not found" });
    }
});