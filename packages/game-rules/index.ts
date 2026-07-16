/**
 * game-rules · Las reglas son DATOS, no código disperso (exigencia de T2.3).
 * Todas las constantes proceden del ADR-000. No se modifican sin un ADR nuevo.
 */
export * from "./constants.js";
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
  | "zone_control";

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
