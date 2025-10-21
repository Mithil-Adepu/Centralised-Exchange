"use client";

import { useEffect, useState } from "react";
import { getDepth, getTicker } from "../../utils/httpClient";
import { BidTable } from "./BidTable";
import { AskTable } from "./AskTable";
import { SignalingManager } from "@/app/utils/SignalingManager";
import { formatPrice } from "@/app/lib/utils";
import { ArrowUp, ArrowDown } from "lucide-react";

export function Depth({ market }: { market: string }) {
    const [bids, setBids] = useState<[string, string][]>([]);
    const [asks, setAsks] = useState<[string, string][]>([]);
    const [price, setPrice] = useState<string>('0');
    const [previousPrice, setPreviousPrice] = useState<string>('0');
    const [loading, setLoading] = useState(true);

    const [_, quote] = market.split('_');

    useEffect(() => {
        setLoading(true);
        const fetchInitialData = async () => {
            try {
                const [depthData, tickerData] = await Promise.all([
                    getDepth(market),
                    getTicker(market)
                ]);
                setBids(depthData.bids.reverse());
                setAsks(depthData.asks);
                setPrice(tickerData.lastPrice);
                setPreviousPrice(tickerData.lastPrice);
            } catch (error) {
                console.error("Failed to fetch initial depth data:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchInitialData();

        const depthCallbackId = `DEPTH-${market}`;
        SignalingManager.getInstance().registerCallback("depth", (data: any) => {
            console.log('📨 Depth callback received:', data);
            setBids((originalBids) => {
                const bidsAfterUpdate = [...(originalBids || [])];
                data.b.forEach(([price, quantity]: [string, string]) => {
                    const existingIndex = bidsAfterUpdate.findIndex(bid => bid[0] === price);
                    if (parseFloat(quantity) === 0) {
                        if (existingIndex !== -1) {
                            bidsAfterUpdate.splice(existingIndex, 1);
                        }
                    } else {
                        if (existingIndex !== -1 && bidsAfterUpdate[existingIndex]) {
                            bidsAfterUpdate[existingIndex]![1] = quantity;
                        } else {
                            bidsAfterUpdate.push([price, quantity]);
                        }
                    }
                });
                return bidsAfterUpdate.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 15);
            });

            setAsks((originalAsks) => {
                const asksAfterUpdate = [...(originalAsks || [])];
                data.a.forEach(([price, quantity]: [string, string]) => {
                    const existingIndex = asksAfterUpdate.findIndex(ask => ask[0] === price);
                    if (parseFloat(quantity) === 0) {
                        if (existingIndex !== -1) {
                            asksAfterUpdate.splice(existingIndex, 1);
                        }
                    } else {
                        if (existingIndex !== -1 && asksAfterUpdate[existingIndex]) {
                            asksAfterUpdate[existingIndex]![1] = quantity;
                        } else {
                            asksAfterUpdate.push([price, quantity]);
                        }
                    }
                });
                return asksAfterUpdate.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, 15);
            });
        }, depthCallbackId);

        const tickerCallbackId = `TICKER-DEPTH-${market}`;
        SignalingManager.getInstance().registerCallback("ticker", (data: any) => {
            console.log('📨 Ticker callback received:', data);
            if (data.lastPrice) {
                setPreviousPrice(price);
                setPrice(data.lastPrice);
            }
        }, tickerCallbackId);

        SignalingManager.getInstance().sendMessage({ method: "SUBSCRIBE", params: [`depth.${market}`] });
        SignalingManager.getInstance().sendMessage({ method: "SUBSCRIBE", params: [`ticker.${market}`] });

        return () => {
            SignalingManager.getInstance().sendMessage({ method: "UNSUBSCRIBE", params: [`depth.${market}`] });
            SignalingManager.getInstance().sendMessage({ method: "UNSUBSCRIBE", params: [`ticker.${market}`] });
            SignalingManager.getInstance().deRegisterCallback("depth", depthCallbackId);
            SignalingManager.getInstance().deRegisterCallback("ticker", tickerCallbackId);
        };
    }, [market]);

    if (loading) {
        return <DepthSkeleton />;
    }

    const priceUp = parseFloat(price) > parseFloat(previousPrice);

    return (
        <div className="flex flex-col h-full">
            {/* Column Headers */}
            <div className="grid grid-cols-3 px-4 py-2 text-[11px] text-bp-text-tertiary border-b border-backpack-border">
                <div>Price ({quote})</div>
                <div className="text-right">Size</div>
                <div className="text-right">Total</div>
            </div>

            {/* Order Book */}
            <div className="flex-1 flex flex-col">
                {/* Asks - reversed order */}
                <div className="flex-1 flex flex-col justify-end">
                    <AskTable asks={asks.slice().reverse().slice(0, 7)} />
                </div>

                {/* Current Price */}
                <div className="px-4 py-3 bg-backpack-bg-primary border-y border-backpack-border">
                    <div className="flex items-center justify-center gap-2">
                        <span className={`text-xl font-semibold tabular-nums ${priceUp ? 'text-bp-green' : 'text-bp-red'}`}>
                            {formatPrice(price, 2)}
                        </span>
                        {priceUp ? (
                            <ArrowUp className="w-3.5 h-3.5 text-bp-green" />
                        ) : (
                            <ArrowDown className="w-3.5 h-3.5 text-bp-red" />
                        )}
                    </div>
                </div>

                {/* Bids */}
                <div className="flex-1">
                    <BidTable bids={bids.slice(0, 7)} />
                </div>
            </div>
        </div>
    );
}

function DepthSkeleton() {
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
                {Array.from({ length: 15 }).map((_, i) => (
                    <div key={i} className="grid grid-cols-3 gap-2">
                        <div className="w-16 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                        <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                        <div className="w-12 h-3 bg-backpack-bg-tertiary rounded animate-pulse" />
                    </div>
                ))}
            </div>
        </div>
    );
}