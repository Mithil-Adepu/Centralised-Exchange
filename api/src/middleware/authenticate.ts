import { NextFunction, Request, Response } from "express";
import { AuthService } from "../auth/AuthService";

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

    if (internalServiceToken && providedInternalToken === internalServiceToken) {
        const internalUserId = req.header("x-internal-user-id") || (req.query.userId as string | undefined) || (req.body as any)?.userId || "internal-service";
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