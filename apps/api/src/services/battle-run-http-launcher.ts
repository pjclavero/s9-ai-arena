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
 */
import { readFileSync } from "node:fs";
import type { Db } from "../db/connection.js";
import { splitVersioned } from "../../../../packages/module-catalog/types.js";
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
}

const DEFAULT_TICKS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
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
        // arena-engine devuelve { result, replay, postures } (Replay real del motor),
        // pero NO ingiere en replay-service (eso no está cableado en B2 — ver informe).
        return {
          status: "completed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          replay: json ? { ingested: false, battleId: input.battleId } : null,
        };
      }
      const message = typeof json?.message === "string" ? json.message : `arena-engine respondió ${res.status}`;
      return { status: "failed", runner: HTTP_LAUNCHER_RUNNER_ID, error: message };
    },
  };
}
