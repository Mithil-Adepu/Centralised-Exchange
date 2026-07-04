"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/useAuthStore";
import { useThemeStore } from "../store/useThemeStore";
import { getTickers } from "../utils/httpClient";
import { Ticker } from "../utils/types";
import { formatPrice, formatPercentage } from "../lib/utils";

/* ═══════════════════════════════════════════════════════════════
   Appbar — Top Navigation (CEX Exchange Style)

   Features:
     - Search modal with live market results (P3-E)
     - Dark / Light theme toggle (P3-F)
     - "Coming Soon" tooltip on disabled nav items (P5-A)
     - Settings link in user dropdown → /settings/security (P3-D)
   ═══════════════════════════════════════════════════════════════ */

export const Appbar = () => {
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, openModal, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const [searchOpen, setSearchOpen] = useState(false);

  // Keyboard shortcut: Cmd/Ctrl + K opens search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const isDark = theme === "dark";

  return (
    <>
      <nav className="bg-bp-bg-secondary border-b border-bp-border h-12 flex-shrink-0 z-50">
        <div className="flex items-center justify-between h-full px-4">
          {/* ─── Left: Logo + Navigation Tabs ─── */}
          <div className="flex items-center gap-1">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 mr-4">
              <CEXLogo />
            </Link>

            {/* Primary Nav Tabs */}
            <NavTab
              href="/markets"
              active={pathname === "/markets" || pathname.startsWith("/trade")}
            >
              Spot
            </NavTab>
            <NavTab href="/wallet" active={pathname === "/wallet"}>
              Wallet
            </NavTab>
            <NavTab href="#" active={false} disabled comingSoon>
              Futures
            </NavTab>
            <NavTab href="#" active={false} disabled comingSoon>
              Lend
            </NavTab>
            <NavTab href="#" active={false} disabled comingSoon>
              Vault
            </NavTab>
            <NavTab href="#" active={false} disabled comingSoon>
              More
            </NavTab>
          </div>

          {/* ─── Right: Utilities + Auth ─── */}
          <div className="flex items-center gap-1">
            {/* Search Button */}
            <button
              onClick={() => setSearchOpen(true)}
              aria-label="Search markets"
              className="flex items-center gap-1.5 px-2 py-1.5 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors rounded hover:bg-bp-bg-tertiary text-xs"
            >
              <SearchIcon />
              <span className="hidden sm:block">Search</span>
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-2xs border border-bp-border rounded text-bp-text-disabled font-mono">⌘K</kbd>
            </button>

            {/* Deposit / Withdraw (authenticated) */}
            {isAuthenticated && (
              <>
                <Link
                  href="/deposit"
                  className="px-3 py-1.5 text-xs font-semibold text-bp-green rounded hover:bg-bp-green-bg transition-colors"
                >
                  Deposit
                </Link>
                <Link
                  href="/withdraw"
                  className="px-3 py-1.5 text-xs font-semibold text-bp-blue rounded hover:bg-bp-blue-bg transition-colors"
                >
                  Withdraw
                </Link>
              </>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-2 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors rounded hover:bg-bp-bg-tertiary"
            >
              {isDark ? <SunIcon /> : <MoonIcon />}
            </button>

            {/* Divider */}
            <div className="w-px h-5 bg-bp-border mx-1" />

            {/* Auth Area */}
            {isLoading ? (
              <div className="w-16 h-6 bg-bp-bg-tertiary rounded animate-pulse" />
            ) : isAuthenticated && user ? (
              <UserDropdown email={user.email} onLogout={logout} />
            ) : (
              <>
                <button
                  onClick={openModal}
                  className="px-4 py-1.5 text-xs font-medium text-bp-text-secondary hover:text-bp-text-primary transition-colors rounded"
                >
                  Log in
                </button>
                <button
                  onClick={openModal}
                  className="px-4 py-1.5 text-xs font-medium bg-bp-text-primary text-bp-text-inverse rounded hover:opacity-90 transition-opacity"
                >
                  Sign up
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Search Modal */}
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
    </>
  );
};

/* ═══════════════════════════════════════════════════════════════
   Search Modal (P3-E)
   ═══════════════════════════════════════════════════════════════ */

function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [focused, setFocused] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    getTickers()
      .then(setTickers)
      .catch(() => setTickers([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = tickers.filter((t) =>
    t.symbol.toLowerCase().includes(query.toLowerCase()) ||
    t.symbol.replace("_", "/").toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = useCallback((symbol: string) => {
    router.push(`/trade/${symbol}`);
    onClose();
  }, [router, onClose]);

  // Arrow key navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((f) => Math.min(f + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((f) => Math.max(f - 1, 0));
      } else if (e.key === "Enter" && filtered[focused]) {
        handleSelect(filtered[focused]!.symbol);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [filtered, focused, handleSelect]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 bg-bp-bg-secondary border border-bp-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-bp-border">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setFocused(0); }}
            placeholder="Search markets (e.g. SOL, BTC/USDC)"
            className="flex-1 bg-transparent text-sm text-bp-text-primary placeholder-bp-text-tertiary outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-bp-text-tertiary hover:text-bp-text-secondary">
              <XIcon />
            </button>
          )}
          <kbd className="text-2xs text-bp-text-disabled border border-bp-border rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-xs text-bp-text-tertiary">Loading markets...</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-bp-text-tertiary">
              No markets found for &quot;{query}&quot;
            </div>
          ) : (
            <div>
              {filtered.slice(0, 12).map((ticker, i) => {
                const pctChange = parseFloat(ticker.priceChangePercent || "0");
                const isPos = pctChange >= 0;
                return (
                  <button
                    key={ticker.symbol}
                    onClick={() => handleSelect(ticker.symbol)}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-2.5 text-xs transition-colors text-left",
                      focused === i
                        ? "bg-bp-bg-tertiary"
                        : "hover:bg-bp-bg-tertiary"
                    )}
                    onMouseEnter={() => setFocused(i)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-bp-bg-active flex items-center justify-center text-2xs font-bold text-bp-text-secondary">
                        {ticker.symbol.split("_")[0]?.charAt(0)}
                      </div>
                      <div>
                        <span className="text-bp-text-primary font-medium">
                          {ticker.symbol.replace("_", "/")}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-bp-text-primary tabular-nums">
                        {formatPrice(ticker.lastPrice, 2)}
                      </div>
                      <div className={cn("tabular-nums", isPos ? "text-bp-green" : "text-bp-red")}>
                        {isPos ? "+" : ""}{formatPercentage(ticker.priceChangePercent, false)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-bp-border flex items-center gap-4 text-2xs text-bp-text-disabled">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   User Dropdown
   ═══════════════════════════════════════════════════════════════ */

function UserDropdown({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const initial = email.charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-bp-bg-tertiary transition-colors"
      >
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-bp-red to-bp-red-hover flex items-center justify-center text-white text-2xs font-bold">
          {initial}
        </div>
        <span className="text-xs text-bp-text-secondary max-w-[120px] truncate hidden sm:block">
          {email}
        </span>
        <svg className={cn("w-3 h-3 text-bp-text-tertiary transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-bp-bg-secondary border border-bp-border rounded-lg shadow-xl py-1 z-50">
          <div className="px-3 py-2 border-b border-bp-border">
            <p className="text-xs text-bp-text-primary font-medium truncate">{email}</p>
          </div>
          <DropdownLink href="/profile" onClick={() => setOpen(false)} label="Profile" icon="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          <DropdownLink href="/wallet" onClick={() => setOpen(false)} label="Wallet" icon="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          <DropdownLink href="/deposit" onClick={() => setOpen(false)} label="Deposit" icon="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
          <DropdownLink href="/withdraw" onClick={() => setOpen(false)} label="Withdraw" icon="M12 20V8m0 0l-4 4m4-4l4 4M4 4h16" />
          <div className="my-1 border-t border-bp-border" />
          <Link
            href="/settings/security"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-bp-text-secondary hover:text-bp-text-primary hover:bg-bp-bg-tertiary transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Security & Sessions
          </Link>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="w-full text-left px-3 py-2 text-xs text-bp-text-secondary hover:text-bp-red hover:bg-bp-bg-tertiary transition-colors flex items-center gap-2"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/** Dropdown menu link with a leading icon (used in the profile menu). */
function DropdownLink({ href, onClick, label, icon }: { href: string; onClick: () => void; label: string; icon: string }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-bp-text-secondary hover:text-bp-text-primary hover:bg-bp-bg-tertiary transition-colors"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
      </svg>
      {label}
    </Link>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Sub-Components
   ═══════════════════════════════════════════════════════════════ */

/** Navigation Tab — with optional "Coming Soon" tooltip (P5-A) */
function NavTab({
  href,
  active,
  disabled,
  comingSoon,
  children,
}: {
  href: string;
  active: boolean;
  disabled?: boolean;
  comingSoon?: boolean;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        href={disabled ? "#" : href}
        className={cn(
          "relative px-3 py-3.5 text-xs font-medium transition-colors inline-block",
          active
            ? "text-bp-text-primary"
            : "text-bp-text-tertiary hover:text-bp-text-secondary",
          disabled && "cursor-not-allowed opacity-40"
        )}
        onClick={disabled ? (e) => e.preventDefault() : undefined}
      >
        {children}
        {active && (
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-[2px] bg-bp-text-primary rounded-full" />
        )}
      </Link>

      {/* Coming Soon Tooltip */}
      {comingSoon && hovered && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-2 py-1 bg-bp-bg-active text-bp-text-tertiary text-2xs rounded border border-bp-border whitespace-nowrap z-50 pointer-events-none shadow-lg">
          Coming Soon
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-bp-bg-active border-l border-t border-bp-border rotate-45" />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Icons
   ═══════════════════════════════════════════════════════════════ */

function CEXLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="url(#bp-grad)" />
      <path
        d="M10 22V14C10 10.6863 12.6863 8 16 8C19.3137 8 22 10.6863 22 14V22"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <rect x="8" y="16" width="16" height="10" rx="3" fill="white" />
      <circle cx="16" cy="20" r="2" fill="#0B0E11" />
      <defs>
        <linearGradient id="bp-grad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#E8485F" />
          <stop offset="1" stopColor="#B7365B" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}