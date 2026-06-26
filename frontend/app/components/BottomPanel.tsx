"use client";

import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { formatPrice, formatTime } from "../lib/utils";
import { getBalances, getOpenOrders, getTrades, cancelOrder } from "../utils/httpClient";
import { Trade } from "../utils/types";

/* ═══════════════════════════════════════════════════════════════
   BottomPanel — Orders, Balances & History (Backpack Style)

   Tabs: Balances | Open Orders | Order History | Trade History
   Sits below the trading grid. Shows relevant trading data.
   ═══════════════════════════════════════════════════════════════ */

type BottomTab =
  | "balances"
  | "openOrders"
  | "orderHistory"
  | "tradeHistory";

type BalanceRow = {
  asset: string;
  total: number;
  available: number;
  inOrder: number;
};

type OpenOrderRow = {
  orderId: string;
  executedQty: number;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  timestamp: number;
};

const TABS: { key: BottomTab; label: string }[] = [
  { key: "balances",     label: "Balances" },
  { key: "openOrders",   label: "Open Orders" },
  { key: "orderHistory", label: "Order History" },
  { key: "tradeHistory", label: "Trade History" },
];

export function BottomPanel({ market: _market }: { market: string }) {
  const market = _market;
  const [activeTab, setActiveTab] = useState<BottomTab>("openOrders");

  return (
    <div className="flex flex-col h-full bg-bp-bg-secondary">
      {/* ─── Resize Handle ─── */}
      <div className="resize-handle border-t border-bp-border" />

      {/* ─── Tab Bar ─── */}
      <div className="flex items-center gap-1 px-4 border-b border-bp-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "relative px-3 py-2.5 text-xs font-medium transition-colors",
              activeTab === tab.key
                ? "text-bp-text-primary"
                : "text-bp-text-tertiary hover:text-bp-text-secondary"
            )}
          >
            {tab.label}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-[1.5px] bg-bp-text-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* ─── Tab Content ─── */}
      <div className="flex-1 overflow-auto bg-bp-bg-primary">
        {activeTab === "balances" && <BalancesTab />}
        {activeTab === "openOrders" && <OpenOrdersTab market={market} />}
        {activeTab === "orderHistory" && <OrderHistoryTab market={market} />}
        {activeTab === "tradeHistory" && <TradeHistoryTab market={market} />}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   Shared Sub-Components
   ═══════════════════════════════════════════════════════════════ */

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <svg
        className="w-10 h-10 text-bp-text-disabled mb-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <p className="text-xs text-bp-text-tertiary">{message}</p>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   Tab Content Components
   ═══════════════════════════════════════════════════════════════ */

/** Balances Tab */
function BalancesTab() {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getBalances()
      .then((response) => {
        if (cancelled) return;
        const rows = Object.entries(response.balances || {}).map(([asset, balance]) => ({
          asset,
          total: Number(balance.available) + Number(balance.locked),
          available: Number(balance.available),
          inOrder: Number(balance.locked),
        }));
        setBalances(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Connect your wallet to view balances");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="w-full">
      {/* Table Header */}
      <div className="grid grid-cols-5 px-4 py-2 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Asset</div>
        <div className="text-right">Total</div>
        <div className="text-right">Available</div>
        <div className="text-right">In Order</div>
        <div className="text-right">USD Value</div>
      </div>

      {loading && <EmptyState message="Loading balances..." />}
      {!loading && error && <EmptyState message={error} />}
      {!loading && !error && balances.length === 0 && (
        <EmptyState message="No balances yet" />
      )}
      {!loading && !error && balances.length > 0 && (
        <div className="divide-y divide-bp-border">
          {balances.map((balance) => (
            <div key={balance.asset} className="grid grid-cols-5 px-4 py-2 text-xs text-bp-text-secondary">
              <div className="text-bp-text-primary font-medium">{balance.asset}</div>
              <div className="text-right tabular-nums">{balance.total.toFixed(4)}</div>
              <div className="text-right tabular-nums">{balance.available.toFixed(4)}</div>
              <div className="text-right tabular-nums">{balance.inOrder.toFixed(4)}</div>
              <div className="text-right tabular-nums">-</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Open Orders Tab */
function OpenOrdersTab({ market }: { market: string }) {
  const [orders, setOrders] = useState<OpenOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Loading open orders...");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    
    const fetchOrders = (signal?: AbortSignal) => {
      getOpenOrders(market)
        .then((response) => {
          if (signal?.aborted) return;
          setOrders(response || []);
          setMessage("No open orders");
        })
        .catch((e) => {
          if (signal?.aborted) return;
          setOrders([]);
          setMessage(e?.message || "Sign in to view open orders");
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    };

    setLoading(true);
    fetchOrders(controller.signal);

    // Poll every 8s for fresh orders
    const interval = setInterval(() => fetchOrders(controller.signal), 8000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [market]);

  const handleCancel = async (order: OpenOrderRow) => {
    setCancellingId(order.orderId);
    setCancelError(null);
    try {
      await cancelOrder(order.orderId, market);
      setOrders((prev) => prev.filter((o) => o.orderId !== order.orderId));
    } catch (e: any) {
      setCancelError(e?.response?.data?.error || e?.message || "Cancel failed");
      setTimeout(() => setCancelError(null), 4000);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="w-full">
      {/* Table Header */}
      <div className="grid grid-cols-8 px-4 py-2 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Time</div>
        <div>Pair</div>
        <div>Type</div>
        <div>Side</div>
        <div className="text-right">Price</div>
        <div className="text-right">Amount</div>
        <div className="text-right">Filled</div>
        <div className="text-right">Action</div>
      </div>

      {cancelError && (
        <div className="mx-4 mt-2 px-3 py-1.5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded">
          {cancelError}
        </div>
      )}

      {loading && <EmptyState message="Loading..." />}
      {!loading && orders.length === 0 && <EmptyState message={message} />}
      {!loading && orders.length > 0 && (
        <div className="divide-y divide-bp-border">
          {orders.map((order) => (
            <div key={order.orderId} className="grid grid-cols-8 px-4 py-2 text-xs text-bp-text-secondary items-center hover:bg-bp-bg-secondary transition-colors">
              <div>{formatTime(order.timestamp)}</div>
              <div>{market.replace("_", "/")}</div>
              <div>Limit</div>
              <div className={order.side === "buy" ? "text-bp-green" : "text-bp-red"}>
                {order.side.toUpperCase()}
              </div>
              <div className="text-right tabular-nums">{formatPrice(order.price)}</div>
              <div className="text-right tabular-nums">{order.quantity}</div>
              <div className="text-right tabular-nums">{order.executedQty}</div>
              <div className="text-right">
                {cancellingId === order.orderId ? (
                  <span className="text-bp-text-disabled text-xs">Cancelling...</span>
                ) : (
                  <button
                    onClick={() => handleCancel(order)}
                    disabled={cancellingId !== null}
                    className={cn(
                      "text-bp-red text-xs hover:underline transition-opacity",
                      cancellingId !== null && "opacity-40 cursor-not-allowed"
                    )}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Order History Tab */
function OrderHistoryTab({ market }: { market: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrades(market)
      .then((response) => {
        if (!cancelled) setTrades(response.slice(0, 20));
      })
      .catch(() => {
        if (!cancelled) setTrades([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [market]);

  return (
    <div className="w-full">
      {/* Table Header */}
      <div className="grid grid-cols-7 px-4 py-2 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Time</div>
        <div>Pair</div>
        <div>Type</div>
        <div>Side</div>
        <div className="text-right">Price</div>
        <div className="text-right">Amount</div>
        <div className="text-right">Status</div>
      </div>

      {loading && <EmptyState message="Loading..." />}
      {!loading && trades.length === 0 && <EmptyState message="No order history yet" />}
      {!loading && trades.length > 0 && (
        <div className="divide-y divide-bp-border">
          {trades.map((trade) => (
            <div key={trade.id} className="grid grid-cols-7 px-4 py-2 text-xs text-bp-text-secondary">
              <div className="tabular-nums">{formatTime(trade.timestamp, "time")}</div>
              <div>{market.replace("_", "/")}</div>
              <div>Market</div>
              <div className={cn(trade.isBuyerMaker ? "text-bp-red" : "text-bp-green")}>
                {trade.isBuyerMaker ? "SELL" : "BUY"}
              </div>
              <div className="text-right tabular-nums">{formatPrice(trade.price, 2)}</div>
              <div className="text-right tabular-nums">{Number(trade.quantity).toFixed(4)}</div>
              <div className="text-right text-bp-text-tertiary">Filled</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Trade History Tab */
function TradeHistoryTab({ market }: { market: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrades(market)
      .then((res) => {
        if (!cancelled) setTrades(res.slice(0, 50)); // Last 50 trades
      })
      .catch(() => {
        if (!cancelled) setTrades([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [market]);

  return (
    <div className="w-full">
      <div className="grid grid-cols-6 px-4 py-2 text-2xs text-bp-text-tertiary border-b border-bp-border">
        <div>Time</div>
        <div>Side</div>
        <div className="text-right">Price</div>
        <div className="text-right">Amount</div>
        <div className="text-right">Value</div>
        <div className="text-right">Marker</div>
      </div>

      {loading && <EmptyState message="Loading trades..." />}
      {!loading && trades.length === 0 && <EmptyState message="No trade history" />}
      {!loading && trades.length > 0 && (
        <div className="divide-y divide-bp-border">
          {trades.map((trade) => (
            <div key={trade.id} className="grid grid-cols-6 px-4 py-2 text-xs text-bp-text-secondary items-center hover:bg-bp-bg-secondary transition-colors">
              <div>{formatTime(trade.timestamp)}</div>
              <div className={trade.isBuyerMaker ? "text-bp-red" : "text-bp-green"}>
                {trade.isBuyerMaker ? "SELL" : "BUY"}
              </div>
              <div className="text-right tabular-nums">{formatPrice(trade.price)}</div>
              <div className="text-right tabular-nums">{trade.quantity}</div>
              <div className="text-right tabular-nums">
                {formatPrice((parseFloat(trade.price) * parseFloat(trade.quantity)).toString())}
              </div>
              <div className="text-right text-bp-text-tertiary text-2xs">
                {trade.isBuyerMaker ? "Maker" : "Taker"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
