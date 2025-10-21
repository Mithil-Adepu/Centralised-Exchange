"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/utils";

export const Appbar = () => {
    const pathname = usePathname();

    return (
        <nav className="bg-backpack-bg-secondary border-b border-backpack-border h-14">
            <div className="flex items-center justify-between h-full px-6">
                {/* Logo and Nav */}
                <div className="flex items-center gap-6">
                    <Link href="/" className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-gradient-to-br from-[#00FFA3] to-[#DC1FFF] rounded-md flex items-center justify-center">
                            <span className="text-white font-bold text-sm">B</span>
                        </div>
                        <span className="text-lg font-semibold text-bp-text-primary">Backpack</span>
                    </Link>

                    <div className="flex items-center">
                        <NavLink href="/markets" active={pathname === "/markets" || pathname.startsWith("/trade")}>
                            Spot
                        </NavLink>
                        <NavLink href="#" active={false} disabled>
                            Perpetuals
                        </NavLink>
                        <NavLink href="#" active={false} disabled>
                            Options
                        </NavLink>
                        <NavLink href="#" active={false} disabled>
                            Lend
                        </NavLink>
                        <NavLink href="#" active={false} disabled>
                            More
                        </NavLink>
                    </div>
                </div>

                {/* Right side */}
                <div className="flex items-center gap-4">
                    <button className="flex items-center gap-2 px-4 py-1.5 rounded-md text-sm text-bp-text-secondary hover:text-bp-text-primary transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                        </svg>
                        English
                    </button>

                    <div className="flex items-center gap-2">
                        <button className="px-4 py-1.5 text-sm font-medium text-bp-text-secondary hover:text-bp-text-primary transition-colors">
                            Log in
                        </button>
                        <button className="px-4 py-1.5 text-sm font-medium bg-bp-blue text-white rounded-md hover:bg-bp-blue-hover transition-colors">
                            Sign up
                        </button>
                    </div>
                </div>
            </div>
        </nav>
    );
};

function NavLink({ href, active, disabled, children }: { href: string; active: boolean; disabled?: boolean; children: React.ReactNode }) {
    return (
        <Link
            href={disabled ? "#" : href}
            className={cn(
                "px-4 py-2 text-sm font-medium transition-colors relative",
                active
                    ? "text-bp-text-primary"
                    : "text-bp-text-tertiary hover:text-bp-text-secondary",
                disabled && "cursor-not-allowed opacity-50"
            )}
            onClick={disabled ? (e) => e.preventDefault() : undefined}
        >
            {children}
            {active && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-bp-blue" />
            )}
        </Link>
    );
}