/**
 * OLA 2 · MA · Ids en el CANAL DEL BOT (WELCOME, OBSERVATION, EVENT, COMMAND.radio.to).
 *
 * Cada bot es su PROPIA audiencia (`bot_team:<vehículo>`): el id interno del vehículo
 * (`veh_N`, que delata el orden de ranuras/alta de la nómina) nunca sale por este canal.
 * El bot ve `v_N` de SU mapper:
 *   - su propio vehículo y sus aliados: `v_1..v_k` por el orden PÚBLICO de la nómina de su
 *     equipo (bando, botId, nombre), asignados al construir el WELCOME;
 *   - un rival: el siguiente `v_N` libre en el momento de su PRIMERA percepción (contacto
 *     de radar nítido o evento público que lo nombra); los empates dentro de una misma
 *     observación se rompen por la posición percibida (clave pública), no por orden interno;
 *   - ESTABLE durante toda la batalla (el bot necesita seguir objetivos): no se retira ni
 *     se recicla.
 * Un id que no se puede traducir se OMITE (falla hacia menos información). Un COMMAND con
 * un id interno o no resuelto en `radio.to` no se entrega a nadie.
 */
import { audienceKey } from "./audience.js";
import { AudiencePublicIdMapper, type RosterOrderEntry } from "./public-id-mapper.js";

export const BOT_PROJECTION_VERSION = "bot-ids/1";
/** Destinatario NO RESUELTO: no coincide con ningún vehículo, así que la radio no se entrega. */
export const UNRESOLVED_RADIO_TARGET = "unresolved_0";

export interface BotIdBookOptions {
  readonly battleId: string;
  /** Vehículo interno del bot (el observador). */
  readonly observer: string;
  /** Nómina de SU equipo (incluido él): sólo para numerar. */
  readonly team: readonly RosterOrderEntry[];
  /** Ids internos de TODOS los vehículos de la batalla (para reconocer una referencia a vehículo). */
  readonly allVehicleIds: readonly string[];
}

const ID_FIELDS = ["sourceId", "targetId"] as const;

function pos(p: unknown): { x: number; y: number } {
  const o = (p && typeof p === "object" ? p : {}) as { x?: unknown; y?: unknown };
  return {
    x: typeof o.x === "number" && Number.isFinite(o.x) ? o.x : 0,
    y: typeof o.y === "number" && Number.isFinite(o.y) ? o.y : 0,
  };
}

export class BotIdBook {
  readonly mapper: AudiencePublicIdMapper;
  private readonly observer: string;
  private readonly teamIds: readonly string[];
  private readonly vehicleIds: ReadonlySet<string>;

  constructor(opts: BotIdBookOptions) {
    this.observer = opts.observer;
    this.mapper = new AudiencePublicIdMapper({
      battleId: opts.battleId,
      audience: audienceKey("bot_team", opts.observer),
      projectionVersion: BOT_PROJECTION_VERSION,
    });
    this.mapper.assignRoster(opts.team);
    this.teamIds = opts.team.map((e) => e.id);
    this.vehicleIds = new Set(opts.allVehicleIds);
  }

  /** Id público del propio vehículo. */
  selfId(): string {
    return this.mapper.toPublic(this.observer) as string;
  }

  /** Ids públicos de los aliados (sin el propio), en orden público. */
  teammateIds(): string[] {
    return this.teamIds
      .filter((id) => id !== this.observer)
      .map((id) => this.mapper.toPublic(id) as string)
      .sort(byNum);
  }

  /** Numera, por clave pública (x, y), los vehículos aún sin id que aparecen a la vez. */
  private revealAll(batch: readonly { id: string; x: number; y: number }[]): void {
    this.mapper.reveal(batch.filter((c) => this.vehicleIds.has(c.id)).map((c) => ({ ...c, prefix: "v" as const })));
  }

  private vehicleRef(id: unknown): string | undefined {
    return typeof id === "string" ? this.mapper.toPublic(id) : undefined;
  }

  /** OBSERVATION → la que ve el bot. Devuelve una COPIA; no muta la del motor. */
  observation(obs: any): any {
    if (!obs || typeof obs !== "object") return obs;
    const out: any = { ...obs };
    const radars = obs.sensors?.radar;
    if (Array.isArray(radars)) {
      const batch: { id: string; x: number; y: number }[] = [];
      for (const r of radars)
        for (const c of r?.contacts ?? [])
          if (typeof c?.entityId === "string") batch.push({ id: c.entityId, ...pos(c.position) });
      this.revealAll(batch);
      out.sensors = {
        ...obs.sensors,
        radar: radars.map((r: any) => ({
          ...r,
          contacts: (r?.contacts ?? []).map((c: any) => {
            if (!c || typeof c.entityId !== "string") return c;
            const { entityId, ...rest } = c;
            const pub = this.vehicleRef(entityId);
            return pub ? { entityId: pub, ...rest } : rest; // sin traducción: es un eco
          }),
        })),
      };
    }
    if (Array.isArray(obs.objectives)) {
      // P2-A (revisión 2): el objetivo del juggernaut lleva el id INTERNO del marcado. Quién es
      // el marcado es público por definición del modo (sin posición): se numera tras el radar.
      this.revealAll(
        obs.objectives
          .filter((o: any) => typeof o?.id === "string")
          .map((o: any) => ({ id: o.id, ...pos(o.position) })),
      );
      out.objectives = obs.objectives.map((o: any) => {
        if (!o || typeof o !== "object" || typeof o.id !== "string" || !this.vehicleIds.has(o.id)) return o;
        const { id, ...rest } = o;
        const pub = this.vehicleRef(id);
        return pub ? { id: pub, ...rest } : rest;
      });
    }
    if (Array.isArray(obs.radio)) {
      out.radio = obs.radio
        .map((m: any) => ({ ...m, from: this.vehicleRef(m?.from) }))
        .filter((m: any) => typeof m.from === "string");
      if (out.radio.length === 0) delete out.radio;
    }
    return this.scrub(out);
  }

  /** EVENT → el que ve el bot. */
  event(e: any): any {
    if (!e || typeof e !== "object") return e;
    const batch: { id: string; x: number; y: number }[] = [];
    for (const f of ID_FIELDS) if (typeof e[f] === "string") batch.push({ id: e[f], ...pos(e.position) });
    this.revealAll(batch);
    const out: any = { ...e };
    for (const f of ID_FIELDS) {
      if (!(f in e)) continue;
      const pub = this.vehicleRef(e[f]);
      if (pub) out[f] = pub;
      else delete out[f];
    }
    return this.scrub(out);
  }

  /**
   * Red de seguridad: cualquier valor que sea EXACTAMENTE el id interno de un vehículo y haya
   * escapado a la traducción explícita se traduce (o se omite). Un campo nuevo del motor con
   * un id no puede llegar al bot con `veh_N`.
   */
  private scrub<T>(v: T): T {
    if (typeof v === "string") return (this.vehicleIds.has(v) ? (this.vehicleRef(v) ?? undefined) : v) as T;
    if (Array.isArray(v)) return v.map((x) => this.scrub(x)).filter((x) => x !== undefined) as unknown as T;
    if (v && typeof v === "object") {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) {
        const y = this.scrub(x);
        if (y !== undefined) o[k] = y;
      }
      return o;
    }
    return v;
  }

  /** COMMAND del bot → ids internos. Un `to` que no es un id público conocido no se entrega. */
  command(cmd: any): any {
    if (!cmd || typeof cmd !== "object" || !Array.isArray(cmd.radio)) return cmd;
    return {
      ...cmd,
      radio: cmd.radio.map((r: any) => {
        if (!r || typeof r !== "object" || !("to" in r) || r.to === undefined) return r;
        const internal = typeof r.to === "string" ? this.mapper.fromPublic(r.to) : undefined;
        return { ...r, to: internal ?? UNRESOLVED_RADIO_TARGET };
      }),
    };
  }
}

function byNum(a: string, b: string): number {
  return Number(a.slice(a.indexOf("_") + 1)) - Number(b.slice(b.indexOf("_") + 1));
}
