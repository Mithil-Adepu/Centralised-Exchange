import axios from "axios";
import { Depth, KLine, Ticker, Trade } from "./types";
import { TRADES_LIMIT } from "../lib/constants";

// Using proxy server for Backpack Exchange API
const BASE_URL = "http://localhost:3000/api/v1";

// Configure axios
axios.defaults.timeout = 60000; // 60 second timeout (increased for slow responses)

// Add request interceptor for debugging
axios.interceptors.request.use(
  (config) => {
    console.log('🚀 API Request:', config.method?.toUpperCase(), config.url);
    return config;
  },
  (error) => {
    console.error('❌ Request Error:', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for debugging
axios.interceptors.response.use(
  (response) => {
    console.log('✅ API Response:', response.status, response.config.url);
    return response;
  },
  (error) => {
    console.error('❌ API Error:', error.response?.status, error.config?.url, error.message);
    return Promise.reject(error);
  }
);

/**
 * Get ticker for a specific market
 */
export async function getTicker(market: string): Promise<Ticker> {
    const tickers = await getTickers();
    const ticker = tickers.find(t => t.symbol === market);
    if (!ticker) {
        throw new Error(`Ticker ${market} not found`);
    }
    return ticker;
}

/**
 * Get tickers for all markets
 * Endpoint: /api/v1/tickers
 */
export async function getTickers(): Promise<Ticker[]> {
    const response = await axios.get(`${BASE_URL}/tickers`);
    return response.data;
}

/**
 * Get order book depth for a market
 * Endpoint: /api/v1/depth?symbol=SOL_USDC
 */
export async function getDepth(market: string): Promise<Depth> {
    const response = await axios.get(`${BASE_URL}/depth`, {
        params: { symbol: market }
    });
    return response.data;
}

/**
 * Get klines/candlestick data for a market
 * Endpoint: /api/v1/klines?symbol=SOL_USDC&interval=1h&startTime=...&endTime=...
 */
export async function getKlines(market: string, interval: string, startTime: number, endTime: number): Promise<KLine[]> {
    const response = await axios.get(`${BASE_URL}/klines`, {
        params: { symbol: market, interval, startTime, endTime }
    });
    return response.data;
}

/**
 * Get recent trades for a market
 * Endpoint: /api/v1/trades?symbol=SOL_USDC&limit=50
 */
export async function getTrades(market: string): Promise<Trade[]> {
    const response = await axios.get(`${BASE_URL}/trades`, {
        params: { symbol: market, limit: TRADES_LIMIT }
    });
    return response.data;
}

/**
 * Create a new order
 * Endpoint: POST /api/v1/order
 */
export async function createOrder(
    market: string,
    price: string,
    quantity: string,
    side: "buy" | "sell",
    userId: string
): Promise<{ orderId: string; executedQty: number; fills: any[] }> {
    const response = await axios.post(`${BASE_URL}/order`, {
        market,
        price,
        quantity,
        side,
        userId
    });
    return response.data;
}