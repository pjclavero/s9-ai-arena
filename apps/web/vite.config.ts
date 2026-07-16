/**
 * T7.4 · Panel web (ADR-E7-003: React + Vite).
 * En desarrollo, /api y /replay-service se proxyan a sus servicios locales; en
 * producción todo va tras el gateway (cap. 6.2) bajo el mismo origen.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/v1": {
        target: process.env.API_URL ?? "http://localhost:8080",
        rewrite: (path) => path.replace(/^\/api\/v1/, ""),
      },
      "/replay-service": {
        target: process.env.REPLAY_SERVICE_URL ?? "http://localhost:8082",
        rewrite: (path) => path.replace(/^\/replay-service/, ""),
      },
    },
  },
});
