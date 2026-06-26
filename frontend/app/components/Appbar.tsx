"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/useAuthStore";

/* ═══════════════════════════════════════════════════════════════
   Appbar — Top Navigation (Backpack Exchange Style)
   ═══════════════════════════════════════════════════════════════ */

export const Appbar = () => {
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, openModal, logout } = useAuthStore();

  return (
    <nav className="bg-bp-bg-secondary border-b border-bp-border h-12 flex-shrink-0 z-50">
      <div className="flex items-center justify-between h-full px-4">
        {/* ─── Left: Logo + Navigation Tabs ─── */}
        <div className="flex items-center gap-1">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 mr-4">
            <BackpackLogo />
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
          <NavTab href="#" active={false} disabled>
            Futures
          </NavTab>
          <NavTab href="#" active={false} disabled>
            Lend
          </NavTab>
          <NavTab href="#" active={false} disabled>
            Vault
          </NavTab>
          <NavTab href="#" active={false} disabled>
            More
          </NavTab>
        </div>

        {/* ─── Right: Utilities + Auth ─── */}
        <div className="flex items-center gap-2">
          {/* Search Button */}
          <IconButton aria-label="Search">
            <SearchIcon />
          </IconButton>

          {/* Theme Toggle */}
          <IconButton aria-label="Toggle theme">
            <ThemeIcon />
          </IconButton>

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
  );
};

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
        <div className="absolute right-0 top-full mt-1 w-48 bg-bp-bg-secondary border border-bp-border rounded-lg shadow-xl py-1 z-50">
          <div className="px-3 py-2 border-b border-bp-border">
            <p className="text-xs text-bp-text-primary font-medium truncate">{email}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="w-full text-left px-3 py-2 text-xs text-bp-text-secondary hover:text-bp-red hover:bg-bp-bg-tertiary transition-colors"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Sub-Components
   ═══════════════════════════════════════════════════════════════ */

/** Navigation Tab */
function NavTab({
  href,
  active,
  disabled,
  children,
}: {
  href: string;
  active: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={disabled ? "#" : href}
      className={cn(
        "relative px-3 py-3.5 text-xs font-medium transition-colors",
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
  );
}

/** Icon Button (ghost style) */
function IconButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="p-2 text-bp-text-tertiary hover:text-bp-text-secondary transition-colors rounded"
      {...props}
    >
      {children}
    </button>
  );
}


/* ═══════════════════════════════════════════════════════════════
   Icons (inline SVG)
   ═══════════════════════════════════════════════════════════════ */

function BackpackLogo() {
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
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}