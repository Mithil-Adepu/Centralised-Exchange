# Module 11: Frontend Architecture, State, and Real-Time Trading UI

## 1. Architectural Philosophy and Component Hierarchy

The frontend of this exchange is built with **Next.js (App Router)** and **TypeScript**, styled using a bespoke dark-mode design system tailored to replicate the high-density, low-latency ergonomics of professional exchanges (such as Backpack Exchange and Binance).

Trading terminals present unique frontend engineering challenges compared to conventional web applications:
1. **High Message Throughput:** Market feeds (order book depth deltas, individual trade executions, ticker updates) push dozens to hundreds of events per second over WebSockets. Naive React state updates cause full component re-rendering cycles that freeze the DOM, drop animation frames, and create severe input lag.
2. **Multiple Independent Consumers of the Same Stream:** A user may view the candlestick chart, the depth ladder, and the recent trade feed simultaneously—all requiring trade or ticker data. If components independently open WebSocket connections or unmount and blindly issue unsubscribe commands, feeds break for other components.
3. **Silent Session Rotation and Network Resilience:** Users trading large sums must not be abruptly kicked out mid-order due to an expired access token. Transparent HTTP token refreshes with request replaying, combined with resilient WebSocket reconnects, are mandatory.

### Visual Component Hierarchy

```
                                  layout.tsx
                                      │
              ┌───────────────────────┴───────────────────────┐
              │                                               │
          Appbar.tsx                                      page.tsx
       (Auth, Balances,                                (Main Trading Terminal)
        Market Selector)                                      │
                                    ┌─────────────────────────┼─────────────────────────┐
                                    │                         │                         │
                               MarketBar.tsx            TradeView.tsx               SwapUI.tsx
                             (24h Stat Ticker)         (Chart / Depth)          (Order Placement Form)
                                    │                         │                         │
                                    │             ┌───────────┴───────────┐             │
                                    │             │                       │             │
                                    │      ChartManager.ts            Depth.tsx         │
                                    │     (Lightweight Charts)       (Order Book)       │
                                    │                                     │             │
                                    │                             ┌───────┴───────┐     │
                                    │                             │               │     │
                                    │                         AskTable.tsx   BidTable.tsx
                                    │                                     │
                                    └─────────────────┬───────────────────┘
                                                      │
                                              BottomPanel.tsx
                                        (Open Orders, Order History,
                                             Balances Table)
```

---

## 2. HTTP Transport and Auth Interceptors (`httpClient.ts`)

Located at [`frontend/app/utils/httpClient.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/utils/httpClient.ts).

### Axios Client Configuration

```typescript
const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE_URL = `${apiBase}/api/v1`;
const AUTH_BASE_URL = `${BASE_URL}/auth`;
const API_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || API_REQUEST_TIMEOUT);

axios.defaults.timeout = API_TIMEOUT_MS;
axios.defaults.withCredentials = true; // Crucial: automatically transmits the HttpOnly refreshToken cookie
```

### Transparent 401 Re-Authentication (`authRequest`)

When making an authenticated request (placing an order, fetching balances, cancelling an order), token expiration must be handled seamlessly without crashing the user's action:

```typescript
async function authRequest<T>(config: any): Promise<T> {
  let accessToken = getStoredAccessToken();

  if (!accessToken) {
    // No access token in memory/storage — attempt refresh via HttpOnly cookie
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

    // Access token expired mid-flight (401 Unauthorized) — invoke silent refresh
    let refreshedToken = "";
    try {
      refreshedToken = await refreshAccessToken();
    } catch {
      clearAccessToken();
      throw error;
    }

    // Replay the exact original request with the fresh Bearer token
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
```

#### Why This Design?
- **No Token Leaks via SSR:** `getStoredAccessToken()` explicitly checks `typeof window === "undefined"`. In Next.js SSR, it returns an empty string, preventing hydration mismatches and local storage access errors on Node.js runtimes.
- **Single-Retry Guarantee:** Notice the retry block does *not* recursively call `authRequest`. It directly executes `axios.request`. If the refreshed token also fails, it clears local state and surfaces the error, preventing infinite retry storms.

---

## 3. Real-Time WebSocket Multiplexing (`SignalingManager.ts`)

Located at [`frontend/app/utils/SignalingManager.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/utils/SignalingManager.ts).

### The Multi-Consumer Problem

In modern reactive web apps, components mount and unmount based on tab switches, viewport resizing, and routing. Consider this scenario:
1. `Depth.tsx` mounts and subscribes to `depth.SOL_USDC`.
2. `TradeView.tsx` (in "Depth" subtab mode) also mounts and subscribes to `depth.SOL_USDC`.
3. The user clicks away from the "Depth" subtab back to the "Chart" subtab in `TradeView`.
4. `TradeView` unmounts its depth listener and sends `UNSUBSCRIBE depth.SOL_USDC`.

**The Fatal Bug:** In a naive implementation using a plain `Set` of active subscriptions, the unmount in `TradeView` instructs the WebSocket gateway to stop publishing depth for the entire client connection. As a result, `Depth.tsx` goes completely dark!

### The Solution: Reference-Counted Subscriptions

`SignalingManager` tracks subscription consumer counts using a `Map<string, number>`:

```typescript
export class SignalingManager {
  private ws: WebSocket | null = null;
  private static instance: SignalingManager;
  private bufferedMessages: any[] = [];
  private callbacks: Record<string, [Function, string][]> = {};
  private id: number = 1;
  private initialized: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private shouldReconnect: boolean = true;
  private subscriptions: Map<string, number> = new Map();
```

#### Line-by-Line Subscription Accounting in `sendMessage`:

```typescript
public sendMessage(message: any) {
  const isSubscribe = message.method === "SUBSCRIBE" && message.params?.[0];
  const isUnsubscribe = message.method === "UNSUBSCRIBE" && message.params?.[0];

  if (isSubscribe) {
    const stream = message.params[0];
    const count = (this.subscriptions.get(stream) || 0) + 1;
    this.subscriptions.set(stream, count);
    if (count > 1) {
      return; // Already subscribed on the WS wire! Do not spam the gateway.
    }
  } else if (isUnsubscribe) {
    const stream = message.params[0];
    const count = (this.subscriptions.get(stream) || 0) - 1;
    if (count > 0) {
      this.subscriptions.set(stream, count);
      return; // Other mounted components still need this feed. Keep wire open!
    }
    this.subscriptions.delete(stream);
  }

  const messageWithId = { ...message, id: this.id++ };

  if (!this.initialized || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
    if (!isSubscribe && !isUnsubscribe) {
      this.bufferedMessages.push(messageWithId);
    }
    return;
  }

  this.ws.send(JSON.stringify(messageWithId));
}
```

### Ticket-Based WebSocket Handshake on Connect

When the WebSocket opens, if the user is authenticated in `localStorage`, the manager automatically fetches a single-use ticket via HTTP POST `/auth/ws-ticket` and presents it immediately:

```typescript
this.ws.onopen = () => {
  log('✅ WebSocket connected');
  this.reconnectAttempts = 0;

  if (!isAuthenticated()) {
    this.initialized = true;
    this.flushPendingMessages();
    return;
  }

  this.authenticateSocket().catch((error) => {
    console.error('❌ WebSocket ticket auth failed:', error);
    this.ws?.close();
  });
};

private async authenticateSocket() {
  const { ticket } = await getWsTicket();
  this.ws.send(JSON.stringify({
    method: "AUTH",
    params: { ticket }
  }));
}
```

Once the gateway verifies the ticket in Redis and replies with `{"type": "AUTH_SUCCESS"}`, the client sets `this.initialized = true` and invokes `flushPendingMessages()`, which replays all buffered subscriptions and messages.

### Exponential Backoff Reconnection

```typescript
private handleReconnect() {
  if (!this.shouldReconnect) return;
  if (this.reconnectTimeout) return;

  this.reconnectAttempts++;
  // Exponential backoff capped at 30 seconds: 1s, 2s, 4s, 8s, 16s, 32s (capped to 30s)
  const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 30_000);
  
  this.reconnectTimeout = setTimeout(() => {
    this.reconnectTimeout = null;
    this.connect();
  }, delay);
}
```

---

## 4. Canvas Candlestick Rendering (`ChartManager.ts`)

Located at [`frontend/app/utils/ChartManager.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/utils/ChartManager.ts).

Rather than rendering hundreds of SVG or HTML DOM elements for candles (which cripples 60 FPS performance), the application wraps TradingView's high-performance HTML5 Canvas library, **Lightweight Charts**.

### Chart Initialization and Resize Observer

```typescript
export class ChartManager {
  private candleSeries: ISeriesApi<"Candlestick"> | null = null;
  private lineSeries: ISeriesApi<"Line"> | null = null;
  private chart: IChartApi;

  constructor(
    ref: HTMLElement,
    initialData: any[],
    layout: { background: string; color: string },
    chartType: ChartType = "candlestick"
  ) {
    const chart = createChart(ref, {
      width: ref.clientWidth || 800,
      height: ref.clientHeight || 420,
      layout: {
        background: { type: ColorType.Solid, color: layout.background },
        textColor: layout.color,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#23242C" },
      timeScale: { borderColor: "#23242C", timeVisible: true, secondsVisible: false },
    });

    this.chart = chart;

    // Responsive Canvas Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || entries[0]?.target !== ref) return;
      const newRect = entries[0]!.contentRect;
      this.chart.applyOptions({
        width: newRect.width,
        height: newRect.height,
      });
    });
    resizeObserver.observe(ref);
```

### Strict Timestamp Validation and Sorting

Lightweight Charts throws an unrecoverable exception if timestamps are not strictly monotonically increasing or contain duplicates:

```typescript
const formattedOHLC = initialData
  .map((data) => {
    let timestamp: number;
    if (data.timestamp instanceof Date) {
      timestamp = Math.floor(data.timestamp.getTime() / 1000);
    } else if (typeof data.timestamp === "number") {
      timestamp = data.timestamp > 1e10 ? Math.floor(data.timestamp / 1000) : data.timestamp;
    } else {
      return null;
    }

    if (isNaN(timestamp) || timestamp <= 0) return null;

    return {
      time: timestamp as UTCTimestamp,
      open: parseFloat(data.open?.toString() || "0"),
      high: parseFloat(data.high?.toString() || "0"),
      low: parseFloat(data.low?.toString() || "0"),
      close: parseFloat(data.close?.toString() || "0"),
    };
  })
  .filter((item): item is NonNullable<typeof item> => item !== null)
  .sort((a, b) => a.time - b.time) // Ensure chronological ascending order
  .filter((item, index, array) => {
    // Remove duplicate time keys
    if (index === 0) return true;
    return item.time !== array[index - 1]!.time;
  });
```

### Real-Time Live Candle Merging in `TradeView.tsx`

When a new trade arrives over the WebSocket:
1. The trade's timestamp is bucketed to the active interval (e.g. 1 hour = 3600s boundary: `bucketTime = Math.floor(unix / 3600) * 3600`).
2. If the trade's bucket matches `currentCandleRef.current.time`, the existing candle's `close` is updated, and `high`/`low` are expanded.
3. If the trade falls into a new bucket, a new candle is instantiated with `open = high = low = close = tradePrice`.
4. `chartManager.update(candle)` is called, rendering the new state directly to the Canvas in sub-millisecond time.

```typescript
sm.registerCallback(`trade.${market}`, (tradeData: Trade) => {
  const price = parseFloat(tradeData.price);
  const unix = toUnixSeconds(tradeData.timestamp);
  const bucketTime = bucketTimestamp(unix, selectedInterval);
  
  let candle = currentCandleRef.current;
  
  if (!candle || candle.time !== bucketTime) {
    // New candlestick period started
    candle = {
      time: bucketTime,
      open: price,
      high: price,
      low: price,
      close: price,
    };
  } else {
    // Update active candlestick
    candle.close = price;
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
  }
  
  currentCandleRef.current = candle;
  chartManagerRef.current?.update(candle);
}, tradeCallbackId);
```

---

## 5. Order Book Depth Management (`Depth.tsx`)

Located at [`frontend/app/components/depth/Depth.tsx`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/components/depth/Depth.tsx).

### Full Snapshot vs. Delta Merging

The matching engine emits depth updates over Redis Pub/Sub in two flavors:
1. **Snapshots (`data.snapshot === true`):** Sent after cancellations, restarts, or initial syncs. The client completely overwrites the local bids and asks.
2. **Deltas (`data.snapshot === false`):** Sent after trades and limit order placements. Contains arrays `b: [[price, quantity]]` and `a: [[price, quantity]]`.

```typescript
// Inside Depth.tsx callback handler
if (data.snapshot) {
  setBids([...(data.b || [])].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 12));
  setAsks([...(data.a || [])].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, 12));
  return;
}

// Delta Merge Logic
setBids((prev) => {
  const updated = [...(prev || [])];
  data.b?.forEach(([p, q]: [string, string]) => {
    const idx = updated.findIndex((b) => b[0] === p);
    if (parseFloat(q) === 0) {
      if (idx !== -1) updated.splice(idx, 1); // Order level fully depleted: remove row
    } else {
      if (idx !== -1) updated[idx] = [p, q];  // Quantity changed: update row
      else updated.push([p, q]);               // New price point: insert row
    }
  });
  return updated.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 12);
});
```

### Visual Depth Bar Rendering

In `AskTable.tsx` and `BidTable.tsx`, cumulative volumes are calculated row-by-row. A background CSS percentage fill creates the dynamic order book depth visual:

$$\text{depthPercent} = \min\left(100, \frac{\text{cumulativeVolume}}{\text{totalBookVolume}} \times 100\right)$$

```tsx
<div
  className="absolute inset-y-0 right-0 bg-bp-red/10 transition-all duration-75 pointer-events-none"
  style={{ width: `${depthPercent}%` }}
/>
```

---

## 6. Order Placement Panel (`SwapUI.tsx`)

Located at [`frontend/app/components/SwapUI.tsx`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/components/SwapUI.tsx).

### Percentage Slider to Balance Calculation

Users expect rapid trading interactions (25%, 50%, 75%, 100% of their balance). The slider calculation accounts for the order side and asset pricing:

```typescript
const handleSliderChange = (percent: number) => {
  setSliderPercent(percent);
  const priceValue = Number(price);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return;

  const ratio = percent / 100;
  if (ratio <= 0) {
    setQuantity("");
    return;
  }

  if (side === "buy") {
    // When buying base asset (e.g., SOL) with quote asset (USDC):
    // Max Spend = quoteBalance * ratio
    // Max Base Quantity = Max Spend / limitPrice
    const maxQuote = quoteBalance * ratio;
    const rawQty = maxQuote / priceValue;
    setQuantity(rawQty > 0 ? rawQty.toFixed(QUANTITY_PRECISION) : "");
  } else {
    // When selling base asset (SOL):
    // Max Quantity = baseBalance * ratio
    const rawQty = baseBalance * ratio;
    setQuantity(rawQty > 0 ? rawQty.toFixed(QUANTITY_PRECISION) : "");
  }
};
```

### Market Order Price Protection

The matching engine enforces a strict Limit-Order-Book protocol. To place a "Market Order" without native market-order drift causing catastrophic slippage:
1. `SwapUI` fetches the current top of the book (`topAsk` for buy, `topBid` for sell).
2. It applies a 5% protection collar:
   - Market Buy: `submitPrice = (parseFloat(topAsk) * 1.05).toFixed(2)`
   - Market Sell: `submitPrice = (parseFloat(topBid) * 0.95).toFixed(2)`
3. The engine executes the order immediately against resting orders up to the collar limit, returning any unspent funds via the **Price Improvement Refund** mechanism documented in Module 03.

---

## 7. Global State Management (`Zustand`)

The application avoids excessive Redux boilerplate by leveraging lightweight, modular **Zustand stores**:

1. [`useAuthStore.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/store/useAuthStore.ts): Manages `user`, `isAuthenticated`, `isLoading`, `isModalOpen`, `pendingVerificationEmail`, and exposes async actions (`login`, `register`, `verifyOTP`, `logout`, `tryRefresh`).
2. [`useMarketStore.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/store/useMarketStore.ts): Tracks `selectedMarket` (e.g. `"SOL_USDC"`) and user favorites (`favorites: string[]`) persisted across sessions.
3. [`useThemeStore.ts`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/frontend/app/store/useThemeStore.ts): Controls color tokens and terminal density settings.

### Summary Checklist for Frontend Performance

| Technique | Implementation | Benefit |
| :--- | :--- | :--- |
| **Canvas Charting** | TradingView Lightweight Charts in `ChartManager.ts` | 60 FPS rendering without DOM node bloating |
| **WS Reference Counting** | `Map<string, number>` in `SignalingManager.ts` | Prevents component unmounts from terminating shared feeds |
| **Silent Auth Recovery** | Axios 401 interceptor + replay queue in `httpClient.ts` | Zero trade disruptions during session token rotation |
| **Collar Slippage Shield** | Top-of-book $\pm 5\%$ price collar in `SwapUI.tsx` | Guarantees instant market execution while preventing flash crashes |
| **Atomic Ticket Auth** | Redis `GETDEL` ticket handshake on WS connect | Secure WebSocket authentication without exposing raw JWTs in WS URLs |
