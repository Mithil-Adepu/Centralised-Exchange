"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBalances } from "../utils/httpClient";
import { useAuthStore } from "../store/useAuthStore";
import { useThemeStore } from "../store/useThemeStore";
import { cn } from "../lib/utils";

/* ═══════════════════════════════════════════════════════════════
   Profile / Account Page (/profile)
   Mirrors Backpack's account panel: identity, trading account balance,
   quick actions, settings links, theme toggle, logout.
   ═══════════════════════════════════════════════════════════════ */

type Balances = Record<string, { available: number; locked: number }>;

export default function ProfilePage() {
  const { isAuthenticated, isLoading, user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const [balances, setBalances] = useState<Balances>({});

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      getBalances().then((r) => setBalances(r.balances || {})).catch(() => {});
    }
  }, [isLoading, isAuthenticated]);

  if (isLoading) return <div className="p-8 text-center text-bp-text-tertiary">Loading...</div>;
  if (!isAuthenticated || !user) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <h2 className="text-xl font-semibold mb-4 text-bp-text-primary">Please log in to view your profile</h2>
      </div>
    );
  }

  const displayName = user.email.split("@")[0] || "Trader";
  const initial = user.email.charAt(0).toUpperCase();
  const usdc = balances.USDC?.available ?? 0;
  const sol = balances.SOL?.available ?? 0;

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      {/* Identity */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-bp-red to-bp-red-hover flex items-center justify-center text-white text-xl font-bold">
          {initial}
        </div>
        <div>
          <h1 className="text-xl font-semibold text-bp-text-primary capitalize">{displayName}</h1>
          <p className="text-sm text-bp-text-tertiary">{user.email}</p>
        </div>
      </div>

      {/* Trading account */}
      <div className="bg-bp-bg-secondary border border-bp-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-bp-text-secondary">Trading Account</h2>
          <span className="text-2xs px-2 py-0.5 rounded-full bg-bp-green-bg text-bp-green">Main</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg bg-bp-bg-tertiary border border-bp-border p-4">
            <p className="text-2xs text-bp-text-tertiary mb-1">USDC</p>
            <p className="text-lg font-semibold text-bp-text-primary tabular-nums">{usdc.toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-bp-bg-tertiary border border-bp-border p-4">
            <p className="text-2xs text-bp-text-tertiary mb-1">SOL</p>
            <p className="text-lg font-semibold text-bp-text-primary tabular-nums">{sol.toFixed(4)}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-4">
          <Link href="/deposit" className="py-2 text-center text-xs font-semibold rounded-md bg-bp-green hover:bg-bp-green-hover text-bp-text-inverse transition-colors">Deposit</Link>
          <Link href="/withdraw" className="py-2 text-center text-xs font-semibold rounded-md bg-bp-blue hover:bg-bp-blue-hover text-white transition-colors">Withdraw</Link>
          <Link href="/markets" className="py-2 text-center text-xs font-semibold rounded-md border border-bp-border text-bp-text-secondary hover:text-bp-text-primary hover:border-bp-border-active transition-colors">Trade</Link>
        </div>
      </div>

      {/* Settings list */}
      <div className="bg-bp-bg-secondary border border-bp-border rounded-xl overflow-hidden">
        <RowLink href="/wallet" label="Wallet & Assets" icon="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        <RowLink href="/settings/security" label="Security & Sessions" icon="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="flex items-center justify-between w-full px-5 py-3.5 text-sm text-bp-text-secondary hover:bg-bp-bg-tertiary transition-colors border-t border-bp-border"
        >
          <span className="flex items-center gap-3">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
            Dark mode
          </span>
          <span className={cn("relative w-9 h-5 rounded-full transition-colors", theme === "dark" ? "bg-bp-green" : "bg-bp-border-active")}>
            <span className={cn("absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform", theme === "dark" && "translate-x-4")} />
          </span>
        </button>

        {/* Logout */}
        <button
          onClick={logout}
          className="flex items-center gap-3 w-full px-5 py-3.5 text-sm text-bp-text-secondary hover:text-bp-red hover:bg-bp-bg-tertiary transition-colors border-t border-bp-border"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Log out
        </button>
      </div>
    </div>
  );
}

function RowLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between px-5 py-3.5 text-sm text-bp-text-secondary hover:bg-bp-bg-tertiary transition-colors"
    >
      <span className="flex items-center gap-3">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
        </svg>
        {label}
      </span>
      <svg className="w-4 h-4 text-bp-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}
