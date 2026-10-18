/**
 * T7.4 · Panel web (ADR-E7-003: React + Vite).
 * En desarrollo, /api/v1 y /ws se proxyan a sus servicios locales; en
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
      // FC-D · mismas rutas que el gateway: /ws (WebSocket del espectador en el
      // tournament-worker, sin el prefijo /ws). PRC (TD-004): ya no hay /replays;
      // los replays se leen por /api/v1/replays (autorizados por la API).
      "/ws": {
        target: process.env.SPECTATE_URL ?? "http://localhost:8081",
        ws: true,
        rewrite: (path) => path.replace(/^\/ws/, ""),
      },
    },
  },
});
