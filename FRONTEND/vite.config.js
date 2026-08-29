import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Backend API server port — api.py runs on 8080 to avoid conflict with the
// LLM server (llama.cpp) which occupies port 8000.
const API_TARGET = process.env.API_PROXY_TARGET || "http://localhost:8080";

const API_PREFIXES = ["/auth", "/uploads", "/sessions", "/knowledge-base", "/health"];

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
