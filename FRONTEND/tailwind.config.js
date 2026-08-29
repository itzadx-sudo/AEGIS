/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Brand / severity palette — solid values live as hex CSS vars in index.css; the
        // `rgb(var(--x-rgb) / <alpha-value>)` form here is what lets Tailwind fill in an alpha
        // channel for a `/NN` opacity modifier (e.g. `bg-alarm/10`). Pointing straight at the hex
        // var (`var(--alarm)`) can't take a modifier — Tailwind has no channel to inject an alpha
        // into inside a hex string — so every existing `/NN` usage on these tokens silently
        // produced no CSS rule at all until the `-rgb` triplets were added alongside the hex vars.
        crimson: {
          DEFAULT: "rgb(var(--crimson-rgb) / <alpha-value>)",
          light: "rgb(var(--crimson-light-rgb) / <alpha-value>)",
          deep: "rgb(var(--crimson-deep-rgb) / <alpha-value>)",
        },
        alarm: {
          DEFAULT: "rgb(var(--alarm-rgb) / <alpha-value>)",
          light: "rgb(var(--alarm-light-rgb) / <alpha-value>)",
        },
        ember: "rgb(var(--ember-rgb) / <alpha-value>)",
        gold: "rgb(var(--gold-rgb) / <alpha-value>)",
        sand: "rgb(var(--sand-rgb) / <alpha-value>)",
        slate: "rgb(var(--slate-rgb) / <alpha-value>)",
        void: {
          DEFAULT: "rgb(var(--void-rgb) / <alpha-value>)",
          2: "rgb(var(--void-2-rgb) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--surface-rgb) / <alpha-value>)",
          2: "rgb(var(--surface-2-rgb) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink-rgb) / <alpha-value>)",
          dim: "rgb(var(--ink-dim-rgb) / <alpha-value>)",
          faint: "rgb(var(--ink-faint-rgb) / <alpha-value>)",
        },
        // shadcn/ui tokens
        border: "var(--line)",
        input: "var(--line)",
        ring: "var(--crimson)",
        background: "var(--void)",
        foreground: "var(--ink)",
        primary: {
          DEFAULT: "var(--crimson)",
          foreground: "#ffffff",
        },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink-dim)",
        },
        muted: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink-faint)",
        },
        accent: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        destructive: {
          DEFAULT: "var(--alarm)",
          foreground: "#ffffff",
        },
      },
      borderColor: {
        strong: "var(--line-strong)",
      },
      fontFamily: {
        sans: ["Archivo", "system-ui", "sans-serif"],
        serif: ["Archivo", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)",
      },
      keyframes: {
        navSweep: {
          "0%": { backgroundPosition: "0% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        ping2: {
          "0%": { transform: "scale(0.85)", opacity: "0.9" },
          "80%": { transform: "scale(1.55)", opacity: "0" },
          "100%": { opacity: "0" },
        },
        spin: {
          to: { transform: "rotate(360deg)" },
        },
        pageIn: {
          // opacity only — a transform here warps the backdrop-filter glass panels mid-transition
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        navSweep: "navSweep 7s linear infinite",
        ping2: "ping2 2.6s cubic-bezier(.4,0,.3,1) infinite",
        spin: "spin 6s linear infinite",
        pageIn: "pageIn 0.45s ease",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
