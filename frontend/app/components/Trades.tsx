"use client";

import { useEffect, useState } from "react";
import { SignalingManager } from "../utils/SignalingManager";
import { Trade } from "../utils/types";
import { getTrades } from "../utils/httpClient";
import { formatPrice, formatTime, cn } from "../lib/utils";

export function Trades({ market }: { market: string }) {
    const [trades, setTrades] = useState<Trade[]>([]);
    const [loading, setLoading] = useState(true);
    const [base = "SOL", quote = "USD"] = market.split("_");

    useEffect(() => {
        setLoading(true);
        getTrades(market).then((initialTrades) => {
            setTrades(initialTrades.slice(0, 50));
            setLoading(false);
        });

        const tradeCallbackId = `TRADES-${market}`;
        SignalingManager.getInstance().registerCallback("trade", (newTrade: Trade) => {
            setTrades((prevTrades) => {
                const updatedTrades = [newTrade, ...prevTrades];
                return updatedTrades.slice(0, 50);
            });
        }, tradeCallbackId);

        SignalingManager.getInstance().sendMessage({
            method: "SUBSCRIBE",
            params: [`trade.${market}`],
        });

        return () => {
            SignalingManager.getInstance().deRegisterCallback("trade", tradeCallbackId);
            SignalingManager.getInstance().sendMessage({
                method: "UNSUBSCRIBE",
                params: [`trade.${market}`],
            });
        };
    }, [market]);

    if (loading) {
        return <TradesSkeleton />;
    }

    return (
        <div className="flex flex-col h-full">
            {/* Column Headers */}
            <div className="grid grid-cols-3 px-4 py-2 text-[11px] text-bp-text-tertiary border-b border-backpack-border">
                <div>Price ({quote})</div>
                <div className="text-right">Size ({base})</div>
                <div className="text-right">Time</div>
            </div>

            {/* Trades List */}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                {trades.map((trade, index) => (
                    <TradeRow key={`${trade.id}-${index}`} trade={trade} />
                ))}
            </div>
        </div>
    );
}

function TradeRow({ trade }: { trade: Trade }) {
    const isBuy = !trade.isBuyerMaker;

    return (
        <div className="grid grid-cols-3 px-4 py-[5px] text-xs hover:bg-backpack-bg-tertiary transition-colors">
            <div className={cn(
                "tabular-nums",
                isBuy ? "text-bp-green" : "text-bp-red"
            )}>
                {formatPrice(trade.price, 2)}
            </div>
            <div className="text-right text-bp-text-secondary tabular-nums">
                {parseFloat(trade.quantity).toFixed(4)}
            </div>
            <div className="text-right text-bp-text-tertiary tabular-nums">
                {formatTime(trade.timestamp, 'time')}
            </div>
        </div>
    );
}

function TradesSkeleton() {
    return (
        <div className="flex flex-col h-full">
            <div className="px-4 py-2 border-b border-backpack-border">
                <div className="grid grid-cols-3 gap-2">
                    <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                    <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                    <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                </div>
            </div>
            <div className="flex-1 p-4 space-y-1.5">
                {Array.from({ length: 20 }).map((_, i) => (
                    <div key={i} className="grid grid-cols-3 gap-2">
                        <div className="w-16 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                        <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse ml-auto" />
                        <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse ml-auto" />
                    </div>
                ))}
            </div>
        </div>
    );
}