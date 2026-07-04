import { NextFunction, Request, Response } from "express";
import { AuthRedis } from "../auth/AuthRedis";

type RateLimiterOptions = {
    keyPrefix: string;
    max: number;
    windowSeconds: number;
    keyGenerator?: (req: Request) => string;
};

type FallbackCounter = {
    count: number;
    resetAt: number;
};

const fallbackCounters = new Map<string, FallbackCounter>();

function getClientIp(req: Request) {
    // Use req.ip, which Express derives from the socket + the configured
    // `trust proxy` hop count. Reading X-Forwarded-For directly is unsafe:
    // clients can spoof it to rotate identities and bypass IP rate limits.
    return req.ip || req.socket.remoteAddress || "unknown";
}

function runFallbackCounter(key: string, windowSeconds: number) {
    const now = Date.now();
    const current = fallbackCounters.get(key);
    const windowMs = windowSeconds * 1000;

    if (!current || current.resetAt <= now) {
        const resetAt = now + windowMs;
        fallbackCounters.set(key, { count: 1, resetAt });
        return {
            totalHits: 1,
            secondsToReset: Math.ceil((resetAt - now) / 1000),
        };
    }

    current.count += 1;
    return {
        totalHits: current.count,
        secondsToReset: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
}

export function createRateLimiter(options: RateLimiterOptions) {
    return async function rateLimiter(req: Request, res: Response, next: NextFunction) {
        const identifier = options.keyGenerator?.(req) || getClientIp(req);
        const key = `${options.keyPrefix}:${identifier}`;

        let totalHits = 0;
        let secondsToReset = options.windowSeconds;

        try {
            const client = await AuthRedis.getInstance().getClient();
            totalHits = await client.incr(key);
            if (totalHits === 1) {
                await client.expire(key, options.windowSeconds);
            }

            const ttl = await client.ttl(key);
            if (ttl > 0) {
                secondsToReset = ttl;
            }
        } catch (error) {
            const fallback = runFallbackCounter(key, options.windowSeconds);
            totalHits = fallback.totalHits;
            secondsToReset = fallback.secondsToReset;
        }

        const remaining = Math.max(0, options.max - totalHits);
        res.setHeader("RateLimit-Limit", String(options.max));
        res.setHeader("RateLimit-Remaining", String(remaining));
        res.setHeader("RateLimit-Reset", String(secondsToReset));

        if (totalHits > options.max) {
            res.setHeader("Retry-After", String(secondsToReset));
            return res.status(429).json({
                error: "Too many requests",
                retryAfterSeconds: secondsToReset,
            });
        }

        return next();
    };
}