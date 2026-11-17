/**
 * OLA 2 · MA · LA FRONTERA: `projectFrame(frame, ctx)` y los proyectores puros de eventos,
 * resultado, nómina, objetivos, estadísticas y WELCOME.
 *
 *   ENGINE INTERNAL STATE → projectFrame() → viewer/public state
 *
 * Todo es lista BLANCA por campo, gobernada por la `DisclosurePolicy` del contexto: un
 * campo nuevo del motor no sale hasta que la política lo declara. Puro y determinista:
 * sin E/S, sin RNG, sin mutar el frame (F3). Los ids internos se traducen con el mapper
 * de la audiencia (`ctx.ids`); una referencia que no se puede traducir se OMITE.
 */
import { armorBroken } from "../game-rules/damage-contract.js";
import type { PublicEntityId, ProjectionContext, SanitizedFrame } from "./contracts.js";
import type { InternalEvent, InternalFrame, InternalRosterEntry, InternalVehicleState } from "./frame-types.js";
import { HULL_LEVEL_N, PUBLIC_FRAME_FORMAT, emits, fieldLevel } from "./policy.js";
import type { AudiencePublicIdMapper } from "./public-id-mapper.js";

// ------------------------------------------------------------------ utilidades

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

function pos(p: unknown): { x: number; y: number } | null {
  if (!p || typeof p !== "object") return null;
  const o = p as { x?: unknown; y?: unknown };
  return { x: num(o.x), y: num(o.y) };
}

function numberRecord(r: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (r && typeof r === "object") {
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

/** Orden numérico por id público (`v_2` < `v_10`). */
function byPublicId(a: { id: string }, b: { id: string }): number {
  const na = Number(a.id.slice(a.id.indexOf("_") + 1));
  const nb = Number(b.id.slice(b.id.indexOf("_") + 1));
  return na - nb;
}

/** Contexto de proyección con el mapper concreto (necesita `ref`). */
export type FrameContext = ProjectionContext & { readonly ids: AudiencePublicIdMapper };

/** D-B5 · hullLevel = ceil(N·hp/hpMax) ∈ [0, N]; 1 como mínimo mientras quede casco. */
export function hullLevel(hp: number, hpMax: number, n: number = HULL_LEVEL_N): number {
  if (!(hpMax > 0) || !(hp > 0)) return 0;
  const lvl = Math.ceil((n * Math.min(hp, hpMax)) / hpMax - 1e-9);
  return Math.max(1, Math.min(n, lvl));
}

// --------------------------------------------------------------------- cuerpo

const ARMOR_SECTORS = ["front", "left", "right", "rear"] as const;

export interface PublicVehicle {
  id: string;
  team?: string;
  alive?: boolean;
  position?: { x: number; y: number } | null;
  heading?: number;
  turretHeading?: number;
  hullLevel?: number;
  /**
   * D-B4 · sectores cuyo blindaje está ROTO (`{ front: true }`). Sólo aparecen los rotos y
   * sólo `true`: un sector íntegro o inexistente es indistinguible (EQUIPMENT_PRIVATE).
   * Ausente mientras no haya ninguno roto.
   */
  armorBroken?: Partial<Record<"front" | "left" | "right" | "rear", true>>;
  carryingFlag?: string | null;
  juggernaut?: boolean;
  respawnsLeft?: number;
}

export interface PublicFrameBody {
  tick: number;
  overtime?: boolean;
  vehicles: PublicVehicle[];
  projectiles: { id: string; position: { x: number; y: number } }[];
  /** Sólo los deployables REVELADOS para la audiencia (hoy: ninguno en público). */
  deployables: { id: string; position: { x: number; y: number } }[];
  score: Record<string, number>;
  objectives: Record<string, unknown>[];
}

function projectVehicle(v: InternalVehicleState, ctx: FrameContext): PublicVehicle | null {
  const id = ctx.ids.toPublic(v.id);
  if (!id) return null; // sin id público no sale (nunca con el interno)
  const a = ctx.audienceClass;
  const P = ctx.policy;
  const out: PublicVehicle = { id };
  if (emits(P, "vehicle.team", a)) out.team = String(v.team ?? "");
  if (emits(P, "vehicle.alive", a)) out.alive = v.alive === true;
  if (emits(P, "vehicle.position", a)) out.position = pos(v.position);
  if (emits(P, "vehicle.heading", a)) out.heading = num(v.heading);
  if (emits(P, "vehicle.turretHeading", a)) out.turretHeading = num(v.turretHeading);
  const hpLevel = fieldLevel(P, "vehicle.hullHp", a);
  if (hpLevel === "SANITIZED") out.hullLevel = hullLevel(num(v.hullHp), num(v.hullHpMax));
  if (emits(P, "vehicle.armorBroken", a)) {
    const broken: NonNullable<PublicVehicle["armorBroken"]> = {};
    for (const s of ARMOR_SECTORS) {
      const sec = v.armor?.[s];
      // Dato no finito ⇒ no se afirma la rotura (nunca se inventa un estado).
      if (sec && Number.isFinite(sec.hp) && Number.isFinite(sec.hpMax) && armorBroken(sec.hp, sec.hpMax))
        broken[s] = true;
    }
    if (Object.keys(broken).length > 0) out.armorBroken = broken;
  }
  if (emits(P, "vehicle.carryingFlag", a))
    out.carryingFlag = typeof v.carryingFlag === "string" ? v.carryingFlag : null;
  if (emits(P, "vehicle.juggernaut", a)) out.juggernaut = v.juggernaut === true;
  if (emits(P, "vehicle.respawnsLeft", a) && typeof v.respawnsLeft === "number") out.respawnsLeft = v.respawnsLeft;
  // vehicle.hullHp (exacto), hullHpMax y modules: sólo si la política los declarase
  // PUBLIC (R1). Con R2 son PRIVATE y no hay rama que los emita.
  const extra = out as unknown as Record<string, unknown>;
  if (hpLevel === "PUBLIC") extra.hullHp = num(v.hullHp);
  if (fieldLevel(P, "vehicle.hullHpMax", a) === "PUBLIC") extra.hullHpMax = num(v.hullHpMax);
  if (fieldLevel(P, "vehicle.modules", a) === "PUBLIC") {
    extra.modules = (v.modules ?? []).map((m) => ({
      slot: String(m.slot),
      state: String(m.state),
    }));
  }
  return out;
}

/** Campos permitidos en un objetivo de modo (bandera, zona, juggernaut). */
const OBJECTIVE_FIELDS: Readonly<Record<string, "str" | "num" | "pos" | "ref">> = {
  kind: "str",
  team: "str",
  state: "str",
  position: "pos",
  radiusM: "num",
  id: "ref",
};

export function projectObjective(o: unknown, ctx: FrameContext): Record<string, unknown> | null {
  if (!o || typeof o !== "object") return null;
  const src = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(OBJECTIVE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = src[k];
    if (t === "str" && typeof v === "string") out[k] = v;
    else if (t === "num" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (t === "pos") out[k] = pos(v);
    else if (t === "ref") {
      const r = ctx.ids.ref(v);
      if (r === undefined) return null; // objetivo que referencia algo no visible: no sale
      out[k] = r;
    }
  }
  return out;
}

/**
 * LA frontera. Pura dado el contexto: el mapper ya tiene asignados los ids de lo que la
 * audiencia ve en este frame (lo hace `AudienceProjector.advance`).
 */
export function projectFrame(frame: InternalFrame, ctx: FrameContext): SanitizedFrame<PublicFrameBody> {
  const a = ctx.audienceClass;
  const P = ctx.policy;
  const vehicles: PublicVehicle[] = [];
  for (const v of frame.vehicles ?? []) {
    const pv = projectVehicle(v, ctx);
    if (pv) vehicles.push(pv);
  }
  vehicles.sort(byPublicId);
  const projectiles: PublicFrameBody["projectiles"] = [];
  if (emits(P, "projectile.id", a)) {
    for (const p of frame.projectiles ?? []) {
      const id = ctx.ids.toPublic(p.id);
      if (!id) continue;
      projectiles.push({ id, position: pos(p.position) ?? { x: 0, y: 0 } });
    }
    projectiles.sort(byPublicId);
  }
  const deployables: PublicFrameBody["deployables"] = [];
  for (const d of frame.deployables ?? []) {
    if (ctx.visibilityOf(d.id as never).level !== "revealed") continue;
    const id = ctx.ids.toPublic(d.id);
    if (!id) continue;
    deployables.push({ id, position: pos(d.position) ?? { x: 0, y: 0 } });
  }
  deployables.sort(byPublicId);
  const body: PublicFrameBody = {
    tick: num(frame.tick),
    ...(typeof frame.overtime === "boolean" && emits(P, "frame.overtime", a) ? { overtime: frame.overtime } : {}),
    vehicles,
    projectiles,
    deployables,
    score: emits(P, "frame.score", a) ? numberRecord(frame.score) : {},
    objectives: emits(P, "frame.objectives", a)
      ? (frame.objectives ?? []).map((o) => projectObjective(o, ctx)).filter((o): o is Record<string, unknown> => !!o)
      : [],
  };
  return {
    stage: "sanitized",
    format: PUBLIC_FRAME_FORMAT,
    mappingId: ctx.ids.mappingId,
    tick: body.tick,
    body,
  } as SanitizedFrame<PublicFrameBody>;
}

// --------------------------------------------------------------------- eventos

type FieldKind = "str" | "num" | "pos" | "ref" | "score";

/**
 * Eventos PÚBLICOS: lista blanca por TIPO y por CAMPO (contrato §2). Un tipo o campo nuevo
 * no sale hasta que se añade aquí. `ref` = id de entidad, traducido o el evento no sale.
 */
export const PUBLIC_EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldKind>>>> = {
  score_changed: { team: "str", score: "score" },
  vehicle_destroyed: { targetId: "ref", position: "pos" },
  vehicle_eliminated: { targetId: "ref", team: "str" },
  mine_triggered: { position: "pos" },
  flag_taken: { team: "str", sourceId: "ref" },
  flag_dropped: { team: "str", position: "pos" },
  flag_captured: { team: "str", score: "score" },
  flag_returned: { team: "str" },
  zone_captured: { team: "str", position: "pos" },
  juggernaut_assigned: { targetId: "ref", team: "str" },
  juggernaut_down: { targetId: "ref", team: "str", score: "score" },
  overtime_started: { score: "score", technicalLimitTicks: "num" },
  technical_limit: { score: "score" },
};

export const PUBLIC_EVENT_KIND_SET: ReadonlySet<string> = new Set(Object.keys(PUBLIC_EVENT_FIELDS));

export function projectEvent(e: unknown, ctx: FrameContext): Record<string, unknown> | null {
  if (!e || typeof e !== "object") return null;
  const src = e as InternalEvent;
  const kind = String(src.kind);
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_EVENT_FIELDS, kind)) return null;
  const fields = PUBLIC_EVENT_FIELDS[kind];
  const out: Record<string, unknown> = { tick: num(src.tick), kind };
  for (const [k, t] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = (src as Record<string, unknown>)[k];
    if (t === "str" && typeof v === "string") out[k] = v;
    else if (t === "num" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (t === "pos") out[k] = pos(v);
    else if (t === "score") out[k] = numberRecord(v);
    else if (t === "ref") {
      const r = ctx.ids.ref(v);
      if (r !== undefined) out[k] = r; // sin traducción: el campo se omite (nunca el interno)
    }
  }
  return out;
}

// ------------------------------------------------------------------- resultado

export function projectResult(r: unknown, ctx: FrameContext): Record<string, unknown> {
  const src = (r ?? {}) as Record<string, unknown>;
  const a = ctx.audienceClass;
  const P = ctx.policy;
  const technical = src.endReason === "technical_limit";
  const out: Record<string, unknown> = {};
  if (emits(P, "result.battleId", a) && typeof src.battleId === "string") out.battleId = src.battleId;
  if (emits(P, "result.winner", a)) out.winner = technical ? null : typeof src.winner === "string" ? src.winner : null;
  if (technical && emits(P, "result.endReason", a)) out.endReason = "technical_limit";
  if (emits(P, "result.ticks", a)) out.ticks = num(src.ticks);
  if (emits(P, "result.score", a)) out.score = numberRecord(src.score);
  if (emits(P, "result.finalStateHash", a) && typeof src.finalStateHash === "string")
    out.finalStateHash = src.finalStateHash;
  if (emits(P, "result.disqualified", a) && Array.isArray(src.disqualified)) {
    out.disqualified = src.disqualified
      .map((id) => ctx.ids.toPublic(String(id)))
      .filter((x): x is PublicEntityId => !!x)
      .sort();
  }
  return out;
}

// --------------------------------------------------------------------- nómina

export function projectRoster(roster: readonly InternalRosterEntry[] | undefined, ctx: FrameContext) {
  const a = ctx.audienceClass;
  const P = ctx.policy;
  const out: Record<string, unknown>[] = [];
  for (const r of roster ?? []) {
    const id = ctx.ids.toPublic(String(r.id));
    if (!id) continue;
    const e: Record<string, unknown> = { id };
    if (emits(P, "roster.botId", a)) e.botId = String(r.botId ?? "");
    if (emits(P, "roster.team", a)) e.team = String(r.team ?? "");
    if (emits(P, "roster.name", a) && typeof r.name === "string") e.name = r.name;
    if (emits(P, "roster.chassis", a) && typeof r.chassis === "string") e.chassis = r.chassis;
    out.push(e);
  }
  return out.sort((x, y) => byPublicId(x as { id: string }, y as { id: string }));
}
