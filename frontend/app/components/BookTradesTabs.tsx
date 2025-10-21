"use client";

import { useState } from "react";
import { cn } from "../lib/utils";
import { Depth } from "./depth/Depth";
import { Trades } from "./Trades";

export function BookTradesTabs({ market }: { market: string }) {
    const [activeTab, setActiveTab] = useState<"book" | "trades">("book");

    return (
        <div className="flex flex-col h-full">
            {/* Tabs Header */}
            <div className="px-4 py-3 border-b border-backpack-border">
                <div className="flex gap-1 bg-backpack-bg-tertiary p-1 rounded-md">
                    <button
                        onClick={() => setActiveTab("book")}
                        className={cn(
                            "flex-1 py-1.5 text-xs font-medium rounded transition-all",
                            activeTab === "book"
                                ? "bg-backpack-bg-secondary text-bp-text-primary"
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Book
                    </button>
                    <button
                        onClick={() => setActiveTab("trades")}
                        className={cn(
                            "flex-1 py-1.5 text-xs font-medium rounded transition-all",
                            activeTab === "trades"
                                ? "bg-backpack-bg-secondary text-bp-text-primary"
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Trades
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === "book" ? (
                    <Depth market={market} />
                ) : (
                    <Trades market={market} />
                )}
            </div>
        </div>
    );
}