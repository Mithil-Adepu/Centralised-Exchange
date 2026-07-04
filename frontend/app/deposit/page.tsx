"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBalances, createRazorpayOrder, verifyRazorpayPayment } from "../utils/httpClient";
import { useAuthStore } from "../store/useAuthStore";
import { cn } from "../lib/utils";
import toast from "react-hot-toast";

/* ═══════════════════════════════════════════════════════════════
   Deposit Page (/deposit) — Add funds via Razorpay
   Dedicated page (split out of Wallet), Backpack-styled.
   ═══════════════════════════════════════════════════════════════ */

declare global {
  interface Window {
    Razorpay: any;
  }
}

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 50000;
const QUICK_ADDS = [1000, 5000, 10000];

export default function DepositPage() {
  const { isAuthenticated, isLoading, user } = useAuthStore();
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      getBalances()
        .then((r) => setUsdcBalance(r.balances?.USDC?.available ?? 0))
        .catch(() => {});
    }
  }, [isLoading, isAuthenticated]);

  const loadRazorpayScript = () =>
    new Promise((resolve) => {
      if (window.Razorpay) return resolve(true);
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });

  const handleDeposit = async () => {
    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount < MIN_AMOUNT) {
      toast.error(`Minimum deposit is ₹${MIN_AMOUNT}`);
      return;
    }
    if (numAmount > MAX_AMOUNT) {
      toast.error(`Maximum deposit is ₹${MAX_AMOUNT.toLocaleString()}`);
      return;
    }

    setIsProcessing(true);
    try {
      const isLoaded = await loadRazorpayScript();
      if (!isLoaded) throw new Error("Razorpay SDK failed to load");

      const { orderId, amount: orderAmount } = await createRazorpayOrder(numAmount);
      const razorpayKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!razorpayKey) {
        toast.error("Payments are not configured (missing Razorpay key)");
        setIsProcessing(false);
        return;
      }

      const options = {
        key: razorpayKey,
        amount: orderAmount * 100,
        currency: "INR",
        name: "CEX Exchange",
        description: "Add Funds to Wallet",
        order_id: orderId,
        handler: async (response: any) => {
          try {
            await verifyRazorpayPayment(
              response.razorpay_order_id,
              response.razorpay_payment_id,
              response.razorpay_signature
            );
            toast.success(`Deposited ₹${numAmount.toLocaleString()} successfully`);
            setAmount("");
            router.push("/wallet");
          } catch (err: any) {
            toast.error(err.response?.data?.error || "Payment verification failed");
          }
        },
        prefill: { email: user?.email || "" },
        theme: { color: "#3FD08B" },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (r: any) => toast.error(`Payment failed: ${r.error.description}`));
      rzp.open();
    } catch (error: any) {
      toast.error(error.response?.data?.error || "Failed to initiate payment");
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) return <div className="p-8 text-center text-bp-text-tertiary">Loading...</div>;
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <h2 className="text-xl font-semibold mb-4 text-bp-text-primary">Please log in to deposit funds</h2>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-4 sm:p-6 lg:p-8">
      <BackLink />
      <h1 className="text-2xl font-semibold text-bp-text-primary mb-6">Deposit</h1>

      <div className="bg-bp-bg-secondary border border-bp-border rounded-xl p-6">
        {/* Tabs */}
        <div className="flex items-center gap-6 border-b border-bp-border mb-6">
          <span className="pb-3 text-sm font-medium text-bp-text-primary border-b-2 border-bp-green -mb-px">Add money</span>
          <Link href="/withdraw" className="pb-3 text-sm font-medium text-bp-text-tertiary hover:text-bp-text-secondary transition-colors">Withdraw</Link>
        </div>

        {/* Amount */}
        <div className="text-center mb-5">
          <div className="flex items-center justify-center gap-1">
            <span className="text-2xl text-bp-text-secondary">₹</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-40 bg-transparent text-4xl font-semibold text-bp-text-primary text-center outline-none tabular-nums placeholder-bp-text-disabled"
            />
          </div>
          {usdcBalance !== null && (
            <p className="text-2xs text-bp-text-tertiary mt-2">Current balance: {usdcBalance.toFixed(2)} USDC</p>
          )}
        </div>

        {/* Quick adds */}
        <div className="flex justify-center gap-2 mb-6">
          {QUICK_ADDS.map((v) => (
            <button
              key={v}
              onClick={() => setAmount(String((Number(amount) || 0) + v))}
              className="px-3 py-1.5 text-xs rounded-full border border-bp-border text-bp-text-secondary hover:border-bp-border-active hover:text-bp-text-primary transition-colors"
            >
              +₹{v.toLocaleString()}
            </button>
          ))}
        </div>

        {/* Method */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-bp-bg-tertiary border border-bp-border mb-5">
          <div className="flex items-center gap-2 text-xs text-bp-text-secondary">
            <svg className="w-4 h-4 text-bp-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Pay securely via Razorpay
          </div>
          <span className="text-2xs text-bp-text-tertiary">UPI / Card / Netbanking</span>
        </div>

        <button
          onClick={handleDeposit}
          disabled={isProcessing || !amount}
          className={cn(
            "w-full py-2.5 rounded-md text-sm font-semibold transition-colors flex justify-center items-center gap-2",
            "bg-bp-green hover:bg-bp-green-hover text-bp-text-inverse",
            (isProcessing || !amount) && "opacity-50 cursor-not-allowed"
          )}
        >
          {isProcessing ? "Processing..." : "Add money"}
        </button>
        <p className="text-2xs text-bp-text-tertiary text-center mt-3">Min ₹{MIN_AMOUNT} — Max ₹{MAX_AMOUNT.toLocaleString()}</p>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/wallet" className="inline-flex items-center gap-1 text-xs text-bp-text-tertiary hover:text-bp-text-primary transition-colors mb-4">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Back to Wallet
    </Link>
  );
}
