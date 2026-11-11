/**
 * OLA 2 · MA · Forma del INTERNAL EXACT STATE que consume la proyección.
 *
 *   SIMULATION (Battle) → captureInternalFrame() → InternalFrame → projectFrame() → SanitizedFrame
 *
 * El motor (`apps/arena-engine/src/sim/internal-frame.ts`) lo produce en el paso 8 del
 * tick y lo guarda en `Battle.snapshots` (que deja de ser «público»: es la etapa
 * INTERNAL). Lleva ids internos, el estado exacto y las entidades ocultas (deployables)
 * con su dueño, para que cada audiencia derive su vista. NUNCA sale tal cual: el único
 * camino hacia un consumidor externo es `projectFrame()`.
 *
 * Sólo tipos: el paquete de proyección no importa el motor y el motor sólo importa estos
 * tipos (sin dependencia circular de código).
 */
import type { InternalFrameHeader } from "./contracts.js";

export interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

export interface InternalVehicleState {
  readonly id: string;
  readonly team: string;
  readonly alive: boolean;
  readonly position: Vec2Like | null;
  readonly heading: number;
  readonly turretHeading: number;
  /** Exacto: lo cuantiza la proyección (hullLevel, N=20). */
  readonly hullHp: number;
  /** Exacto: revela el chasis (EQUIPMENT_PRIVATE). */
  readonly hullHpMax: number;
  readonly carryingFlag: string | null;
  readonly juggernaut: boolean;
  readonly respawnsLeft?: number;
  /** Ranuras y estado: revelan el loadout (EQUIPMENT_PRIVATE). */
  readonly modules: readonly { readonly slot: string; readonly state: string }[];
}

export interface InternalProjectileState {
  readonly id: string;
  readonly position: Vec2Like;
}

/** Entidad que puede estar OCULTA para una audiencia (hoy: minas). */
export interface InternalDeployableState {
  readonly id: string;
  /** Subtipo de catálogo: es INTERNO (el prefijo público es siempre `d`). */
  readonly kind: string;
  readonly position: Vec2Like;
  readonly ownerId: string;
  readonly team: string;
}

export interface InternalFrame extends InternalFrameHeader {
  readonly overtime?: boolean;
  readonly vehicles: readonly InternalVehicleState[];
  readonly projectiles: readonly InternalProjectileState[];
  readonly deployables: readonly InternalDeployableState[];
  readonly score: Readonly<Record<string, number>>;
  readonly objectives: readonly unknown[];
}

/** Evento interno del motor (los «públicos por definición» y los de bot). */
export interface InternalEvent {
  readonly tick: number;
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** Nómina INTERNA de la batalla (id interno ↔ bot). La proyecta `projectRoster`. */
export interface InternalRosterEntry {
  readonly id: string;
  readonly botId: string;
  readonly team: string;
  /** Chasis: PRIVADO bajo R2. */
  readonly chassis?: string;
  readonly name?: string;
}
