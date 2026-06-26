import express from "express";
import cors from "cors";
import crypto from "crypto";
import { orderRouter } from "./routes/order";
import { depthRouter } from "./routes/depth";
import { tradesRouter } from "./routes/trades";
import { klineRouter } from "./routes/kline";
import { tickersRouter } from "./routes/ticker";
import { onRampRouter } from "./routes/onramp";
import { authRouter } from "./routes/auth";
import { openApiRouter } from "./routes/openapi";
import { walletRouter } from "./routes/wallet";
import { razorpayRouter } from "./routes/razorpay";
import { startSessionCleanup } from "./auth/sessionCleanup";

/* ═══════════════════════════════════════════════════════════════
   API Server — Entry Point
   
   Improvements:
   - Health check endpoint (/health)
   - Security headers middleware
   - Environment-based port
   - Request size limits
   ═══════════════════════════════════════════════════════════════ */

const app = express();
const PORT = Number(process.env.API_PORT) || 3000;
app.set("trust proxy", true);

/* ─── Middleware ─── */
const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(origin => origin.trim())
    : true;

app.use(cors({
    origin: corsOrigin,
    credentials: true,
}));
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startedAt = Date.now();
    res.on("finish", () => {
        if (req.path === "/health") {
            return;
        }

        const durationMs = Date.now() - startedAt;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms id=${requestId}`);
    });

    next();
});

// Security headers
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("X-XSS-Protection", "0"); // Modern browsers use CSP instead
    if (process.env.NODE_ENV === "production") {
        res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    }
    next();
});

/* ─── Health Check ─── */
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: Date.now(),
    });
});

/* ─── Routes ─── */
app.use("/api/v1/order", orderRouter);
app.use("/api/v1/depth", depthRouter);
app.use("/api/v1/trades", tradesRouter);
app.use("/api/v1/klines", klineRouter);
app.use("/api/v1/tickers", tickersRouter);
app.use("/api/v1/onramp", onRampRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/wallet", walletRouter);
app.use("/api/v1/wallet/razorpay", razorpayRouter);
app.use("/api/v1/openapi.json", openApiRouter);

/* ─── Global Error Handler ─── */
app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("API Error:", err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
    }
});

/* ─── Unhandled Rejection ─── */
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

/* ─── Start Server ─── */
app.listen(PORT, () => {
    console.log(`\n  API Server running on port ${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/health`);
    console.log(`  Ready to accept requests\n`);
    startSessionCleanup();
});