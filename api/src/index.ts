import express from "express";
import cors from "cors";
import { orderRouter } from "./routes/order";
import { depthRouter } from "./routes/depth";
import { tradesRouter } from "./routes/trades";
import { klineRouter } from "./routes/kline";
import { tickersRouter } from "./routes/ticker";
import { onRampRouter } from "./routes/onramp";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/v1/order", orderRouter);
app.use("/api/v1/depth", depthRouter);
app.use("/api/v1/trades", tradesRouter);
app.use("/api/v1/klines", klineRouter);
app.use("/api/v1/tickers", tickersRouter);
app.use("/api/v1/onramp", onRampRouter);

// Global error handler to prevent crashes
app.use((err: any, req: any, res: any, next: any) => {
    console.error('API Error:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', message: err.message });
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit - keep server running
});

app.listen(3000, () => {
    console.log("Server is running on port 3000");
    console.log("API endpoints:");
    console.log("  POST   /api/v1/order");
    console.log("  DELETE /api/v1/order");
    console.log("  GET    /api/v1/order/open");
    console.log("  GET    /api/v1/depth");
    console.log("  GET    /api/v1/trades");
    console.log("  GET    /api/v1/klines");
    console.log("  GET    /api/v1/tickers");
    console.log("  POST   /api/v1/onramp");
    console.log("\n✅ Ready to accept requests!");
});