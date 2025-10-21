import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Backpack color palette sampled from production UI
        backpack: {
          "bg-primary": "#04070F",
          "bg-secondary": "#081224",
          "bg-tertiary": "#101B33",
          "bg-card": "#0B1629",
          "border": "#16243B",
          "border-light": "#1E2F4A",
        },
        bp: {
          green: "#0ECB81",
          "green-hover": "#11E890",
          "green-bg": "rgba(14, 203, 129, 0.12)",
          "green-bg-strong": "rgba(14, 203, 129, 0.22)",

          red: "#F6465D",
          "red-hover": "#FF5F74",
          "red-bg": "rgba(246, 70, 93, 0.12)",
          "red-bg-strong": "rgba(246, 70, 93, 0.22)",

          blue: "#2962FF",
          "blue-hover": "#3F73FF",
          "blue-bg": "rgba(41, 98, 255, 0.12)",

          purple: "#7B61FF",
          pink: "#FF1F69",

          "text-primary": "#F4F7FF",
          "text-secondary": "#9AA8C6",
          "text-tertiary": "#637397",
          "text-disabled": "#45516E",
        },
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],  // 10px
        'xs': ['0.6875rem', { lineHeight: '1rem' }],      // 11px
        'sm': ['0.75rem', { lineHeight: '1.125rem' }],    // 12px
        'base': ['0.875rem', { lineHeight: '1.25rem' }],  // 14px
        'lg': ['1rem', { lineHeight: '1.5rem' }],         // 16px
        'xl': ['1.125rem', { lineHeight: '1.75rem' }],    // 18px
        '2xl': ['1.25rem', { lineHeight: '1.875rem' }],   // 20px
        '3xl': ['1.5rem', { lineHeight: '2rem' }],        // 24px
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '128': '32rem',
      },
      borderRadius: {
        'sm': '0.25rem',     // 4px
        'DEFAULT': '0.375rem', // 6px
        'md': '0.5rem',      // 8px
        'lg': '0.625rem',    // 10px
        'xl': '0.75rem',     // 12px
      },
      boxShadow: {
        'sm': '0 1px 2px 0 rgba(0, 0, 0, 0.25)',
        'DEFAULT': '0 2px 8px 0 rgba(0, 0, 0, 0.3)',
        'lg': '0 4px 16px 0 rgba(0, 0, 0, 0.4)',
        'xl': '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
        'glow-green': '0 0 20px rgba(14, 203, 129, 0.3)',
        'glow-red': '0 0 20px rgba(246, 70, 93, 0.3)',
        'glow-blue': '0 0 20px rgba(41, 98, 255, 0.3)',
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'slide-down': 'slideDown 0.2s ease-out',
        'scale-in': 'scaleIn 0.15s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      transitionDuration: {
        '0': '0ms',
        '100': '100ms',
        '150': '150ms',
        '200': '200ms',
        '250': '250ms',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.19, 1, 0.22, 1)',
        'in-expo': 'cubic-bezier(0.95, 0.05, 0.795, 0.035)',
      },
    },
  },
  plugins: [],
};

export default config;