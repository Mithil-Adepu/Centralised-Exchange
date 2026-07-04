"use client";

import { useEffect, useState } from "react";
import { SignalingManager } from "../utils/SignalingManager";
import { Trade } from "../utils/types";
import { getTrades } from "../utils/httpClient";
import { formatPrice, formatTime, cn } from "../lib/utils";

/* ═══════════════════════════════════════════════════════════════
   Trades — Recent Trades List (Backpack Exchange Style)
   ═══════════════════════════════════════════════════════════════ */

export function Trades({ market }: { market: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [base = "", quote = ""] = market.split("_");

  useEffect(() => {
    setLoading(true);
    getTrades(market)
      .then((initialTrades) => {
        setTrades(initialTrades.slice(0, 50));
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    /* ─── Real-time Trade Updates ─── */
    const callbackId = `TRADES-${market}`;
    const tradeStream = `trade.${market}`;
    SignalingManager.getInstance().registerCallback(
      tradeStream,
      (newTrade: Trade) => {
        setTrades((prev) => [newTrade, ...prev].slice(0, 50));
      },
      callbackId
    );

    SignalingManager.getInstance().sendMessage({
      method: "SUBSCRIBE",
      params: [`trade.${market}`],
    });

    return () => {
      SignalingManager.getInstance().deRegisterCallback(tradeStream, callbackId);
      SignalingManager.getInstance().sendMessage({
        method: "UNSUBSCRIBE",
        params: [`trade.${market}`],
      });
    };
  }, [market]);

  if (loading) return <TradesSkeleton />;

  return (
    <div className="flex flex-col h-full">
      {/* ─── Column Headers ─── */}
      <div className="grid grid-cols-3 px-3 py-1.5 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Price ({quote})</div>
        <div className="text-right">Size ({base})</div>
        <div className="text-right">Time</div>
      </div>

      {/* ─── Trades List ─── */}
      <div className="flex-1 overflow-y-auto no-scrollbar">
        {trades.map((trade, index) => (
          <TradeRow key={`${trade.id}-${index}`} trade={trade} />
        ))}
      </div>
    </div>
  );
}


/* ─── Single Trade Row ─── */
function TradeRow({ trade }: { trade: Trade }) {
  const isBuy = !trade.isBuyerMaker;

  return (
    <div className="grid grid-cols-3 px-3 py-[3px] text-xs hover:bg-bp-bg-hover transition-colors">
      <div className={cn("tabular-nums", isBuy ? "text-bp-green" : "text-bp-red")}>
        {formatPrice(trade.price, 2)}
      </div>
      <div className="text-right text-bp-text-secondary tabular-nums">
        {parseFloat(trade.quantity).toFixed(4)}
      </div>
      <div className="text-right text-bp-text-tertiary tabular-nums">
        {formatTime(trade.timestamp, "time")}
      </div>
    </div>
  );
}


/* ─── Loading Skeleton ─── */
function TradesSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-bp-border">
        <div className="grid grid-cols-3 gap-2">
          <div className="w-12 h-3 bg-bp-bg-tertiary rounded animate-pulse" />
          <div className="w-10 h-3 bg-bp-bg-tertiary rounded animate-pulse ml-auto" />
          <div className="w-10 h-3 bg-bp-bg-tertiary rounded animate-pulse ml-auto" />
        </div>
      </div>
      <div className="flex-1 p-3 space-y-1">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="grid grid-cols-3 gap-2">
            <div className="w-14 h-3 bg-bp-bg-tertiary rounded animate-pulse" />
            <div className="w-10 h-3 bg-bp-bg-tertiary rounded animate-pulse ml-auto" />
            <div className="w-10 h-3 bg-bp-bg-tertiary rounded animate-pulse ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}