/**
 * E8 · T8.3 — entrypoint de servicio del replay-service.
 *
 * V1 REPLAYS PR-4 · el servicio ya NO sirve ni ingiere replays: el worker publica S9R/1
 * directamente en el volumen y la API los lee por fragmentos (TD-004: /api/v1/replays). Las
 * rutas antiguas (`/replays*`, `/retention/sweep`) leían y escribían el formato JSONL anterior
 * (corte D-OP-30); su código (server.ts, store.ts, segment.ts, auth.ts) se RETIRÓ en PR-4b.
 * Quedan `/healthz` y `/version`, y el preflight del volumen (el janitor de PR-6 vivirá aquí).
 */
import express from "express";
import { requireWritableDataDir } from "./data-dir.js";
import { mountVersionEndpoint } from "../../../packages/build-info/index.js";

const dir = process.env.REPLAYS_DIR ?? "/data/replays";
const port = Number(process.env.PORT ?? 8083);

// B7 · Preflight ANTES de escuchar: si el volumen de replays no es escribible
// (el caso real de VM108: `arena_replays` root:root y el proceso como `node`),
// el servicio se niega a arrancar en vez de seguir como si nada.
requireWritableDataDir("replay-service", dir);

const app = express();
app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "replay-service", dir }));
// ADR-016 · identidad de build embebida en la imagen, observable en ejecución.
mountVersionEndpoint(app, "replay-service");

// Express 5 pasa a este callback también el ERROR de `listen` (p. ej. EADDRINUSE): sin
// comprobarlo, el proceso anunciaría «escuchando» y saldría con 0 sin servir nada.
app.listen(port, (err?: Error) => {
  if (err) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "replay-service",
        msg: "no se pudo escuchar",
        port,
        reason: err.message,
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      level: "info",
      service: "replay-service",
      msg: `replay-service escuchando en :${port} (sin rutas de replay: las sirve la API)`,
      dir,
    }),
  );
});
