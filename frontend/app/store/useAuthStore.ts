"use client";

import { create } from "zustand";
import {
  loginUser,
  registerUser,
  logoutUser,
  refreshAccessToken,
  getCurrentUser,
  verifyEmailOTP,
  resendOTP,
  forgotPassword,
  resetPassword,
  type AuthUser,
} from "../utils/httpClient";

/* ═══════════════════════════════════════════════════════════════
   Auth Store — Zustand global auth state
   ═══════════════════════════════════════════════════════════════ */

type AuthState = {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isModalOpen: boolean;
  // OTP flow state
  pendingVerificationEmail: string | null;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<{ requiresVerification: boolean }>;
  verifyOTP: (email: string, otp: string) => Promise<void>;
  resendVerificationOTP: (email: string) => Promise<void>;
  sendForgotPassword: (email: string) => Promise<void>;
  submitResetPassword: (email: string, otp: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  tryRefresh: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
  setUser: (user: AuthUser | null) => void;
  setPendingVerificationEmail: (email: string | null) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isModalOpen: false,
  pendingVerificationEmail: null,

  login: async (email: string, password: string) => {
    const payload = await loginUser(email, password);
    set({
      user: payload.user,
      isAuthenticated: true,
      isModalOpen: false,
      pendingVerificationEmail: null,
    });
  },

  register: async (email: string, password: string) => {
    const payload = await registerUser(email, password);
    if (payload.requiresVerification) {
      set({ pendingVerificationEmail: email });
      return { requiresVerification: true };
    }
    set({ user: payload.user, isAuthenticated: true, isModalOpen: false });
    return { requiresVerification: false };
  },

  verifyOTP: async (email: string, otp: string) => {
    const payload = await verifyEmailOTP(email, otp);
    set({
      user: payload.user,
      isAuthenticated: true,
      isModalOpen: false,
      pendingVerificationEmail: null,
    });
  },

  resendVerificationOTP: async (email: string) => {
    await resendOTP(email);
  },

  sendForgotPassword: async (email: string) => {
    await forgotPassword(email);
  },

  submitResetPassword: async (email: string, otp: string, newPassword: string) => {
    await resetPassword(email, otp, newPassword);
  },

  logout: async () => {
    await logoutUser();
    set({
      user: null,
      isAuthenticated: false,
    });
  },

  tryRefresh: async () => {
    set({ isLoading: true });
    try {
      await refreshAccessToken();
      const user = await getCurrentUser();
      set({
        user,
        isAuthenticated: !!user,
        isLoading: false,
      });
    } catch {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false, pendingVerificationEmail: null }),
  setUser: (user) => set({ user, isAuthenticated: !!user }),
  setPendingVerificationEmail: (email) => set({ pendingVerificationEmail: email }),
}));
