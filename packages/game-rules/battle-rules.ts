/**
 * R-RULES · Reglas de BATALLA: presets oficiales, modo personalizado, límites de
 * composición y la COPIA INMUTABLE que se guarda en cada batalla (`battles.rules`) y en
 * cada torneo (`tournaments.rules`).
 *
 * Módulo PURO (sin BD ni motor): lo usan la API (validación y copia), el worker (juega
 * `engineRuleset` de la copia), las stats (perfil por modo), la web (resumen) y el
 * generador de la documentación de reglas (`docs/user/rules.md`, ver
 * `scripts/generate-rules-doc.ts`). Una sola autoridad para cada regla; la UI sólo
 * ayuda, el servidor decide.
 *
 * Dos capas (ver ADR-021 y ADR-022):
 *  - `RulesParams`: lo que elige el jugador, en su idioma (reapariciones, minutos…);
 *  - `Ruleset` del motor: lo que se simula. `engineRulesetFor()` traduce una a la otra
 *    de forma determinista y la copia guarda AMBAS.
 */
import { BUDGET_CREDITS_MAX, BUDGET_CREDITS_MIN, BUDGET_CREDITS_MVP, TICK_HZ } from "./constants.js";
import { loadRuleset, type Ruleset, type TimeoutTiebreakCriterion } from "./index.js";

/** Versión del contrato de la copia. Se sube si cambia su forma. 2 = motor 0.4.0 (ADR-022). */
export const BATTLE_RULES_SCHEMA = 2;
/** Copias anteriores que se siguen LEYENDO (nunca se reescriben). */
export const READABLE_BATTLE_RULES_SCHEMAS: readonly number[] = [1, 2];

export type RespawnMode = "none" | "limited" | "unlimited";
export type VictoryCondition = "elimination" | "score_limit" | "time_score";
/** Juego: combate (bajas) o capturar la bandera. */
export type GameKind = "combat" | "capture_the_flag";

export interface CtfParams {
  /** Segundos hasta que una bandera caída vuelve sola a su base. */
  flagReturnSeconds: number;
  /** ¿Hace falta tener la bandera PROPIA en base para puntuar una captura? */
  requireOwnFlagAtBase: boolean;
}

export interface RulesParams {
  /** Vehículos por bando: 1 = 1 contra 1. */
  teamSize: number;
  /** Juego. Ausente en copias de schema 1 ⇒ "combat". */
  game: GameKind;
  respawn: {
    mode: RespawnMode;
    /**
     * REAPARICIONES por bot: veces que puede volver tras morir (vidas = maxRespawns + 1).
     * Sólo con `limited`; 0 = una sola vida.
     */
    maxRespawns: number | null;
    /** Segundos hasta reaparecer. Sólo con respawn. */
    delaySeconds: number | null;
  };
  victory: VictoryCondition;
  /** Bajas (o capturas en CTF) para ganar. Sólo con `score_limit`. */
  scoreLimit: number | null;
  timeLimitMinutes: number;
  /** Topes de composición; null = sin restricción adicional. */
  botCredits: number | null;
  teamCredits: number | null;
  botMassKg: number | null;
  teamMassKg: number | null;
  friendlyFire: boolean;
  /** Sólo en CTF. */
  ctf: CtfParams | null;
}

/**
 * Límite de SEGURIDAD de la prórroga de CTF (ADR-022): si en 3 minutos de prórroga nadie
 * captura, la batalla termina en empate. Explícito, documentado y visible en la UI.
 */
export const CTF_OVERTIME_MAX_SECONDS = 180;

/** Límites SERVER-SIDE (FASE 16). La web los lee de GET /rulesets; nunca manda ella. */
export const RULES_LIMITS = {
  teamSize: { min: 1, max: 4 },
  maxRespawns: { min: 0, max: 10 },
  delaySeconds: { min: 1, max: 30 },
  scoreLimit: { min: 1, max: 100 },
  captures: { min: 1, max: 10 },
  timeLimitMinutes: { min: 1, max: 30 },
  flagReturnSeconds: { min: 1, max: 60 },
  botCredits: { min: BUDGET_CREDITS_MIN, max: BUDGET_CREDITS_MAX },
  teamCredits: { min: BUDGET_CREDITS_MIN, max: 4 * BUDGET_CREDITS_MAX },
  botMassKg: { min: 500, max: 10_000 },
  teamMassKg: { min: 500, max: 40_000 },
} as const;

/** Máximo de participantes de una batalla (no se sube en esta fase). */
export const MAX_BATTLE_PARTICIPANTS = 8;

// ------------------------------------------------------------------ desempates

/**
 * Familias de desempate (decisión del operador, ADR-022). La familia la decide el tipo
 * de reaparición (y CTF), no el preset: presets y personalizado comparten la tabla.
 */
export type TiebreakFamily = "elimination" | "limited_respawn" | "deathmatch" | "capture_the_flag";

export interface TiebreakRule {
  family: TiebreakFamily;
  /** Nombre del modo para la documentación. */
  label: string;
  /** Criterios del motor, en orden (vacío en CTF: lo resuelve la prórroga). */
  criteria: TimeoutTiebreakCriterion[];
  /** Pasos legibles, en orden, tal como se enseñan al usuario. */
  steps: string[];
}

export const TIEBREAK_RULES: Readonly<Record<TiebreakFamily, TiebreakRule>> = {
  elimination: {
    family: "elimination",
    label: "Eliminación (sin reaparición)",
    criteria: ["alive", "lives", "kills"],
    steps: ["más bots vivos", "más vidas/reapariciones restantes", "más bajas", "empate"],
  },
  limited_respawn: {
    family: "limited_respawn",
    label: "Respawn limitado",
    criteria: ["score", "alive", "respawns_left", "kills"],
    steps: ["más puntos", "más bots vivos", "más reapariciones restantes", "más bajas", "empate"],
  },
  deathmatch: {
    family: "deathmatch",
    label: "Team Deathmatch / reaparición ilimitada",
    criteria: ["score", "kills"],
    steps: ["más puntos", "más bajas", "empate"],
  },
  capture_the_flag: {
    family: "capture_the_flag",
    label: "Capturar la bandera",
    criteria: [],
    steps: [
      "más capturas",
      "si empatan al acabar el tiempo: prórroga con el mismo estado (no se reinician bots, banderas ni posiciones)",
      "en la prórroga, la siguiente captura gana",
      `si en ${CTF_OVERTIME_MAX_SECONDS / 60} minutos de prórroga nadie captura (límite de seguridad): empate`,
    ],
  },
};

export function tiebreakFamilyOf(p: Pick<RulesParams, "game" | "respawn">): TiebreakFamily {
  if (p.game === "capture_the_flag") return "capture_the_flag";
  if (p.respawn.mode === "none") return "elimination";
  if (p.respawn.mode === "limited") return "limited_respawn";
  return "deathmatch";
}

/** Desempate al tiempo derivado de los parámetros (una tabla, para presets y personalizado). */
export function tiebreakFor(p: Pick<RulesParams, "game" | "respawn">): TimeoutTiebreakCriterion[] {
  return [...TIEBREAK_RULES[tiebreakFamilyOf(p)].criteria];
}

/** Lectura humana de `maxRespawns` (la UI y la documentación usan SIEMPRE esta). */
export function respawnLabel(p: Pick<RulesParams, "respawn">): string {
  if (p.respawn.mode === "none") return "Sin reaparición (1 vida)";
  if (p.respawn.mode === "unlimited") return "Reaparición ilimitada";
  const n = p.respawn.maxRespawns ?? 0;
  const lives = n + 1;
  return `${n} ${n === 1 ? "reaparición" : "reapariciones"} por bot (${lives} ${lives === 1 ? "vida" : "vidas"} en total)`;
}

// --------------------------------------------------------------------- presets

export interface RulesPreset {
  id: string;
  version: number;
  format: "1v1" | "team";
  /** Modo de plataforma que juega el preset (en equipos sin CTF, team_deathmatch). */
  game: GameKind;
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

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * Presets OFICIALES. Versionados e INMUTABLES: cambiar una regla de `X@1` exige añadir
 * `X@2` (nunca editar `X@1`); las batallas y torneos ya creados conservan su copia, así
 * que tampoco se reinterpretan. `rules-presets-immutable.test.ts` fija la huella de cada
 * versión publicada. Valores justificados en DISENO.md §2 (balance medido) y ADR-022.
 */
export const RULES_PRESETS: readonly RulesPreset[] = deepFreeze([
  {
    id: "duel",
    version: 1,
    format: "1v1",
    game: "combat",
    name: "Duelo",
    tagline: "Una vida. Sin reaparición.",
    description:
      "Gana el último bot operativo. Límite de 5 minutos; si se agota: gana el bot vivo; si siguen los dos, más bajas; si no, empate.",
    teamSizes: [1],
    params: {
      game: "combat",
      respawn: { mode: "none", maxRespawns: null, delaySeconds: null },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "combat",
    version: 1,
    format: "1v1",
    game: "combat",
    name: "Combate",
    tagline: "Reapariciones y límite de bajas.",
    description:
      "Reaparición ilimitada a los 5 s. Gana el primero en llegar a 5 bajas. Límite de seguridad de 10 minutos: más puntos, luego más bajas; si no, empate.",
    teamSizes: [1],
    params: {
      game: "combat",
      respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
      victory: "score_limit",
      scoreLimit: 5,
      timeLimitMinutes: 10,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "endurance",
    version: 1,
    format: "1v1",
    game: "combat",
    name: "Resistencia",
    tagline: "Gana quien consiga más puntos antes de terminar el tiempo.",
    description:
      "5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar: más puntos, luego más bajas; si no, empate.",
    teamSizes: [1],
    params: {
      game: "combat",
      respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
      victory: "time_score",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "team_elimination",
    version: 1,
    format: "team",
    game: "combat",
    name: "Eliminación por equipos",
    tagline: "Sin reaparición. Pierde el equipo que se queda sin vehículos.",
    description:
      "Cada bot tiene una sola vida. Gana el equipo que conserve algún vehículo operativo. Límite de 8 minutos: más bots vivos, luego más vidas restantes, luego más bajas; si no, empate.",
    teamSizes: [2, 3, 4],
    params: {
      game: "combat",
      respawn: { mode: "none", maxRespawns: null, delaySeconds: null },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 8,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "team_limited_respawn",
    version: 1,
    format: "team",
    game: "combat",
    name: "Respawn limitado",
    tagline: "2 reapariciones por bot (3 vidas). Gana el último equipo en pie.",
    description:
      "Cada bot puede reaparecer 2 veces (maxRespawns = 2: 3 vidas en total) a los 5 s. Gana el equipo que conserve vidas. Límite de 10 minutos: más puntos, luego más bots vivos, luego más reapariciones restantes, luego más bajas; si no, empate.",
    teamSizes: [2, 3, 4],
    params: {
      game: "combat",
      respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 },
      victory: "elimination",
      scoreLimit: null,
      timeLimitMinutes: 10,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "team_deathmatch",
    version: 1,
    format: "team",
    game: "combat",
    name: "Team Deathmatch",
    tagline: "Reaparición ilimitada. Gana el primer equipo en llegar a 10 bajas.",
    description:
      "Reaparición ilimitada a los 5 s; cada baja enemiga es un punto. Gana el primer equipo en llegar a 10. Límite de seguridad de 8 minutos: más puntos, luego más bajas; si no, empate.",
    teamSizes: [2, 3, 4],
    params: {
      game: "combat",
      respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
      victory: "score_limit",
      scoreLimit: 10,
      timeLimitMinutes: 8,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "team_endurance",
    version: 1,
    format: "team",
    game: "combat",
    name: "Resistencia por equipos",
    tagline: "Tiempo fijo. Gana el equipo con más puntos al terminar.",
    description:
      "5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar: más puntos, luego más bajas; si no, empate.",
    teamSizes: [2, 3, 4],
    params: {
      game: "combat",
      respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
      victory: "time_score",
      scoreLimit: null,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: null,
    },
  },
  {
    id: "ctf",
    version: 1,
    format: "team",
    game: "capture_the_flag",
    name: "Capturar la bandera",
    tagline: "3 capturas para ganar. Empate al tiempo ⇒ prórroga: la siguiente captura gana.",
    description:
      "Cada equipo tiene bandera y base. Tocar la bandera rival la recoge; el portador puede seguir combatiendo; si muere, la bandera cae: un rival puede recogerla y un compañero del dueño devolverla; si nadie la toca vuelve sola a su base a los 10 s. Llevar la bandera rival a tu base puntúa si la tuya está en su base. Gana quien llegue a 3 capturas o tenga más al acabar los 5 minutos. Empate ⇒ prórroga con el mismo estado: la siguiente captura gana; si en 3 minutos nadie captura, empate. Reaparición ilimitada a los 5 s; sin fuego amigo.",
    teamSizes: [2, 3, 4],
    params: {
      game: "capture_the_flag",
      respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
      victory: "score_limit",
      scoreLimit: 3,
      timeLimitMinutes: 5,
      ...NO_LIMITS,
      friendlyFire: false,
      ctf: { flagReturnSeconds: 10, requireOwnFlagAtBase: true },
    },
  },
] satisfies RulesPreset[]);

/** Clave canónica de un preset versionado: `id@version`. */
export const presetKey = (p: Pick<RulesPreset, "id" | "version">) => `${p.id}@${p.version}`;

/** Busca un preset por id (Map, nunca indexación de objeto con datos del cliente). */
const PRESETS_BY_KEY: ReadonlyMap<string, RulesPreset> = new Map(RULES_PRESETS.map((p) => [presetKey(p), p]));
const LATEST_BY_ID: ReadonlyMap<string, RulesPreset> = new Map(
  [...RULES_PRESETS].sort((a, b) => a.version - b.version).map((p) => [p.id, p]),
);
/**
 * `id` ⇒ versión MÁS RECIENTE; `id@N` ⇒ exactamente esa versión. La copia guarda la
 * versión resuelta, así que una versión nueva no cambia batallas ya creadas.
 */
export function findPreset(id: unknown): RulesPreset | undefined {
  if (typeof id !== "string") return undefined;
  return id.includes("@") ? PRESETS_BY_KEY.get(id) : LATEST_BY_ID.get(id);
}

/** Presets vigentes (última versión de cada id), en el orden del registro. */
export function currentPresets(): RulesPreset[] {
  const latest = new Set([...LATEST_BY_ID.values()]);
  return RULES_PRESETS.filter((p) => latest.has(p));
}

/** Defectos del personalizado (lo que la UI precarga). */
export const CUSTOM_DEFAULTS: Omit<RulesParams, "teamSize"> = deepFreeze({
  game: "combat",
  respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
  victory: "score_limit",
  scoreLimit: 10,
  timeLimitMinutes: 10,
  ...NO_LIMITS,
  friendlyFire: false,
  ctf: null,
} satisfies Omit<RulesParams, "teamSize">);

/** Defectos del personalizado de CTF (los del preset base `ctf@1`). */
export const CUSTOM_CTF_DEFAULTS: Omit<RulesParams, "teamSize"> = deepFreeze({
  game: "capture_the_flag",
  respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
  victory: "score_limit",
  scoreLimit: 3,
  timeLimitMinutes: 5,
  ...NO_LIMITS,
  friendlyFire: false,
  ctf: { flagReturnSeconds: 10, requireOwnFlagAtBase: true },
} satisfies Omit<RulesParams, "teamSize">);

/**
 * Lo que el personalizado NO deja tocar (decisión del operador): física, daño, HP,
 * sensores, munición, velocidad. Se rechaza con un mensaje explícito, no como «campo
 * desconocido» genérico, para que nadie crea que es un despiste.
 */
export const CUSTOM_FORBIDDEN_FIELDS: readonly string[] = [
  "damageMultiplier",
  "gravity",
  "speed",
  "speedMultiplier",
  "hp",
  "hullHp",
  "sensors",
  "sensorRange",
  "infiniteAmmo",
  "ammo",
  "physics",
  "mass",
  "energy",
];

// ------------------------------------------------------------------ validación

export interface RulesError {
  field: string;
  code: "required" | "type" | "range" | "unknown_field" | "incompatible" | "unknown_preset" | "forbidden_field";
  message: string;
}

/** Petición del cliente (cuerpo `rules` de POST /battles y POST /tournaments). */
export interface RulesRequest {
  preset?: unknown;
  teamSize?: unknown;
  params?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function checkKeys(o: Record<string, unknown>, allowed: string[], prefix: string, errs: RulesError[]): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if (CUSTOM_FORBIDDEN_FIELDS.includes(k)) {
      errs.push({
        field: `${prefix}${k}`,
        code: "forbidden_field",
        message: `${prefix}${k}: el modo personalizado sólo cambia reglas competitivas; física, daño, HP, sensores y munición no se pueden alterar`,
      });
    } else {
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

function boolField(o: Record<string, unknown>, key: string, field: string, dflt: boolean, errs: RulesError[]): boolean {
  const v = own(o, key) ? o[key] : dflt;
  if (typeof v !== "boolean") {
    errs.push({ field, code: "type", message: `${field} debe ser true o false` });
    return dflt;
  }
  return v;
}

const RESPAWN_MODES: readonly RespawnMode[] = ["none", "limited", "unlimited"];
const VICTORIES: readonly VictoryCondition[] = ["elimination", "score_limit", "time_score"];
const GAMES: readonly GameKind[] = ["combat", "capture_the_flag"];

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
      "game",
      "respawn",
      "victory",
      "scoreLimit",
      "timeLimitMinutes",
      "botCredits",
      "teamCredits",
      "botMassKg",
      "teamMassKg",
      "friendlyFire",
      "ctf",
    ],
    P,
    errs,
  );
  const L = RULES_LIMITS;
  const gRaw = own(raw, "game") ? raw.game : "combat";
  let game: GameKind = "combat";
  if (typeof gRaw !== "string" || !(GAMES as readonly string[]).includes(gRaw)) {
    errs.push({ field: `${P}game`, code: "type", message: `${P}game debe ser combat o capture_the_flag` });
  } else game = gRaw as GameKind;
  const respawnRaw = own(raw, "respawn") ? raw.respawn : undefined;
  let mode: RespawnMode = "unlimited";
  let maxRespawns: number | null = null;
  let delaySeconds: number | null = null;
  if (!isObj(respawnRaw)) {
    errs.push({ field: `${P}respawn`, code: "required", message: `${P}respawn es obligatorio` });
  } else {
    checkKeys(respawnRaw, ["mode", "maxRespawns", "delaySeconds"], `${P}respawn.`, errs);
    const m = own(respawnRaw, "mode") ? respawnRaw.mode : undefined;
    if (typeof m !== "string" || !(RESPAWN_MODES as readonly string[]).includes(m)) {
      errs.push({
        field: `${P}respawn.mode`,
        code: "type",
        message: `${P}respawn.mode debe ser none, limited o unlimited`,
      });
    } else mode = m as RespawnMode;
    maxRespawns = intField(respawnRaw, "maxRespawns", `${P}respawn.maxRespawns`, L.maxRespawns, errs, {
      nullable: mode !== "limited",
    });
    delaySeconds = intField(respawnRaw, "delaySeconds", `${P}respawn.delaySeconds`, L.delaySeconds, errs, {
      nullable: mode === "none",
    });
    if (mode !== "limited" && maxRespawns !== null) {
      errs.push({
        field: `${P}respawn.maxRespawns`,
        code: "incompatible",
        message: "maxRespawns (reapariciones por bot) sólo se admite con respawn limitado",
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
  const scoreLimit = intField(
    raw,
    "scoreLimit",
    `${P}scoreLimit`,
    game === "capture_the_flag" ? L.captures : L.scoreLimit,
    errs,
    { nullable: victory !== "score_limit" },
  );
  if (victory !== "score_limit" && scoreLimit !== null) {
    errs.push({
      field: `${P}scoreLimit`,
      code: "incompatible",
      message: "scoreLimit sólo se admite con victoria por límite de bajas/capturas",
    });
  }
  const timeLimitMinutes = intField(raw, "timeLimitMinutes", `${P}timeLimitMinutes`, L.timeLimitMinutes, errs, {
    nullable: false,
  });
  const botCredits = intField(raw, "botCredits", `${P}botCredits`, L.botCredits, errs, { nullable: true });
  const teamCredits = intField(raw, "teamCredits", `${P}teamCredits`, L.teamCredits, errs, { nullable: true });
  const botMassKg = intField(raw, "botMassKg", `${P}botMassKg`, L.botMassKg, errs, { nullable: true });
  const teamMassKg = intField(raw, "teamMassKg", `${P}teamMassKg`, L.teamMassKg, errs, { nullable: true });
  const friendlyFire = boolField(raw, "friendlyFire", `${P}friendlyFire`, false, errs);
  let ctf: CtfParams | null = null;
  const ctfRaw = own(raw, "ctf") ? raw.ctf : undefined;
  if (game === "capture_the_flag") {
    const c = ctfRaw === undefined || ctfRaw === null ? {} : ctfRaw;
    if (!isObj(c)) {
      errs.push({ field: `${P}ctf`, code: "type", message: `${P}ctf debe ser un objeto` });
    } else {
      checkKeys(c, ["flagReturnSeconds", "requireOwnFlagAtBase"], `${P}ctf.`, errs);
      const flagReturnSeconds =
        intField(c, "flagReturnSeconds", `${P}ctf.flagReturnSeconds`, L.flagReturnSeconds, errs, {
          nullable: true,
        }) ?? 10;
      const requireOwnFlagAtBase = boolField(c, "requireOwnFlagAtBase", `${P}ctf.requireOwnFlagAtBase`, true, errs);
      ctf = { flagReturnSeconds, requireOwnFlagAtBase };
    }
  } else if (ctfRaw !== undefined && ctfRaw !== null) {
    errs.push({ field: `${P}ctf`, code: "incompatible", message: "ctf sólo se admite con game = capture_the_flag" });
  }
  const params: RulesParams = {
    teamSize,
    game,
    respawn: { mode, maxRespawns, delaySeconds },
    victory,
    scoreLimit,
    timeLimitMinutes: timeLimitMinutes ?? 1,
    botCredits,
    teamCredits,
    botMassKg,
    teamMassKg,
    friendlyFire,
    ctf,
  };
  errs.push(...incompatibilities(params));
  return params;
}

/** Combinaciones incompatibles (FASE 9/18). También se aplica a los presets (defensa). */
export function incompatibilities(p: RulesParams): RulesError[] {
  const errs: RulesError[] = [];
  const P = "rules.params.";
  if (p.game === "capture_the_flag") {
    if (p.victory !== "score_limit") {
      errs.push({
        field: `${P}victory`,
        code: "incompatible",
        message: "en CTF se gana por capturas: victory debe ser score_limit (capturas para ganar)",
      });
    }
    if (p.respawn.mode !== "unlimited") {
      errs.push({
        field: `${P}respawn.mode`,
        code: "incompatible",
        message: "en CTF la reaparición es ilimitada (una eliminación dejaría la bandera sin disputa)",
      });
    }
    return errs.concat(compositionIncompatibilities(p));
  }
  if (p.victory === "elimination" && p.respawn.mode === "unlimited") {
    errs.push({
      field: `${P}victory`,
      code: "incompatible",
      message: "con reaparición ilimitada nadie queda eliminado: usa límite de bajas o puntos al acabar el tiempo",
    });
  }
  if (p.victory === "time_score" && p.respawn.mode === "limited") {
    // Revisión PR #204: con vidas contadas la batalla puede acabar por ELIMINACIÓN antes
    // del tiempo, y entonces «puntos al acabar el tiempo» engaña (resumen y perfil `time`).
    errs.push({
      field: `${P}victory`,
      code: "incompatible",
      message:
        "con reapariciones limitadas un equipo puede quedar eliminado antes del final: usa eliminación o límite de bajas, o reaparición ilimitada",
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
      p.respawn.mode === "none" ? 1 : p.respawn.mode === "limited" ? 1 + (p.respawn.maxRespawns ?? 0) : Infinity;
    const reachable = p.teamSize * lives;
    if (p.scoreLimit > reachable) {
      errs.push({
        field: `${P}scoreLimit`,
        code: "incompatible",
        message: `límite de ${p.scoreLimit} bajas inalcanzable: el rival sólo tiene ${reachable} vida(s) en total`,
      });
    }
  }
  return errs.concat(compositionIncompatibilities(p));
}

function compositionIncompatibilities(p: RulesParams): RulesError[] {
  const errs: RulesError[] = [];
  const P = "rules.params.";
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
  // Presupuesto de equipo con reparto DESIGUAL (decisión del operador): el tope de bot
  // puede faltar o ser mayor que el reparto igualitario; sólo se rechaza lo imposible.
  if (p.teamCredits !== null && p.botCredits !== null && p.botCredits > p.teamCredits) {
    errs.push({
      field: `${P}botCredits`,
      code: "incompatible",
      message: `el tope por bot (${p.botCredits} cr) no puede superar el presupuesto del equipo (${p.teamCredits} cr)`,
    });
  }
  if (p.teamMassKg !== null && p.botMassKg !== null && p.botMassKg > p.teamMassKg) {
    errs.push({
      field: `${P}botMassKg`,
      code: "incompatible",
      message: `la masa máxima por bot (${p.botMassKg} kg) no puede superar la del equipo (${p.teamMassKg} kg)`,
    });
  }
  return errs;
}

// ------------------------------------------------------------- traducción

/** Ruleset base del motor por juego y formato (el resto lo fijan los parámetros). */
export function baseEngineRulesetId(
  p: Pick<RulesParams, "teamSize" | "game">,
): "dm_practice@1" | "tdm_mvp@1" | "ctf_mvp@1" {
  if (p.game === "capture_the_flag") return "ctf_mvp@1";
  return p.teamSize === 1 ? "dm_practice@1" : "tdm_mvp@1";
}

export type RulesMode = "deathmatch" | "team_deathmatch" | "capture_the_flag";

/** Modo de plataforma que juega un formato. */
export function modeFor(p: Pick<RulesParams, "teamSize" | "game">): RulesMode {
  if (p.game === "capture_the_flag") return "capture_the_flag";
  return p.teamSize === 1 ? "deathmatch" : "team_deathmatch";
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
          ...(p.respawn.mode === "limited" ? { maxRespawns: p.respawn.maxRespawns ?? 0 } : {}),
        };
  const isCtf = p.game === "capture_the_flag";
  return loadRuleset(baseEngineRulesetId(p), {
    rulesetId,
    budgetCredits: p.botCredits ?? BUDGET_CREDITS_MVP,
    timeLimitTicks: p.timeLimitMinutes * 60 * TICK_HZ,
    // Sin límite de bajas: el entero seguro máximo (sobrevive a JSON, a diferencia de Infinity).
    scoreToWin: p.victory === "score_limit" && p.scoreLimit !== null ? p.scoreLimit : Number.MAX_SAFE_INTEGER,
    friendlyFire: p.teamSize > 1 ? p.friendlyFire : false,
    respawn,
    ...(isCtf
      ? {
          ctf: {
            requireOwnFlagAtBase: p.ctf?.requireOwnFlagAtBase ?? true,
            flagReturnTicks: (p.ctf?.flagReturnSeconds ?? 10) * TICK_HZ,
          },
          overtime: { kind: "next_score_wins" as const, maxTicks: CTF_OVERTIME_MAX_SECONDS * TICK_HZ },
        }
      : { timeoutTiebreak: tiebreakFor(p) }),
  });
}

/** Resultado de resolver `rules` de una petición (sin BD). */
export type ResolvedRules =
  | {
      ok: true;
      source: "preset" | "custom";
      preset: RulesPreset | null;
      params: RulesParams;
      mode: RulesMode;
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
    const ctf = params.game === "capture_the_flag";
    return {
      ok: true,
      source: "custom",
      preset: null,
      params,
      mode: modeFor(params),
      engineRuleset: engineRulesetFor(params, ctf ? "custom_ctf@1" : "custom@1"),
      name: ctf ? "CTF personalizada" : teamSize === 1 ? "Personalizada 1 contra 1" : "Personalizada por equipos",
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
  const params: RulesParams = structuredClone({ ...preset.params, teamSize }) as RulesParams;
  const bad = incompatibilities(params);
  if (bad.length > 0) return { ok: false, errors: bad };
  return {
    ok: true,
    source: "preset",
    preset,
    params,
    mode: modeFor(params),
    engineRuleset: engineRulesetFor(params, presetKey(preset)),
    name: preset.name,
  };
}

/** Normaliza parámetros de una copia de schema 1 (sin `game`/`ctf`) para leerla. */
export function normalizeParams(
  p: RulesParams | (Omit<RulesParams, "game" | "ctf"> & Partial<RulesParams>),
): RulesParams {
  const r = p.respawn as RulesParams["respawn"] & { respawnsPerBot?: number | null };
  return {
    ...p,
    game: p.game ?? "combat",
    ctf: p.ctf ?? null,
    respawn: {
      mode: r.mode,
      maxRespawns: r.maxRespawns !== undefined ? r.maxRespawns : (r.respawnsPerBot ?? null),
      delaySeconds: r.delaySeconds,
    },
  } as RulesParams;
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
 * Masa en centésimas de kg REDONDEADA HACIA ARRIBA: es la cifra que se compara con el
 * tope Y la que se muestra (revisión PR #204: antes el bot comparaba la masa cruda y
 * mostraba la redondeada ⇒ «supera en 0 kg (3000/3000)», y un equipo de 5000,004 kg
 * pasaba un tope de 5000). Antes de subir se quita el ruido de coma flotante (1e-6
 * kg) para que una suma exacta como 0,1 + 0,2 + 2999,7 no se convierta en 3000,01.
 */
const kgUp = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;

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
    const bots = list.map((raw) => {
      const e = { ...raw, massKg: kgUp(raw.massKg) };
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
          actual: e.massKg,
          excess: kg(e.massKg - limits.botMassKg),
          message: `${e.label} supera la masa máxima por bot en ${kg(e.massKg - limits.botMassKg)} kg (${e.massKg}/${limits.botMassKg} kg)`,
        });
      }
      return { ...e, ok };
    });
    const totalCredits = list.reduce((s, e) => s + e.costCredits, 0);
    const totalMassKg = kgUp(list.reduce((s, e) => s + e.massKg, 0));
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

/**
 * Copia de reglas guardada en `battles.rules` y `tournaments.rules`. Ver ADR-021/022.
 * INMUTABLE: se escribe una vez al crear la batalla o el torneo y nunca se recalcula.
 */
export interface BattleRulesSnapshot {
  /** 1 = copias de la rama antes de 0.4.0 (sólo lectura); 2 = motor 0.4.0. */
  schema: number;
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
 *  capture_the_flag · capturas, bajas, muertes;
 *  classic · lo de siempre (sin copia o rulesets de plataforma).
 */
export type StatsProfile = "elimination" | "limited_respawn" | "deathmatch" | "time" | "capture_the_flag" | "classic";

export function statsProfileOf(rules: Pick<BattleRulesSnapshot, "source" | "params"> | null | undefined): StatsProfile {
  if (!rules || rules.source === "classic" || !rules.params) return "classic";
  const p = normalizeParams(rules.params);
  if (p.game === "capture_the_flag") return "capture_the_flag";
  if (p.victory === "time_score") return "time";
  if (p.respawn.mode === "limited") return "limited_respawn";
  if (p.respawn.mode === "none") return "elimination";
  return "deathmatch";
}

/** Resumen legible (FASE 10): las líneas que la UI enseña antes de crear. */
export function summarizeParams(raw: RulesParams): string[] {
  const p = normalizeParams(raw);
  const ctf = p.game === "capture_the_flag";
  const lines: string[] = [];
  lines.push(
    `${p.teamSize === 1 ? "1 contra 1" : `${p.teamSize} contra ${p.teamSize}`}${ctf ? " · Capturar la bandera" : ""}`,
  );
  lines.push(`Reaparición: ${respawnLabel(p)}`);
  if (p.respawn.mode !== "none") lines.push(`Espera de reaparición: ${p.respawn.delaySeconds ?? 5} s`);
  if (ctf) lines.push(`Victoria: ${p.scoreLimit} capturas`);
  else if (p.victory === "elimination") lines.push("Victoria: eliminación");
  else if (p.victory === "score_limit") lines.push(`Victoria: ${p.scoreLimit} bajas`);
  else lines.push("Victoria: más puntos al acabar el tiempo");
  lines.push(`${p.victory === "time_score" ? "Duración" : "Tiempo máximo"}: ${p.timeLimitMinutes} min`);
  if (ctf && p.ctf) {
    lines.push(`Retorno automático de la bandera: ${p.ctf.flagReturnSeconds} s`);
    lines.push(`Bandera propia en base para puntuar: ${p.ctf.requireOwnFlagAtBase ? "sí" : "no"}`);
    lines.push(
      `Prórroga: la siguiente captura gana (máx. ${CTF_OVERTIME_MAX_SECONDS / 60} min; si nadie captura, empate)`,
    );
  }
  if (p.botCredits !== null) lines.push(`Máx. por bot: ${p.botCredits} cr`);
  if (p.teamCredits !== null) lines.push(`Presupuesto del equipo: ${p.teamCredits} cr (reparto libre entre bots)`);
  if (p.botMassKg !== null) lines.push(`Máx. masa por bot: ${p.botMassKg} kg`);
  if (p.teamMassKg !== null) lines.push(`Máx. masa equipo: ${p.teamMassKg} kg`);
  if (p.teamSize > 1) lines.push(`Fuego amigo: ${p.friendlyFire ? "activado" : "desactivado"}`);
  lines.push(`Desempate: ${TIEBREAK_RULES[tiebreakFamilyOf(p)].steps.join(" → ")}`);
  return lines;
}
