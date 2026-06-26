import axios from "axios";
import { Depth, KLine, Ticker, Trade } from "./types";
import { API_REQUEST_TIMEOUT, TRADES_LIMIT } from "../lib/constants";

const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE_URL = `${apiBase}/api/v1`;
const AUTH_BASE_URL = `${BASE_URL}/auth`;
const DEBUG = process.env.NODE_ENV !== "production";
const API_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || API_REQUEST_TIMEOUT);

// Configure axios
axios.defaults.timeout = API_TIMEOUT_MS;
axios.defaults.withCredentials = true;

if (DEBUG) {
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
}

/* ═══════════════════════════════════════════════════════════════
   Token Storage
   ═══════════════════════════════════════════════════════════════ */

function getStoredAccessToken() {
  if (typeof window === "undefined") {
    return "";
  }
  return localStorage.getItem("accessToken") || "";
}

function storeAccessToken(accessToken: string) {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem("accessToken", accessToken);
}

function clearAccessToken() {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem("accessToken");
}

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */

export type AuthUser = {
  id: string;
  email: string;
  roles: string[];
};

export type AuthPayload = {
  accessToken: string;
  user: AuthUser;
  expiresIn: string;
};

type BalancesResponse = {
  userId: string;
  balances: Record<string, { available: number; locked: number }>;
};

/* ═══════════════════════════════════════════════════════════════
   Auth API Functions
   ═══════════════════════════════════════════════════════════════ */

export async function loginUser(email: string, password: string): Promise<AuthPayload> {
  const response = await axios.post<AuthPayload>(`${AUTH_BASE_URL}/login`, {
    email,
    password,
  });

  storeAccessToken(response.data.accessToken);
  return response.data;
}

export async function registerUser(
  email: string,
  password: string
): Promise<AuthPayload & { requiresVerification?: boolean }> {
  const response = await axios.post<AuthPayload & { requiresVerification?: boolean }>(
    `${AUTH_BASE_URL}/register`,
    { email, password }
  );

  // Only store token if account is auto-logged in (no verification required)
  if (response.data.accessToken) {
    storeAccessToken(response.data.accessToken);
  }
  return response.data;
}

export async function logoutUser(): Promise<void> {
  try {
    await axios.post(`${AUTH_BASE_URL}/logout`);
  } catch {
    // Logout should be idempotent — clear local state regardless
  }
  clearAccessToken();
}

export async function refreshAccessToken(): Promise<string> {
  const response = await axios.post<AuthPayload>(`${AUTH_BASE_URL}/refresh`);

  storeAccessToken(response.data.accessToken);
  return response.data.accessToken;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = getStoredAccessToken();
  if (!token) {
    return null;
  }

  try {
    const response = await axios.get<{ user: AuthUser }>(`${AUTH_BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data.user;
  } catch {
    return null;
  }
}

/** Check if the user has a stored access token (client-side only). */
export function isAuthenticated(): boolean {
  return !!getStoredAccessToken();
}

/* ═══════════════════════════════════════════════════════════════
   Authenticated Request Helper
   ═══════════════════════════════════════════════════════════════ */

async function authRequest<T>(config: any): Promise<T> {
  let accessToken = getStoredAccessToken();

  if (!accessToken) {
    // Try to refresh from cookie
    try {
      accessToken = await refreshAccessToken();
    } catch {
      throw new Error("Not authenticated");
    }
  }

  try {
    const response = await axios.request<T>({
      ...config,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return response.data;
  } catch (error: any) {
    if (error?.response?.status !== 401) {
      throw error;
    }

    // Access token expired — try refresh
    let refreshedToken = "";
    try {
      refreshedToken = await refreshAccessToken();
    } catch {
      clearAccessToken();
      throw error;
    }

    const retryResponse = await axios.request<T>({
      ...config,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${refreshedToken}`,
      },
    });

    return retryResponse.data;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Authenticated Endpoints
   ═══════════════════════════════════════════════════════════════ */

export async function getWsTicket(): Promise<{ ticket: string; expiresIn: number }> {
  return authRequest<{ ticket: string; expiresIn: number }>({
    method: "POST",
    url: `${AUTH_BASE_URL}/ws-ticket`,
  });
}

export async function getBalances(): Promise<BalancesResponse> {
  return authRequest<BalancesResponse>({
    method: "GET",
    url: `${BASE_URL}/wallet/balances`,
  });
}

/* ═══════════════════════════════════════════════════════════════
   Public Market Data Endpoints
   ═══════════════════════════════════════════════════════════════ */

export async function getTicker(market: string): Promise<Ticker> {
    const tickers = await getTickers();
    const ticker = tickers.find(t => t.symbol === market);
    if (!ticker) {
        throw new Error(`Ticker ${market} not found`);
    }
    return ticker;
}

export async function getTickers(): Promise<Ticker[]> {
    const response = await axios.get(`${BASE_URL}/tickers`);
    return response.data;
}

export async function getDepth(market: string): Promise<Depth> {
    const response = await axios.get(`${BASE_URL}/depth`, {
        params: { symbol: market }
    });
    return response.data;
}

export async function getKlines(market: string, interval: string, startTime: number, endTime: number): Promise<KLine[]> {
    const response = await axios.get(`${BASE_URL}/klines`, {
        params: { symbol: market, interval, startTime, endTime }
    });
    return response.data;
}

export async function getTrades(market: string): Promise<Trade[]> {
    const response = await axios.get(`${BASE_URL}/trades`, {
        params: { symbol: market, limit: TRADES_LIMIT }
    });
    return response.data;
}

/* ═══════════════════════════════════════════════════════════════
   Authenticated Trading Endpoints
   ═══════════════════════════════════════════════════════════════ */

export async function createOrder(
    market: string,
    price: string,
    quantity: string,
  side: "buy" | "sell"
): Promise<{ orderId: string; executedQty: number; fills: any[] }> {
  return authRequest<{ orderId: string; executedQty: number; fills: any[] }>({
    method: "POST",
    url: `${BASE_URL}/order`,
    data: {
      market,
      price,
      quantity,
      side
    },
  });
}

export async function getOpenOrders(market: string): Promise<any[]> {
  return authRequest<any[]>({
    method: "GET",
    url: `${BASE_URL}/order/open`,
    params: {
      market
    }
  });
}

export async function cancelOrder(orderId: string, market: string): Promise<any> {
  return authRequest<any>({
    method: "DELETE",
    url: `${BASE_URL}/order`,
    data: { orderId, market },
  });
}

export async function onRamp(amount: number): Promise<{ success: boolean; message: string }> {
  return authRequest<{ success: boolean; message: string }>({
    method: "POST",
    url: `${BASE_URL}/onramp`,
    data: {
      amount,
    },
  });
}

/* ═══════════════════════════════════════════════════════════════
   Wallet & Razorpay Endpoints
   ═══════════════════════════════════════════════════════════════ */

export async function createRazorpayOrder(amount: number): Promise<{ success: boolean; orderId: string; amount: number }> {
  return authRequest<{ success: boolean; orderId: string; amount: number }>({
    method: "POST",
    url: `${BASE_URL}/wallet/razorpay/create-order`,
    data: { amount },
  });
}

export async function verifyRazorpayPayment(
  razorpay_order_id: string,
  razorpay_payment_id: string,
  razorpay_signature: string
): Promise<{ success: boolean; message: string }> {
  return authRequest<{ success: boolean; message: string }>({
    method: "POST",
    url: `${BASE_URL}/wallet/razorpay/verify`,
    data: {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    },
  });
}

/* ═══════════════════════════════════════════════════════════════
   OTP / Email Verification Endpoints
   ═══════════════════════════════════════════════════════════════ */

export async function verifyEmailOTP(email: string, otp: string): Promise<{ user: AuthUser; accessToken: string; expiresIn: string }> {
  const response = await axios.post(`${AUTH_BASE_URL}/verify-otp`, { email, otp }, { withCredentials: true });
  storeAccessToken(response.data.accessToken);
  return response.data;
}

export async function resendOTP(email: string): Promise<{ sent: boolean }> {
  const response = await axios.post(`${AUTH_BASE_URL}/resend-otp`, { email });
  return response.data;
}

export async function forgotPassword(email: string): Promise<{ sent: boolean }> {
  const response = await axios.post(`${AUTH_BASE_URL}/forgot-password`, { email });
  return response.data;
}

export async function resetPassword(email: string, otp: string, newPassword: string): Promise<{ success: boolean }> {
  const response = await axios.post(`${AUTH_BASE_URL}/reset-password`, { email, otp, newPassword });
  return response.data;
}