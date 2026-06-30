import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Backend origin for the dev proxy. Override with API_PROXY_TARGET if the
// FastAPI server (api.py) runs somewhere other than localhost:8000.
const API_TARGET = process.env.API_PROXY_TARGET || "http://localhost:8000";

// Route prefixes owned by api.py — proxied in dev so the frontend can call
// relative paths (VITE_API_BASE_URL empty) without hitting CORS.
const API_PREFIXES = ["/uploads", "/sessions", "/knowledge-base", "/health"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: API_TARGET, changeOrigin: true }])
    ),
  },
});
