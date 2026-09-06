import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite + React setup. The dev server proxies /api and /ws to the
// backend's API server (port 8080) so the browser never has to worry about
// CORS during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
