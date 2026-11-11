/**
 * PRE-1 · Replay CRUDO restringido + PROYECCIÓN PÚBLICA de competición.
 *
 * Política (decisión de producto, 2026-11):
 *  - PUBLIC_REPLAY ⇒ SANITIZED COMPETITION PROJECTION. RAW_REPLAY ⇒ RESTRICTED.
 *  - El fichero crudo es la RECETA de la batalla (semilla + comandos de cada bot +
 *    loadout completo): con él se re-simula todo, incluido lo que un espectador no
 *    ve (radio de equipo, minas, órdenes). Sólo lo recibe quien tiene derecho a
 *    TODO su contenido; el resto recibe la proyección, aunque
 *    `S9_PUBLIC_REPLAYS_ENABLED` esté activado.
 *
 * Quién recibe el CRUDO (`rawReplayAllowed`), decidido en el BACKEND:
 *  1. Rol interno de supervisión: moderator o admin (juego limpio, incidencias).
 *     `organizer` NO: organiza competiciones, no audita la información privada
 *     de los bots; sigue leyendo cualquier replay, pero proyectado.
 *  2. Dueño de TODOS los bots participantes: el fichero sólo contiene lo suyo.
 *     Con un rival ajeno, el dueño recibe la proyección: el crudo llevaría los
 *     comandos, la radio, las minas y el loadout del rival, y la semilla con la
 *     que re-simular su comportamiento. «Sólo lo suyo» no se puede recortar del
 *     fichero sin dejar de ser el fichero (la verificación por hash dejaría de
 *     cuadrar), así que no se sirve un crudo parcial.
 *  Nadie más: ni anónimos, ni usuarios ajenos, ni miembros de equipo, ni con el
 *  flag público activado.
 *
 * La PROYECCIÓN es una lista BLANCA, no una lista negra sobre el crudo, y desde la
 * OLA 2 (MA) la hace la frontera ÚNICA `packages/projection` (audiencia
 * `public_replay`): ids PÚBLICOS densos por primera visibilidad (#261), casco
 * cuantizado (hullLevel) y equipamiento privado (R2: sin ranuras, sin hullHpMax,
 * sin chasis en la nómina). El mapping se calcula UNA vez sobre todo el stream: un
 * segmento usa los mismos ids que el documento completo. Nunca: semilla, ruleset completo,
 * comandos (ni con `debugOpen`), `radio[].data`, `deployMine`, `participants[].spec`,
 * hashes por tick, ni metadatos del almacén (sha, algoritmo, caducidad, ruta).
 * Sin semilla ni comandos la batalla NO se puede re-simular con lo publicado.
 */
import { createHash } from "node:crypto";
import type { Request } from "express";
import {
  AudienceProjector,
  DEFAULT_DISCLOSURE_POLICY,
  DEFAULT_SPECTATOR_POLICY,
  PROJECTION_VERSION,
  PUBLIC_EVENT_KIND_SET,
  policyRef,
  ProjectionCache,
  audienceKey,
  projectReplayStream,
  type InternalRosterEntry,
  type ProjectedReplayStream,
} from "../../../packages/projection/index.js";
import type { Db } from "./db/connection.js";
import { ROLE_RANK } from "./openapi.js";

type Auth = Request["auth"];

/** Marca de formato de la proyección (para clientes y para los tests de fuga). */
export const PUBLIC_PROJECTION_FORMAT = "s9.replay.public-competition.v2";

/** Rol interno mínimo para el crudo: moderator (y admin). */
export function isRawReplayRole(auth: Auth): boolean {
  return (auth?.rank ?? 0) >= ROLE_RANK.moderator;
}

/**
 * ¿Puede ESTE solicitante recibir el replay CRUDO de la batalla? Sólo se llama
 * DESPUÉS de comprobar que la puede leer (replay-access.ts); aquí se decide la
 * representación. Fail-closed: cualquier error ⇒ false (proyección).
 */
export async function rawReplayAllowed(db: Db, battleId: string, auth: Auth): Promise<boolean> {
  if (isRawReplayRole(auth)) return true;
  const userId = auth?.userId;
  if (!userId) return false;
  try {
    const rows = (await db("participants")
      .leftJoin("bots", "bots.id", "participants.bot_id")
      .where("participants.battle_id", battleId)
      .select("bots.owner_id as owner_id")) as { owner_id: string | null }[];
    return rows.length > 0 && rows.every((r) => r.owner_id === userId);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- saneado
/**
 * Claves que JAMÁS salen en lo que no proyecta el paquete (la geometría del mundo).
 * El stream (frames, eventos, objetivos) ya es lista blanca por campo en la frontera.
 */
export const FORBIDDEN_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  "seed",
  "command",
  "commands",
  "radio",
  "data",
  "deployMine",
  "spec",
  "loadout",
  "observation",
  "observations",
  "stateHashes",
  "source",
  "sourceCode",
  "code",
  "ownerId",
  "owner_id",
  "rng",
]);

/** Eventos PÚBLICOS: los de la lista blanca por tipo y campo de la frontera. */
export const PUBLIC_EVENT_KINDS: ReadonlySet<string> = PUBLIC_EVENT_KIND_SET;

/** Copia de datos planos sin las claves prohibidas (y sin funciones ni prototipos raros). */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PROJECTION_KEYS.has(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const s = scrub(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

export interface ViewerMeta {
  world: unknown;
  /** Nómina INTERNA (id del motor, chasis): la proyecta la frontera, nunca sale tal cual. */
  roster: InternalRosterEntry[];
  /** Ids PÚBLICOS del mapa (muros, destructibles, zonas) de la cabecera. */
  mapEntityIds?: string[];
}

/** Ids PÚBLICOS del mapa (lista blanca del mapper) desde la cabecera del replay. */
function mapIdsOf(header: any, meta: ViewerMeta | null = null): string[] {
  if (!header?.map && meta?.mapEntityIds) return meta.mapEntityIds;
  const m = header?.map ?? {};
  const ids = (xs: unknown) =>
    (Array.isArray(xs) ? xs : []).map((x: any) => x?.id).filter((x: unknown): x is string => typeof x === "string");
  return [...ids(m.walls), ...ids(m.destructibles), ...ids(m.zones)];
}

/** Nómina interna: la del meta (con nombres) o, si no, la de la cabecera. */
function rosterOf(header: any, meta: ViewerMeta | null): InternalRosterEntry[] {
  if (meta?.roster?.length) return meta.roster;
  const ps: any[] = Array.isArray(header?.participants) ? header.participants : [];
  return ps.map((p) => ({ id: String(p.id), botId: String(p.botId ?? ""), team: String(p.team ?? "") }));
}

const PUBLIC_REPLAY = audienceKey("public_replay");

/** Proyector de la audiencia `public_replay` sin frames (nómina y resultado). */
function rosterProjector(battleId: string, header: any, meta: ViewerMeta | null): AudienceProjector {
  return new AudienceProjector({
    battleId,
    audience: PUBLIC_REPLAY,
    roster: rosterOf(header, meta),
    mapEntityIds: mapIdsOf(header, meta),
  });
}

/**
 * Caché de streams PROYECTADOS. Clave = `buildProjectionKey` (audiencia, políticas,
 * versión de proyección, destino http) con el digest de epochs ligado al sha256 del
 * crudo: en un stream cerrado los epochs son función del contenido, así que el sha lo
 * refina (nunca sirve una proyección de otro contenido, audiencia o política).
 */
const streamCache = new ProjectionCache<ProjectedReplayStream>(16);

export function projectedReplayStream(
  replay: { header?: any; events?: unknown; snapshots?: unknown; result?: unknown },
  meta: ViewerMeta | null,
  sha?: string,
): ProjectedReplayStream {
  const h = replay.header ?? {};
  const battleId = String(h.battleId ?? "");
  const run = () =>
    projectReplayStream({
      battleId,
      audience: PUBLIC_REPLAY,
      roster: rosterOf(h, meta),
      mapEntityIds: mapIdsOf(h, meta),
      snapshots: Array.isArray(replay.snapshots) ? replay.snapshots : [],
      events: Array.isArray(replay.events) ? replay.events : [],
      result: replay.result,
    });
  if (!sha) return run();
  const pr = rosterProjector(battleId, h, meta);
  const key = pr.key("*", { renderTarget: "http", visibilityEpochDigest: `sha256:${sha}` });
  // Subclave: lo que el llamador aporta además del stream (nómina con nombres, resultado).
  return streamCache.getOrProject(key, `${meta ? "meta" : "nometa"}:${replay.result ? "result" : "noresult"}`, run);
}

/** Conveniencia (tests y herramientas): proyección de UN frame interno aislado. */
export function projectSnapshot(frame: any, meta: ViewerMeta | null = null): Record<string, unknown> {
  const pr = rosterProjector(String(frame?.battleId ?? ""), {}, meta);
  return pr.project(frame).body as unknown as Record<string, unknown>;
}

/** Conveniencia: eventos internos proyectados para `public_replay`. */
export function projectEvents(events: unknown, meta: ViewerMeta | null = null): Record<string, unknown>[] {
  if (!Array.isArray(events)) return [];
  const pr = rosterProjector("", {}, meta);
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const p = pr.projectEvent(e);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Índice PROYECTADO para el visor: sólo lo que el reproductor usa para pintar y
 * saltar. Sin sha/algoritmo/caducidad/checksum de mapa/versiones; `debugOpen`
 * siempre false (los comandos nunca salen proyectados).
 */
export function projectIndex(index: any, meta: ViewerMeta | null, header: any = null): Record<string, unknown> {
  const pr = rosterProjector(String(index?.battleId ?? ""), header ?? {}, meta);
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    projectionVersion: PROJECTION_VERSION,
    mappingId: pr.mappingId,
    battleId: String(index?.battleId ?? ""),
    ticks: num(index?.ticks),
    snapshotCount: num(index?.snapshotCount),
    keyframes: (Array.isArray(index?.keyframes) ? index.keyframes : []).map((k: any) => ({
      tick: num(k?.tick),
      snapshotIndex: num(k?.snapshotIndex),
    })),
    result: pr.projectResult(index?.result),
    official: index?.official === true,
    ...(typeof index?.createdAt === "string" ? { createdAt: index.createdAt } : {}),
    debugOpen: false,
    ...(meta ? { world: scrub(meta.world), roster: pr.projectRoster() } : {}),
  };
}

/**
 * Segmento PROYECTADO: frames y eventos públicos del rango, NUNCA comandos. Los ids
 * salen del stream COMPLETO proyectado (`full`), no del segmento: saltar a cualquier
 * tick da los mismos ids que el documento entero.
 */
export function projectSegment(body: any, full: ProjectedReplayStream): Record<string, unknown> {
  const ticks = new Set<number>((Array.isArray(body?.snapshots) ? body.snapshots : []).map((s: any) => num(s?.tick)));
  const evTicks = (Array.isArray(body?.events) ? body.events : []).map((e: any) => num(e?.tick));
  const evFrom = evTicks.length ? Math.min(...evTicks) : Infinity;
  const evTo = evTicks.length ? Math.max(...evTicks) : -Infinity;
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    mappingId: full.mappingId,
    battleId: String(body?.battleId ?? ""),
    fromKeyframeTick: num(body?.fromKeyframeTick),
    snapshots: full.snapshots.filter((s) => ticks.has(s.tick)),
    events: full.events.filter((e) => num(e.tick) >= evFrom && num(e.tick) <= evTo),
  };
}

/**
 * Documento PÚBLICO completo (descarga pública): la proyección de toda la batalla
 * en JSON. Sustituye al fichero crudo en `/public/replays/{id}/download`.
 */
export function projectReplayDocument(
  replay: { header?: any; events?: unknown; snapshots?: unknown; result?: any },
  meta: ViewerMeta | null,
  sha?: string,
): Record<string, unknown> {
  const h = replay.header ?? {};
  const full = projectedReplayStream(replay, meta, sha);
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    projectionVersion: PROJECTION_VERSION,
    mappingId: full.mappingId,
    battleId: String(h.battleId ?? ""),
    ...(typeof h.rulesetId === "string" ? { rulesetId: h.rulesetId } : {}),
    ...(typeof h.recordedAt === "string" ? { recordedAt: h.recordedAt } : {}),
    ...(meta ? { world: scrub(meta.world), roster: full.roster } : {}),
    snapshots: full.snapshots,
    events: full.events,
    result: full.result,
  };
}

/**
 * OLA 2 · MA · Caché HTTP de una respuesta PÚBLICA proyectada (`ProjectedHttpCachePolicy`):
 * nunca `immutable` (no se podría invalidar ante un cambio de política o de proyección) y
 * con un ETag que incluye projectionVersion y las dos políticas.
 */
export const PROJECTED_HTTP_CACHE_CONTROL = "public, max-age=300";

export function projectedEtag(...parts: string[]): string {
  const h = createHash("sha256")
    .update(
      JSON.stringify([
        PROJECTION_VERSION,
        DEFAULT_SPECTATOR_POLICY,
        policyRef(DEFAULT_DISCLOSURE_POLICY),
        ...parts,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `"${h}"`;
}
