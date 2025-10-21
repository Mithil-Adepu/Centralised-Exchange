"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { getTickers } from "../utils/httpClient";
import { Ticker } from "../utils/types";
import { useRouter } from "next/navigation";
import { SignalingManager } from "../utils/SignalingManager";
import { formatPrice, formatVolume, formatPercentage, cn } from "../lib/utils";
import { useMarketStore } from "../store/useMarketStore";
import { parseMarketSymbol } from "../utils/market-utils";

type TabType = 'all' | 'favorites' | 'spot' | 'perp';

export default function MarketsPage() {
    const [tickers, setTickers] = useState<Ticker[]>([]);
    const [filteredTickers, setFilteredTickers] = useState<Ticker[]>([]);
    const [activeTab, setActiveTab] = useState<TabType>('spot');
    const [loading, setLoading] = useState(true);
    
    const router = useRouter();
    const { favorites, toggleFavorite, isFavorite } = useMarketStore();

    useEffect(() => {
        setLoading(true);
        getTickers().then((data) => {
            setTickers(data);
            setLoading(false);
        });

        // Subscribe to ticker updates for all markets
        SignalingManager.getInstance().registerCallback(
            "ticker",
            (data: Partial<Ticker>) => {
                setTickers(prevTickers => {
                    const updatedTickers = [...prevTickers];
                    const index = updatedTickers.findIndex(t => t.symbol === data.symbol);
                    if (index !== -1 && data.symbol) {
                        updatedTickers[index] = {
                            ...updatedTickers[index],
                            ...data,
                            symbol: data.symbol
                        } as Ticker;
                    }
                    return updatedTickers;
                });
            },
            "MARKETS-PAGE"
        );

        SignalingManager.getInstance().sendMessage({
            method: "SUBSCRIBE",
            params: ["ticker.all"]
        });

        return () => {
            SignalingManager.getInstance().deRegisterCallback("ticker", "MARKETS-PAGE");
            SignalingManager.getInstance().sendMessage({
                method: "UNSUBSCRIBE",
                params: ["ticker.all"]
            });
        };
    }, []);

    useEffect(() => {
        let filtered = [...tickers];

        // Filter by tab
        if (activeTab === 'spot') {
            filtered = filtered.filter(t => !t.symbol.endsWith('_PERP'));
        } else if (activeTab === 'perp') {
            filtered = filtered.filter(t => t.symbol.endsWith('_PERP'));
        } else if (activeTab === 'favorites') {
            filtered = filtered.filter(t => favorites.includes(t.symbol));
        }

        // Sort by volume by default (descending)
        filtered.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

        setFilteredTickers(filtered);
    }, [tickers, activeTab, favorites]);

    return (
        <div className="min-h-screen bg-backpack-bg-primary">
            {/* Hero Section */}
            <div className="bg-gradient-to-r from-[#1a1b23] to-[#2a2b35] py-16 px-6">
                <div className="max-w-7xl mx-auto">
                    <h1 className="text-5xl font-bold text-bp-text-primary mb-4">
                        Spot Markets
                    </h1>
                    <p className="text-bp-text-secondary text-lg">
                        Trade your favorite cryptocurrencies with low fees and deep liquidity
                    </p>
                </div>
            </div>

            {/* Market Stats */}
            <div className="max-w-7xl mx-auto px-6 py-8">
                <div className="grid grid-cols-4 gap-6 mb-8">
                    <StatCard 
                        title="24h Volume"
                        value={`$${formatVolume(
                            tickers.reduce((sum, t) => sum + parseFloat(t.quoteVolume), 0).toString()
                        )}`}
                    />
                    <StatCard 
                        title="Markets"
                        value={tickers.length.toString()}
                    />
                    <StatCard 
                        title="Top Gainer"
                        value={(() => {
                            const topGainer = [...tickers].sort((a, b) => 
                                parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent)
                            )[0];
                            return topGainer ? `${topGainer.symbol.split('_')[0]} +${formatPercentage(topGainer.priceChangePercent, false)}` : '-';
                        })()}
                        isPositive
                    />
                    <StatCard 
                        title="Top Loser"
                        value={(() => {
                            const topLoser = [...tickers].sort((a, b) => 
                                parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent)
                            )[0];
                            return topLoser ? `${topLoser.symbol.split('_')[0]} ${formatPercentage(topLoser.priceChangePercent, false)}` : '-';
                        })()}
                        isNegative
                    />
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-8 mb-6 border-b border-backpack-border">
                    <button
                        onClick={() => setActiveTab('spot')}
                        className={cn(
                            "pb-3 text-sm font-medium transition-colors relative",
                            activeTab === 'spot' 
                                ? "text-bp-text-primary" 
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Spot
                        {activeTab === 'spot' && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-bp-blue" />
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('perp')}
                        className={cn(
                            "pb-3 text-sm font-medium transition-colors relative",
                            activeTab === 'perp' 
                                ? "text-bp-text-primary" 
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Perpetuals
                        {activeTab === 'perp' && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-bp-blue" />
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('all')}
                        className={cn(
                            "pb-3 text-sm font-medium transition-colors relative",
                            activeTab === 'all' 
                                ? "text-bp-text-primary" 
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        All Markets
                        {activeTab === 'all' && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-bp-blue" />
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('favorites')}
                        className={cn(
                            "pb-3 text-sm font-medium transition-colors relative flex items-center gap-2",
                            activeTab === 'favorites' 
                                ? "text-bp-text-primary" 
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        <Star className="w-3.5 h-3.5" />
                        Favorites
                        {favorites.length > 0 && (
                            <span className="text-xs bg-backpack-bg-tertiary px-1.5 py-0.5 rounded">
                                {favorites.length}
                            </span>
                        )}
                        {activeTab === 'favorites' && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-bp-blue" />
                        )}
                    </button>
                </div>

                {/* Markets Table */}
                {loading ? (
                    <MarketsTableSkeleton />
                ) : (
                    <div className="bg-backpack-bg-secondary rounded-lg overflow-hidden">
                        <table className="w-full">
                            <thead>
                                <tr className="text-xs text-bp-text-tertiary border-b border-backpack-border">
                                    <th className="text-left py-3 px-4 font-normal"></th>
                                    <th className="text-left py-3 px-4 font-normal">Market</th>
                                    <th className="text-right py-3 px-4 font-normal">Price</th>
                                    <th className="text-right py-3 px-4 font-normal">24h Change</th>
                                    <th className="text-right py-3 px-4 font-normal">24h Volume</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredTickers.map((ticker) => (
                                    <MarketRow
                                        key={ticker.symbol}
                                        ticker={ticker}
                                        isFavorite={isFavorite(ticker.symbol)}
                                        onToggleFavorite={() => toggleFavorite(ticker.symbol)}
                                        onClick={() => router.push(`/trade/${ticker.symbol}`)}
                                    />
                                ))}
                            </tbody>
                        </table>

                        {filteredTickers.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-20">
                                <Star className="w-12 h-12 text-bp-text-tertiary mb-4" />
                                <p className="text-bp-text-secondary text-lg mb-2">No markets found</p>
                                <p className="text-bp-text-tertiary text-sm">
                                    {activeTab === 'favorites' 
                                        ? "You haven't added any favorites yet" 
                                        : "No markets available"}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function StatCard({ 
    title, 
    value, 
    isPositive, 
    isNegative 
}: { 
    title: string; 
    value: string; 
    isPositive?: boolean;
    isNegative?: boolean;
}) {
    return (
        <div className="bg-backpack-bg-secondary rounded-lg p-6">
            <p className="text-bp-text-tertiary text-xs mb-2">{title}</p>
            <p className={cn(
                "text-2xl font-semibold",
                isPositive && "text-bp-green",
                isNegative && "text-bp-red",
                !isPositive && !isNegative && "text-bp-text-primary"
            )}>
                {value}
            </p>
        </div>
    );
}

function MarketRow({ 
    ticker, 
    isFavorite, 
    onToggleFavorite, 
    onClick 
}: { 
    ticker: Ticker;
    isFavorite: boolean;
    onToggleFavorite: () => void;
    onClick: () => void;
}) {
    const priceChange = parseFloat(ticker.priceChangePercent || "0");
    const isPositive = priceChange >= 0;
    const [base, quote] = parseMarketSymbol(ticker.symbol);
    const isPerp = ticker.symbol.endsWith('_PERP');

    return (
        <tr
            onClick={onClick}
            className="border-b border-backpack-border hover:bg-backpack-bg-tertiary cursor-pointer transition-colors group"
        >
            {/* Favorite */}
            <td className="py-4 px-4" onClick={(e) => e.stopPropagation()}>
                <button
                    onClick={onToggleFavorite}
                    className="p-1 hover:bg-backpack-bg-tertiary rounded transition-all"
                >
                    <Star
                        className={cn(
                            "w-4 h-4 transition-all",
                            isFavorite
                                ? "fill-yellow-500 text-yellow-500"
                                : "text-bp-text-tertiary hover:text-yellow-500"
                        )}
                    />
                </button>
            </td>

            {/* Market */}
            <td className="py-4 px-4">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00FFA3] to-[#DC1FFF] flex items-center justify-center">
                        <span className="text-white font-bold text-xs">
                            {base.charAt(0)}
                        </span>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-bp-text-primary font-medium">
                                {base}/{quote}
                            </span>
                            {isPerp && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bp-purple/20 text-bp-purple font-medium">
                                    PERP
                                </span>
                            )}
                        </div>
                        <div className="text-xs text-bp-text-tertiary">
                            {isPerp ? 'Perpetual' : 'Spot'}
                        </div>
                    </div>
                </div>
            </td>

            {/* Price */}
            <td className="text-right py-4 px-4">
                <div className="text-bp-text-primary font-medium tabular-nums">
                    ${formatPrice(ticker.lastPrice, 2)}
                </div>
            </td>

            {/* 24h Change */}
            <td className="text-right py-4 px-4">
                <div className={cn(
                    "font-medium tabular-nums",
                    isPositive ? "text-bp-green" : "text-bp-red"
                )}>
                    {isPositive ? '+' : ''}{formatPercentage(ticker.priceChangePercent, false)}
                </div>
            </td>

            {/* 24h Volume */}
            <td className="text-right py-4 px-4">
                <div className="text-bp-text-secondary tabular-nums">
                    ${formatVolume(ticker.quoteVolume)}
                </div>
            </td>
        </tr>
    );
}

function MarketsTableSkeleton() {
    return (
        <div className="bg-backpack-bg-secondary rounded-lg">
            <div className="animate-pulse">
                {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4 p-4 border-b border-backpack-border">
                        <div className="w-4 h-4 bg-backpack-bg-tertiary rounded" />
                        <div className="w-8 h-8 bg-backpack-bg-tertiary rounded-full" />
                        <div className="flex-1 space-y-2">
                            <div className="w-20 h-4 bg-backpack-bg-tertiary rounded" />
                            <div className="w-16 h-3 bg-backpack-bg-tertiary rounded" />
                        </div>
                        <div className="w-24 h-4 bg-backpack-bg-tertiary rounded" />
                        <div className="w-20 h-4 bg-backpack-bg-tertiary rounded" />
                        <div className="w-28 h-4 bg-backpack-bg-tertiary rounded" />
                    </div>
                ))}
            </div>
        </div>
    );
}