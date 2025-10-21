"use client";

import { MarketBar } from "@/app/components/MarketBar";
import { SwapUI } from "@/app/components/SwapUI";
import { TradeView } from "@/app/components/TradeView";
import { BookTradesTabs } from "@/app/components/BookTradesTabs";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { useMarketStore } from "@/app/store/useMarketStore";

export default function TradePage() {
    const { market } = useParams();
    const { setSelectedMarket } = useMarketStore();
    const marketString = market as string;

    useEffect(() => {
        setSelectedMarket(marketString);
    }, [marketString, setSelectedMarket]);

    return (
        <div className="flex flex-col h-screen bg-backpack-bg-primary">
            {/* Market Bar */}
            <div className="border-b border-backpack-border">
                <MarketBar market={marketString} />
            </div>

            {/* Main Trading Layout */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left: Chart */}
                <div className="flex-1 min-w-0 border-r border-backpack-border bg-backpack-bg-secondary">
                    <TradeView market={marketString} />
                </div>

                {/* Middle: Order Book & Trades */}
                <div className="w-[340px] border-r border-backpack-border bg-backpack-bg-secondary">
                    <BookTradesTabs market={marketString} />
                </div>

                {/* Right: Trading Form */}
                <div className="w-[320px] bg-backpack-bg-secondary">
                    <SwapUI market={marketString} />
                </div>
            </div>
        </div>
    );
}