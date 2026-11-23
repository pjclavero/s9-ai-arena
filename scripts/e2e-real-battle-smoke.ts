#!/usr/bin/env -S npx tsx
/**
 * R6.2 · Arnés de la batalla E2E REAL con contenedores (opt-in, VM108).
 *
 * A diferencia de `apps/bot-manager/tests/container-battle.test.ts` (runner MOCK en
 * proceso, para CI sin Docker), este arnés usa `ProxyContainerRunner` para lanzar los
 * bots como CONTENEDORES REALES a través de `s9-docker-proxy`. Ejecuta una batalla
 * smoke con 2 runtimes reales, recoge el `BattleResult` y publica el `Replay` en S9R/1.
 *
 * ⚠️ Ejecuta CÓDIGO NO CONFIABLE en contenedores reales. Por eso es OPT-IN y NUNCA
 * corre en el CI normal: exige `S9_RUN_REAL_DOCKER_E2E=1`. La lógica (parseo de
 * config y orquestación) es testeable con un runner inyectado (ver
 * `tests/e2e/e2e-real-battle-smoke.test.ts`), pero la ejecución con Docker real es un
 * paso de VM108, tras instalar y validar el docker-proxy.
 *
 * Variables de entorno:
 *   S9_RUN_REAL_DOCKER_E2E  "1" para ejecutar de verdad (si no, NO-OP).
 *   DOCKER_PROXY_URL        URL del docker-proxy (def. http://docker-proxy.internal:2375).
 *   ARENA_NETWORK           red Docker de los bots (def. arena; nombre EXACTO exigido por compliance).
 *   ENGINE_HOST             host del ProtocolServer alcanzable desde ARENA_NETWORK
 *                           (def. arena-engine). El puerto lo asigna el server.
 *   SMOKE_BOT_DIGEST        imagen del s9-smoke-bot FIJADA POR DIGEST (obligatoria).
 *   SMOKE_TICKS             techo de ticks (def. 300).
 *   SMOKE_SEED              semilla (def. e2e-real-smoke).
 *   SMOKE_MAP               empty|mvp|ctf (def. empty).
 *   SMOKE_TIMEOUT_MS        timeout global (def. 120000).
 *   REPLAY_OUT_DIR          directorio del replay S9R/1 (def. /data/replays/e2e-real-smoke).
 *   REPLAY_VERIFY_REQUIRED  "1": un replay que no verifica hace fallar el arnés (también
 *                           REPLAY_INGEST_REQUIRED=1, nombre anterior). La ingesta HTTP en el
 *                           replay-service (REPLAY_SERVICE_URL) está RETIRADA (V1 REPLAYS PR-4b).
 */
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runContainerBattle, type ContainerBattleBot } from "../apps/bot-manager/src/container-battle.js";
import { ProxyContainerRunner } from "../apps/bot-manager/src/docker-proxy.js";
import type { ContainerRunner } from "../apps/bot-manager/src/container-runner.js";
import type { Replay } from "../apps/arena-engine/src/replay.js";
// V1 REPLAYS PR-4b · el replay se escribe en S9R/1 (mismo grabador y publicación que el worker) y se
// verifica por fragmentos. La ingesta HTTP en el replay-service (JSONL) está RETIRADA (D-OP-30).
import { writeS9rReplay } from "../apps/replay-service/src/s9r/replay-file.js";
import { verifyRecipePath } from "../apps/replay-service/src/recipe-verify.js";
import type { BattleResult } from "../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../apps/arena-engine/src/sim/physics.js";

export interface SmokeHarnessConfig {
  dockerProxyUrl: string;
  arenaNetwork: string;
  engineHost: string;
  smokeBotDigest: string;
  ticks: number;
  seed: string;
  mapName: "empty" | "mvp" | "ctf";
  timeoutMs: number;
  /** Directorio donde se publica el replay S9R/1 (`<battleId>.1.s9r` + `.s9v`). */
  replayOutDir: string;
  /** Si true, un replay que no verifica hace FALLAR el resultado operativo (modo estricto). */
  replayVerifyRequired: boolean;
}

/** Lee y valida la configuración del entorno. Falla cerrado si falta el digest. */
export function readHarnessConfig(env: NodeJS.ProcessEnv): SmokeHarnessConfig {
  const digest = env.SMOKE_BOT_DIGEST;
  if (!digest) throw new Error("falta SMOKE_BOT_DIGEST (imagen del s9-smoke-bot fijada por digest)");
  const map = (env.SMOKE_MAP ?? "empty") as SmokeHarnessConfig["mapName"];
  if (!["empty", "mvp", "ctf"].includes(map)) throw new Error(`SMOKE_MAP inválido: ${map}`);
  return {
    dockerProxyUrl: env.DOCKER_PROXY_URL ?? "http://docker-proxy.internal:2375",
    arenaNetwork: env.ARENA_NETWORK ?? "arena",
    engineHost: env.ENGINE_HOST ?? "arena-engine",
    smokeBotDigest: digest,
    ticks: Number(env.SMOKE_TICKS ?? "300"),
    seed: env.SMOKE_SEED ?? "e2e-real-smoke",
    mapName: map,
    timeoutMs: Number(env.SMOKE_TIMEOUT_MS ?? "120000"),
    replayOutDir: env.REPLAY_OUT_DIR ?? "/data/replays/e2e-real-smoke",
    // Mismo nombre de variable que antes para el modo estricto (ahora: verificación local).
    replayVerifyRequired: env.REPLAY_VERIFY_REQUIRED === "1" || env.REPLAY_INGEST_REQUIRED === "1",
  };
}

export interface SmokeHarnessOutcome {
  result: BattleResult;
  replay: Replay;
  /** Receta S9R/1 publicada. */
  replayPath: string;
  viewPath: string;
  /** Re-simulación local de la receta (por fragmentos): ¿reproduce el resultado oficial? */
  verified: boolean;
}

/**
 * Orquesta la batalla smoke con el `ContainerRunner` dado (real o inyectado en tests), publica el
 * replay en S9R/1 y lo verifica. La limpieza de contenedores la garantiza runContainerBattle.
 */
export async function runSmokeHarness(cfg: SmokeHarnessConfig, runner: ContainerRunner): Promise<SmokeHarnessOutcome> {
  await initPhysics();
  const battleId = `e2e-real-smoke-${Date.now()}`;
  const bots: ContainerBattleBot[] = [
    { botId: "bot_smokeA", version: 1, archetype: "scout", imageDigest: cfg.smokeBotDigest },
    { botId: "bot_smokeB", version: 1, archetype: "gunner", imageDigest: cfg.smokeBotDigest },
  ];
  const { result, replay } = await runContainerBattle({
    battleId,
    seed: cfg.seed,
    rulesetId: "dm_practice@1",
    ticks: cfg.ticks,
    mapName: cfg.mapName,
    bots,
    runner,
    network: cfg.arenaNetwork,
    engineHost: cfg.engineHost,
    overallTimeoutMs: cfg.timeoutMs,
  });
  mkdirSync(cfg.replayOutDir, { recursive: true });
  const fx = await writeS9rReplay(cfg.replayOutDir, replay);
  // No se da por bueno un replay que no verifica (re-simula la receta y compara hashes y resultado).
  const { verification } = await verifyRecipePath(fx.path);
  const verified = verification.matches;
  if (!verified && cfg.replayVerifyRequired) {
    throw new Error("REPLAY_VERIFY_REQUIRED=1 y el replay no verifica: resultado operativo FALLIDO");
  }
  return { result, replay, replayPath: fx.path, viewPath: fx.viewPath, verified };
}

// --------------------------------------------------------------------------- CLI
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.env.S9_RUN_REAL_DOCKER_E2E !== "1") {
    console.error(
      "e2e-real-battle-smoke: NO-OP. Ejecuta CÓDIGO NO CONFIABLE en contenedores reales.\n" +
        "Exige S9_RUN_REAL_DOCKER_E2E=1 (paso de VM108, tras instalar y validar el docker-proxy).\n" +
        "No se ejecuta en el CI normal.",
    );
    process.exit(0);
  }
  const cfg = readHarnessConfig(process.env);
  const runner = new ProxyContainerRunner(cfg.dockerProxyUrl);
  runSmokeHarness(cfg, runner)
    .then(({ result, replayPath, verified }) => {
      console.log(
        JSON.stringify({
          event: "result",
          winner: result.winner,
          ticks: result.ticks,
          finalStateHash: result.finalStateHash,
          disqualified: result.disqualified,
          replayPath,
          verified,
        }),
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("e2e-real-battle-smoke FALLÓ:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
