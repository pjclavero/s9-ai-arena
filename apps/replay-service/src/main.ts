/**
 * E8 · T8.3 — entrypoint de servicio del replay-service.
 *
 * createReplayServer() ya monta todas las rutas; aquí solo se resuelve el
 * directorio de replays, se añade /healthz (que el contrato de E1 no cubre
 * porque es señal de infraestructura, no API pública) y se escucha.
 */
import express from "express";
import { createReplayServer } from "./server.js";
import { resolveIngestSecretFromEnv } from "./auth.js";
import { requireWritableDataDir } from "./data-dir.js";
import { mountVersionEndpoint } from "../../../packages/build-info/index.js";

const dir = process.env.REPLAYS_DIR ?? "/data/replays";
const port = Number(process.env.PORT ?? 8083);

// B7 · Preflight ANTES de escuchar: si el volumen de replays no es escribible
// (el caso real de VM108: `arena_replays` root:root y el proceso como `node`),
// el servicio se niega a arrancar en vez de aceptar ingestas y perderlas todas
// con EACCES mientras /healthz sigue diciendo "ok".
requireWritableDataDir("replay-service", dir);

// B8 · secreto interno de ESCRITURA (ingesta + barrido de retención). Sin él,
// el servicio SÍ arranca —el visor tiene que poder seguir leyendo replays ya
// publicados— pero rechaza toda escritura con 401. Fail-closed: no existe modo
// "sin autenticación". Se avisa por log SIN volcar ningún valor.
const internalSecret = resolveIngestSecretFromEnv(process.env);

const app = express();
app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "replay-service", dir }));
// ADR-016 · identidad de build embebida en la imagen, observable en ejecución.
mountVersionEndpoint(app, "replay-service");
app.use(createReplayServer({ dir, internalSecret }));

app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: internalSecret ? "info" : "warn",
      service: "replay-service",
      msg: internalSecret
        ? `replay-service escuchando en :${port} (escritura autenticada)`
        : `replay-service escuchando en :${port} — SIN secreto de ingesta configurado (REPLAY_INGEST_SECRET[_FILE]): toda escritura responderá 401`,
      dir,
    }),
  );
});
