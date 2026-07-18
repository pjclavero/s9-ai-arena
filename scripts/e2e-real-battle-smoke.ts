#!/usr/bin/env -S npx tsx
/**
 * R6.2 · Arnés de la batalla E2E REAL con contenedores (opt-in, VM108).
 *
 * A diferencia de `apps/bot-manager/tests/container-battle.test.ts` (runner MOCK en
 * proceso, para CI sin Docker), este arnés usa `ProxyContainerRunner` para lanzar los
 * bots como CONTENEDORES REALES a través de `s9-docker-proxy`. Ejecuta una batalla
 * smoke con 2 runtimes reales, recoge el `BattleResult` y escribe el `Replay` a disco.
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
 *   REPLAY_OUT              ruta de salida del replay (def. /data/replays/e2e-real-smoke.jsonl).
 *   REPLAY_SERVICE_URL      (opcional, R7) si se define, ingesta el replay en el
 *                           replay-service (POST /replays/:battleId) → recurso gestionado
 *                           visible por el visor y GET /replays/{battleId}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { runContainerBattle, type ContainerBattleBot } from "../apps/bot-manager/src/container-battle.js";
import { ProxyContainerRunner } from "../apps/bot-manager/src/docker-proxy.js";
import type { ContainerRunner } from "../apps/bot-manager/src/container-runner.js";
import { toJsonl, type Replay } from "../apps/arena-engine/src/replay.js";
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
  replayOut: string;
  /**
   * R7 · Si se define, el replay real se INGESTA en el replay-service (POST
   * /replays/:battleId), pasando de fichero suelto a recurso gestionado que el
   * visor y la API (`GET /replays/{battleId}`) ya saben servir. Opcional: si no se
   * define, solo se escribe a disco (comportamiento previo). Best-effort: un fallo
   * de ingesta NO invalida la batalla, solo se reporta.
   */
  replayServiceUrl?: string;
}

export interface ReplayIngestResult {
  ok: boolean;
  status: number;
  /** Cuerpo de respuesta del servicio (sha256/path/official) o el error. */
  body: unknown;
}

/**
 * R7 · Ingesta un replay (JSONL) en el replay-service vía POST /replays/:battleId.
 * El servicio valida que `header.battleId` coincide y almacena+indexa. El mismo JSONL
 * que se escribe a disco es el que se envía (Content-Type ndjson).
 */
export async function ingestReplayToService(
  serviceUrl: string,
  battleId: string,
  jsonl: string,
): Promise<ReplayIngestResult> {
  const url = new URL(`/replays/${encodeURIComponent(battleId)}`, serviceUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: jsonl,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* deja el texto crudo */
  }
  return { ok: res.status === 201, status: res.status, body };
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
    replayOut: env.REPLAY_OUT ?? "/data/replays/e2e-real-smoke.jsonl",
    ...(env.REPLAY_SERVICE_URL ? { replayServiceUrl: env.REPLAY_SERVICE_URL } : {}),
  };
}

export interface SmokeHarnessOutcome {
  result: BattleResult;
  replay: Replay;
  replayPath: string;
  /** R7 · Resultado de la ingesta en el replay-service, si se configuró. */
  ingest?: ReplayIngestResult;
}

/**
 * Orquesta la batalla smoke con el `ContainerRunner` dado (real o inyectado en tests) y
 * escribe el replay a disco. La limpieza de contenedores la garantiza runContainerBattle.
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
  const jsonl = toJsonl(replay);
  mkdirSync(dirname(cfg.replayOut), { recursive: true });
  writeFileSync(cfg.replayOut, jsonl, "utf8");

  const outcome: SmokeHarnessOutcome = { result, replay, replayPath: cfg.replayOut };

  // R7 · Ingesta best-effort en el replay-service (recurso gestionado + visor).
  if (cfg.replayServiceUrl) {
    try {
      outcome.ingest = await ingestReplayToService(cfg.replayServiceUrl, battleId, jsonl);
    } catch (e) {
      outcome.ingest = { ok: false, status: 0, body: (e as Error).message };
    }
  }
  return outcome;
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
    .then(({ result, replayPath, ingest }) => {
      console.log(
        JSON.stringify({
          event: "result",
          winner: result.winner,
          ticks: result.ticks,
          finalStateHash: result.finalStateHash,
          disqualified: result.disqualified,
          replayPath,
          ingested: ingest ? ingest.ok : undefined,
          ingestStatus: ingest ? ingest.status : undefined,
        }),
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("e2e-real-battle-smoke FALLÓ:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
