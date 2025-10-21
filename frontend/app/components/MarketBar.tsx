"use client";

import { useEffect, useState } from "react";
import { getTicker } from "../utils/httpClient";
import { Ticker } from "../utils/types";
import { formatPrice, formatPercentage, formatVolume, cn } from "../lib/utils";
import { SignalingManager } from "../utils/SignalingManager";
import { ChevronDown } from "lucide-react";
import Link from "next/link";

export function MarketBar({ market }: { market: string }) {
    const [ticker, setTicker] = useState<Ticker | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                setLoading(true);
                const tickerData = await getTicker(market);
                setTicker(tickerData);
            } catch (err) {
                console.error('Failed to fetch market data:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();

        // Register for real-time ticker updates
        const tickerCallbackId = `TICKER-MARKET-${market}`;
        SignalingManager.getInstance().registerCallback("ticker", (data: any) => {
            console.log('📨 MarketBar ticker callback received:', data);
            if (data.symbol === market) {
                setTicker(prev => prev ? { ...prev, ...data } : null);
            }
        }, tickerCallbackId);

        // Subscribe to ticker updates
        SignalingManager.getInstance().sendMessage({ 
            method: "SUBSCRIBE", 
            params: [`ticker.${market}`] 
        });

        return () => {
            SignalingManager.getInstance().deRegisterCallback("ticker", tickerCallbackId);
            SignalingManager.getInstance().sendMessage({ 
                method: "UNSUBSCRIBE", 
                params: [`ticker.${market}`] 
            });
        };
    }, [market]);

    if (loading || !ticker) {
        return <MarketBarSkeleton />;
    }

    const isPositive = parseFloat(ticker.priceChangePercent || '0') >= 0;
    const [base, quote] = market.split('_');

    return (
        <div className="flex items-center h-[56px] px-4 bg-backpack-bg-secondary">
            {/* Market Selector */}
            <Link href="/markets" className="flex items-center gap-2 pr-6 border-r border-backpack-border hover:opacity-80 transition-opacity">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#00FFA3] to-[#DC1FFF] flex items-center justify-center">
                        <span className="text-white font-bold text-xs">
                            {base?.charAt(0) || 'S'}
                        </span>
                    </div>
                    <span className="text-base font-semibold text-bp-text-primary">{base}/{quote}</span>
                    <ChevronDown className="w-4 h-4 text-bp-text-tertiary" />
                </div>
            </Link>

            {/* Price Section */}
            <div className="flex items-center gap-8 pl-6">
                <div>
                    <div className="text-2xl font-semibold text-bp-text-primary tabular-nums">
                        ${formatPrice(ticker.lastPrice, 2)}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <span className={cn(
                            "tabular-nums",
                            isPositive ? "text-bp-green" : "text-bp-red"
                        )}>
                            {isPositive ? '+' : ''}{formatPrice(ticker.priceChange, 2)}
                        </span>
                        <span className={cn(
                            "tabular-nums",
                            isPositive ? "text-bp-green" : "text-bp-red"
                        )}>
                            ({isPositive ? '+' : ''}{formatPercentage(ticker.priceChangePercent, false)})
                        </span>
                    </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-8 text-sm">
                    <div>
                        <div className="text-bp-text-tertiary text-xs">24h High</div>
                        <div className="text-bp-text-secondary tabular-nums">${formatPrice(ticker.high, 2)}</div>
                    </div>
                    <div>
                        <div className="text-bp-text-tertiary text-xs">24h Low</div>
                        <div className="text-bp-text-secondary tabular-nums">${formatPrice(ticker.low, 2)}</div>
                    </div>
                    <div>
                        <div className="text-bp-text-tertiary text-xs">24h Volume</div>
                        <div className="text-bp-text-secondary tabular-nums">${formatVolume(ticker.quoteVolume)}</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MarketBarSkeleton() {
    return (
        <div className="flex items-center h-[56px] px-4 bg-backpack-bg-secondary">
            <div className="flex items-center gap-2 pr-6 border-r border-backpack-border">
                <div className="w-6 h-6 bg-backpack-bg-tertiary rounded-full animate-pulse" />
                <div className="w-20 h-4 bg-backpack-bg-tertiary rounded animate-pulse" />
            </div>
            <div className="flex items-center gap-8 pl-6">
                <div className="space-y-2">
                    <div className="w-24 h-6 bg-backpack-bg-tertiary rounded animate-pulse" />
                    <div className="w-16 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                </div>
                <div className="flex gap-8">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="space-y-1">
                            <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                            <div className="w-16 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}