/**
 * B9 · Resolución REAL del ruleset (y por tanto de `ticks`) de una batalla.
 *
 * QUÉ HABÍA ANTES (y por qué era un fallo, no solo una carencia): el launcher HTTP
 * enviaba a arena-engine `rulesetId: input.mode` — es decir, la cadena
 * `"deathmatch"` — y `ticks: 20000` fijo. Los rulesets que el MOTOR conoce
 * (`RULESETS`, packages/game-rules) se llaman `dm_practice@1`, `tdm_mvp@1`,
 * `ctf_mvp@1`... nunca `deathmatch`. Aguas abajo, `runContainerBattle` hace
 * `loadRuleset(cfg.rulesetId)`, que LANZA con un id desconocido: cualquier batalla
 * real lanzada por la API moría con un 502 `battle_failed` genérico DESPUÉS de
 * haber pasado todas las validaciones. Los `rulesets` de la BD (tabla `rulesets`,
 * p. ej. `mvp-default` del seed) tampoco comparten espacio de nombres con los del
 * motor; son dos catálogos distintos que nadie había atado.
 *
 * QUÉ HACE B9: ata los dos catálogos, sin inventar nada y fallando cerrado.
 *   1. Si la batalla referencia un ruleset de BD y su `config.engineRulesetId`
 *      nombra un ruleset REAL del motor, ese manda (es la forma explícita de que
 *      un operador diga "esta competición se juega con estas reglas del motor").
 *   2. Si no, se traduce el MODO de la batalla al ruleset por defecto del motor
 *      para ese modo (`MODE_DEFAULT_ENGINE_RULESET`).
 *   3. El resultado se carga con `loadRuleset()` (que usa `safeLookup`, no
 *      indexación directa) y se EXIGE que `ruleset.mode` sea el modo de la
 *      batalla. Un ruleset de otro modo no es "casi el pedido": jugar
 *      `capture_the_flag` cuando alguien programó `deathmatch` es la misma clase
 *      de sustitución silenciosa que este bloque prohíbe con los mapas.
 * Sin traducción posible, se RECHAZA (nunca "el primero de la lista").
 *
 * `ticks`: deja de ser un número fijo del launcher y pasa a ser
 * `ruleset.timeLimitTicks` — el límite REAL de las reglas que se van a jugar
 * (9000 ticks = 5 min a 30 Hz en los rulesets MVP, frente a los 20000 inventados).
 * `HttpBattleRunLauncherConfig.ticks`, si el operador lo fija explícitamente,
 * sigue teniendo precedencia como override consciente.
 */
import type { Db } from "../db/connection.js";
import { loadRuleset, safeLookup, type Ruleset } from "../../../../packages/game-rules/index.js";

export type RulesetResolutionErrorCode = "ruleset_unresolvable" | "ruleset_mode_mismatch";

/** Campos "del otro caso" opcionales: `strict: false` en el monorepo ⇒ sin
 *  estrechamiento de uniones discriminadas (ver `arena-engine/src/arena-map.ts`). */
export type RulesetResolution =
  | { ok: true; ruleset: Ruleset; code?: undefined; message?: undefined }
  | { ok: false; ruleset?: undefined; code: RulesetResolutionErrorCode; message: string };

/**
 * Modo de juego (columna `battles.mode`) → ruleset por defecto del MOTOR.
 * `Map`, no objeto plano: `mode` viene de la BD y termina indexando este
 * diccionario; con un objeto plano, `mode = "__proto__"` resolvería a
 * `Object.prototype` (truthy) y la guarda `if (!id)` no saltaría (la misma clase
 * de fallo que apareció seis veces en este repo). `Map.get` no consulta la cadena
 * de prototipos.
 */
export const MODE_DEFAULT_ENGINE_RULESET: ReadonlyMap<string, string> = new Map([
  ["deathmatch", "dm_practice@1"],
  ["team_deathmatch", "tdm_mvp@1"],
  ["capture_the_flag", "ctf_mvp@1"],
  ["zone_control", "zc_mvp@1"],
  ["last_man_standing", "lms_bo3@1"],
  ["domination", "dom_mvp@1"],
  ["juggernaut", "jugg_mvp@1"],
]);

/**
 * Lee `config.engineRulesetId` de la fila de `rulesets` (jsonb). Devuelve
 * `undefined` si no hay fila, no hay config, o el campo no es una cadena.
 * NO valida que el ruleset exista: eso lo hace `loadRuleset` aguas abajo.
 */
function engineRulesetIdFromRow(row: Record<string, unknown> | undefined): string | undefined {
  if (!row) return undefined;
  let config: unknown = row.config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return undefined;
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  // safeLookup: `config` es JSON venido de la BD, un objeto plano cuyo contenido
  // no controla este código.
  const value = safeLookup(config as Record<string, unknown>, "engineRulesetId");
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resuelve el ruleset REAL del motor para una batalla. `rulesetId` es el de la
 * BD (`battles.ruleset_id`, puede ser null); `mode` es `battles.mode`.
 */
export async function resolveBattleRuleset(db: Db, mode: unknown, rulesetId: unknown): Promise<RulesetResolution> {
  if (typeof mode !== "string" || mode.length === 0) {
    return { ok: false, code: "ruleset_unresolvable", message: `modo de batalla inválido: ${JSON.stringify(mode)}` };
  }

  let engineRulesetId: string | undefined;
  if (typeof rulesetId === "string" && rulesetId.length > 0) {
    let row: Record<string, unknown> | undefined;
    try {
      row = await db("rulesets").where({ id: rulesetId }).first();
    } catch (err) {
      // NO se cae al defecto por modo: si la BD no responde, no sabemos si esa
      // fila declaraba `engineRulesetId` — jugar con el defecto sería jugar con
      // reglas posiblemente distintas a las configuradas. Fail closed.
      return {
        ok: false,
        code: "ruleset_unresolvable",
        message: `no se pudo consultar el ruleset "${rulesetId}" de la batalla: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    engineRulesetId = engineRulesetIdFromRow(row);
  }
  const source = engineRulesetId ? `rulesets.config.engineRulesetId` : `modo "${mode}"`;
  engineRulesetId ??= MODE_DEFAULT_ENGINE_RULESET.get(mode);
  if (!engineRulesetId) {
    return {
      ok: false,
      code: "ruleset_unresolvable",
      message:
        `no hay ruleset del motor para el modo "${mode}" (ni la fila de rulesets de la batalla declara ` +
        `config.engineRulesetId): se rechaza en vez de jugar con reglas distintas a las pedidas.`,
    };
  }

  let ruleset: Ruleset;
  try {
    ruleset = loadRuleset(engineRulesetId);
  } catch (err) {
    return {
      ok: false,
      code: "ruleset_unresolvable",
      message: `el ruleset "${engineRulesetId}" (resuelto desde ${source}) no existe en el catálogo del motor: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (ruleset.mode !== mode) {
    return {
      ok: false,
      code: "ruleset_mode_mismatch",
      message:
        `el ruleset "${engineRulesetId}" (resuelto desde ${source}) juega el modo "${ruleset.mode}", ` +
        `pero la batalla es de modo "${mode}": se rechaza en vez de cambiar el modo en silencio.`,
    };
  }
  return { ok: true, ruleset };
}
