"use client";

import { useState, useEffect, useRef } from "react";
import { useAuthStore } from "../store/useAuthStore";
import { cn } from "../lib/utils";

/* ═══════════════════════════════════════════════════════════════
   AuthModal — Login / Register / OTP / Forgot Password
   Screens: login | register | otp | forgot | reset
   ═══════════════════════════════════════════════════════════════ */

type Screen = "login" | "register" | "otp" | "forgot" | "reset";

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    {open ? (
      <>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </>
    ) : (
      <>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
      </>
    )}
  </svg>
);

function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  id: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "••••••••"}
        autoComplete={autoComplete}
        className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 pr-10 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-bp-text-tertiary hover:text-bp-text-primary transition-colors"
        aria-label={show ? "Hide password" : "Show password"}
      >
        <EyeIcon open={show} />
      </button>
    </div>
  );
}

function OTPInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = (value + "      ").slice(0, 6).split("");

  const handleChange = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "").slice(-1);
    const next = digits.map((d, idx) => (idx === i ? clean : d)).join("").trimEnd();
    onChange(next.slice(0, 6));
    if (clean && i < 5) inputs.current[i + 1]?.focus();
  };

  const handleKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[i]?.trim() && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    onChange(pasted);
    inputs.current[Math.min(pasted.length, 5)]?.focus();
  };

  return (
    <div className="flex gap-2 justify-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { inputs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={d.trim()}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          className="w-10 h-12 text-center text-lg font-bold bg-bp-bg-input border border-bp-border rounded-md text-bp-text-primary focus:outline-none focus:border-bp-border-active transition-colors"
        />
      ))}
    </div>
  );
}

export function AuthModal() {
  const { isModalOpen, closeModal, login, register, verifyOTP, resendVerificationOTP, sendForgotPassword, submitResetPassword, pendingVerificationEmail } = useAuthStore();

  const [screen, setScreen] = useState<Screen>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // If store has a pending email (e.g. came from outside modal), jump to OTP screen
  useEffect(() => {
    if (pendingVerificationEmail && isModalOpen) {
      setEmail(pendingVerificationEmail);
      setScreen("otp");
    }
  }, [pendingVerificationEmail, isModalOpen]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  if (!isModalOpen) return null;

  const reset = () => {
    setEmail(""); setPassword(""); setConfirmPassword("");
    setOtp(""); setNewPassword(""); setConfirmNewPassword("");
    setError(""); setInfo("");
  };

  const goTo = (s: Screen) => { reset(); setScreen(s); };

  /* ─── Login ─── */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) { setError("Email and password are required"); return; }
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Login failed");
    } finally { setLoading(false); }
  };

  /* ─── Register ─── */
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) { setError("Email and password are required"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (!/[a-zA-Z]/.test(password)) { setError("Password must contain at least one letter"); return; }
    if (!/[0-9]/.test(password)) { setError("Password must contain at least one number"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      const result = await register(email.trim(), password);
      if (result.requiresVerification) {
        setScreen("otp");
        setInfo(`A 6-digit code was sent to ${email.trim()}`);
        setResendCooldown(60);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Registration failed");
    } finally { setLoading(false); }
  };

  /* ─── Verify OTP ─── */
  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (otp.length < 6) { setError("Enter the 6-digit code"); return; }
    setLoading(true);
    try {
      await verifyOTP(email, otp);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Verification failed");
      setOtp("");
    } finally { setLoading(false); }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setError(""); setInfo("");
    try {
      await resendVerificationOTP(email);
      setInfo("New code sent!");
      setResendCooldown(60);
    } catch (err: any) {
      setError("Failed to resend code");
    }
  };

  /* ─── Forgot Password ─── */
  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setInfo("");
    if (!email.trim()) { setError("Email is required"); return; }
    setLoading(true);
    try {
      await sendForgotPassword(email.trim());
      setScreen("reset");
      setInfo(`Reset code sent to ${email.trim()}`);
      setResendCooldown(60);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Failed to send reset code");
    } finally { setLoading(false); }
  };

  /* ─── Reset Password ─── */
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (otp.length < 6) { setError("Enter the 6-digit reset code"); return; }
    if (newPassword.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (newPassword !== confirmNewPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      await submitResetPassword(email, otp, newPassword);
      setInfo("Password reset! You can now log in.");
      setTimeout(() => goTo("login"), 1500);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Reset failed");
    } finally { setLoading(false); }
  };

  const screenTitle: Record<Screen, string> = {
    login: "Log In",
    register: "Sign Up",
    otp: "Verify Email",
    forgot: "Forgot Password",
    reset: "Reset Password",
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={closeModal}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm mx-4 bg-bp-bg-secondary border border-bp-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={closeModal}
          className="absolute top-3 right-3 p-1 text-bp-text-tertiary hover:text-bp-text-primary transition-colors z-10"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Tab bar — only for login/register */}
        {(screen === "login" || screen === "register") && (
          <div className="flex border-b border-bp-border">
            {(["login", "register"] as Screen[]).map((s) => (
              <button
                key={s}
                onClick={() => goTo(s)}
                className={cn(
                  "flex-1 py-3.5 text-sm font-medium transition-colors relative",
                  screen === s ? "text-bp-text-primary" : "text-bp-text-tertiary hover:text-bp-text-secondary"
                )}
              >
                {s === "login" ? "Log In" : "Sign Up"}
                {screen === s && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-[2px] bg-bp-text-primary rounded-full" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Header for non-tab screens */}
        {screen !== "login" && screen !== "register" && (
          <div className="flex items-center gap-2 px-5 pt-5 pb-2">
            <button
              onClick={() => goTo(screen === "otp" ? "register" : screen === "reset" ? "forgot" : "login")}
              className="text-bp-text-tertiary hover:text-bp-text-primary transition-colors"
              aria-label="Go back"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-sm font-semibold text-bp-text-primary">{screenTitle[screen]}</h2>
          </div>
        )}

        {/* ── LOGIN ── */}
        {screen === "login" && (
          <form onSubmit={handleLogin} className="p-5 space-y-4">
            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md">{error}</div>}
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Email</label>
              <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
                className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors" />
            </div>
            <div>
              <div className="flex justify-between mb-1.5">
                <label className="text-xs text-bp-text-tertiary">Password</label>
                <button type="button" onClick={() => { setEmail(email); goTo("forgot"); }} className="text-xs text-bp-text-tertiary hover:text-bp-text-primary transition-colors">
                  Forgot password?
                </button>
              </div>
              <PasswordInput id="login-password" value={password} onChange={setPassword} autoComplete="current-password" />
            </div>
            <button type="submit" disabled={loading}
              className={cn("w-full py-2.5 rounded-md text-sm font-semibold transition-all bg-bp-text-primary text-bp-text-inverse hover:opacity-90", loading && "opacity-50 cursor-not-allowed")}>
              {loading ? "Logging in..." : "Log In"}
            </button>
            <p className="text-center text-xs text-bp-text-tertiary">
              Don&apos;t have an account?{" "}
              <button type="button" onClick={() => goTo("register")} className="text-bp-text-primary hover:underline font-medium">Sign up</button>
            </p>
          </form>
        )}

        {/* ── REGISTER ── */}
        {screen === "register" && (
          <form onSubmit={handleRegister} className="p-5 space-y-4">
            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md">{error}</div>}
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Email</label>
              <input id="register-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
                className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors" />
            </div>
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Password</label>
              <PasswordInput id="register-password" value={password} onChange={setPassword} placeholder="Min 8 chars, 1 letter, 1 number" autoComplete="new-password" />
            </div>
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Confirm Password</label>
              <PasswordInput id="register-confirm-password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
            </div>
            <button type="submit" disabled={loading}
              className={cn("w-full py-2.5 rounded-md text-sm font-semibold transition-all bg-bp-text-primary text-bp-text-inverse hover:opacity-90", loading && "opacity-50 cursor-not-allowed")}>
              {loading ? "Creating account..." : "Create Account"}
            </button>
            <p className="text-center text-xs text-bp-text-tertiary">
              Already have an account?{" "}
              <button type="button" onClick={() => goTo("login")} className="text-bp-text-primary hover:underline font-medium">Log in</button>
            </p>
          </form>
        )}

        {/* ── OTP VERIFY ── */}
        {screen === "otp" && (
          <form onSubmit={handleVerifyOTP} className="p-5 space-y-5">
            {info && <div className="px-3 py-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-md">{info}</div>}
            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md">{error}</div>}
            <p className="text-xs text-bp-text-tertiary text-center">Enter the 6-digit code sent to<br /><span className="text-bp-text-primary font-medium">{email}</span></p>
            <OTPInput value={otp} onChange={setOtp} />
            <button type="submit" disabled={loading || otp.length < 6}
              className={cn("w-full py-2.5 rounded-md text-sm font-semibold transition-all bg-bp-text-primary text-bp-text-inverse hover:opacity-90", (loading || otp.length < 6) && "opacity-50 cursor-not-allowed")}>
              {loading ? "Verifying..." : "Verify Email"}
            </button>
            <p className="text-center text-xs text-bp-text-tertiary">
              Didn&apos;t receive it?{" "}
              <button type="button" onClick={handleResend} disabled={resendCooldown > 0}
                className={cn("text-bp-text-primary font-medium", resendCooldown > 0 ? "opacity-40 cursor-not-allowed" : "hover:underline")}>
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
              </button>
            </p>
          </form>
        )}

        {/* ── FORGOT PASSWORD ── */}
        {screen === "forgot" && (
          <form onSubmit={handleForgotPassword} className="p-5 space-y-4">
            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md">{error}</div>}
            <p className="text-xs text-bp-text-tertiary">Enter your email and we&apos;ll send a reset code.</p>
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Email</label>
              <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
                className="w-full bg-bp-bg-input border border-bp-border rounded-md px-3 py-2.5 text-sm text-bp-text-primary placeholder-bp-text-disabled focus:outline-none focus:border-bp-border-active transition-colors" />
            </div>
            <button type="submit" disabled={loading}
              className={cn("w-full py-2.5 rounded-md text-sm font-semibold transition-all bg-bp-text-primary text-bp-text-inverse hover:opacity-90", loading && "opacity-50 cursor-not-allowed")}>
              {loading ? "Sending..." : "Send Reset Code"}
            </button>
            <p className="text-center text-xs text-bp-text-tertiary">
              Remember it?{" "}
              <button type="button" onClick={() => goTo("login")} className="text-bp-text-primary hover:underline font-medium">Back to login</button>
            </p>
          </form>
        )}

        {/* ── RESET PASSWORD ── */}
        {screen === "reset" && (
          <form onSubmit={handleResetPassword} className="p-5 space-y-4">
            {info && <div className="px-3 py-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-md">{info}</div>}
            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md">{error}</div>}
            <p className="text-xs text-bp-text-tertiary text-center">Enter the code sent to<br /><span className="text-bp-text-primary font-medium">{email}</span></p>
            <OTPInput value={otp} onChange={setOtp} />
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">New Password</label>
              <PasswordInput id="reset-new-password" value={newPassword} onChange={setNewPassword} placeholder="Min 8 chars, 1 letter, 1 number" autoComplete="new-password" />
            </div>
            <div>
              <label className="block text-xs text-bp-text-tertiary mb-1.5">Confirm New Password</label>
              <PasswordInput id="reset-confirm-password" value={confirmNewPassword} onChange={setConfirmNewPassword} autoComplete="new-password" />
            </div>
            <button type="submit" disabled={loading || otp.length < 6}
              className={cn("w-full py-2.5 rounded-md text-sm font-semibold transition-all bg-bp-text-primary text-bp-text-inverse hover:opacity-90", (loading || otp.length < 6) && "opacity-50 cursor-not-allowed")}>
              {loading ? "Resetting..." : "Reset Password"}
            </button>
            <p className="text-center text-xs text-bp-text-tertiary">
              Didn&apos;t receive it?{" "}
              <button type="button" onClick={() => goTo("forgot")} className="text-bp-text-primary hover:underline font-medium">Resend code</button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
