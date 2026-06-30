/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Brand / severity palette — values live as CSS vars in index.css
        crimson: {
          DEFAULT: "var(--crimson)",
          light: "var(--crimson-light)",
          deep: "var(--crimson-deep)",
        },
        alarm: {
          DEFAULT: "var(--alarm)",
          light: "var(--alarm-light)",
        },
        ember: "var(--ember)",
        gold: "var(--gold)",
        sand: "var(--sand)",
        slate: "var(--slate)",
        void: {
          DEFAULT: "var(--void)",
          2: "var(--void-2)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          dim: "var(--ink-dim)",
          faint: "var(--ink-faint)",
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
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
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
