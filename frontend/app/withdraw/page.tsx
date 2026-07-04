"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBalances } from "../utils/httpClient";
import { useAuthStore } from "../store/useAuthStore";
import { cn } from "../lib/utils";
import toast from "react-hot-toast";

/* ═══════════════════════════════════════════════════════════════
   Withdraw Page (/withdraw)
   Dedicated page, Backpack-styled. NOTE: there is no withdrawal rail
   in this environment, so submission validates the balance and records
   a simulated request (does not move funds) — clearly surfaced to the user.
   ═══════════════════════════════════════════════════════════════ */

type Balances = Record<string, { available: number; locked: number }>;

export default function WithdrawPage() {
  const { isAuthenticated, isLoading } = useAuthStore();
  const [balances, setBalances] = useState<Balances>({});
  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      getBalances().then((r) => setBalances(r.balances || {})).catch(() => {});
    }
  }, [isLoading, isAuthenticated]);

  const available = balances[asset]?.available ?? 0;
  const assets = Object.keys(balances).length ? Object.keys(balances) : ["USDC", "SOL"];

  const handleWithdraw = () => {
    const num = Number(amount);
    if (!amount || isNaN(num) || num <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (num > available) {
      toast.error(`Insufficient ${asset} balance`);
      return;
    }
    if (!address.trim()) {
      toast.error("Enter a destination address");
      return;
    }
    setSubmitting(true);
    // No withdrawal rail in this environment — simulate the request.
    setTimeout(() => {
      toast.success(`Withdrawal of ${num} ${asset} requested (simulated — no funds moved)`);
      setAmount("");
      setAddress("");
      setSubmitting(false);
    }, 600);
  };

  if (isLoading) return <div className="p-8 text-center text-bp-text-tertiary">Loading...</div>;
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <h2 className="text-xl font-semibold mb-4 text-bp-text-primary">Please log in to withdraw funds</h2>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-4 sm:p-6 lg:p-8">
      <Link href="/wallet" className="inline-flex items-center gap-1 text-xs text-bp-text-tertiary hover:text-bp-text-primary transition-colors mb-4">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Wallet
      </Link>
      <h1 className="text-2xl font-semibold text-bp-text-primary mb-6">Withdraw</h1>

      <div className="bg-bp-bg-secondary border border-bp-border rounded-xl p-6">
        {/* Tabs */}
        <div className="flex items-center gap-6 border-b border-bp-border mb-6">
          <Link href="/deposit" className="pb-3 text-sm font-medium text-bp-text-tertiary hover:text-bp-text-secondary transition-colors">Add money</Link>
          <span className="pb-3 text-sm font-medium text-bp-text-primary border-b-2 border-bp-blue -mb-px">Withdraw</span>
        </div>

        {/* Asset selector */}
        <label className="block text-xs text-bp-text-tertiary mb-1.5">Asset</label>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {assets.map((a) => (
            <button
              key={a}
              onClick={() => { setAsset(a); setAmount(""); }}
              className={cn(
                "py-2 text-xs font-medium rounded-md border transition-colors",
                asset === a
                  ? "border-bp-border-active bg-bp-bg-tertiary text-bp-text-primary"
                  : "border-bp-border text-bp-text-tertiary hover:text-bp-text-secondary"
              )}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-bp-text-tertiary">Amount</label>
          <button
            onClick={() => setAmount(String(available))}
            className="text-2xs text-bp-blue hover:underline"
          >
            Max: {available.toFixed(available >= 1 ? 2 : 4)} {asset}
          </button>
        </div>
        <div className="relative mb-4">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 pr-14 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors tabular-nums"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-2xs text-bp-text-tertiary">{asset}</span>
        </div>

        {/* Destination */}
        <label className="block text-xs text-bp-text-tertiary mb-1.5">Destination address</label>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={`${asset} wallet address`}
          className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors mb-5"
        />

        <button
          onClick={handleWithdraw}
          disabled={submitting || !amount || !address}
          className={cn(
            "w-full py-2.5 rounded-md text-sm font-semibold transition-colors",
            "bg-bp-blue hover:bg-bp-blue-hover text-white",
            (submitting || !amount || !address) && "opacity-50 cursor-not-allowed"
          )}
        >
          {submitting ? "Processing..." : "Withdraw"}
        </button>
        <p className="text-2xs text-bp-text-tertiary text-center mt-3">
          Withdrawals are simulated in this environment — no funds are moved on-chain.
        </p>
      </div>
    </div>
  );
}
