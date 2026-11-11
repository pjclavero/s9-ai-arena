/**
 * OLA 2 · MA · Proyector por AUDIENCIA sobre el stream de frames internos.
 *
 * Una instancia por (batalla, AudienceKey) — nunca compartida (M3). Mantiene el mapper de
 * ids y el tracker de visibilidad de ESA audiencia; tiene que ver todos los frames en
 * orden desde el tick 0 (la numeración es por primera visibilidad). La proyección de cada
 * frame es `projectFrame()` (pura) con el contexto de la audiencia.
 *
 * Lo usan el gateway (directo y broadcast, un proyector por audiencia del feed) y la API
 * de replays (`projectReplayStream`, una pasada sobre todo el stream: cualquier segmento
 * usa los mismos ids que el documento completo).
 */
import type {
  AudienceClass,
  AudienceKey,
  DisclosurePolicy,
  InternalEntityId,
  PolicyRef,
  ProjectionKey,
  SanitizedFrame,
  ViewerRelation,
  VisibilityLevel,
} from "./contracts.js";
import { audienceClassOf } from "./audience.js";
import type { InternalFrame, InternalRosterEntry } from "./frame-types.js";
import {
  DEFAULT_DISCLOSURE_POLICY,
  DEFAULT_SPECTATOR_POLICY,
  PROJECTION_VERSION,
  deployableVisibility,
} from "./policy.js";
import { buildProjectionKeyWith, type KeyExtras } from "./projection-key.js";
import {
  projectEvent,
  projectFrame,
  projectResult,
  projectRoster,
  type FrameContext,
  type PublicFrameBody,
} from "./project-frame.js";
import { AudiencePublicIdMapper, type RevealCandidate } from "./public-id-mapper.js";
import { VisibilityTracker } from "./visibility.js";

export interface AudienceProjectorOptions {
  readonly battleId: string;
  readonly audience: AudienceKey;
  readonly roster?: readonly InternalRosterEntry[];
  readonly mapEntityIds?: Iterable<string>;
  readonly policy?: DisclosurePolicy;
  readonly spectatorPolicy?: PolicyRef;
  readonly projectionVersion?: string;
  /**
   * Relación del visor con una entidad interna (dueño de un vehículo/deployable). La
   * calcula el BACKEND desde auth + participants; por defecto `none` (público).
   */
  readonly relationOf?: (entity: string) => ViewerRelation;
}

export class AudienceProjector {
  readonly audience: AudienceKey;
  readonly audienceClass: AudienceClass;
  readonly ids: AudiencePublicIdMapper;
  readonly visibility: VisibilityTracker;
  readonly ctx: FrameContext & { readonly epochDigest: (scope: InternalEntityId | "*") => string };
  private readonly roster: readonly InternalRosterEntry[];
  private readonly ownerOf = new Map<string, string>();
  private readonly live = new Set<string>();
  private lastTick = -1;

  constructor(opts: AudienceProjectorOptions) {
    this.audience = opts.audience;
    this.audienceClass = audienceClassOf(opts.audience);
    const projectionVersion = opts.projectionVersion ?? PROJECTION_VERSION;
    const policy = opts.policy ?? DEFAULT_DISCLOSURE_POLICY;
    this.ids = new AudiencePublicIdMapper({
      battleId: opts.battleId,
      audience: opts.audience,
      projectionVersion,
      mapEntityIds: opts.mapEntityIds,
      identityContinuity: policy.identityContinuity,
    });
    this.roster = opts.roster ?? [];
    this.ids.assignRoster(this.roster);
    this.visibility = new VisibilityTracker(opts.audience);
    const relationOf = opts.relationOf ?? (() => "none" as ViewerRelation);
    const tracker = this.visibility;
    this.ctx = {
      battleId: opts.battleId,
      audience: opts.audience,
      audienceClass: this.audienceClass,
      relationOf: (e) => relationOf(String(e)),
      visibilityOf: (e) => tracker.stateOf(e),
      ids: this.ids,
      policy,
      spectatorPolicy: opts.spectatorPolicy ?? DEFAULT_SPECTATOR_POLICY,
      projectionVersion,
      epochDigest: (scope) => tracker.digest(scope),
    };
  }

  get mappingId(): string {
    return this.ids.mappingId;
  }

  /** Actualiza visibilidad y mapper con un frame interno (en orden). */
  advance(frame: InternalFrame): void {
    const tick = Number(frame.tick) || 0;
    if (tick < this.lastTick) throw new Error(`AudienceProjector: frame fuera de orden (${tick} < ${this.lastTick})`);
    this.lastTick = tick;
    const reveal: RevealCandidate[] = [];
    const present = new Set<string>();
    const mark = (id: string, level: VisibilityLevel, cand: RevealCandidate | null) => {
      const t = this.visibility.set(id, level, tick);
      if (level === "hidden") {
        if (t) this.ids.retire(id);
        return;
      }
      present.add(id);
      if (cand && !this.ids.toPublic(id)) reveal.push(cand);
    };
    for (const v of frame.vehicles ?? []) {
      mark(v.id, "revealed", { id: v.id, prefix: "v", x: v.position?.x ?? 0, y: v.position?.y ?? 0 });
    }
    for (const p of frame.projectiles ?? []) {
      mark(p.id, "revealed", { id: p.id, prefix: "p", x: p.position?.x ?? 0, y: p.position?.y ?? 0 });
    }
    for (const d of frame.deployables ?? []) {
      this.ownerOf.set(d.id, d.ownerId);
      const rel = this.ctx.relationOf(d.ownerId as InternalEntityId);
      const level = deployableVisibility(this.audienceClass, rel);
      mark(d.id, level, { id: d.id, prefix: "d", x: d.position?.x ?? 0, y: d.position?.y ?? 0 });
    }
    // Lo que estaba vivo y ya no está en el frame termina su episodio (no se recicla).
    for (const id of this.live) {
      if (!present.has(id)) {
        this.visibility.set(id, "hidden", tick);
        this.ids.retire(id);
      }
    }
    this.live.clear();
    for (const id of present) this.live.add(id);
    this.ids.reveal(reveal);
  }

  /** Avanza y proyecta un frame. */
  project(frame: InternalFrame): SanitizedFrame<PublicFrameBody> {
    this.advance(frame);
    return projectFrame(frame, this.ctx);
  }

  projectEvent(e: unknown): Record<string, unknown> | null {
    return projectEvent(e, this.ctx);
  }

  projectResult(r: unknown): Record<string, unknown> {
    return projectResult(r, this.ctx);
  }

  projectRoster(roster: readonly InternalRosterEntry[] = this.roster): Record<string, unknown>[] {
    return projectRoster(roster, this.ctx);
  }

  /** Clave de caché de ESTA audiencia en su estado de visibilidad actual. */
  key(scope: InternalEntityId | "*" = "*", extras: KeyExtras = {}): ProjectionKey {
    return buildProjectionKeyWith(this.ctx, scope, extras);
  }
}

export interface ProjectedReplayStream {
  readonly mappingId: string;
  readonly snapshots: PublicFrameBody[];
  readonly events: Record<string, unknown>[];
  readonly result: Record<string, unknown>;
  readonly roster: Record<string, unknown>[];
}

/**
 * Replay público: UNA pasada sobre todo el stream desde el tick 0. Los eventos se
 * proyectan tras avanzar el frame de su tick (una referencia a algo aún no visto no sale).
 */
export function projectReplayStream(input: {
  battleId: string;
  audience: AudienceKey;
  roster?: readonly InternalRosterEntry[];
  mapEntityIds?: Iterable<string>;
  snapshots: readonly unknown[];
  events: readonly unknown[];
  result?: unknown;
  policy?: DisclosurePolicy;
}): ProjectedReplayStream {
  const pr = new AudienceProjector({
    battleId: input.battleId,
    audience: input.audience,
    roster: input.roster,
    mapEntityIds: input.mapEntityIds,
    policy: input.policy,
  });
  const events = [...(input.events ?? [])]
    .filter((e): e is { tick: number } => !!e && typeof e === "object")
    .map((e, i) => ({ e, i, t: Number((e as { tick?: unknown }).tick) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const snapshots: PublicFrameBody[] = [];
  const outEvents: Record<string, unknown>[] = [];
  let ei = 0;
  for (const raw of input.snapshots ?? []) {
    const f = raw as InternalFrame;
    snapshots.push(pr.project(f).body);
    while (ei < events.length && events[ei].t <= (Number(f.tick) || 0)) {
      const p = pr.projectEvent(events[ei++].e);
      if (p) outEvents.push(p);
    }
  }
  while (ei < events.length) {
    const p = pr.projectEvent(events[ei++].e);
    if (p) outEvents.push(p);
  }
  return {
    mappingId: pr.mappingId,
    snapshots,
    events: outEvents,
    result: pr.projectResult(input.result),
    roster: pr.projectRoster(),
  };
}
