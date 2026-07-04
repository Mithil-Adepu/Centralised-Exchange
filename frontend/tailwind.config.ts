import type { Config } from "tailwindcss";

/**
 * Tailwind Configuration — Backpack Exchange Design System
 *
 * Color tokens are organized into semantic groups:
 *   bp-bg-*     → Background colors
 *   bp-text-*   → Text colors  
 *   bp-border-* → Border colors
 *   bp-green/red/blue → Accent colors
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Tokens reference CSS variables (defined in globals.css) so a single
           [data-theme] switch re-themes EVERY bp-* styled element. Hardcoding
           hex here (the previous approach) meant theme toggling only affected
           raw var() elements like <body>, leaving components stuck in dark. */

        /* ─── Backgrounds ─── */
        "bp-bg": {
          primary:   "var(--bg-primary)",
          secondary: "var(--bg-secondary)",
          tertiary:  "var(--bg-tertiary)",
          card:      "var(--bg-card)",
          hover:     "var(--bg-hover)",
          active:    "var(--bg-active)",
          input:     "var(--bg-input)",
        },

        /* ─── Borders ─── */
        "bp-border": {
          DEFAULT:   "var(--border)",
          light:     "var(--border-light)",
          active:    "var(--border-active)",
        },

        /* ─── Text ─── */
        "bp-text": {
          primary:   "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary:  "var(--text-tertiary)",
          disabled:  "var(--text-disabled)",
          inverse:   "var(--text-inverse)",
        },

        /* ─── Green (Buy) ─── */
        "bp-green": {
          DEFAULT:   "var(--green)",
          hover:     "var(--green-hover)",
          bg:        "var(--green-bg)",
          "bg-strong": "var(--green-bg-strong)",
        },

        /* ─── Red (Sell) ─── */
        "bp-red": {
          DEFAULT:   "var(--red)",
          hover:     "var(--red-hover)",
          bg:        "var(--red-bg)",
          "bg-strong": "var(--red-bg-strong)",
        },

        /* ─── Blue (Accent) ─── */
        "bp-blue": {
          DEFAULT:   "var(--blue)",
          hover:     "var(--blue-hover)",
          bg:        "var(--blue-bg)",
        },

        /* ─── Other Accents ─── */
        "bp-purple":  "var(--purple)",
        "bp-yellow":  "var(--yellow)",
        "bp-orange":  "var(--orange)",
      },

      /* ─── Typography ─── */
      fontSize: {
        "2xs":  ["0.625rem",  { lineHeight: "0.875rem" }],   // 10px
        "xs":   ["0.6875rem", { lineHeight: "1rem" }],       // 11px
        "sm":   ["0.75rem",   { lineHeight: "1.125rem" }],   // 12px
        "base": ["0.8125rem", { lineHeight: "1.25rem" }],    // 13px
        "md":   ["0.875rem",  { lineHeight: "1.25rem" }],    // 14px
        "lg":   ["1rem",      { lineHeight: "1.5rem" }],     // 16px
        "xl":   ["1.125rem",  { lineHeight: "1.75rem" }],    // 18px
        "2xl":  ["1.25rem",   { lineHeight: "1.875rem" }],   // 20px
        "3xl":  ["1.5rem",    { lineHeight: "2rem" }],       // 24px
      },

      /* ─── Spacing ─── */
      spacing: {
        "18":  "4.5rem",
        "88":  "22rem",
        "128": "32rem",
      },

      /* ─── Border Radius ─── */
      borderRadius: {
        "sm":      "0.25rem",     // 4px
        "DEFAULT": "0.375rem",    // 6px
        "md":      "0.5rem",      // 8px
        "lg":      "0.625rem",    // 10px
        "xl":      "0.75rem",     // 12px
      },

      /* ─── Shadows ─── */
      boxShadow: {
        "sm":         "0 1px 2px 0 rgba(0, 0, 0, 0.25)",
        "DEFAULT":    "0 2px 8px 0 rgba(0, 0, 0, 0.3)",
        "lg":         "0 4px 16px 0 rgba(0, 0, 0, 0.4)",
        "xl":         "0 8px 32px 0 rgba(0, 0, 0, 0.5)",
        "glow-green": "0 0 16px rgba(14, 203, 129, 0.25)",
        "glow-red":   "0 0 16px rgba(246, 70, 93, 0.25)",
        "glow-blue":  "0 0 16px rgba(41, 98, 255, 0.25)",
      },

      /* ─── Animations ─── */
      animation: {
        "fade-in":    "fadeIn 0.15s ease-out",
        "slide-up":   "slideUp 0.2s ease-out",
        "slide-down": "slideDown 0.2s ease-out",
        "scale-in":   "scaleIn 0.15s ease-out",
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%":   { transform: "translateY(4px)", opacity: "0" },
          "100%": { transform: "translateY(0)",   opacity: "1" },
        },
        slideDown: {
          "0%":   { transform: "translateY(-4px)", opacity: "0" },
          "100%": { transform: "translateY(0)",    opacity: "1" },
        },
        scaleIn: {
          "0%":   { transform: "scale(0.95)", opacity: "0" },
          "100%": { transform: "scale(1)",    opacity: "1" },
        },
      },

      /* ─── Transitions ─── */
      transitionDuration: {
        "0":   "0ms",
        "100": "100ms",
        "150": "150ms",
        "200": "200ms",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.19, 1, 0.22, 1)",
        "in-expo":  "cubic-bezier(0.95, 0.05, 0.795, 0.035)",
      },
    },
  },
  plugins: [],
};

export default config;