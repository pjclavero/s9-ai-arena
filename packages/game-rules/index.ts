/**
 * game-rules · Las reglas son DATOS, no código disperso (exigencia de T2.3).
 * Todas las constantes proceden del ADR-000. No se modifican sin un ADR nuevo.
 */
export * from "./constants.js";
export * from "./art-direction.js";
import {
  MODULE_STATE_PERFORMANCE,
  MODULE_STATE_THRESHOLDS,
  BUDGET_CREDITS_MVP,
  type ModuleState,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Degradación por estado de módulo (cap. 12.2 · D6)
// ---------------------------------------------------------------------------

/** Estado que corresponde a una salud dada. Umbrales del ADR-000. */
export function stateFromHealth(healthFraction: number): ModuleState {
  if (healthFraction <= MODULE_STATE_THRESHOLDS.destroyed) return "destroyed";
  if (healthFraction < MODULE_STATE_THRESHOLDS.critical) return "critical";
  if (healthFraction < MODULE_STATE_THRESHOLDS.damaged) return "damaged";
  return "operational";
}

/** Multiplicador de prestaciones. 0 = el módulo no hace nada. */
export function performanceOf(state: ModuleState): number {
  return MODULE_STATE_PERFORMANCE[state];
}

/**
 * Un módulo en estado crítico funciona de forma INTERMITENTE: falla algunos ciclos.
 * Se consulta con el RNG del motor, así que es determinista por semilla.
 */
export const CRITICAL_FAILURE_CHANCE = 0.35;

/** Un módulo destruido o apagado no actúa jamás; uno crítico, a veces. */
export function moduleActs(state: ModuleState, roll: number): boolean {
  if (state === "destroyed" || state === "offline") return false;
  if (state === "critical") return roll >= CRITICAL_FAILURE_CHANCE;
  return true;
}

// ---------------------------------------------------------------------------
// Rulesets (D7: budgetCredits es del ruleset, no del motor)
// ---------------------------------------------------------------------------

export type GameModeId =
  | "deathmatch"
  | "team_deathmatch"
  | "capture_the_flag"
  | "zone_control"
  | "last_man_standing"
  | "domination"
  | "juggernaut";

export interface Ruleset {
  rulesetId: string;
  mode: GameModeId;
  /** D7 · perilla de dificultad. Si no se declara, BUDGET_CREDITS_MVP. */
  budgetCredits: number;
  timeLimitTicks: number;
  scoreToWin: number;
  friendlyFire: boolean;
  respawn: { enabled: boolean; delayTicks: number };
  sharedTeamVision: boolean;
  /** Ticks de gracia tras desconexión antes de descalificar (D2). */
  disconnectGraceTicks: number;
  maxConsecutiveTimeouts: number;
  /** Solo CTF. */
  ctf?: {
    /** ¿Hace falta tener la bandera propia en base para capturar? */
    requireOwnFlagAtBase: boolean;
    /** Ticks que una bandera caída tarda en volver sola a su base. */
    flagReturnTicks: number;
  };
  /** Solo zone_control: puntos por segundo y por zona controlada. */
  zone?: { pointsPerTickHeld: number };
  /**
   * Cada cuántos ticks emite el motor un hash de estado (ERR-ENG-04). Por defecto 30
   * (1 hash/segundo). Para auditar una impugnación, un ruleset con hashEveryNTicks: 1
   * produce hash POR TICK y verify() señala el tick exacto de divergencia, no el
   * múltiplo de 30 más cercano. Viaja en la cabecera del replay (ruleset completo),
   * así que la re-simulación usa la misma cadencia que la grabación.
   */
  hashEveryNTicks?: number;
  /**
   * R3.8 · Nivel MATCH (rondas). Lo consume el MatchRunner del motor, no la batalla:
   * una batalla individual sigue siendo una ronda. Las semillas de cada ronda se
   * derivan de la del match con rng.fork(), y con swapSides los equipos cambian de
   * lado en las rondas pares (solo mapas de 2 equipos).
   */
  match?: { rounds: number; swapSides: boolean };
  /**
   * R3.8 · Solo domination: puntos por tick y por zona EN PROPIEDAD. A diferencia de
   * zone_control (presencia real, fix ERR-ENG-03), en Domination la propiedad persiste
   * al abandonar la zona —es la definición del modo, no una regresión del fix— pero
   * CAPTURAR exige ser el único equipo dentro, igual que en zone_control corregido.
   */
  domination?: { pointsPerTickPerZone: number };
  /** R3.8 · Solo juggernaut: puntos por destruir al marcado / por matar siendo el marcado. */
  juggernaut?: { pointsPerJuggernautKill: number; pointsPerKillAsJuggernaut: number };
  /** Categorías de módulo prohibidas en esta competición (usado por el validador de E3). */
  forbiddenCategories?: string[];
  /**
   * E8/T8.2 · Modo espectador. Opcional y aditivo: si no se declara, el visor no
   * permite la vista con niebla de guerra y el directo va sin retardo.
   */
  spectator?: {
    /** ¿Puede el espectador activar la vista con niebla de guerra (perspectiva de equipo)? */
    allowFogView?: boolean;
    /** Retardo del directo en segundos (anti-coaching en torneos, mejora E8.M). */
    delaySeconds?: number;
  };
}

const base: Omit<Ruleset, "rulesetId" | "mode"> = {
  budgetCredits: BUDGET_CREDITS_MVP,
  timeLimitTicks: 9000, // 5 min a 30 Hz
  scoreToWin: 3,
  friendlyFire: false,
  respawn: { enabled: true, delayTicks: 150 },
  sharedTeamVision: false,
  disconnectGraceTicks: 60,
  maxConsecutiveTimeouts: 20,
};

export const RULESETS: Record<string, Ruleset> = {
  "dm_practice@1": {
    ...base,
    rulesetId: "dm_practice@1",
    mode: "deathmatch",
    scoreToWin: 5,
    respawn: { enabled: false, delayTicks: 0 },
  },
  "tdm_mvp@1": {
    ...base,
    rulesetId: "tdm_mvp@1",
    mode: "team_deathmatch",
    scoreToWin: 8,
  },
  "ctf_mvp@1": {
    ...base,
    rulesetId: "ctf_mvp@1",
    mode: "capture_the_flag",
    scoreToWin: 3,
    ctf: { requireOwnFlagAtBase: true, flagReturnTicks: 300 },
  },
  "zc_mvp@1": {
    ...base,
    rulesetId: "zc_mvp@1",
    mode: "zone_control",
    scoreToWin: 500,
    zone: { pointsPerTickHeld: 1 },
  },
  /**
   * King of the Hill: zone_control con UNA sola zona (la aporta el mapa) y puntuación solo
   * por presencia real (comportamiento por defecto del modo ya corregido). Reutiliza
   * ZoneControlMode sin lógica nueva; solo cambia la meta a una duración de control razonable
   * (100 ticks ≈ 3,3 s controlando la colina sin oposición).
   */
  "koth_mvp@1": {
    ...base,
    rulesetId: "koth_mvp@1",
    mode: "zone_control",
    scoreToWin: 100,
    zone: { pointsPerTickHeld: 1 },
  },
  /**
   * R3.8 · Eliminación por rondas (Last Man Standing) al mejor de 3. Sin respawn por
   * definición del modo (el registro de modos lo EXIGE); scoreToWin no aplica: se gana
   * la ronda por eliminación y el match por rondas ganadas. Las kills son solo desempate.
   */
  "lms_bo3@1": {
    ...base,
    rulesetId: "lms_bo3@1",
    mode: "last_man_standing",
    scoreToWin: Number.MAX_SAFE_INTEGER,
    timeLimitTicks: 6000,
    respawn: { enabled: false, delayTicks: 0 },
    match: { rounds: 3, swapSides: true },
  },
  /** R3.8 · Domination: varias zonas permanentes; ritmo de puntuación ∝ zonas en propiedad. */
  "dom_mvp@1": {
    ...base,
    rulesetId: "dom_mvp@1",
    mode: "domination",
    scoreToWin: 300,
    domination: { pointsPerTickPerZone: 1 },
  },
  /** R3.8 · Juggernaut/VIP: un vehículo marcado; el resto puntúa destruirlo. Respawn obligatorio. */
  "jugg_mvp@1": {
    ...base,
    rulesetId: "jugg_mvp@1",
    mode: "juggernaut",
    scoreToWin: 3,
    juggernaut: { pointsPerJuggernautKill: 3, pointsPerKillAsJuggernaut: 1 },
  },
  /** D7 · demostración de la perilla de presupuesto: misma partida, menos créditos. */
  "skirmish_low@1": {
    ...base,
    rulesetId: "skirmish_low@1",
    mode: "team_deathmatch",
    budgetCredits: 600,
    timeLimitTicks: 4500,
    scoreToWin: 5,
  },
};

export function loadRuleset(id: string, overrides: Partial<Ruleset> = {}): Ruleset {
  const rs = RULESETS[id];
  if (!rs) throw new Error(`Ruleset desconocido: ${id}`);
  return { ...rs, ...overrides };
}
