/**
 * Constantes fundacionales de S9 AI Arena.
 *
 * FUENTE ÚNICA DE VERDAD: docs/decisiones/ADR-000-decisiones-fundacionales.md
 * No modificar ningún valor sin un ADR que supersede al ADR-000.
 * El test constants.test.ts verifica la coherencia entre ellas.
 */

// ---------------------------------------------------------------- D1 · Mundo
export const WORLD_UNIT = "m" as const;
export const ARENA_MVP_WIDTH_M = 120;
export const ARENA_MVP_HEIGHT_M = 80;
/** Solo para el visor (E8). El motor jamás usa píxeles. */
export const PIXELS_PER_METER = 10;

// ------------------------------------------------- D2 · Tick y decisión
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;
export const DECISION_HZ = 10;
export const DECISION_EVERY_N_TICKS = TICK_HZ / DECISION_HZ; // 3
export const DECISION_DEADLINE_MS = 80;

/** Decisiones consecutivas perdidas antes de descalificar (2 s). */
export const MAX_CONSECUTIVE_TIMEOUTS = 20;
/** Ventana de gracia tras desconexión de transporte, en ticks (2 s). */
export const DISCONNECT_GRACE_TICKS = 60;

// ------------------------------------------------------- D4 · Motor/física
export const ENGINE_RUNTIME = "node22" as const;
export const PHYSICS_ENGINE = "rapier2d-compat" as const;
// Versión y sha256 del WASM en packages/game-rules/engine-deps.json

// ---------------------------------------------------------- D5 · Protocolo
export const PROTO_ID = "arena/1" as const;
export const PROTO_ENCODING_DEFAULT = "json" as const;
export const PROTO_ENCODINGS_SUPPORTED = ["json"] as const;

// -------------------------------------------------------------- D6 · Daño
/** El blindaje nunca reduce el daño por debajo de esta fracción. */
export const DMG_MIN_FRACTION = 0.1;
export const CHASSIS_DAMAGE_SHARE = 0.7;
export const MODULE_DAMAGE_SHARE = 0.3;
export const SECTORS = ["front", "left", "right", "rear"] as const;
export type Sector = (typeof SECTORS)[number];

/** Estados de módulo (cap. 12.2) y su multiplicador de prestaciones. */
export const MODULE_STATES = ["operational", "damaged", "critical", "destroyed", "offline"] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export const MODULE_STATE_PERFORMANCE: Record<ModuleState, number> = {
  operational: 1.0,
  damaged: 0.6,
  critical: 0.25, // además, funcionamiento intermitente (ver game-rules/degradation.ts)
  destroyed: 0.0,
  offline: 0.0,
};

/** Umbrales de salud del módulo (fracción) que determinan su estado. */
export const MODULE_STATE_THRESHOLDS = {
  damaged: 0.66,
  critical: 0.33,
  destroyed: 0.0,
} as const;

/** Ticks necesarios para reactivar un módulo apagado voluntariamente. */
export const MODULE_REACTIVATION_TICKS = 15; // 0,5 s

// ----------------------------------------- D7 · Presupuesto, masa, energía
/**
 * Presupuesto de créditos por defecto, usado únicamente cuando un ruleset no
 * declara el suyo. El presupuesto real de una batalla es un parámetro del
 * ruleset (WELCOME.rules.budgetCredits) y puede ajustarse por competición
 * para variar la dificultad; NUNCA se lee esta constante en tiempo de
 * validación de loadout salvo como valor por defecto.
 */
export const BUDGET_CREDITS_MVP = 1000;
/** Fracción del presupuesto EFECTIVO de la batalla, no de BUDGET_CREDITS_MVP. Escala junto con el presupuesto. */
export const MAX_MODULE_COST_FRACTION = 0.35;
/** Suelo del factor de velocidad por exceso de masa. */
export const MASS_SPEED_FLOOR = 0.4;

/** Rango razonable para validar que un ruleset no fija un presupuesto absurdo. */
export const BUDGET_CREDITS_MIN = 200;
export const BUDGET_CREDITS_MAX = 5000;

// ------------------------------------------------- D8 · Niebla y radio
export const RADIO_MAX_MESSAGE_BYTES = 32;
export const RADIO_MAX_MESSAGES_PER_SECOND = 2;
export const RADIO_DELIVERY_DELAY_DECISIONS = 1;
/** Por defecto, cada bot ve solo lo que perciben sus sensores. */
export const DEFAULT_SHARED_TEAM_VISION = false;

// --------------------------------------------------- Acción segura (D2)
/** Comando aplicado cuando no llega orden válida a tiempo. */
export const SAFE_ACTION = {
  keepLastMovement: true,
  keepLastTurret: true,
  fire: false,
} as const;

// ------------------------------------------------------------ Navegación
/** Tamaño de celda del grid de navegación usado por el validador de mapas (E4). */
export const NAV_CELL_SIZE_M = 0.5;
/** Margen añadido al radio de colisión del chasis para calcular clearance. */
export const NAV_CLEARANCE_MARGIN_M = 0.25;
