/**
 * OLA 2 · MA · `captureInternalFrame()`: ÚNICO lector de la simulación para SALIDA
 * (contrato §2, camino A2).
 *
 * Produce el INTERNAL EXACT STATE del tick: estado exacto con ids internos y las entidades
 * ocultas (minas) con su dueño. Sustituye a `Battle.publicSnapshot()`: el motor ya no
 * fabrica una vista «pública»; cada audiencia la deriva `projectFrame()` en
 * `packages/projection`. Este frame NUNCA se publica tal cual.
 *
 * Determinista y sin efectos: no consume RNG ni muta la simulación, así que capturar 0 o N
 * veces no cambia `stateHash` (F3). No entra en el hash.
 */
import type { InternalFrame } from "../../../../packages/projection/frame-types.js";
import type { Mine, Projectile } from "./combat.js";
import type { Vehicle } from "./vehicle.js";

export interface InternalFrameSource {
  readonly battleId: string;
  readonly tick: number;
  /** Sólo con prórroga declarada en el ruleset (si no, el campo no existe). */
  readonly overtime?: boolean;
  readonly vehicles: readonly Vehicle[];
  readonly poses: ReadonlyMap<string, { position: { x: number; y: number }; heading: number }>;
  readonly projectiles: readonly Projectile[];
  readonly mines: readonly Mine[];
  readonly score: Readonly<Record<string, number>>;
  readonly objectives: readonly unknown[];
  /** Reapariciones restantes por vehículo, sólo con respawn limitado. */
  readonly respawnsLeft?: (v: Vehicle) => number;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function captureInternalFrame(s: InternalFrameSource): InternalFrame {
  return {
    stage: "internal",
    battleId: s.battleId,
    tick: s.tick,
    ...(s.overtime !== undefined ? { overtime: s.overtime } : {}),
    vehicles: s.vehicles.map((v) => {
      const p = s.poses.get(v.id);
      return {
        id: v.id,
        team: v.team,
        alive: v.alive,
        position: p ? { x: round6(p.position.x), y: round6(p.position.y) } : null,
        heading: p ? round6(p.heading) : 0,
        turretHeading: round6(v.turretHeading),
        hullHp: round6(v.hullHp),
        hullHpMax: v.spec.hullHp,
        carryingFlag: v.carryingFlag,
        juggernaut: v.juggernaut,
        ...(s.respawnsLeft ? { respawnsLeft: s.respawnsLeft(v) } : {}),
        modules: [...v.modules.values()].map((m) => ({ slot: m.spec.slot, state: v.stateOf(m.spec.slot) })),
      };
    }),
    projectiles: s.projectiles.map((p) => ({
      id: p.id,
      position: { x: round6(p.position.x), y: round6(p.position.y) },
    })),
    // Ocultas para el público: el frame las lleva con su dueño para que la proyección
    // decida por audiencia (el dueño sí las ve).
    deployables: s.mines.map((m) => ({
      id: m.id,
      kind: "mine",
      position: { x: round6(m.position.x), y: round6(m.position.y) },
      ownerId: m.ownerId,
      team: m.team,
    })),
    score: { ...s.score },
    objectives: s.objectives,
  };
}
