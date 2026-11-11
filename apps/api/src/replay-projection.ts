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
 * La PROYECCIÓN es una lista BLANCA, no una lista negra sobre el crudo: sólo sale
 * lo que el espectador en directo ya recibe (snapshot público, eventos públicos,
 * resultado deportivo, mundo y nómina pública). Nunca: semilla, ruleset completo,
 * comandos (ni con `debugOpen`), `radio[].data`, `deployMine`, `participants[].spec`,
 * hashes por tick, ni metadatos del almacén (sha, algoritmo, caducidad, ruta).
 * Sin semilla ni comandos la batalla NO se puede re-simular con lo publicado.
 */
import type { Request } from "express";
import type { Db } from "./db/connection.js";
import { ROLE_RANK } from "./openapi.js";

type Auth = Request["auth"];

/** Marca de formato de la proyección (para clientes y para los tests de fuga). */
export const PUBLIC_PROJECTION_FORMAT = "s9.replay.public-competition.v1";

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
 * Claves que JAMÁS salen en una proyección, a cualquier profundidad. Es la red de
 * seguridad bajo la lista blanca (por si un evento o un objetivo de modo llevara
 * algo que no debe): `data` es la carga de la radio.
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

/**
 * Eventos PÚBLICOS que el motor emite a todos (los mismos que recibe el espectador
 * en directo). Un tipo nuevo NO sale hasta que se añade aquí a propósito: un test
 * compara esta lista con lo que el motor emite de verdad.
 */
export const PUBLIC_EVENT_KINDS: ReadonlySet<string> = new Set([
  "score_changed",
  "vehicle_destroyed",
  "vehicle_eliminated",
  "mine_triggered",
  "flag_taken",
  "flag_dropped",
  "flag_captured",
  "flag_returned",
  "zone_captured",
  "juggernaut_assigned",
  "juggernaut_down",
  "overtime_started",
  "technical_limit",
]);

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
const pos = (p: any) => (p && typeof p === "object" ? { x: num(p.x), y: num(p.y) } : null);

function numberRecord(r: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (r && typeof r === "object") {
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) if (typeof v === "number") out[k] = v;
  }
  return out;
}

/** Snapshot público, campo a campo (lista blanca = lo que el motor publica al espectador). */
export function projectSnapshot(s: any): Record<string, unknown> {
  const out: Record<string, unknown> = { tick: num(s?.tick) };
  if (typeof s?.overtime === "boolean") out.overtime = s.overtime;
  out.vehicles = (Array.isArray(s?.vehicles) ? s.vehicles : []).map((v: any) => {
    const pv: Record<string, unknown> = {
      id: String(v?.id ?? ""),
      team: String(v?.team ?? ""),
      alive: v?.alive === true,
      position: pos(v?.position),
      heading: num(v?.heading),
      turretHeading: num(v?.turretHeading),
      hullHp: num(v?.hullHp),
      hullHpMax: num(v?.hullHpMax),
      carryingFlag: typeof v?.carryingFlag === "string" ? v.carryingFlag : null,
      juggernaut: v?.juggernaut === true,
    };
    if (typeof v?.respawnsLeft === "number") pv.respawnsLeft = v.respawnsLeft;
    if (Array.isArray(v?.modules)) {
      pv.modules = v.modules.map((m: any) => ({ slot: String(m?.slot ?? ""), state: String(m?.state ?? "") }));
    }
    return pv;
  });
  out.projectiles = (Array.isArray(s?.projectiles) ? s.projectiles : []).map((p: any) => ({
    id: p?.id,
    position: pos(p?.position),
  }));
  out.score = numberRecord(s?.score);
  out.objectives = Array.isArray(s?.objectives) ? scrub(s.objectives) : [];
  return out;
}

/** Evento público: tipo en la lista blanca y sin claves prohibidas. null = no sale. */
export function projectEvent(e: any): Record<string, unknown> | null {
  if (!e || typeof e !== "object" || !PUBLIC_EVENT_KINDS.has(String(e.kind))) return null;
  return scrub(e) as Record<string, unknown>;
}

export function projectEvents(events: unknown): Record<string, unknown>[] {
  if (!Array.isArray(events)) return [];
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const p = projectEvent(e);
    if (p) out.push(p);
  }
  return out;
}

/** Resultado deportivo: ganador, motivo de fin, ticks, marcador y hash final (auditoría pública). */
export function projectResult(r: any): Record<string, unknown> {
  const technical = r?.endReason === "technical_limit";
  return {
    winner: technical ? null : (r?.winner ?? null),
    ...(technical ? { endReason: "technical_limit" } : {}),
    ticks: num(r?.ticks),
    score: numberRecord(r?.score),
    ...(typeof r?.finalStateHash === "string" ? { finalStateHash: r.finalStateHash } : {}),
  };
}

export interface ViewerMeta {
  world: unknown;
  roster: { id: string; botId: string; team: string; chassis?: string; name?: string }[];
}

/** Nómina pública: id de vehículo, bot, bando, chasis (lo que ya recibe el directo) y nombre. */
function projectRoster(roster: ViewerMeta["roster"] | undefined) {
  return (roster ?? []).map((r) => ({
    id: String(r.id),
    botId: String(r.botId ?? ""),
    team: String(r.team ?? ""),
    ...(typeof r.chassis === "string" ? { chassis: r.chassis } : {}),
    ...(typeof r.name === "string" ? { name: r.name } : {}),
  }));
}

/**
 * Índice PROYECTADO para el visor: sólo lo que el reproductor usa para pintar y
 * saltar. Sin sha/algoritmo/caducidad/checksum de mapa/versiones; `debugOpen`
 * siempre false (los comandos nunca salen proyectados).
 */
export function projectIndex(index: any, meta: ViewerMeta | null): Record<string, unknown> {
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    battleId: String(index?.battleId ?? ""),
    ticks: num(index?.ticks),
    snapshotCount: num(index?.snapshotCount),
    keyframes: (Array.isArray(index?.keyframes) ? index.keyframes : []).map((k: any) => ({
      tick: num(k?.tick),
      snapshotIndex: num(k?.snapshotIndex),
    })),
    result: projectResult(index?.result),
    official: index?.official === true,
    ...(typeof index?.createdAt === "string" ? { createdAt: index.createdAt } : {}),
    debugOpen: false,
    ...(meta ? { world: scrub(meta.world), roster: projectRoster(meta.roster) } : {}),
  };
}

/** Segmento PROYECTADO: snapshots y eventos públicos del rango, NUNCA comandos. */
export function projectSegment(body: any): Record<string, unknown> {
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    battleId: String(body?.battleId ?? ""),
    fromKeyframeTick: num(body?.fromKeyframeTick),
    snapshots: (Array.isArray(body?.snapshots) ? body.snapshots : []).map(projectSnapshot),
    events: projectEvents(body?.events),
  };
}

/**
 * Documento PÚBLICO completo (descarga pública): la proyección de toda la batalla
 * en JSON. Sustituye al fichero crudo en `/public/replays/{id}/download`.
 */
export function projectReplayDocument(
  replay: { header?: any; events?: unknown; snapshots?: unknown; result?: any },
  meta: ViewerMeta | null,
): Record<string, unknown> {
  const h = replay.header ?? {};
  return {
    projection: PUBLIC_PROJECTION_FORMAT,
    battleId: String(h.battleId ?? ""),
    ...(typeof h.rulesetId === "string" ? { rulesetId: h.rulesetId } : {}),
    ...(typeof h.recordedAt === "string" ? { recordedAt: h.recordedAt } : {}),
    ...(meta ? { world: scrub(meta.world), roster: projectRoster(meta.roster) } : {}),
    snapshots: (Array.isArray(replay.snapshots) ? replay.snapshots : []).map(projectSnapshot),
    events: projectEvents(replay.events),
    result: projectResult(replay.result),
  };
}
