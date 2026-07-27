/** Entrypoint de la API: PORT + DATABASE_URL (cap. 6.2). Servida tras el gateway bajo /api/v1. */
import express from "express";
import { createDb } from "./db/connection.js";
import { createApp } from "./app.js";
import { resolveTrustProxyHops } from "./middleware/proxy-trust.js";
import { battleRunConfigFromEnv } from "./battle-run.js";
import {
  createHttpBattleRunLauncher,
  httpBattleRunLauncherEnvConfig,
  replayIngestEnvConfig,
  runTimeoutEnvConfig,
} from "./services/battle-run-http-launcher.js";

const db = createDb();
const port = Number(process.env.PORT ?? 8080);
// R1.8 · ERR-SEC-05: se resuelve UNA vez y falla cerrado (valor inválido =
// no arranca). Se aplica también al envolvente para que ningún middleware
// futuro montado aquí vea una IP distinta de la de la app principal.
const trustProxyHops = resolveTrustProxyHops();

// B2 · el launcher REAL (API → arena-engine por HTTP, nunca Docker) solo se
// inyecta si ARENA_ENGINE_URL y el secreto compartido están AMBOS presentes
// (fail closed); `S9_ENABLE_REAL_BATTLE_RUNS` sigue resolviéndose aparte y
// apagada por defecto — cablear el runner no la enciende.
const launcherEnvCfg = httpBattleRunLauncherEnvConfig();
// B6 · ingesta del replay real en el replay-service (ver la nota de cabecera de
// battle-run-http-launcher.ts). Sin REPLAY_SERVICE_URL, no cambia nada de B2.
const replayIngestCfg = replayIngestEnvConfig();
// B9 · plazo de `POST /run`: por defecto DERIVADO de la duración real de la batalla
// (ticks del ruleset × ritmo de tick + margen). `ARENA_ENGINE_RUN_TIMEOUT_MS` lo
// sobrescribe de forma absoluta si un operador lo necesita.
const runTimeoutCfg = runTimeoutEnvConfig();
const realBattleRuns = {
  ...battleRunConfigFromEnv(),
  runner: launcherEnvCfg
    ? createHttpBattleRunLauncher({ ...launcherEnvCfg, ...replayIngestCfg, ...runTimeoutCfg, db })
    : undefined,
};

// /healthz va en un Express envolvente, NO en createApp(): el test de
// conformidad (conformance.test.ts) exige que la app no exponga rutas fuera del
// contrato de E1 salvo las documentadas. El healthcheck es infraestructura.
const root = express();
root.set("trust proxy", trustProxyHops);
root.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api" }));
root.use(createApp({ db, trustProxyHops, realBattleRuns }));

root.listen(port, () => {
  console.log(JSON.stringify({ level: "info", service: "api", msg: `API de plataforma escuchando en :${port}` }));
});
