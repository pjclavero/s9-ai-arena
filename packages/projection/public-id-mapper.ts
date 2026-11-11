/**
 * OLA 2 · MA · PublicIdMapper por (batalla, audiencia). Cierra #261.
 *
 * Reglas (contrato §3):
 *  - DENSO por prefijo y en orden de PRIMERA VISIBILIDAD para esa audiencia: lo que la
 *    audiencia nunca ve no consume número, así que no hay huecos que delaten entidades
 *    ocultas (el contador interno compartido entre proyectiles y minas deja de importar).
 *  - Empates en un mismo frame por clave PÚBLICA (prefijo, x, y cuantizadas), nunca por el
 *    orden interno: permutar el orden interno no cambia la numeración.
 *  - Vehículos `v_1..v_n` por el orden PÚBLICO de la nómina (bando, botId, nombre).
 *  - Sin secreto y SIN semilla (la semilla es pública): la secuencia sólo contiene lo que la
 *    audiencia ya ve.
 *  - Nuevo episodio de visibilidad ⇒ id nuevo (salvo `identityContinuity`); los ids no se
 *    reciclan.
 *  - Ids de mapa (muros, destructibles, zonas): pasan sólo por lista blanca explícita.
 *  - Un id interno NUNCA sale: `ref()` devuelve el público, un id de mapa de la lista
 *    blanca, o `undefined` (el campo se omite: falla hacia menos información).
 */
import { createHash } from "node:crypto";
import type {
  AudienceKey,
  InternalEntityId,
  PublicEntityId,
  PublicEntityPrefix,
  PublicIdMapper,
} from "./contracts.js";

/** Forma de un id público de proyección: `<prefijo>_<n>`. Un id de mapa con esta forma NO pasa. */
export const PUBLIC_ID_RE = /^[vpdzc]_[0-9]{1,16}$/;
/** Patrón de `common.schema.json#/$defs/entityId` (I7). */
export const ENTITY_ID_SCHEMA_RE = /^[a-z]+_[0-9a-zA-Z]{1,16}$/;

/** Cuantización de la clave pública de desempate (no es la precisión pública de la pose). */
const TIE_Q = 1e3;

export interface RevealCandidate {
  readonly id: string;
  readonly prefix: PublicEntityPrefix;
  readonly x: number;
  readonly y: number;
}

export interface RosterOrderEntry {
  readonly id: string;
  readonly team: string;
  readonly botId?: string;
  readonly name?: string;
}

export interface MapperOptions {
  readonly battleId: string;
  readonly audience: AudienceKey;
  readonly projectionVersion: string;
  /** Ids PÚBLICOS del mapa (muros, destructibles, zonas). */
  readonly mapEntityIds?: Iterable<string>;
  /** Continuidad de identidad entre episodios por prefijo (política). */
  readonly identityContinuity?: Readonly<Partial<Record<PublicEntityPrefix, boolean>>>;
}

/** `mappingId` opaco: hash(battleId, audienceKey, projectionVersion). Nunca la semilla. */
export function mappingIdOf(battleId: string, audience: AudienceKey, projectionVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["s9.mapping", battleId, String(audience), projectionVersion]))
    .digest("hex")
    .slice(0, 24);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function qn(n: number): number {
  return Number.isFinite(n) ? Math.round(n * TIE_Q) : 0;
}

export class AudiencePublicIdMapper implements PublicIdMapper {
  readonly mappingId: string;
  private readonly next = new Map<PublicEntityPrefix, number>();
  private readonly toPub = new Map<string, PublicEntityId>();
  /** Último público de cada entidad retirada (sólo para `identityContinuity`). */
  private readonly retired = new Map<string, PublicEntityId>();
  private readonly toInt = new Map<string, string>();
  private readonly mapIds: ReadonlySet<string>;
  private readonly continuity: Readonly<Partial<Record<PublicEntityPrefix, boolean>>>;
  private rosterAssigned = false;

  constructor(opts: MapperOptions) {
    this.mappingId = mappingIdOf(opts.battleId, opts.audience, opts.projectionVersion);
    const ids = new Set<string>();
    for (const id of opts.mapEntityIds ?? []) {
      const s = String(id);
      // Un id de mapa con forma de id público se rechaza: no puede suplantar a una entidad.
      if (!PUBLIC_ID_RE.test(s)) ids.add(s);
    }
    this.mapIds = ids;
    this.continuity = opts.identityContinuity ?? {};
  }

  private alloc(prefix: PublicEntityPrefix): PublicEntityId {
    const n = (this.next.get(prefix) ?? 0) + 1;
    this.next.set(prefix, n);
    return `${prefix}_${n}` as PublicEntityId;
  }

  private bind(id: string, pub: PublicEntityId): void {
    this.toPub.set(id, pub);
    this.toInt.set(pub, id);
  }

  /** Vehículos: `v_1..v_n` por orden público de la nómina. Idempotente. */
  assignRoster(entries: readonly RosterOrderEntry[]): void {
    if (this.rosterAssigned) return;
    this.rosterAssigned = true;
    const sorted = [...entries].sort(
      (a, b) =>
        cmp(String(a.team), String(b.team)) ||
        cmp(String(a.botId ?? ""), String(b.botId ?? "")) ||
        cmp(String(a.name ?? ""), String(b.name ?? "")),
    );
    for (const e of sorted) if (!this.toPub.has(e.id)) this.bind(e.id, this.alloc("v"));
  }

  /**
   * Entidades que pasan a ser visibles EN ESTE frame. Se numeran por la clave pública
   * (prefijo, x, y cuantizadas), nunca por el orden en que llegan.
   */
  reveal(batch: readonly RevealCandidate[]): void {
    const fresh = batch.filter((c) => !this.toPub.has(c.id));
    fresh.sort((a, b) => cmp(a.prefix, b.prefix) || qn(a.x) - qn(b.x) || qn(a.y) - qn(b.y));
    for (const c of fresh) {
      const prev = this.retired.get(c.id);
      if (prev && this.continuity[c.prefix] === true) {
        this.retired.delete(c.id);
        this.bind(c.id, prev);
      } else {
        this.bind(c.id, this.alloc(c.prefix));
      }
    }
  }

  /** Fin del episodio de visibilidad: el id público deja de resolverse y no se recicla. */
  retire(id: string): void {
    const pub = this.toPub.get(id);
    if (!pub) return;
    this.toPub.delete(id);
    this.toInt.delete(pub);
    this.retired.set(id, pub);
  }

  toPublic(entity: InternalEntityId | string): PublicEntityId | undefined {
    return this.toPub.get(String(entity));
  }

  fromPublic(id: PublicEntityId | string): InternalEntityId | undefined {
    return this.toInt.get(String(id)) as InternalEntityId | undefined;
  }

  /** Referencia a entidad en un evento/objetivo: público, id de mapa permitido o nada. */
  ref(id: unknown): string | undefined {
    if (typeof id !== "string") return undefined;
    const pub = this.toPub.get(id);
    if (pub) return pub;
    return this.mapIds.has(id) ? id : undefined;
  }

  /** Para tests y diagnósticos: cuántos ids de cada prefijo se han emitido. */
  issued(prefix: PublicEntityPrefix): number {
    return this.next.get(prefix) ?? 0;
  }
}
