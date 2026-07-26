/**
 * B2 · Launcher REAL de `BattleRunLauncher` (apps/api/src/battle-run.ts): habla
 * por HTTP con el servicio arena-engine (`POST /run`, apps/arena-engine/src/service.ts),
 * NUNCA con Docker directamente. Cadena completa:
 *
 *   API --HTTP(red platform)--> arena-engine --HTTP--> s9-docker-proxy --> bots (red arena)
 *
 * Traduce `BattleRunInput` (contrato de la API, cap. 16) al cuerpo que espera
 * `POST /run` de arena-engine y traduce la respuesta de vuelta a `BattleRunResult`.
 * Autenticación interna: el mismo secreto compartido que arena-engine exige
 * (cabecera `x-arena-engine-auth`); NUNCA se loguea ni se devuelve en respuestas.
 *
 * `S9_ENABLE_REAL_BATTLE_RUNS` sigue apagada por defecto (battle-run.ts): este
 * fichero solo aporta el launcher, no enciende nada. Wiring en server.ts:
 * se inyecta cuando `ARENA_ENGINE_URL` + el secreto están AMBOS presentes;
 * si falta alguno, no se inyecta runner y `/battles/:id/run` sigue en 503
 * `runner_unavailable` con la flag encendida (fail closed, igual que hoy).
 *
 * LÍMITES CONOCIDOS DE ESTA TRADUCCIÓN (documentados, no resueltos en B2 —
 * ver el informe de entrega): `rulesetId` se pasa tal cual desde `input.mode`
 * (sin resolver contra el catálogo real de rulesets); `ticks` es un techo fijo
 * configurable (`cfg.ticks`), no derivado del ruleset real. Nada de esto
 * relaja seguridad (firma/mapa publicado ya se validaron en routes/battles.ts
 * antes de llegar aquí): es fidelidad de simulación pendiente de un bloque
 * posterior.
 *
 * MAPA — FALLA CERRADO, NO SUSTITUYE EN SILENCIO (revisión del supervisor de
 * B2): arena-engine (contrato R6.2) solo entiende mapas-fixture
 * ("empty"|"mvp"|"ctf", `apps/arena-engine/src/fixtures.ts`), no el catálogo
 * real de mapas de la API. Jugar SIEMPRE el fixture "mvp" sin mirar
 * `mapId`/`mapVersion` de `BattleRunInput` habría hecho que alguien eligiera
 * un mapa en la UI y se jugara otro sin enterarse — un fallo de integridad,
 * no un detalle cosmético: invalida la evidencia de una batalla (B4). En vez
 * de eso, `FIXTURE_MAP_EQUIVALENTS` es una allowlist EXPLÍCITA de qué mapId+
 * mapVersion reales tienen fixture equivalente; cualquier otro mapa se
 * RECHAZA (`status: "failed"`, sin llamar siquiera a arena-engine) con un
 * error que dice qué se pidió y que no hay equivalente. Hoy solo hay una
 * entrada: `mvpArena()` (fixtures.ts) tiene el MISMO mapId+version
 * ("mvp-arena-01" v1) que el mapa publicado por el seed real
 * (`maps/mvp-arena-01.json` vía `db/seeds/dev.ts`) — es la misma entidad de
 * catálogo, no una sustitución arbitraria. Dicho esto, la fixture es
 * "PROVISIONAL POR DISEÑO" (comentario propio de fixtures.ts): su geometría
 * exacta puede no ser bit-a-bit idéntica al JSON importado de Tiled hasta que
 * E4 la sustituya. Soportar mapas reales arbitrarios (que la batalla juegue
 * la geometría real de CUALQUIER mapa publicado, no solo este) es un
 * REQUISITO PENDIENTE, fuera de alcance de B2 — requiere que arena-engine
 * acepte geometría de mapa en el cuerpo de `/run` en vez de un nombre de
 * fixture fijo (cambio en `container-battle.ts`/`fixtures.ts`, un bloque
 * propio). Hasta entonces, SOLO se admite mvp-arena-01 v1.
 *
 * B6 · INGESTA DEL REPLAY (cierra el circuito hasta el visor): arena-engine
 * devuelve `{ result, replay, postures }` (`ContainerBattleOutcome`, replay.ts
 * REAL del motor) en el cuerpo 200, pero hasta B6 este launcher lo descartaba
 * (`replay: { ingested: false, ... }` siempre) — el replay se perdía al volver
 * de `/run`, nunca llegaba al replay-service, y el visor web (que habla
 * DIRECTAMENTE con el replay-service vía el gateway, `apps/web/src/viewer/
 * replay-player.ts` → `/replay-service/replays/:battleId/index|segment`, NO a
 * través de esta API) no tenía nada que reproducir.
 *
 * Cierre: si `cfg.replayServiceUrl` está configurado (opt-in, igual patrón que
 * `scripts/e2e-real-battle-smoke.ts::REPLAY_SERVICE_URL`), este launcher:
 *   1. VERIFICA el replay localmente (`verify()` re-simula con el motor real y
 *      compara el hash final bit a bit) ANTES de ingestarlo. Un replay que no
 *      verifica NUNCA se envía al replay-service como si fuera bueno — eso
 *      sería falsear la evidencia de la batalla. Se refleja con
 *      `replay.verify_matches: false` y NO se llama al replay-service.
 *   2. Si verifica, lo serializa a JSONL (mismo formato que graba el motor,
 *      `toJsonl`) y hace `POST /replays/:battleId` al replay-service (HTTP,
 *      misma red `platform` que ya comparten API y replay-service en
 *      infrastructure/docker-compose.yml — sin volumen compartido, sin tocar
 *      el filesystem del contenedor).
 *   3. Un fallo de ingesta (replay-service caído, timeout, respuesta != 201)
 *      es BEST-EFFORT por defecto (`replayIngestRequired: false`, igual
 *      decisión que el arnés E2E): la batalla en sí ya ocurrió y su resultado
 *      es válido aunque el replay tarde en aparecer en el visor; se refleja
 *      honestamente en `replay.ingested: false`, nunca se presenta como
 *      ingerido. Con `REPLAY_INGEST_REQUIRED=1` (modo estricto, mismo nombre
 *      de variable que el arnés E2E) un fallo de ingesta O un replay que no
 *      verifica hace que el `BattleRunResult` sea `status: "failed"`.
 *
 * Sin `cfg.replayServiceUrl` configurado (por defecto, hasta que se despliegue
 * y se fije `REPLAY_SERVICE_URL`), el comportamiento es EXACTAMENTE el de B2:
 * `replay: { ingested: false, battleId }`, sin `verify_matches` — no cambia
 * nada para quien no haya optado a la ingesta.
 */
import { readFileSync } from "node:fs";
import type { Db } from "../db/connection.js";
import { splitVersioned } from "../../../../packages/module-catalog/types.js";
import { toJsonl, verify, type Replay } from "../../../arena-engine/src/replay.js";
import type { BattleRunInput, BattleRunLauncher, BattleRunResult } from "../battle-run.js";

/**
 * Arquetipo de la partida de humo según el chasis del loadout (ARCHETYPES de E3).
 * Copia deliberada de `archetypeForChassis` (services/e6-bot-manager.ts) en vez
 * de importarla: ese módulo arrastra el pipeline completo de E6 (bot-manager/src/pipeline.js
 * → static-analysis → ast-analysis → `acorn`), que en este entorno no está instalado
 * (issue conocido, ajeno a B2) y rompería CUALQUIER test que importe este fichero,
 * aunque no toque builds en absoluto. Misma lógica, sin el arrastre.
 */
function archetypeForChassis(chassis: string): "scout" | "heavy" | "gunner" {
  const base = splitVersioned(chassis).base;
  if (base === "chassis.light") return "scout";
  if (base === "chassis.heavy") return "heavy";
  return "gunner";
}

export interface HttpBattleRunLauncherConfig {
  /** Base URL del servicio arena-engine, p. ej. http://arena-engine:8081 (red platform). */
  engineUrl: string;
  /** Secreto interno compartido con arena-engine (ARENA_ENGINE_INTERNAL_SECRET[_FILE] allí). */
  sharedSecret: string;
  /** BD para resolver el arquetipo real de cada bot (loadout → chassis → arquetipo, E3/E6). */
  db: Db;
  /** Techo de ticks de las batallas lanzadas por este launcher (def. 20000). */
  ticks?: number;
  /** Timeout de la llamada HTTP a arena-engine, ms (def. 30000). */
  timeoutMs?: number;
  /**
   * B6 · URL base del replay-service (p. ej. http://replay-service:8083). Si se
   * define, el replay REAL que devuelve arena-engine se verifica e ingesta ahí
   * (ver la nota de cabecera del fichero). Sin ella, ningún cambio de
   * comportamiento respecto a B2 (`ingested: false` siempre).
   */
  replayServiceUrl?: string;
  /** B6 · Si true, un replay que no verifica o una ingesta fallida hacen que el
   *  resultado operativo sea `status: "failed"` (modo estricto). Def. false
   *  (best-effort: la batalla no se pierde por un fallo de ingesta). */
  replayIngestRequired?: boolean;
  /** B6 · Timeout de la llamada HTTP al replay-service, ms (def. 10000). */
  replayIngestTimeoutMs?: number;
}

const DEFAULT_TICKS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REPLAY_INGEST_TIMEOUT_MS = 10_000;
/** Runner declarado en `BattleRunResult.runner` para este launcher (visible en la respuesta). */
export const HTTP_LAUNCHER_RUNNER_ID = "arena-engine-http";

/**
 * Allowlist EXPLÍCITA mapId+mapVersion real → fixture equivalente de arena-engine.
 * Cualquier mapa fuera de esta lista se RECHAZA en `launch()` (ver la nota de
 * cabecera del fichero) en vez de sustituirse en silencio por un fixture
 * cualquiera. Ampliar esta lista exige verificar caso a caso que el fixture
 * represente de verdad el mapa real (no basta con "algo parecido").
 *
 * `Map`, NO un objeto plano (revisión del supervisor de B2, hallazgo real
 * confirmado en ejecución): `FIXTURE_MAP_EQUIVALENTS[input.mapId]` con
 * `input.mapId = "__proto__"` resolvería a `Object.prototype` (truthy) en un
 * objeto plano, y `Object.prototype.mapVersion === undefined` — si además
 * `input.mapVersion` llegara `undefined`, la guarda `!== ` no lo detectaría
 * (`undefined !== undefined` es `false`) y se jugaría el fixture por defecto
 * de `container-battle.ts`/`MAPS[cfg.mapName ?? "empty"]` en silencio. Lo
 * mismo con `"constructor"`/`"toString"`/`"hasOwnProperty"`. `Map` no tiene
 * prototipo contaminable por claves de string, así que esta clase entera de
 * fallo desaparece de raíz (no depende de que nadie vuelva a indexar sin
 * pensar). Se refuerza además con la validación explícita de tipo de
 * `mapVersion` en `launch()`: defensa en dos capas independientes.
 */
const FIXTURE_MAP_EQUIVALENTS: ReadonlyMap<string, { mapName: "empty" | "mvp" | "ctf"; mapVersion: number }> = new Map([
  ["mvp-arena-01", { mapName: "mvp" as const, mapVersion: 1 }],
]);

function resolveSharedSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.ARENA_ENGINE_SHARED_SECRET_FILE;
  if (file) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }
  const plain = env.ARENA_ENGINE_SHARED_SECRET;
  return plain && plain.length > 0 ? plain : undefined;
}

/**
 * Config del launcher HTTP resuelta del entorno. `null` si falta la URL del
 * motor o el secreto: el llamador (server.ts) entonces NO inyecta ningún
 * runner, así que `POST /battles/:id/run` sigue respondiendo 503
 * `runner_unavailable` aunque `S9_ENABLE_REAL_BATTLE_RUNS=1` (fail closed).
 */
export function httpBattleRunLauncherEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): { engineUrl: string; sharedSecret: string } | null {
  const engineUrl = env.ARENA_ENGINE_URL;
  const sharedSecret = resolveSharedSecretFromEnv(env);
  if (!engineUrl || !sharedSecret) return null;
  return { engineUrl, sharedSecret };
}

/**
 * B6 · Config de ingesta del replay resuelta del entorno. `replayServiceUrl`
 * ausente ⇒ ingesta desactivada (comportamiento B2 sin cambios). Mismos
 * nombres de variable que `scripts/e2e-real-battle-smoke.ts` a propósito
 * (mismo concepto, mismo operador que los configura).
 */
export function replayIngestEnvConfig(env: NodeJS.ProcessEnv = process.env): {
  replayServiceUrl?: string;
  replayIngestRequired: boolean;
  replayIngestTimeoutMs: number;
} {
  return {
    ...(env.REPLAY_SERVICE_URL ? { replayServiceUrl: env.REPLAY_SERVICE_URL } : {}),
    replayIngestRequired: env.REPLAY_INGEST_REQUIRED === "1",
    replayIngestTimeoutMs: Number(env.REPLAY_INGEST_TIMEOUT_MS ?? String(DEFAULT_REPLAY_INGEST_TIMEOUT_MS)),
  };
}

/** B6 · Resultado de intentar ingestar el replay en el replay-service. */
interface ReplayIngestOutcome {
  ingested: boolean;
  verifyMatches: boolean;
  /** Motivo del fallo (no verifica / HTTP / red), para el `error` del BattleRunResult en modo estricto. */
  reason?: string;
}

/**
 * B6 · Verifica (`verify()`, re-simulación bit a bit) el replay REAL devuelto por
 * arena-engine y, solo si verifica, lo ingesta en el replay-service (POST
 * /replays/:battleId, mismo contrato que usa `scripts/e2e-real-battle-smoke.ts`).
 * Un replay que no verifica JAMÁS se envía como si fuera bueno.
 */
async function verifyAndIngestReplay(
  replayServiceUrl: string,
  battleId: string,
  replay: Replay,
  timeoutMs: number,
): Promise<ReplayIngestOutcome> {
  let verification;
  try {
    verification = await verify(replay);
  } catch (err) {
    // El motor no pudo re-simular (cabecera incompleta, etc.): tratamos como "no
    // verifica" — nunca se ingesta algo que ni siquiera se pudo comprobar.
    return {
      ingested: false,
      verifyMatches: false,
      reason: `no se pudo verificar el replay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!verification.matches) {
    return {
      ingested: false,
      verifyMatches: false,
      reason: `el replay no verifica (verify_matches=false, divergedAtTick=${verification.divergedAtTick ?? "final"})`,
    };
  }

  const jsonl = toJsonl(replay);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(`/replays/${encodeURIComponent(battleId)}`, replayServiceUrl), {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: jsonl,
      signal: controller.signal,
    });
    if (res.status !== 201) {
      const text = await res.text().catch(() => "");
      return {
        ingested: false,
        verifyMatches: true,
        reason: `replay-service respondió ${res.status} al ingestar: ${text.slice(0, 200)}`,
      };
    }
    return { ingested: true, verifyMatches: true };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ingested: false,
      verifyMatches: true,
      reason: timedOut
        ? `replay-service no respondió en ${timeoutMs}ms`
        : `replay-service inalcanzable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ResolvedBot {
  botId: string;
  version: number;
  archetype: ReturnType<typeof archetypeForChassis>;
  imageDigest: string;
}

/** Arquetipo+imagen de un participante, resuelto desde su loadout REAL en BD
 *  (no un valor inventado): bot_versions.loadout_revision → bot_loadouts.chassis
 *  → archetypeForChassis (misma función que usa el pipeline E6). */
async function resolveBot(db: Db, p: BattleRunInput["participants"][number]): Promise<ResolvedBot> {
  const version = await db("bot_versions").where({ bot_id: p.botId, version: p.version }).first();
  const loadout = version
    ? await db("bot_loadouts").where({ bot_id: p.botId, revision: version.loadout_revision }).first()
    : undefined;
  if (!loadout) {
    throw new Error(`no se encontró el loadout del bot ${p.botId} v${p.version} (no debería ocurrir tras validar)`);
  }
  return {
    botId: p.botId,
    version: p.version,
    archetype: archetypeForChassis(loadout.chassis),
    imageDigest: p.artifactHash,
  };
}

/** Launcher real: API → arena-engine por HTTP. La API NUNCA llama a Docker. */
export function createHttpBattleRunLauncher(cfg: HttpBattleRunLauncherConfig): BattleRunLauncher {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async launch(input: BattleRunInput): Promise<BattleRunResult> {
      // Mapa PRIMERO, sin ni siquiera resolver bots ni llamar a arena-engine:
      // si no hay fixture equivalente al mapId+mapVersion pedidos, se rechaza
      // en vez de jugar un mapa distinto al que eligió quien lanzó la batalla.
      //
      // Defensa en dos capas independientes (revisión del supervisor de B2):
      // (1) `mapVersion` DEBE ser `number` — descarta de raíz cualquier valor
      //     "raro" (undefined/null/string) ANTES de comparar nada; (2) `Map.get`
      //     (nunca indexación de objeto plano) — sin prototipo contaminable por
      //     claves tipo `"__proto__"`/`"constructor"`/`"toString"`.
      if (typeof input.mapVersion !== "number" || !Number.isInteger(input.mapVersion)) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error: `mapa no soportado por este launcher: mapVersion debe ser un entero (recibido: ${JSON.stringify(input.mapVersion)}).`,
        };
      }
      const fixture = FIXTURE_MAP_EQUIVALENTS.get(input.mapId);
      if (!fixture || fixture.mapVersion !== input.mapVersion) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error:
            `mapa no soportado por este launcher: no hay fixture de arena-engine equivalente a ` +
            `${input.mapId} v${input.mapVersion} (hoy solo mvp-arena-01 v1). Se rechaza la ` +
            `petición en vez de jugar un mapa distinto al pedido.`,
        };
      }

      let bots: ResolvedBot[];
      try {
        bots = await Promise.all(input.participants.map((p) => resolveBot(cfg.db, p)));
      } catch (err) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error: `no se pudo resolver el arquetipo de los bots: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const body = {
        battleId: input.battleId,
        seed: input.seed ?? input.battleId,
        rulesetId: input.mode,
        ticks: cfg.ticks ?? DEFAULT_TICKS,
        mapName: fixture.mapName,
        bots,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(new URL("/run", cfg.engineUrl), {
          method: "POST",
          headers: { "content-type": "application/json", "x-arena-engine-auth": cfg.sharedSecret },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "AbortError";
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error: timedOut
            ? `arena-engine no respondió en ${timeoutMs}ms`
            : `arena-engine inalcanzable: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (res.status === 200) {
        // arena-engine devuelve { result, replay, postures } (Replay real del motor).
        if (!json) {
          return { status: "completed", runner: HTTP_LAUNCHER_RUNNER_ID, replay: null };
        }
        // B6 · sin replayServiceUrl configurado, comportamiento IDÉNTICO a B2: no se
        // toca el replay-service, nunca se afirma "ingested: true" sin haberlo hecho.
        if (!cfg.replayServiceUrl) {
          return {
            status: "completed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            replay: { ingested: false, battleId: input.battleId },
          };
        }
        const replay = (json as { replay?: unknown }).replay as Replay | undefined;
        if (!replay || typeof replay !== "object" || !replay.header) {
          // arena-engine respondió 200 sin un replay utilizable: no hay nada que
          // verificar ni ingestar. Se refleja honestamente, no se inventa un éxito.
          return {
            status: "completed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            replay: { ingested: false, battleId: input.battleId, verify_matches: false },
          };
        }
        const outcome = await verifyAndIngestReplay(
          cfg.replayServiceUrl,
          input.battleId,
          replay,
          cfg.replayIngestTimeoutMs ?? DEFAULT_REPLAY_INGEST_TIMEOUT_MS,
        );
        if (!outcome.ingested && cfg.replayIngestRequired) {
          return {
            status: "failed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            error: `REPLAY_INGEST_REQUIRED y la ingesta del replay falló: ${outcome.reason ?? "motivo desconocido"}`,
            replay: { ingested: false, battleId: input.battleId, verify_matches: outcome.verifyMatches },
          };
        }
        return {
          status: "completed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          replay: { ingested: outcome.ingested, battleId: input.battleId, verify_matches: outcome.verifyMatches },
        };
      }
      const message = typeof json?.message === "string" ? json.message : `arena-engine respondió ${res.status}`;
      return { status: "failed", runner: HTTP_LAUNCHER_RUNNER_ID, error: message };
    },
  };
}
