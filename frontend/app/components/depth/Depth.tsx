"use client";

import { useEffect, useState } from "react";
import { getDepth, getTicker } from "../../utils/httpClient";
import { BidTable } from "./BidTable";
import { AskTable } from "./AskTable";
import { SentimentBar } from "../SentimentBar";
import { SignalingManager } from "@/app/utils/SignalingManager";
import { formatPrice, cn } from "@/app/lib/utils";
import { ArrowUp, ArrowDown } from "lucide-react";

/* ═══════════════════════════════════════════════════════════════
   Depth — Full Order Book with Asks, Spread, Bids, Sentiment
   ═══════════════════════════════════════════════════════════════ */

const ORDER_BOOK_ROWS = 12;

export function Depth({ market }: { market: string }) {
  const [bids, setBids] = useState<[string, string][]>([]);
  const [asks, setAsks] = useState<[string, string][]>([]);
  const [price, setPrice] = useState<string>("0");
  const [previousPrice, setPreviousPrice] = useState<string>("0");
  const [loading, setLoading] = useState(true);

  const [, quote = ""] = market.split("_");

  useEffect(() => {
    setLoading(true);

    const fetchInitialData = async () => {
      try {
        const [depthData, tickerData] = await Promise.all([
          getDepth(market),
          getTicker(market),
        ]);
        setBids(depthData.bids);
        setAsks(depthData.asks);
        setPrice(tickerData.lastPrice);
        setPreviousPrice(tickerData.lastPrice);
      } catch (error) {
        console.error("Failed to fetch initial depth data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchInitialData();

    /* ─── Real-time Depth Updates ─── */
    const depthCallbackId = `DEPTH-${market}`;
    const depthStream = `depth.${market}`;
    SignalingManager.getInstance().registerCallback(
      depthStream,
      (data: any) => {
        // Full-book snapshot (e.g. after a cancel): replace state so levels
        // removed server-side don't linger. Otherwise merge the delta.
        if (data.snapshot) {
          setBids(
            [...(data.b || [])]
              .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
              .slice(0, ORDER_BOOK_ROWS)
          );
          setAsks(
            [...(data.a || [])]
              .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
              .slice(0, ORDER_BOOK_ROWS)
          );
          return;
        }

        setBids((prev) => {
          const updated = [...(prev || [])];
          data.b?.forEach(([p, q]: [string, string]) => {
            const idx = updated.findIndex((b) => b[0] === p);
            if (parseFloat(q) === 0) {
              if (idx !== -1) updated.splice(idx, 1);
            } else {
              if (idx !== -1) updated[idx] = [p, q];
              else updated.push([p, q]);
            }
          });
          return updated
            .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
            .slice(0, ORDER_BOOK_ROWS);
        });

        setAsks((prev) => {
          const updated = [...(prev || [])];
          data.a?.forEach(([p, q]: [string, string]) => {
            const idx = updated.findIndex((a) => a[0] === p);
            if (parseFloat(q) === 0) {
              if (idx !== -1) updated.splice(idx, 1);
            } else {
              if (idx !== -1) updated[idx] = [p, q];
              else updated.push([p, q]);
            }
          });
          return updated
            .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
            .slice(0, ORDER_BOOK_ROWS);
        });
      },
      depthCallbackId
    );

    /* ─── Real-time Ticker (for price) ─── */
    const tickerCallbackId = `TICKER-DEPTH-${market}`;
    const tickerStream = `ticker.${market}`;
    SignalingManager.getInstance().registerCallback(
      tickerStream,
      (data: any) => {
        if (data.lastPrice) {
          setPreviousPrice((prev) => prev);
          setPrice((prev) => {
            setPreviousPrice(prev);
            return data.lastPrice;
          });
        }
      },
      tickerCallbackId
    );

    SignalingManager.getInstance().sendMessage({
      method: "SUBSCRIBE",
      params: [`depth.${market}`],
    });
    SignalingManager.getInstance().sendMessage({
      method: "SUBSCRIBE",
      params: [`ticker.${market}`],
    });

    return () => {
      SignalingManager.getInstance().sendMessage({
        method: "UNSUBSCRIBE",
        params: [`depth.${market}`],
      });
      SignalingManager.getInstance().sendMessage({
        method: "UNSUBSCRIBE",
        params: [`ticker.${market}`],
      });
      SignalingManager.getInstance().deRegisterCallback(depthStream, depthCallbackId);
      SignalingManager.getInstance().deRegisterCallback(tickerStream, tickerCallbackId);
    };
  }, [market]);

  if (loading) return <DepthSkeleton />;

  /* ─── Derived Values ─── */
  const priceUp = parseFloat(price) >= parseFloat(previousPrice);
  const spread = asks.length > 0 && bids.length > 0
    ? (parseFloat(asks[0]![0]) - parseFloat(bids[0]![0])).toFixed(2)
    : "0.00";

  const bidVolume = bids.reduce((sum, [, q]) => sum + Number(q), 0);
  const askVolume = asks.reduce((sum, [, q]) => sum + Number(q), 0);

  return (
    <div className="flex flex-col h-full">
      {/* ─── Column Headers ─── */}
      <div className="grid grid-cols-3 px-3 py-1.5 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Price ({quote})</div>
        <div className="text-right">Size</div>
        <div className="text-right">Total</div>
      </div>

      {/* ─── Order Book Content ─── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Asks — reversed to show lowest price nearest to spread */}
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          <AskTable asks={asks.slice().reverse().slice(0, ORDER_BOOK_ROWS)} />
        </div>

        {/* ─── Spread / Last Price ─── */}
        <div className="px-3 py-2 bg-bp-bg-primary border-y border-bp-border">
          <div className="flex items-center justify-between">
            {/* Price + Direction Arrow */}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "text-lg font-semibold tabular-nums",
                  priceUp ? "text-bp-green" : "text-bp-red"
                )}
              >
                {formatPrice(price, 2)}
              </span>
              {priceUp ? (
                <ArrowUp className="w-3.5 h-3.5 text-bp-green" />
              ) : (
                <ArrowDown className="w-3.5 h-3.5 text-bp-red" />
              )}
            </div>

            {/* Spread */}
            <span className="text-2xs text-bp-text-tertiary tabular-nums">
              Spread: {spread}
            </span>
          </div>
        </div>

        {/* Bids */}
        <div className="flex-1 overflow-hidden">
          <BidTable bids={bids.slice(0, ORDER_BOOK_ROWS)} />
        </div>
      </div>

      {/* ─── Sentiment Bar ─── */}
      <div className="border-t border-bp-border">
        <SentimentBar bidVolume={bidVolume} askVolume={askVolume} />
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   Loading Skeleton
   ═══════════════════════════════════════════════════════════════ */

function DepthSkeleton() {
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