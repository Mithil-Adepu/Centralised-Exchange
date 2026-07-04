"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBalances } from "../utils/httpClient";
import { useAuthStore } from "../store/useAuthStore";
import toast from "react-hot-toast";

/* ═══════════════════════════════════════════════════════════════
   Wallet Page (/wallet) — balances overview.
   Deposit/Withdraw now live on their own dedicated pages; this page
   links out to them (matching the reference flow).
   ═══════════════════════════════════════════════════════════════ */

type Balances = Record<string, { available: number; locked: number }>;

export default function WalletPage() {
  const { isAuthenticated, isLoading } = useAuthStore();
  const [balances, setBalances] = useState<Balances>({});
  const [isFetching, setIsFetching] = useState(true);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      fetchBalances();
    }
  }, [isLoading, isAuthenticated]);

  const fetchBalances = async () => {
    try {
      setIsFetching(true);
      const res = await getBalances();
      setBalances(res.balances || {});
    } catch (error) {
      console.error("Failed to fetch balances:", error);
      toast.error("Failed to fetch balances");
    } finally {
      setIsFetching(false);
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-bp-text-tertiary">Loading...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <h2 className="text-xl font-semibold mb-4 text-bp-text-primary">Please log in to view your wallet</h2>
      </div>
    );
  }

  const entries = Object.entries(balances);
  const totalLabel = entries.length ? `${entries.length} asset${entries.length !== 1 ? "s" : ""}` : "";

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
      {/* Header with actions */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold text-bp-text-primary">Wallet</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/deposit"
            className="px-4 py-2 text-xs font-semibold rounded-md bg-bp-green hover:bg-bp-green-hover text-bp-text-inverse transition-colors"
          >
            Deposit
          </Link>
          <Link
            href="/withdraw"
            className="px-4 py-2 text-xs font-semibold rounded-md bg-bp-blue hover:bg-bp-blue-hover text-white transition-colors"
          >
            Withdraw
          </Link>
        </div>
      </div>

      {/* Assets */}
      <div className="bg-bp-bg-secondary border border-bp-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-bp-border flex items-center justify-between">
          <h2 className="text-sm font-medium text-bp-text-primary">Your Assets</h2>
          <span className="text-2xs text-bp-text-tertiary">{totalLabel}</span>
        </div>

        {isFetching ? (
          <div className="flex justify-center p-12">
            <div className="w-7 h-7 border-2 border-bp-border border-t-bp-green rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center p-12 text-bp-text-tertiary text-sm">
            No assets yet.{" "}
            <Link href="/deposit" className="text-bp-green hover:underline">Deposit funds</Link> to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-bp-border text-2xs text-bp-text-tertiary uppercase tracking-wider">
                  <th className="px-6 py-3 font-medium">Asset</th>
                  <th className="px-6 py-3 font-medium text-right">Available</th>
                  <th className="px-6 py-3 font-medium text-right">In Order</th>
                  <th className="px-6 py-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(([asset, balance]) => (
                  <tr key={asset} className="border-b border-bp-border hover:bg-bp-bg-tertiary transition-colors last:border-0">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-bp-bg-tertiary border border-bp-border flex items-center justify-center text-2xs font-bold text-bp-text-primary">
                          {asset.slice(0, 3)}
                        </div>
                        <span className="font-medium text-bp-text-primary">{asset}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-bp-text-primary tabular-nums">{balance.available.toFixed(4)}</td>
                    <td className="px-6 py-4 text-right text-sm text-bp-text-tertiary tabular-nums">{balance.locked.toFixed(4)}</td>
                    <td className="px-6 py-4 text-right text-sm font-medium text-bp-text-primary tabular-nums">
                      {(balance.available + balance.locked).toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
