/**
 * OLA 2 · MA · Clave ÚNICA de toda caché proyectada (`buildProjectionKey`, contrato §4) y
 * la caché acotada que la usa.
 *
 * Regla: una proyección (frame, nómina, documento, mapping) NO sobrevive a una transición
 * que cambie lo que la audiencia puede observar. Por eso la clave lleva la audiencia, la
 * entidad observada, la relación, el perfil, las dos políticas, el digest de epochs, la
 * versión de proyección y el destino. Quitar cualquiera es un mutante (M2/M3/M5/M6).
 */
import type { BuildProjectionKey, InternalEntityId, ProjectionContext, ProjectionKey } from "./contracts.js";
import { policyRef } from "./policy.js";

export interface KeyExtras {
  /** Perfil resuelto del visor (p. ej. `default`, `debug`). */
  readonly resolvedProfile?: string;
  readonly renderTarget?: ProjectionKey["renderTarget"];
  /** Digest de epochs ya calculado (si el contexto no tiene tracker propio). */
  readonly visibilityEpochDigest?: string;
}

/**
 * Constructor ÚNICO. El digest de epochs sale del contexto (`visibilityOf`) a través de
 * `ctxDigest`, que el proyector instala; si no lo hay, el llamador lo pasa en `extras`.
 */
export function buildProjectionKeyWith(
  ctx: ProjectionContext & { readonly epochDigest?: (scope: InternalEntityId | "*") => string },
  scope: InternalEntityId | "*",
  extras: KeyExtras = {},
): ProjectionKey {
  const digest = extras.visibilityEpochDigest ?? ctx.epochDigest?.(scope);
  if (typeof digest !== "string" || digest.length === 0) {
    // Sin epoch no hay clave: fallar cerrado antes que servir una entrada pre-revelación.
    throw new Error("buildProjectionKey: falta visibilityEpochDigest");
  }
  return {
    battleId: ctx.battleId,
    audience: ctx.audience,
    observed: scope,
    relation: scope === "*" ? "none" : ctx.relationOf(scope),
    resolvedProfile: extras.resolvedProfile ?? "default",
    spectatorPolicy: ctx.spectatorPolicy,
    disclosurePolicy: policyRef(ctx.policy),
    visibilityEpochDigest: digest,
    projectionVersion: ctx.projectionVersion,
    renderTarget: extras.renderTarget ?? "ws",
  };
}

export const buildProjectionKey: BuildProjectionKey = (ctx, scope) => buildProjectionKeyWith(ctx, scope);

/** Serialización canónica (orden fijo de campos). Es la única forma de indexar una caché. */
export function projectionKeyString(k: ProjectionKey): string {
  return JSON.stringify([
    k.battleId,
    String(k.audience),
    String(k.observed),
    k.relation,
    k.resolvedProfile,
    k.spectatorPolicy,
    k.disclosurePolicy,
    k.visibilityEpochDigest,
    k.projectionVersion,
    k.renderTarget,
  ]);
}

/** Caché LRU acotada de proyecciones, indexada SÓLO por `ProjectionKey` (+ subclave). */
export class ProjectionCache<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly max = 64) {}

  private k(key: ProjectionKey, sub: string): string {
    return `${projectionKeyString(key)}|${sub}`;
  }

  getOrProject(key: ProjectionKey, sub: string, project: () => V): V {
    const k = this.k(key, sub);
    const hit = this.m.get(k);
    if (hit !== undefined) {
      this.m.delete(k);
      this.m.set(k, hit);
      return hit;
    }
    const v = project();
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
    return v;
  }

  get size(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }
}
