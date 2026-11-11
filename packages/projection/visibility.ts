/**
 * OLA 2 · MA · VisibilityEpoch por (entidad, audiencia).
 *
 * El epoch es el número de EPISODIO de visibilidad: sube en cada cambio de nivel (o de
 * componentes revelados) y nunca baja. Vive SÓLO en la proyección y en las claves de
 * caché: no es simulación, no entra en `stateHash`, no consume RNG y no influye en el
 * resultado (F3). Es función determinista del stream de frames internos.
 */
import { createHash } from "node:crypto";
import type {
  AudienceKey,
  InternalEntityId,
  VisibilityEpoch,
  VisibilityLevel,
  VisibilityState,
} from "./contracts.js";

interface Slot {
  level: VisibilityLevel;
  epoch: number;
  sinceTick: number;
  components: readonly string[];
}

export interface VisibilityTransition {
  readonly id: string;
  readonly from: VisibilityLevel;
  readonly to: VisibilityLevel;
}

export class VisibilityTracker {
  private readonly slots = new Map<string, Slot>();

  constructor(readonly audience: AudienceKey) {}

  /** Fija el nivel de una entidad en `tick`. Devuelve la transición si la hay. */
  set(
    id: string,
    level: VisibilityLevel,
    tick: number,
    components: readonly string[] = [],
  ): VisibilityTransition | null {
    const canon = [...components].sort();
    const cur = this.slots.get(id);
    if (!cur) {
      if (level === "hidden" && canon.length === 0) return null; // nunca visto: no existe
      this.slots.set(id, { level, epoch: 1, sinceTick: tick, components: canon });
      return { id, from: "hidden", to: level };
    }
    const sameComponents = cur.components.length === canon.length && cur.components.every((c, i) => c === canon[i]);
    if (cur.level === level && sameComponents) return null;
    const from = cur.level;
    cur.level = level;
    cur.epoch += 1;
    cur.sinceTick = tick;
    cur.components = canon;
    return { id, from, to: level };
  }

  stateOf(id: InternalEntityId | string): VisibilityState {
    const s = this.slots.get(String(id));
    return {
      entity: String(id) as InternalEntityId,
      audience: this.audience,
      level: s?.level ?? "hidden",
      epoch: (s?.epoch ?? 0) as VisibilityEpoch,
      sinceTick: s?.sinceTick ?? 0,
      ...(s && s.components.length > 0 ? { revealedComponents: s.components } : {}),
    };
  }

  /** Forma canónica `hidden` | `visible#k`. */
  canonical(id: string): string {
    const s = this.slots.get(id);
    if (!s || s.level === "hidden") return `hidden#${s?.epoch ?? 0}`;
    return `${s.level}#${s.epoch}${s.components.length ? `[${s.components.join(",")}]` : ""}`;
  }

  /**
   * Digest canónico de los epochs del alcance (`*` = todas las entidades vistas alguna vez
   * por la audiencia). Va en `ProjectionKey.visibilityEpochDigest`. Es interno: nunca sale.
   */
  digest(scope: InternalEntityId | "*" = "*"): string {
    const ids = scope === "*" ? [...this.slots.keys()].sort() : [String(scope)];
    const h = createHash("sha256");
    for (const id of ids) h.update(`${id}=${this.canonical(id)};`);
    return h.digest("hex").slice(0, 32);
  }
}
