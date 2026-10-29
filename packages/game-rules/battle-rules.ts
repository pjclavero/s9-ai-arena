/**
 * R-RULES · Reglas de BATALLA: presets oficiales, modo personalizado, límites de
 * composición y la COPIA INMUTABLE que se guarda en cada batalla (`battles.rules`).
 *
 * Módulo PURO (sin BD ni motor): lo usan la API (validación y copia), el worker (juega
 * `engineRuleset` de la copia), las stats (perfil por modo) y la web (resumen). Una
 * sola autoridad para cada regla; la UI sólo ayuda, el servidor decide.
 *
 * Dos capas (ver ADR-021):
 *  - `RulesParams`: lo que elige el jugador, en su idioma (respawns por bot, minutos…);
 *  - `Ruleset` del motor: lo que se simula. `engineRulesetFor()` traduce una a la otra
 *    de forma determinista y la copia guarda AMBAS.
 */
import { BUDGET_CREDITS_MAX, BUDGET_CREDITS_MIN, BUDGET_CREDITS_MVP, TICK_HZ } from "./constants.js";
import { loadRuleset, type Ruleset, type TimeoutTiebreakCriterion } from "./index.js";

/** Versión del contrato de la copia. Se sube si cambia su forma. */
export const BATTLE_RULES_SCHEMA = 1;

export type RespawnMode = "none" | "limited" | "unlimited";
export type VictoryCondition = "elimination" | "score_limit" | "time_score";

export interface RulesParams {
  /** Vehículos por bando: 1 = 1 contra 1. */
  teamSize: number;
  respawn: {
    mode: RespawnMode;
    /** REAPARICIONES por bot (vidas = 1 + respawnsPerBot). Sólo con `limited`. */
    respawnsPerBot: number | null;
    /** Segundos hasta reaparecer. Sólo con respawn. */
    delaySeconds: number | null;
  };
  victory: VictoryCondition;
  /** Bajas para ganar. Sólo con `score_limit`. */
  scoreLimit: number | null;
  timeLimitMinutes: number;
  /** Topes de composición; null = sin restricción adicional. */
  botCredits: number | null;
  teamCredits: number | null;
  botMassKg: number | null;
  teamMassKg: number | null;
  friendlyFire: boolean;
}

/** Límites SERVER-SIDE (FASE 16). La web los lee de GET /rulesets; nunca manda ella. */
export const RULES_LIMITS = {
  teamSize: { min: 1, max: 4 },
  respawnsPerBot: { min: 1, max: 10 },
  delaySeconds: { min: 1, max: 30 },
  scoreLimit: { min: 1, max: 100 },
  timeLimitMinutes: { min: 1, max: 30 },
  botCredits: { min: BUDGET_CREDITS_MIN, max: BUDGET_CREDITS_MAX },
  teamCredits: { min: BUDGET_CREDITS_MIN, max: 4 * BUDGET_CREDITS_MAX },
  botMassKg: { min: 500, max: 10_000 },
  teamMassKg: { min: 500, max: 40_000 },
} as const;

/** Máximo de participantes de una batalla (no se sube en esta fase). */
export const MAX_BATTLE_PARTICIPANTS = 8;

export interface RulesPreset {
  id: string;
  version: number;
  format: "1v1" | "team";
  name: string;
  /** Una frase, para la tarjeta de la UI. */
  tagline: string;
  /** Explicación completa (qué pasa al morir, cómo se gana, qué pasa al acabar el tiempo). */
  description: string;
  /** Tamaños de bando admitidos. */
  teamSizes: number[];
  /** Parámetros del preset salvo `teamSize`, que elige el jugador dentro de `teamSizes`. */
  params: Omit<RulesParams, "teamSize">;
}

const NO_LIMITS = { botCredits: null, teamCredits: null, botMassKg: null, teamMassKg: null } as const;

/**
 * Presets OFICIALES v1. Inmutables: cambiar un valor exige `version + 1` (las batallas
 * ya creadas conservan su copia, así que tampoco se reinterpretan). Valores justificados
 * en DISENO.md §2 (balance medido).
 */
export const RULES_PRESETS: readonly RulesPreset[] = [
  {
    id: "duel",
    version: 1,
    format: "1v1",
    name: "Duelo",
    tagline: "Una vida. Sin reaparición.",
    description:
      "Gana el último bot operativo. Límite de 5 minutos; si se agota, gana quien conserve más casco (si empatan, tablas).",
    teamSizes: [1],
    params: {
      respawn: { mode: "none", respawnsPerBot: null, delaySeconds: null },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "combat",
    version: 1,
    format: "1v1",
    name: "Combate",
    tagline: "Reapariciones y límite de bajas.",
    description:
      "Reaparición ilimitada a los 5 s. Gana el primero en llegar a 5 bajas. Límite de seguridad de 10 minutos: gana quien tenga más bajas (si empatan, tablas).",
    teamSizes: [1],
    params: {
      respawn: { mode: "unlimited", respawnsPerBot: null, delaySeconds: 5 },
      victory: "score_limit",
      scoreLimit: 5,
      timeLimitMinutes: 10,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "endurance",
    version: 1,
    format: "1v1",
    name: "Resistencia",
    tagline: "Gana quien consiga más puntos antes de terminar el tiempo.",
    description:
      "5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar gana quien tenga más bajas (si empatan, tablas).",
    teamSizes: [1],
    params: {
      respawn: { mode: "unlimited", respawnsPerBot: null, delaySeconds: 5 },
      victory: "time_score",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "team_elimination",
    version: 1,
    format: "team",
    name: "Eliminación por equipos",
    tagline: "Sin reaparición. Pierde el equipo que se queda sin vehículos.",
    description:
      "Cada bot tiene una sola vida. Gana el equipo que conserve algún vehículo operativo. Límite de 8 minutos: gana quien tenga más vehículos vivos, luego más bajas, luego más casco; si no, tablas.",
    teamSizes: [2, 3, 4],
    params: {
      respawn: { mode: "none", respawnsPerBot: null, delaySeconds: null },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 8,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "team_limited_respawn",
    version: 1,
    format: "team",
    name: "Respawn limitado",
    tagline: "2 reapariciones por bot (3 vidas). Gana el último equipo en pie.",
    description:
      "Cada bot puede reaparecer 2 veces (3 vidas en total) a los 5 s. Gana el equipo que conserve vidas. Límite de 10 minutos: gana quien tenga más vidas restantes, luego más bajas, luego más casco; si no, tablas.",
    teamSizes: [2, 3, 4],
    params: {
      respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 5 },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 10,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "team_deathmatch",
    version: 1,
    format: "team",
    name: "Team Deathmatch",
    tagline: "Reaparición ilimitada. Gana el primer equipo en llegar a 10 bajas.",
    description:
      "Reaparición ilimitada a los 5 s; cada baja enemiga es un punto. Gana el primer equipo en llegar a 10. Límite de seguridad de 8 minutos: gana quien tenga más puntos (si empatan, tablas).",
    teamSizes: [2, 3, 4],
    params: {
      respawn: { mode: "unlimited", respawnsPerBot: null, delaySeconds: 5 },
      victory: "score_limit",
      scoreLimit: 10,
      timeLimitMinutes: 8,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
  {
    id: "team_endurance",
    version: 1,
    format: "team",
    name: "Resistencia por equipos",
    tagline: "Tiempo fijo. Gana el equipo con más puntos al terminar.",
    description:
      "5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar gana el equipo con más bajas (si empatan, tablas).",
    teamSizes: [2, 3, 4],
    params: {
      respawn: { mode: "unlimited", respawnsPerBot: null, delaySeconds: 5 },
      victory: "time_score",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
    },
  },
];

/** Busca un preset por id (Map, nunca indexación de objeto con datos del cliente). */
const PRESETS_BY_ID: ReadonlyMap<string, RulesPreset> = new Map(RULES_PRESETS.map((p) => [p.id, p]));
export function findPreset(id: unknown): RulesPreset | undefined {
  return typeof id === "string" ? PRESETS_BY_ID.get(id) : undefined;
}

/** Defectos del personalizado (lo que la UI precarga). */
export const CUSTOM_DEFAULTS: Omit<RulesParams, "teamSize"> = {
  respawn: { mode: "unlimited", respawnsPerBot: null, delaySeconds: 5 },
  victory: "score_limit",
  scoreLimit: 10,
  timeLimitMinutes: 10,
  ...NO_LIMITS,
  friendlyFire: false,
};

// ------------------------------------------------------------------ validación

export interface RulesError {
  field: string;
  code: "required" | "type" | "range" | "unknown_field" | "incompatible" | "unknown_preset";
  message: string;
}

/** Petición del cliente (cuerpo `rules` de POST /battles). */
export interface RulesRequest {
  preset?: unknown;
  teamSize?: unknown;
  params?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function checkKeys(o: Record<string, unknown>, allowed: string[], prefix: string, errs: RulesError[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      errs.push({ field: `${prefix}${k}`, code: "unknown_field", message: `campo desconocido: ${prefix}${k}` });
    }
  }
}

/** Entero en [min,max] o null si `nullable`. Rechaza floats, NaN, strings, negativos y cero fuera de rango. */
function intField(
  o: Record<string, unknown>,
  key: string,
  field: string,
  range: { min: number; max: number },
  errs: RulesError[],
  opts: { nullable: boolean },
): number | null {
  const v = own(o, key) ? o[key] : undefined;
  if (v === undefined || v === null) {
    if (opts.nullable) return null;
    errs.push({ field, code: "required", message: `${field} es obligatorio` });
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    errs.push({ field, code: "type", message: `${field} debe ser un número entero` });
    return null;
  }
  if (v < range.min || v > range.max) {
    errs.push({
      field,
      code: "range",
      message: `${field} debe estar entre ${range.min} y ${range.max} (recibido ${v})`,
    });
    return null;
  }
  return v;
}

const RESPAWN_MODES: readonly RespawnMode[] = ["none", "limited", "unlimited"];
const VICTORIES: readonly VictoryCondition[] = ["elimination", "score_limit", "time_score"];

/** Parsea y valida los parámetros de un personalizado. Estricto: claves desconocidas = error. */
export function parseCustomParams(raw: unknown, teamSize: number, errs: RulesError[]): RulesParams | null {
  if (!isObj(raw)) {
    errs.push({
      field: "rules.params",
      code: "required",
      message: "rules.params es obligatorio en una batalla personalizada",
    });
    return null;
  }
  const P = "rules.params.";
  checkKeys(
    raw,
    [
      "respawn",
      "victory",
      "scoreLimit",
      "timeLimitMinutes",
      "botCredits",
      "teamCredits",
      "botMassKg",
      "teamMassKg",
      "friendlyFire",
    ],
    P,
    errs,
  );
  const L = RULES_LIMITS;
  const respawnRaw = own(raw, "respawn") ? raw.respawn : undefined;
  let mode: RespawnMode = "unlimited";
  let respawnsPerBot: number | null = null;
  let delaySeconds: number | null = null;
  if (!isObj(respawnRaw)) {
    errs.push({ field: `${P}respawn`, code: "required", message: `${P}respawn es obligatorio` });
  } else {
    checkKeys(respawnRaw, ["mode", "respawnsPerBot", "delaySeconds"], `${P}respawn.`, errs);
    const m = own(respawnRaw, "mode") ? respawnRaw.mode : undefined;
    if (typeof m !== "string" || !(RESPAWN_MODES as readonly string[]).includes(m)) {
      errs.push({
        field: `${P}respawn.mode`,
        code: "type",
        message: `${P}respawn.mode debe ser none, limited o unlimited`,
      });
    } else mode = m as RespawnMode;
    respawnsPerBot = intField(respawnRaw, "respawnsPerBot", `${P}respawn.respawnsPerBot`, L.respawnsPerBot, errs, {
      nullable: mode !== "limited",
    });
    delaySeconds = intField(respawnRaw, "delaySeconds", `${P}respawn.delaySeconds`, L.delaySeconds, errs, {
      nullable: mode === "none",
    });
    if (mode !== "limited" && respawnsPerBot !== null) {
      errs.push({
        field: `${P}respawn.respawnsPerBot`,
        code: "incompatible",
        message: "respawnsPerBot sólo se admite con respawn limitado",
      });
    }
    if (mode === "none" && delaySeconds !== null) {
      errs.push({
        field: `${P}respawn.delaySeconds`,
        code: "incompatible",
        message: "delaySeconds no se admite sin reaparición",
      });
    }
  }
  const vRaw = own(raw, "victory") ? raw.victory : undefined;
  let victory: VictoryCondition = "score_limit";
  if (typeof vRaw !== "string" || !(VICTORIES as readonly string[]).includes(vRaw)) {
    errs.push({
      field: `${P}victory`,
      code: "type",
      message: `${P}victory debe ser elimination, score_limit o time_score`,
    });
  } else victory = vRaw as VictoryCondition;
  const scoreLimit = intField(raw, "scoreLimit", `${P}scoreLimit`, L.scoreLimit, errs, {
    nullable: victory !== "score_limit",
  });
  if (victory !== "score_limit" && scoreLimit !== null) {
    errs.push({
      field: `${P}scoreLimit`,
      code: "incompatible",
      message: "scoreLimit sólo se admite con victoria por límite de bajas",
    });
  }
  const timeLimitMinutes = intField(raw, "timeLimitMinutes", `${P}timeLimitMinutes`, L.timeLimitMinutes, errs, {
    nullable: false,
  });
  const botCredits = intField(raw, "botCredits", `${P}botCredits`, L.botCredits, errs, { nullable: true });
  const teamCredits = intField(raw, "teamCredits", `${P}teamCredits`, L.teamCredits, errs, { nullable: true });
  const botMassKg = intField(raw, "botMassKg", `${P}botMassKg`, L.botMassKg, errs, { nullable: true });
  const teamMassKg = intField(raw, "teamMassKg", `${P}teamMassKg`, L.teamMassKg, errs, { nullable: true });
  const ffRaw = own(raw, "friendlyFire") ? raw.friendlyFire : false;
  if (typeof ffRaw !== "boolean") {
    errs.push({ field: `${P}friendlyFire`, code: "type", message: `${P}friendlyFire debe ser true o false` });
  }
  const friendlyFire = ffRaw === true;
  const params: RulesParams = {
    teamSize,
    respawn: { mode, respawnsPerBot, delaySeconds },
    victory,
    scoreLimit,
    timeLimitMinutes: timeLimitMinutes ?? 1,
    botCredits,
    teamCredits,
    botMassKg,
    teamMassKg,
    friendlyFire,
  };
  errs.push(...incompatibilities(params));
  return params;
}

/** Combinaciones incompatibles (FASE 9/18). También se aplica a los presets (defensa). */
export function incompatibilities(p: RulesParams): RulesError[] {
  const errs: RulesError[] = [];
  const P = "rules.params.";
  if (p.victory === "elimination" && p.respawn.mode === "unlimited") {
    errs.push({
      field: `${P}victory`,
      code: "incompatible",
      message: "con reaparición ilimitada nadie queda eliminado: usa límite de bajas o puntos al acabar el tiempo",
    });
  }
  if (p.victory === "time_score" && p.respawn.mode === "none") {
    errs.push({
      field: `${P}victory`,
      code: "incompatible",
      message: "sin reaparición, «puntos al acabar el tiempo» es una eliminación: elige victoria por eliminación",
    });
  }
  if (p.victory === "score_limit" && p.scoreLimit !== null) {
    const lives =
      p.respawn.mode === "none" ? 1 : p.respawn.mode === "limited" ? 1 + (p.respawn.respawnsPerBot ?? 0) : Infinity;
    const reachable = p.teamSize * lives;
    if (p.scoreLimit > reachable) {
      errs.push({
        field: `${P}scoreLimit`,
        code: "incompatible",
        message: `límite de ${p.scoreLimit} bajas inalcanzable: el rival sólo tiene ${reachable} vida(s) en total`,
      });
    }
  }
  if (p.teamSize === 1) {
    if (p.friendlyFire) {
      errs.push({
        field: `${P}friendlyFire`,
        code: "incompatible",
        message: "el fuego amigo sólo tiene sentido por equipos",
      });
    }
    if (p.teamCredits !== null) {
      errs.push({
        field: `${P}teamCredits`,
        code: "incompatible",
        message: "en 1 contra 1 usa el límite por bot (botCredits)",
      });
    }
    if (p.teamMassKg !== null) {
      errs.push({
        field: `${P}teamMassKg`,
        code: "incompatible",
        message: "en 1 contra 1 usa el límite por bot (botMassKg)",
      });
    }
  }
  return errs;
}

// ------------------------------------------------------------- traducción

/** Ruleset base del motor por formato (el resto lo fijan los parámetros). */
export function baseEngineRulesetId(teamSize: number): "dm_practice@1" | "tdm_mvp@1" {
  return teamSize === 1 ? "dm_practice@1" : "tdm_mvp@1";
}

/** Modo de plataforma que juega un formato. */
export function modeForTeamSize(teamSize: number): "deathmatch" | "team_deathmatch" {
  return teamSize === 1 ? "deathmatch" : "team_deathmatch";
}

/** Desempate al tiempo derivado de la victoria (una tabla, para presets y personalizado). */
export function tiebreakFor(p: RulesParams): TimeoutTiebreakCriterion[] {
  if (p.victory === "elimination") return ["lives", "score", "hull"];
  // Por puntos: más bajas; con vidas contadas, a igualdad, más vidas restantes.
  return p.respawn.mode === "limited" ? ["score", "lives"] : ["score"];
}

/**
 * Parámetros → ruleset COMPLETO del motor. Determinista y sin estado: la copia guarda
 * el resultado, así que un cambio futuro de esta función no altera batallas creadas.
 */
export function engineRulesetFor(p: RulesParams, rulesetId: string): Ruleset {
  const respawn: Ruleset["respawn"] =
    p.respawn.mode === "none"
      ? { enabled: false, delayTicks: 0 }
      : {
          enabled: true,
          delayTicks: (p.respawn.delaySeconds ?? 5) * TICK_HZ,
          ...(p.respawn.mode === "limited" ? { maxRespawns: p.respawn.respawnsPerBot ?? 0 } : {}),
        };
  return loadRuleset(baseEngineRulesetId(p.teamSize), {
    rulesetId,
    budgetCredits: p.botCredits ?? BUDGET_CREDITS_MVP,
    timeLimitTicks: p.timeLimitMinutes * 60 * TICK_HZ,
    // Sin límite de bajas: el entero seguro máximo (sobrevive a JSON, a diferencia de Infinity).
    scoreToWin: p.victory === "score_limit" && p.scoreLimit !== null ? p.scoreLimit : Number.MAX_SAFE_INTEGER,
    friendlyFire: p.teamSize > 1 ? p.friendlyFire : false,
    respawn,
    timeoutTiebreak: tiebreakFor(p),
  });
}

/** Resultado de resolver `rules` de una petición (sin BD). */
export type ResolvedRules =
  | {
      ok: true;
      source: "preset" | "custom";
      preset: RulesPreset | null;
      params: RulesParams;
      mode: "deathmatch" | "team_deathmatch";
      engineRuleset: Ruleset;
      name: string;
      errors?: undefined;
    }
  | { ok: false; errors: RulesError[] };

/** `rules` de la petición → parámetros normalizados + ruleset del motor, o errores. */
export function resolveRulesRequest(raw: unknown): ResolvedRules {
  const errs: RulesError[] = [];
  if (!isObj(raw))
    return { ok: false, errors: [{ field: "rules", code: "type", message: "rules debe ser un objeto" }] };
  checkKeys(raw, ["preset", "teamSize", "params"], "rules.", errs);
  const teamSize = intField(raw, "teamSize", "rules.teamSize", RULES_LIMITS.teamSize, errs, { nullable: false });
  const presetId = own(raw, "preset") ? raw.preset : undefined;
  if (presetId === "custom") {
    if (teamSize === null) return { ok: false, errors: errs };
    const params = parseCustomParams(own(raw, "params") ? raw.params : undefined, teamSize, errs);
    if (errs.length > 0 || !params) return { ok: false, errors: errs };
    return {
      ok: true,
      source: "custom",
      preset: null,
      params,
      mode: modeForTeamSize(teamSize),
      engineRuleset: engineRulesetFor(params, "custom@1"),
      name: teamSize === 1 ? "Personalizada 1 contra 1" : "Personalizada por equipos",
    };
  }
  const preset = findPreset(presetId);
  if (!preset) {
    errs.push({ field: "rules.preset", code: "unknown_preset", message: `preset desconocido: ${String(presetId)}` });
    return { ok: false, errors: errs };
  }
  if (own(raw, "params") && raw.params !== undefined) {
    errs.push({
      field: "rules.params",
      code: "incompatible",
      message: "un preset oficial no admite parámetros: usa «custom» para cambiarlos",
    });
  }
  if (teamSize !== null && !preset.teamSizes.includes(teamSize)) {
    errs.push({
      field: "rules.teamSize",
      code: "incompatible",
      message: `${preset.name} admite bandos de ${preset.teamSizes.join(", ")}; recibido ${teamSize}`,
    });
  }
  if (errs.length > 0 || teamSize === null) return { ok: false, errors: errs };
  const params: RulesParams = { ...preset.params, respawn: { ...preset.params.respawn }, teamSize };
  const bad = incompatibilities(params);
  if (bad.length > 0) return { ok: false, errors: bad };
  return {
    ok: true,
    source: "preset",
    preset,
    params,
    mode: modeForTeamSize(teamSize),
    engineRuleset: engineRulesetFor(params, `${preset.id}@${preset.version}`),
    name: preset.name,
  };
}

// --------------------------------------------------------------- composición

export interface CompositionLimits {
  botCredits: number | null;
  teamCredits: number | null;
  botMassKg: number | null;
  teamMassKg: number | null;
}

export interface CompositionEntry {
  botId: string;
  label: string;
  team: string;
  costCredits: number;
  massKg: number;
}

export type CompositionViolationCode =
  "bot_credits_exceeded" | "team_credits_exceeded" | "bot_mass_exceeded" | "team_mass_exceeded";

export interface CompositionViolation {
  code: CompositionViolationCode;
  team: string;
  botId?: string;
  limit: number;
  actual: number;
  excess: number;
  message: string;
}

export interface CompositionReport {
  ok: boolean;
  limits: CompositionLimits;
  teams: {
    team: string;
    totalCredits: number;
    totalMassKg: number;
    ok: boolean;
    bots: (CompositionEntry & { ok: boolean })[];
  }[];
  violations: CompositionViolation[];
}

const kg = (n: number) => Math.round(n * 100) / 100;

/**
 * Comprueba los topes de créditos y masa por bot y por bando. Límite INCLUSIVO: justo
 * en el límite vale; una unidad por encima, no. Bandos y bots en orden de entrada.
 */
export function checkComposition(entries: readonly CompositionEntry[], limits: CompositionLimits): CompositionReport {
  const violations: CompositionViolation[] = [];
  const order: string[] = [];
  const byTeam = new Map<string, CompositionEntry[]>();
  for (const e of entries) {
    if (!byTeam.has(e.team)) {
      byTeam.set(e.team, []);
      order.push(e.team);
    }
    byTeam.get(e.team)!.push(e);
  }
  const teams: CompositionReport["teams"] = [];
  for (const team of order) {
    const list = byTeam.get(team)!;
    const bots = list.map((e) => {
      let ok = true;
      if (limits.botCredits !== null && e.costCredits > limits.botCredits) {
        ok = false;
        violations.push({
          code: "bot_credits_exceeded",
          team,
          botId: e.botId,
          limit: limits.botCredits,
          actual: e.costCredits,
          excess: e.costCredits - limits.botCredits,
          message: `${e.label} supera el presupuesto máximo por bot en ${e.costCredits - limits.botCredits} cr (${e.costCredits}/${limits.botCredits} cr)`,
        });
      }
      if (limits.botMassKg !== null && e.massKg > limits.botMassKg) {
        ok = false;
        violations.push({
          code: "bot_mass_exceeded",
          team,
          botId: e.botId,
          limit: limits.botMassKg,
          actual: kg(e.massKg),
          excess: kg(e.massKg - limits.botMassKg),
          message: `${e.label} supera la masa máxima por bot en ${kg(e.massKg - limits.botMassKg)} kg (${kg(e.massKg)}/${limits.botMassKg} kg)`,
        });
      }
      return { ...e, ok };
    });
    const totalCredits = list.reduce((s, e) => s + e.costCredits, 0);
    const totalMassKg = kg(list.reduce((s, e) => s + e.massKg, 0));
    let teamOk = bots.every((b) => b.ok);
    if (limits.teamCredits !== null && totalCredits > limits.teamCredits) {
      teamOk = false;
      violations.push({
        code: "team_credits_exceeded",
        team,
        limit: limits.teamCredits,
        actual: totalCredits,
        excess: totalCredits - limits.teamCredits,
        message: `el bando ${team} supera el presupuesto de equipo en ${totalCredits - limits.teamCredits} cr (${totalCredits}/${limits.teamCredits} cr)`,
      });
    }
    if (limits.teamMassKg !== null && totalMassKg > limits.teamMassKg) {
      teamOk = false;
      violations.push({
        code: "team_mass_exceeded",
        team,
        limit: limits.teamMassKg,
        actual: totalMassKg,
        excess: kg(totalMassKg - limits.teamMassKg),
        message: `el bando ${team} supera la masa máxima de equipo en ${kg(totalMassKg - limits.teamMassKg)} kg (${totalMassKg}/${limits.teamMassKg} kg)`,
      });
    }
    teams.push({ team, totalCredits, totalMassKg, ok: teamOk, bots });
  }
  return { ok: violations.length === 0, limits, teams, violations };
}

export function limitsOf(p: RulesParams | null): CompositionLimits {
  return {
    botCredits: p?.botCredits ?? null,
    teamCredits: p?.teamCredits ?? null,
    botMassKg: p?.botMassKg ?? null,
    teamMassKg: p?.teamMassKg ?? null,
  };
}

// ---------------------------------------------------------- copia inmutable

/** Copia de reglas guardada en `battles.rules`. Ver ADR-021. */
export interface BattleRulesSnapshot {
  schema: typeof BATTLE_RULES_SCHEMA;
  source: "preset" | "custom" | "classic";
  presetId: string | null;
  presetVersion: number | null;
  name: string;
  mode: string;
  platformRulesetId: string;
  params: RulesParams | null;
  composition: CompositionLimits;
  /** Catálogo de la batalla; null sólo si no había ninguno importado (el worker usa entonces el último, como 0.3.0). */
  catalogVersion: string | null;
  engineRuleset: Ruleset;
  engineVersion: string;
}

/**
 * Perfil de stats por modo (FASE 13): qué métricas tienen sentido.
 *  elimination · bajas, muertes, supervivientes;
 *  limited_respawn · bajas, muertes, respawns usados y restantes;
 *  deathmatch · puntos, bajas, muertes, respawns;
 *  time · puntuación final y duración;
 *  classic · lo de siempre (sin copia o rulesets de plataforma).
 */
export type StatsProfile = "elimination" | "limited_respawn" | "deathmatch" | "time" | "classic";

export function statsProfileOf(rules: Pick<BattleRulesSnapshot, "source" | "params"> | null | undefined): StatsProfile {
  if (!rules || rules.source === "classic" || !rules.params) return "classic";
  const p = rules.params;
  if (p.victory === "time_score") return "time";
  if (p.respawn.mode === "limited") return "limited_respawn";
  if (p.respawn.mode === "none") return "elimination";
  return "deathmatch";
}

/** Resumen legible (FASE 10): las líneas que la UI enseña antes de crear. */
export function summarizeParams(p: RulesParams): string[] {
  const lines: string[] = [];
  lines.push(p.teamSize === 1 ? "1 contra 1" : `${p.teamSize} contra ${p.teamSize}`);
  if (p.respawn.mode === "none") lines.push("Respawns: ninguno (1 vida)");
  else if (p.respawn.mode === "limited") {
    const n = p.respawn.respawnsPerBot ?? 0;
    lines.push(`Respawns: ${n} por bot (${n + 1} vidas)`);
  } else lines.push("Respawns: ilimitados");
  if (p.respawn.mode !== "none") lines.push(`Respawn: ${p.respawn.delaySeconds ?? 5} s`);
  if (p.victory === "elimination") lines.push("Victoria: eliminación");
  else if (p.victory === "score_limit") lines.push(`Victoria: ${p.scoreLimit} bajas`);
  else lines.push("Victoria: más puntos al acabar el tiempo");
  lines.push(`${p.victory === "time_score" ? "Duración" : "Tiempo máximo"}: ${p.timeLimitMinutes} min`);
  if (p.botCredits !== null) lines.push(`Máx. por bot: ${p.botCredits} cr`);
  if (p.teamCredits !== null) lines.push(`Máx. equipo: ${p.teamCredits} cr`);
  if (p.botMassKg !== null) lines.push(`Máx. masa por bot: ${p.botMassKg} kg`);
  if (p.teamMassKg !== null) lines.push(`Máx. masa equipo: ${p.teamMassKg} kg`);
  if (p.teamSize > 1) lines.push(`Fuego amigo: ${p.friendlyFire ? "activado" : "desactivado"}`);
  return lines;
}
