"use client";

import { useEffect, useState } from "react";
import { getBalances, createRazorpayOrder, verifyRazorpayPayment } from "../utils/httpClient";
import { useAuthStore } from "../store/useAuthStore";
import toast from "react-hot-toast";

// Use standard type for window.Razorpay
declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function WalletPage() {
  const { isAuthenticated, isLoading, user } = useAuthStore();
  const [balances, setBalances] = useState<Record<string, { available: number; locked: number }>>({});
  const [isFetching, setIsFetching] = useState(true);
  const [amount, setAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      fetchBalances();
    }
  }, [isLoading, isAuthenticated]);

  const fetchBalances = async () => {
    try {
      setIsFetching(true);
      const res = await getBalances();
      setBalances(res.balances || {});
    } catch (error) {
      console.error("Failed to fetch balances:", error);
      toast.error("Failed to fetch balances");
    } finally {
      setIsFetching(false);
    }
  };

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      if (window.Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handleAddFunds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    setIsProcessing(true);
    try {
      const isLoaded = await loadRazorpayScript();
      if (!isLoaded) {
        throw new Error("Razorpay SDK failed to load");
      }

      // 1. Create order on backend
      const { orderId, amount: orderAmount } = await createRazorpayOrder(Number(amount));

      // 2. Initialize Razorpay checkout
      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_placeholder",
        amount: orderAmount * 100, // in paise
        currency: "INR",
        name: "Backpack Exchange",
        description: "Add Funds to Wallet",
        order_id: orderId,
        handler: async function (response: any) {
          try {
            // 3. Verify payment on backend
            await verifyRazorpayPayment(
              response.razorpay_order_id,
              response.razorpay_payment_id,
              response.razorpay_signature
            );
            toast.success(`Successfully added ${amount} INR to your wallet`);
            setAmount("");
            fetchBalances(); // Refresh balances
          } catch (err: any) {
            console.error("Payment verification failed", err);
            toast.error(err.response?.data?.error || "Payment verification failed");
          }
        },
        prefill: {
          email: user?.email || "",
        },
        theme: {
          color: "#E8485F",
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", function (response: any) {
        toast.error(`Payment failed: ${response.error.description}`);
      });
      rzp.open();
    } catch (error: any) {
      console.error("Failed to initiate payment:", error);
      toast.error(error.response?.data?.error || "Failed to initiate payment");
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-bp-text-tertiary">Loading...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <h2 className="text-xl font-semibold mb-4 text-bp-text-primary">Please log in to view your wallet</h2>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold text-bp-text-primary">Wallet & Funds</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Balances */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-bp-bg-secondary border border-bp-border rounded-xl p-6 shadow-sm">
            <h2 className="text-lg font-medium text-bp-text-secondary mb-4">Your Assets</h2>
            {isFetching ? (
              <div className="flex justify-center p-8">
                <div className="w-8 h-8 border-2 border-bp-text-tertiary border-t-bp-red rounded-full animate-spin"></div>
              </div>
            ) : Object.keys(balances).length === 0 ? (
              <div className="text-center p-8 text-bp-text-tertiary">
                No assets found in your wallet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-bp-border text-xs text-bp-text-tertiary uppercase tracking-wider">
                      <th className="pb-3 font-medium">Asset</th>
                      <th className="pb-3 font-medium text-right">Available</th>
                      <th className="pb-3 font-medium text-right">In Order</th>
                      <th className="pb-3 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(balances).map(([asset, balance]) => (
                      <tr key={asset} className="border-b border-bp-border/50 hover:bg-bp-bg-tertiary/20 transition-colors">
                        <td className="py-4 flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-bp-bg-tertiary flex items-center justify-center text-xs font-bold text-bp-text-primary">
                            {asset.slice(0, 3)}
                          </div>
                          <span className="font-medium text-bp-text-primary">{asset}</span>
                        </td>
                        <td className="py-4 text-right text-sm text-bp-text-primary">{balance.available.toFixed(2)}</td>
                        <td className="py-4 text-right text-sm text-bp-text-tertiary">{balance.locked.toFixed(2)}</td>
                        <td className="py-4 text-right text-sm font-medium text-bp-text-primary">
                          {(balance.available + balance.locked).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Add Funds */}
        <div className="space-y-6">
          <div className="bg-bp-bg-secondary border border-bp-border rounded-xl p-6 shadow-sm">
            <h2 className="text-lg font-medium text-bp-text-primary mb-1">Add Funds</h2>
            <p className="text-xs text-bp-text-tertiary mb-6">Deposit INR securely via Razorpay</p>

            <form onSubmit={handleAddFunds} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-bp-text-secondary mb-1.5">
                  Amount (INR)
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <span className="text-bp-text-tertiary text-sm">₹</span>
                  </div>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter amount"
                    min="1"
                    className="block w-full pl-8 pr-3 py-2.5 bg-bp-bg-primary border border-bp-border rounded-lg text-bp-text-primary text-sm focus:outline-none focus:border-bp-red transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isProcessing || !amount}
                className="w-full py-2.5 bg-bp-red hover:bg-bp-red-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    Processing...
                  </>
                ) : (
                  "Proceed to Pay"
                )}
              </button>
            </form>
            
            <div className="mt-4 pt-4 border-t border-bp-border flex items-center gap-2 text-xs text-bp-text-tertiary justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
              </svg>
              Secured by Razorpay
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
