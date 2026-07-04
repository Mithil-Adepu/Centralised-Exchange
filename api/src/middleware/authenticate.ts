import { NextFunction, Request, Response } from "express";
import { AuthService } from "../auth/AuthService";

// Well-known placeholder values that must NEVER be accepted as a real secret,
// even though they satisfy the length check. Shipping these = open auth bypass.
const WEAK_INTERNAL_TOKENS = new Set<string>([
    "change-this-internal-service-token",
]);

/** A configured internal token is only usable if it's long and not a known placeholder. */
export function isInternalTokenConfigured(token: string | undefined): token is string {
    return !!token && token.length >= 32 && !WEAK_INTERNAL_TOKENS.has(token);
}

function extractBearerToken(header?: string) {
    if (!header) {
        return null;
    }

    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
        return null;
    }

    return token;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN;
    const providedInternalToken = req.header("x-internal-service-token");

    // Only allow internal token auth if the configured token is strong (not a
    // placeholder) and matches. Impersonation identity comes ONLY from the
    // X-Internal-User-Id header — never from query/body, which are attacker-controlled.
    if (
        isInternalTokenConfigured(internalServiceToken) &&
        providedInternalToken &&
        providedInternalToken === internalServiceToken
    ) {
        const internalUserId = req.header("x-internal-user-id") || "internal-service";
        req.auth = {
            userId: String(internalUserId),
            email: "internal-service@local",
            sessionId: "internal-service",
            roles: ["admin", "user"],
        };
        return next();
    }

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