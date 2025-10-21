"use client";
import { useEffect, useRef, useState } from "react";
import { ChartManager } from "../utils/ChartManager";
import { getKlines } from "../utils/httpClient";
import { KLine } from "../utils/types";
import { CHART_INTERVALS } from "../lib/constants";
import { cn } from "../lib/utils";
import { SignalingManager } from "../utils/SignalingManager";

export function TradeView({ market }: { market: string }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartManagerRef = useRef<ChartManager | null>(null);
  const [selectedInterval, setSelectedInterval] = useState("1h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      setError(null);
      
      // Destroy existing chart first
      if (chartManagerRef.current) {
        try {
          chartManagerRef.current.destroy();
        } catch (e) {
          console.log('Chart already destroyed');
        }
        chartManagerRef.current = null;
      }
      
      let klineData: KLine[] = [];
      try {
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgo = now - (7 * 24 * 60 * 60);
        
        klineData = await getKlines(market, selectedInterval, sevenDaysAgo, now);
        
        if (!klineData || klineData.length === 0) {
          console.warn('No chart data yet - waiting for trades to populate database');
          setError('No trades yet. Chart will appear after trades are executed.');
          setLoading(false);
          return;
        }
      } catch (e: any) {
        console.error("Failed to fetch klines:", e);
        setError('Failed to load chart data. Make sure the API is running.');
        setLoading(false);
        return;
      }

      if (chartRef.current) {
        try {
          const chartData = klineData.map((kline) => {
            const endTime = parseInt(kline.end);
            
            return {
              timestamp: endTime,
              open: parseFloat(kline.open),
              high: parseFloat(kline.high),
              low: parseFloat(kline.low),
              close: parseFloat(kline.close),
            };
          });

          const chartManager = new ChartManager(
            chartRef.current,
            chartData,
            {
              background: "#16171D",
              color: "#8B8E98",
            }
          );

          chartManagerRef.current = chartManager;
          setLoading(false);
          
          // Subscribe to real-time chart updates
          const signalingManager = SignalingManager.getInstance();
          if (signalingManager) {
            // Subscribe to trade updates for chart
            signalingManager.registerCallback("trade", (tradeData: any) => {
              console.log('📊 Chart update received:', tradeData);
              // Update chart with new trade data
              if (chartManagerRef.current && tradeData.p) {
                const price = parseFloat(tradeData.p);
                const updateData = {
                  close: price,
                  high: price,
                  low: price,
                  open: price,
                  newCandleInitiated: true,
                  time: tradeData.t * 1000
                };
                chartManagerRef.current.update(updateData);
              }
            }, `CHART-${market}`);

            // Subscribe to trade updates
            signalingManager.sendMessage({
              method: "SUBSCRIBE",
              params: [`trade.${market}`]
            });
          }
        } catch (e: any) {
          console.error("Failed to initialize chart:", e);
          setError('Failed to initialize chart');
          setLoading(false);
        }
      }
    };
    
    init();

    return () => {
      if (chartManagerRef.current) {
        try {
          chartManagerRef.current.destroy();
        } catch (e) {
          console.log('Chart already destroyed');
        }
        chartManagerRef.current = null;
      }
      
      // Clean up WebSocket subscriptions
      const signalingManager = SignalingManager.getInstance();
      if (signalingManager) {
        signalingManager.deRegisterCallback("trade", `CHART-${market}`);
        signalingManager.sendMessage({
          method: "UNSUBSCRIBE",
          params: [`trade.${market}`]
        });
      }
    };
  }, [market, selectedInterval]);

  return (
    <div className="flex flex-col h-full">
      {/* Chart Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-backpack-border">
        <div className="flex items-center gap-2">
          {/* Time/Original Toggle */}
          <div className="flex gap-1 bg-backpack-bg-tertiary p-1 rounded-md">
            <button className="px-3 py-1 text-xs font-medium bg-backpack-bg-secondary text-bp-text-primary rounded">
              Time
            </button>
            <button className="px-3 py-1 text-xs font-medium text-bp-text-tertiary hover:text-bp-text-secondary rounded">
              Original
            </button>
          </div>

          {/* Interval Selector */}
          <div className="flex items-center gap-1">
            {CHART_INTERVALS.map((interval) => (
              <button
                key={interval.value}
                onClick={() => setSelectedInterval(interval.value)}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium rounded transition-all",
                  selectedInterval === interval.value
                    ? "bg-backpack-bg-tertiary text-bp-text-primary"
                    : "text-bp-text-tertiary hover:text-bp-text-secondary"
                )}
              >
                {interval.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chart Type */}
        <div className="flex items-center gap-2">
          <button className="p-1.5 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>
            </svg>
          </button>
          <button className="p-1.5 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 4v16h2V4h-2zm4 0v16h2V4h-2z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Chart Container */}
      <div className="relative flex-1 bg-backpack-bg-secondary">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-bp-text-tertiary text-sm">Loading chart...</div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center">
              <div className="text-bp-text-tertiary text-sm mb-2">{error}</div>
              <button 
                onClick={() => window.location.reload()}
                className="px-3 py-1 bg-backpack-bg-tertiary text-bp-text-secondary rounded hover:text-bp-text-primary transition-colors text-xs"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <div
          ref={chartRef}
          className="w-full h-full"
          style={{ minHeight: '400px' }}
        />
      </div>
    </div>
  );
}