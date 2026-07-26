/**
 * E8 · T8.3 — entrypoint de servicio del replay-service.
 *
 * createReplayServer() ya monta todas las rutas; aquí solo se resuelve el
 * directorio de replays, se añade /healthz (que el contrato de E1 no cubre
 * porque es señal de infraestructura, no API pública) y se escucha.
 */
import express from "express";
import { createReplayServer } from "./server.js";
import { requireWritableDataDir } from "./data-dir.js";

const dir = process.env.REPLAYS_DIR ?? "/data/replays";
const port = Number(process.env.PORT ?? 8083);

// B7 · Preflight ANTES de escuchar: si el volumen de replays no es escribible
// (el caso real de VM108: `arena_replays` root:root y el proceso como `node`),
// el servicio se niega a arrancar en vez de aceptar ingestas y perderlas todas
// con EACCES mientras /healthz sigue diciendo "ok".
requireWritableDataDir("replay-service", dir);

const app = express();
app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "replay-service", dir }));
app.use(createReplayServer({ dir }));

app.listen(port, () => {
  console.log(
    JSON.stringify({ level: "info", service: "replay-service", msg: `replay-service escuchando en :${port}`, dir }),
  );
});
