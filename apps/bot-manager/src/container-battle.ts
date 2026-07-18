/**
 * R6.2 · Orquestador de batalla-en-contenedores.
 *
 * Ata TRES piezas REALES que ya existían por separado pero nunca juntas:
 *   - el motor E2 + protocolo E5 (`Battle` + `ProtocolServer`, apps/arena-engine),
 *   - el runner containerizado tras el docker-proxy (`ContainerRunner`, bot-manager),
 *   - los replays reales del motor (`getReplay()` → `replayFromBattle`).
 *
 * A diferencia de `local-sim.ts` (que conecta bots como SUBPROCESOS del SDK), aquí
 * cada bot es un CONTENEDOR aislado lanzado por el `ContainerRunner` inyectado: en
 * producción `ProxyContainerRunner` (habla con `s9-docker-proxy`, sin docker.sock);
 * en tests un runner mock que arranca un bot EN PROCESO que conecta por WebSocket —
 * misma orquestación, mismo protocolo, sin Docker.
 *
 * El bot containerizado recibe por entorno (NUNCA secretos):
 *   WS_URL        ws://<engineHost>:<puerto asignado por el ProtocolServer>
 *   BATTLE_TOKEN  token de esta batalla para ESTE bot (autenticación del HELLO)
 *   BOT_ID        su identificador
 * y conecta con `arena_sdk`.run(WS_URL, BATTLE_TOKEN) (ver bots/s9-smoke-bot).
 *
 * Seguridad: NO se relaja nada. El `SandboxSpec` que se construye pasa por el mismo
 * contrato (`SecurityPosture`/compliance) que valida el docker-proxy; los contenedores
 * se limpian SIEMPRE (éxito, error o timeout) para no dejar procesos colgados.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BattleResult, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena, mvpArena, ctfArena } from "../../arena-engine/src/fixtures.js";
import { ProtocolServer, type ExpectedBot } from "../../arena-engine/src/protocol-server.js";
import type { Replay } from "../../arena-engine/src/replay.js";
import {
  DEFAULT_LIMITS,
  type ContainerHandle,
  type ContainerLimits,
  type ContainerRunner,
  type SandboxSpec,
} from "./container-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Perfil seccomp restrictivo por defecto (E6/R6.1, mínimo probado con el sandbox VIVO). */
export const DEFAULT_SECCOMP_PROFILE = join(__dirname, "..", "security", "seccomp-bot.json");

const MAPS: Record<string, () => unknown> = { empty: emptyArena, mvp: mvpArena, ctf: ctfArena };

export interface ContainerBattleBot {
  botId: string;
  version: number;
  /** Arquetipo del catálogo (loadout congelado); ver ARCHETYPES. */
  archetype: keyof typeof ARCHETYPES;
  /** Imagen del bot FIJADA POR DIGEST (nunca tag mutable). El guard de digest
   *  placeholder (issue #12) la valida en el runner antes de lanzar. */
  imageDigest: string;
}

export interface ContainerBattleConfig {
  battleId: string;
  seed: string;
  /** Ruleset del motor, p. ej. "dm_practice@1". */
  rulesetId: string;
  /** Techo de ticks de la batalla. */
  ticks: number;
  /** Nombre de mapa fixture: "empty" | "mvp" | "ctf". */
  mapName?: keyof typeof MAPS;
  /** Al menos 2 bots. El índice par → equipo red, impar → blue. */
  bots: ContainerBattleBot[];
  /** Runner containerizado inyectado (ProxyContainerRunner en prod, mock en tests). */
  runner: ContainerRunner;
  /** Red interna del motor a la que conectan los contenedores (sin Internet). */
  network: string;
  /** Host alcanzable por los contenedores para el WebSocket del ProtocolServer
   *  (p. ej. el hostname del worker en `network`). El puerto lo asigna el server. */
  engineHost: string;
  seccompProfilePath?: string;
  limits?: ContainerLimits;
  /** ms reales por tick (los tests lo aceleran). Por defecto el del motor. */
  tickIntervalMs?: number;
  /** Guard de timeout global; por defecto tiempo teórico + 15 s. */
  overallTimeoutMs?: number;
}

export interface ContainerBattleOutcome {
  result: BattleResult;
  replay: Replay;
  /** Postura de seguridad inspeccionada de cada contenedor (por botId), best-effort. */
  postures: Record<string, unknown>;
}

/** DECISION_EVERY_N_TICKS del protocolo (OBSERVATION tick N → COMMAND forTick N+3). */
export const DECISION_EVERY_N_TICKS = 3;

/**
 * Ejecuta una batalla REAL con los bots corriendo en contenedores aislados.
 * Devuelve el resultado y el replay reproducibles del motor.
 */
export async function runContainerBattle(cfg: ContainerBattleConfig): Promise<ContainerBattleOutcome> {
  if (cfg.bots.length < 2) throw new Error("runContainerBattle: se requieren al menos 2 bots");
  const seccompProfilePath = cfg.seccompProfilePath ?? DEFAULT_SECCOMP_PROFILE;
  const limits = cfg.limits ?? DEFAULT_LIMITS;
  const catalog = loadCatalog();
  const mapFactory = MAPS[cfg.mapName ?? "empty"] ?? emptyArena;

  const participants: Participant[] = cfg.bots.map((b, i) => {
    const loadout = ARCHETYPES[b.archetype];
    if (!loadout) throw new Error(`runContainerBattle: arquetipo desconocido "${String(b.archetype)}"`);
    return {
      id: `veh_${i + 1}`,
      botId: b.botId,
      team: i % 2 === 0 ? "red" : "blue",
      spec: resolveVehicle(loadout, catalog),
    };
  });

  const battle = await Battle.create({
    battleId: cfg.battleId,
    seed: cfg.seed,
    ruleset: loadRuleset(cfg.rulesetId, { timeLimitTicks: cfg.ticks }),
    map: mapFactory() as never,
    participants,
    recordReplay: true,
  });

  const expected: ExpectedBot[] = cfg.bots.map((b, i) => ({
    botId: b.botId,
    vehicleId: `veh_${i + 1}`,
    battleToken: randomUUID(),
  }));

  // El WebSocketServer se crea (y el puerto queda listo) en el constructor; el bucle
  // de ticks NO arranca hasta start(). Así podemos lanzar los contenedores, esperar a
  // que TODOS hagan handshake y solo entonces arrancar — con los agentes enganchados
  // desde el tick 0 (igual que exige verify() del replay).
  const server = new ProtocolServer({
    battle,
    catalogVersion: CATALOG_VERSION,
    expected,
    port: 0,
    ...(cfg.tickIntervalMs !== undefined
      ? { tickIntervalMs: cfg.tickIntervalMs, decisionDeadlineMs: Math.max(80, cfg.tickIntervalMs * 6) }
      : {}),
  });

  const wsUrl = `ws://${cfg.engineHost}:${server.port}`;
  const handles: ContainerHandle[] = [];
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    for (let i = 0; i < cfg.bots.length; i++) {
      const b = cfg.bots[i];
      const spec: SandboxSpec = {
        imageDigest: b.imageDigest,
        botId: b.botId,
        version: b.version,
        battleId: cfg.battleId,
        network: cfg.network,
        engineEndpoint: wsUrl,
        env: {
          WS_URL: wsUrl,
          BATTLE_TOKEN: expected[i].battleToken,
          BOT_ID: b.botId,
        },
        limits,
        seccompProfilePath,
      };
      // Si el lanzamiento de un bot falla, el `finally` limpia los ya lanzados.
      handles.push(await cfg.runner.launch(spec));
    }

    // Esperar a que TODOS los contenedores hayan hecho handshake y arrancar el bucle
    // (agentes enganchados desde el tick 0). Si alguno no conecta, whenAllConnected
    // rechaza y el `finally` limpia los contenedores.
    const connectTimeoutMs = cfg.overallTimeoutMs ? Math.min(cfg.overallTimeoutMs, 15_000) : 15_000;
    await server.whenAllConnected(connectTimeoutMs);
    server.start();

    const theoreticalMs = cfg.ticks * (cfg.tickIntervalMs ?? 34);
    const overallMs = cfg.overallTimeoutMs ?? theoreticalMs + 15_000;
    const result = await Promise.race<BattleResult>([
      server.waitForResult(),
      new Promise<BattleResult>((_resolve, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error(`runContainerBattle: timeout global tras ${overallMs} ms (¿bots sin conectar?)`)),
          overallMs,
        );
      }),
    ]);

    const replay = server.getReplay();

    const postures: Record<string, unknown> = {};
    for (let i = 0; i < handles.length; i++) {
      try {
        postures[cfg.bots[i].botId] = await handles[i].posture();
      } catch {
        /* best-effort: la postura es diagnóstico, no bloquea el resultado. */
      }
    }
    return { result, replay, postures };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Limpieza incondicional: parar TODOS los contenedores (no dejar colgados).
    await Promise.allSettled(handles.map((h) => h.stop()));
    server.stop();
    battle.free();
  }
}
