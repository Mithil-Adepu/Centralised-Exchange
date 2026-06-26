"use client";

import { useEffect, useRef, useState } from "react";
import { ChartManager } from "../utils/ChartManager";
import { getKlines, getTicker } from "../utils/httpClient";
import { KLine, Trade } from "../utils/types";
import { CHART_INTERVALS } from "../lib/constants";
import { cn } from "../lib/utils";
import { SignalingManager } from "../utils/SignalingManager";

/* ═══════════════════════════════════════════════════════════════
   TradeView — Candlestick Chart Area (Backpack Exchange Style)

   Layout:
     1. Top tabs: Chart | Depth | Market Info
     2. Interval selector: 1m, 5m, 15m, 1H, 4H, 1D, 1W
     3. Chart container (lightweight-charts)
   ═══════════════════════════════════════════════════════════════ */

type ViewTab = "chart" | "depth" | "info";

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

function toUnixSeconds(raw: string | number): number {
  if (typeof raw === "number") {
    return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  }

  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    return Math.floor(parsedDate / 1000);
  }

  return Math.floor(Date.now() / 1000);
}

function bucketTimestamp(unixSeconds: number, interval: string): number {
  const step = INTERVAL_SECONDS[interval] || 3600;
  return Math.floor(unixSeconds / step) * step;
}

function buildSeedCandles(price: number, endTime: number, interval: string) {
  const step = INTERVAL_SECONDS[interval] || 3600;
  const candles = [];

  for (let index = 6; index >= 0; index -= 1) {
    const base = price * (1 + (index - 3) * 0.0025);
    const open = base * (1 + (index % 2 === 0 ? -0.0015 : 0.0015));
    const close = base * (1 + (index % 2 === 0 ? 0.0015 : -0.0015));
    const high = Math.max(open, close) * 1.0035;
    const low = Math.min(open, close) * 0.9965;

    candles.push({
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      start: String(endTime - step * (index + 1)),
      end: String(endTime - step * (index + 1)),
      volume: "0",
      quoteVolume: "0",
      trades: "0",
    });
  }

  return candles;
}

export function TradeView({ market }: { market: string }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartManagerRef = useRef<ChartManager | null>(null);
  const currentCandleRef = useRef<any>(null);
  const [selectedInterval, setSelectedInterval] = useState("1h");
  const [activeView, setActiveView] = useState<ViewTab>("chart");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeView !== "chart") return;

    const init = async () => {
      setLoading(true);
      setError(null);

      /* ─── Destroy existing chart ─── */
      if (chartManagerRef.current) {
        try { chartManagerRef.current.destroy(); } catch {}
        chartManagerRef.current = null;
      }

      /* ─── Fetch kline data ─── */
      let klineData: KLine[] = [];
      try {
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgo = now - 7 * 24 * 60 * 60;
        klineData = await getKlines(market, selectedInterval, sevenDaysAgo, now);

        if (!klineData || klineData.length === 0) {
          const ticker = await getTicker(market);
          const fallbackPrice = parseFloat(ticker.lastPrice || ticker.high || ticker.low || "0");

          if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
            setError("No chart data available yet.");
            setLoading(false);
            return;
          }

          const bucket = bucketTimestamp(now, selectedInterval);
          klineData = buildSeedCandles(fallbackPrice, bucket, selectedInterval);
        } else if (klineData.length === 1) {
          const fallbackPrice = parseFloat(klineData[0]!.close);
          const endTime = bucketTimestamp(now, selectedInterval);
          klineData = buildSeedCandles(fallbackPrice, endTime, selectedInterval);
        }
      } catch (e) {
        console.error("Failed to fetch klines:", e);
        setError("Failed to load chart data. Make sure the API is running.");
        setLoading(false);
        return;
      }

      /* ─── Initialize chart ─── */
      if (chartRef.current) {
        try {
          const chartData = klineData.map((kline) => ({
            timestamp: toUnixSeconds(kline.end),
            open: parseFloat(kline.open),
            high: parseFloat(kline.high),
            low: parseFloat(kline.low),
            close: parseFloat(kline.close),
          }));

          const chartManager = new ChartManager(chartRef.current, chartData, {
            background: "#0B0E11",
            color: "#848E9C",
          });

          chartManagerRef.current = chartManager;
          if (chartData.length > 0) {
            currentCandleRef.current = { ...chartData[chartData.length - 1] };
          }
          setLoading(false);

          /* ─── Subscribe to real-time trade updates ─── */
          const sm = SignalingManager.getInstance();
          const tradeStream = `trade.${market}`;
          sm.registerCallback(
            tradeStream,
            (tradeData: Trade) => {
              if (chartManagerRef.current && tradeData.price) {
                const price = parseFloat(tradeData.price);
                const unix = toUnixSeconds(tradeData.timestamp);
                const bucketTime = bucketTimestamp(unix, selectedInterval) * 1000;
                
                let candle = currentCandleRef.current;
                
                if (!candle || candle.time !== bucketTime) {
                  // New candle
                  candle = {
                    time: bucketTime,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                  };
                } else {
                  // Update existing candle
                  candle.close = price;
                  candle.high = Math.max(candle.high, price);
                  candle.low = Math.min(candle.low, price);
                }
                
                currentCandleRef.current = candle;
                chartManagerRef.current.update(candle);
              }
            },
            `CHART-${market}`
          );

          sm.sendMessage({
            method: "SUBSCRIBE",
            params: [`trade.${market}`],
          });
        } catch (e) {
          console.error("Failed to initialize chart:", e);
          setError("Failed to initialize chart");
          setLoading(false);
        }
      }
    };

    init();

    return () => {
      if (chartManagerRef.current) {
        try { chartManagerRef.current.destroy(); } catch {}
        chartManagerRef.current = null;
      }

      const sm = SignalingManager.getInstance();
      sm.deRegisterCallback(`trade.${market}`, `CHART-${market}`);
      sm.sendMessage({
        method: "UNSUBSCRIBE",
        params: [`trade.${market}`],
      });
    };
  }, [market, selectedInterval, activeView]);

  return (
    <div className="flex flex-col h-full">
      {/* ═══ Header Bar ═══ */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-bp-border bg-bp-bg-secondary">
        <div className="flex items-center gap-3">
          {/* ─── View Tabs ─── */}
          <div className="flex items-center gap-1">
            <ViewTabButton
              active={activeView === "chart"}
              onClick={() => setActiveView("chart")}
            >
              Chart
            </ViewTabButton>
            <ViewTabButton
              active={activeView === "depth"}
              onClick={() => setActiveView("depth")}
            >
              Depth
            </ViewTabButton>
            <ViewTabButton
              active={activeView === "info"}
              onClick={() => setActiveView("info")}
            >
              Info
            </ViewTabButton>
          </div>

          {/* ─── Divider ─── */}
          <div className="w-px h-4 bg-bp-border" />

          {/* ─── Interval Selector ─── */}
          {activeView === "chart" && (
            <div className="flex items-center gap-0.5">
              {CHART_INTERVALS.map((interval) => (
                <button
                  key={interval.value}
                  onClick={() => setSelectedInterval(interval.value)}
                  className={cn(
                    "px-2 py-1 text-2xs font-medium rounded transition-all",
                    selectedInterval === interval.value
                      ? "text-bp-text-primary bg-bp-bg-tertiary"
                      : "text-bp-text-tertiary hover:text-bp-text-secondary"
                  )}
                >
                  {interval.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ─── Chart Tools (right side) ─── */}
        {activeView === "chart" && (
          <div className="flex items-center gap-1">
            <ChartToolButton icon="candle" />
            <ChartToolButton icon="indicators" />
            <ChartToolButton icon="settings" />
          </div>
        )}
      </div>

      {/* ═══ Chart Content ═══ */}
      <div className="relative flex-1 bg-bp-bg-primary" style={{ minHeight: "420px" }}>
        {activeView === "chart" && (
          <>
            {/* Loading */}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="flex items-center gap-2 text-bp-text-tertiary text-xs">
                  <LoadingSpinner />
                  Loading chart...
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="text-center">
                  <div className="text-bp-text-tertiary text-xs mb-2">{error}</div>
                  <button
                    onClick={() => window.location.reload()}
                    className="px-3 py-1 bg-bp-bg-tertiary text-bp-text-secondary rounded text-2xs hover:text-bp-text-primary transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {/* Chart Container — needs explicit height so clientHeight > 0 */}
            <div
              ref={chartRef}
              className="w-full h-full"
              style={{ minHeight: "420px", height: "100%" }}
            />
          </>
        )}

        {/* Depth View Placeholder */}
        {activeView === "depth" && (
          <div className="flex items-center justify-center h-full">
            <p className="text-bp-text-tertiary text-xs">
              Depth chart coming soon
            </p>
          </div>
        )}

        {/* Info View Placeholder */}
        {activeView === "info" && (
          <div className="flex items-center justify-center h-full">
            <p className="text-bp-text-tertiary text-xs">
              Market information coming soon
            </p>
          </div>
        )}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   Sub-Components
   ═══════════════════════════════════════════════════════════════ */

/** View Tab Button */
function ViewTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 text-2xs font-medium rounded transition-all",
        active
          ? "text-bp-text-primary bg-bp-bg-tertiary"
          : "text-bp-text-tertiary hover:text-bp-text-secondary"
      )}
    >
      {children}
    </button>
  );
}

/** Chart Tool Button */
function ChartToolButton({ icon }: { icon: string }) {
  return (
    <button className="p-1.5 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors rounded hover:bg-bp-bg-tertiary">
      {icon === "candle" && (
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
          <rect x="5" y="4" width="2" height="16" rx="1" />
          <rect x="11" y="8" width="2" height="8" rx="1" />
          <rect x="17" y="6" width="2" height="12" rx="1" />
        </svg>
      )}
      {icon === "indicators" && (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth={1.5} d="M3 17l6-6 4 4 8-8" />
        </svg>
      )}
      {icon === "settings" && (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
      )}
    </button>
  );
}

/** Loading Spinner */
function LoadingSpinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}