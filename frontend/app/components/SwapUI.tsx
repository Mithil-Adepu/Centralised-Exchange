"use client";

import { useState, useEffect } from "react";
import { getTicker, createOrder } from "../utils/httpClient";
import { cn } from "../lib/utils";
import toast from "react-hot-toast";

export function SwapUI({ market }: { market: string }) {
    const [activeTab, setActiveTab] = useState<"limit" | "market">("limit");
    const [side, setSide] = useState<"buy" | "sell">("buy");
    const [price, setPrice] = useState("");
    const [quantity, setQuantity] = useState("");
    const [isUsdInput, setIsUsdInput] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Hardcoded userId for demo (no auth system)
    const USER_ID = "1";

    const [base = "SOL", quote = "USD"] = market.split("_");

    useEffect(() => {
        getTicker(market).then((t) => {
            setPrice(t.lastPrice);
        });
    }, [market]);

    const total = price && quantity ? (parseFloat(price) * parseFloat(quantity)).toFixed(2) : "0.00";

    const handleSubmit = async () => {
        // Validation
        if (!price || !quantity) {
            toast.error("Please enter price and quantity");
            return;
        }

        if (parseFloat(price) <= 0 || parseFloat(quantity) <= 0) {
            toast.error("Price and quantity must be positive numbers");
            return;
        }

        setIsSubmitting(true);
        
        try {
            const result = await createOrder(
                market,
                price,
                quantity,
                side,
                USER_ID
            );

            toast.success(`Order placed! ID: ${result.orderId.slice(0, 8)}...`);
            
            // Reset quantity after successful order
            setQuantity("");
            
        } catch (error) {
            console.error("Order error:", error);
            toast.error(error instanceof Error ? error.message : "Failed to place order");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-backpack-border">
                <div className="flex gap-1 bg-backpack-bg-tertiary p-1 rounded-md">
                    <button
                        onClick={() => setActiveTab("limit")}
                        className={cn(
                            "flex-1 py-1.5 text-xs font-medium rounded transition-all",
                            activeTab === "limit"
                                ? "bg-backpack-bg-secondary text-bp-text-primary"
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Limit
                    </button>
                    <button
                        onClick={() => setActiveTab("market")}
                        className={cn(
                            "flex-1 py-1.5 text-xs font-medium rounded transition-all",
                            activeTab === "market"
                                ? "bg-backpack-bg-secondary text-bp-text-primary"
                                : "text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Market
                    </button>
                </div>
            </div>

            <div className="flex-1 p-4 space-y-3">
                {/* Buy/Sell Toggle */}
                <div className="grid grid-cols-2 gap-2">
                    <button
                        onClick={() => setSide("buy")}
                        className={cn(
                            "py-2.5 text-sm font-semibold rounded-md transition-all",
                            side === "buy"
                                ? "bg-bp-green text-white"
                                : "bg-backpack-bg-tertiary text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Buy
                    </button>
                    <button
                        onClick={() => setSide("sell")}
                        className={cn(
                            "py-2.5 text-sm font-semibold rounded-md transition-all",
                            side === "sell"
                                ? "bg-bp-red text-white"
                                : "bg-backpack-bg-tertiary text-bp-text-tertiary hover:text-bp-text-secondary"
                        )}
                    >
                        Sell
                    </button>
                </div>

                {/* Price Input (Limit only) */}
                {activeTab === "limit" && (
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs text-bp-text-tertiary">Price</label>
                            <div className="flex gap-2 text-xs">
                                <button className="text-bp-blue hover:underline">Mid</button>
                                <button className="text-bp-blue hover:underline">BBO</button>
                            </div>
                        </div>
                        <div className="relative">
                            <input
                                type="number"
                                value={price}
                                onChange={(e) => setPrice(e.target.value)}
                                placeholder="0.00"
                                className="w-full bg-backpack-bg-tertiary border border-backpack-border rounded-md px-3 py-2 pr-12 text-sm text-bp-text-primary placeholder-bp-text-tertiary focus:outline-none focus:border-bp-blue transition-colors"
                            />
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-bp-text-tertiary">
                                {quote}
                            </div>
                        </div>
                    </div>
                )}

                {/* Quantity Input */}
                <div>
                    <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-bp-text-tertiary">
                            {activeTab === "market" ? "Quantity" : "Size"}
                        </label>
                        <button 
                            onClick={() => setIsUsdInput(!isUsdInput)}
                            className="text-xs text-bp-blue hover:underline"
                        >
                            {isUsdInput ? base : quote}
                        </button>
                    </div>
                    <div className="relative">
                        <input
                            type="number"
                            value={quantity}
                            onChange={(e) => setQuantity(e.target.value)}
                            placeholder="0.00"
                            className="w-full bg-backpack-bg-tertiary border border-backpack-border rounded-md px-3 py-2 pr-12 text-sm text-bp-text-primary placeholder-bp-text-tertiary focus:outline-none focus:border-bp-blue transition-colors"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-bp-text-tertiary">
                            {isUsdInput ? quote : base}
                        </div>
                    </div>
                </div>

                {/* Percentage Quick Select */}
                <div className="grid grid-cols-4 gap-1">
                    {['25%', '50%', '75%', '100%'].map((percent) => (
                        <button
                            key={percent}
                            className="py-1 text-xs bg-backpack-bg-tertiary text-bp-text-tertiary rounded hover:bg-backpack-border transition-colors"
                        >
                            {percent}
                        </button>
                    ))}
                </div>

                {/* Total */}
                {activeTab === "limit" && (
                    <div className="bg-backpack-bg-tertiary rounded-md p-3">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-bp-text-tertiary">Total</span>
                            <span className="text-bp-text-primary font-medium">${total}</span>
                        </div>
                    </div>
                )}

                {/* Balance */}
                <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                        <span className="text-bp-text-tertiary">{base} Balance</span>
                        <span className="text-bp-text-secondary">-</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-bp-text-tertiary">{quote} Balance</span>
                        <span className="text-bp-text-secondary">-</span>
                    </div>
                </div>

                {/* Advanced Options */}
                <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="w-3.5 h-3.5 rounded border-backpack-border bg-backpack-bg-tertiary"
                        />
                        <span className="text-bp-text-tertiary">Post Only</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="w-3.5 h-3.5 rounded border-backpack-border bg-backpack-bg-tertiary"
                        />
                        <span className="text-bp-text-tertiary">IOC</span>
                    </label>
                </div>

                {/* Submit Button */}
                <button
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className={cn(
                        "w-full py-3 rounded-md font-semibold text-sm transition-all",
                        isSubmitting && "opacity-50 cursor-not-allowed",
                        side === "buy"
                            ? "bg-bp-green hover:bg-bp-green-hover text-white"
                            : "bg-bp-red hover:bg-bp-red-hover text-white"
                    )}
                >
                    {isSubmitting 
                        ? "Submitting..." 
                        : `${side === "buy" ? "Buy" : "Sell"} ${base}`
                    }
                </button>

                {/* Auth Links */}
                <div className="text-center space-y-1">
                    <p className="text-xs text-bp-text-tertiary">
                        New to Backpack?{" "}
                        <button className="text-bp-blue hover:underline">
                            Sign up
                        </button>
                    </p>
                    <p className="text-xs text-bp-text-tertiary">
                        Already have an account?{" "}
                        <button className="text-bp-blue hover:underline">
                            Log in
                        </button>
                    </p>
                </div>
            </div>
        </div>
    );
}