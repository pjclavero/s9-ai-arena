/**
 * EQ4 · Filtros y paginación EN SERVIDOR del listado de replays (`listReplays`).
 *
 * Cambio ADITIVO: sin ninguno de estos parámetros la consulta y la respuesta son
 * exactamente las de antes. Todo filtro se aplica sobre la consulta que YA lleva
 * `whereReplayReadable` (replay-access.ts): un filtro sólo puede ESTRECHAR lo que
 * el solicitante ya podía listar, nunca ampliarlo. Los filtros que miran bots
 * (bot, equipo, usuario, resultado win/loss) además sólo casan con bots que el
 * solicitante puede identificar (`whereBotIdentifiable`, battle-access.ts): no
 * sirven de oráculo sobre bots privados ajenos de una batalla legible.
 *
 * Validación estricta: cualquier valor fuera de forma ⇒ 400 `bad_request`, nada
 * llega a SQL sin validar y los textos libres van como parámetros enlazados, con
 * los comodines de LIKE escapados.
 */
import type { Request } from "express";
import type { Db } from "../db/connection.js";
import { badRequest } from "../errors.js";
import { whereBotIdentifiable } from "../battle-access.js";
import { PLATFORM_MODES, type PlatformMode } from "../routes/catalog.js";

type Auth = Request["auth"];

// Rev. EQ6 P3 · una sola fuente: los modos de la plataforma (routes/catalog.ts).
export const REPLAY_MODES = PLATFORM_MODES;
export type ReplayMode = PlatformMode;
export const REPLAY_RESULTS = ["win", "loss", "draw", "aborted"] as const;
export type ReplayResultFilter = (typeof REPLAY_RESULTS)[number];

/** Longitud máxima de un nombre (bots, equipos y display_name: CHECK <= 48). */
export const MAX_NAME_FILTER = 48;

/** Referencia a una entidad por id (UUID exacto) o por nombre (subcadena, sin distinguir mayúsculas). */
export type EntityRef = { id: string } | { name: string };

export interface ReplayListFilters {
  battleId?: { exact: string } | { prefix: string };
  from?: string; // ISO, inclusivo
  to?: string; // ISO, inclusivo
  mode?: ReplayMode;
  result?: ReplayResultFilter;
  bot?: EntityRef;
  team?: EntityRef;
  user?: EntityRef;
  includeTotal: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Prefijo de UUID: sólo hex y guiones, empieza por hex, como mucho 36 caracteres. */
const BATTLE_PREFIX_RE = /^[0-9a-f][0-9a-f-]{0,35}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** Un parámetro de query como string único, o undefined. Arrays/objetos ⇒ 400. */
function single(query: Request["query"], name: string): string | undefined {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw badRequest(`Parámetro «${name}» repetido o con forma inválida`);
  return raw;
}

function parseInstant(name: string, raw: string, endOfDay: boolean): string {
  let iso: string;
  if (DATE_ONLY_RE.test(raw)) iso = `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  else if (DATE_TIME_RE.test(raw)) iso = raw;
  else throw badRequest(`«${name}» debe ser una fecha ISO 8601 (AAAA-MM-DD o fecha-hora con zona)`);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw badRequest(`«${name}» no es una fecha válida`);
  // Rechaza fechas que JS «normaliza» (p. ej. 2026-02-31 → 3 de marzo). Con
  // desplazamiento horario la fecha UTC puede cambiar legítimamente de día.
  if (iso.endsWith("Z") && d.toISOString().slice(0, 10) !== iso.slice(0, 10)) {
    throw badRequest(`«${name}» no es una fecha válida`);
  }
  return d.toISOString();
}

function parseEntity(name: string, raw: string): EntityRef {
  const v = raw.trim();
  if (v.length === 0) throw badRequest(`«${name}» no puede estar vacío`);
  if (isUuid(v)) return { id: v.toLowerCase() };
  if (v.length > MAX_NAME_FILTER || CONTROL_RE.test(v)) {
    throw badRequest(`«${name}» debe ser un UUID o un nombre de como mucho ${MAX_NAME_FILTER} caracteres`);
  }
  return { name: v };
}

/** Lee y valida los filtros. Sin parámetros ⇒ `{ includeTotal: false }` (comportamiento histórico). */
export function parseReplayListFilters(query: Request["query"]): ReplayListFilters {
  const f: ReplayListFilters = { includeTotal: false };

  const battleId = single(query, "battleId");
  if (battleId !== undefined) {
    const v = battleId.trim().toLowerCase();
    if (!BATTLE_PREFIX_RE.test(v)) {
      throw badRequest("«battleId» debe ser un UUID o un prefijo suyo (sólo 0-9, a-f y guiones, máx. 36)");
    }
    f.battleId = isUuid(v) ? { exact: v } : { prefix: v };
  }

  const from = single(query, "from");
  if (from !== undefined) f.from = parseInstant("from", from, false);
  const to = single(query, "to");
  if (to !== undefined) f.to = parseInstant("to", to, true);
  if (f.from && f.to && f.from > f.to) throw badRequest("«from» no puede ser posterior a «to»");

  const mode = single(query, "mode");
  if (mode !== undefined) {
    if (!(REPLAY_MODES as readonly string[]).includes(mode)) {
      throw badRequest(`«mode» debe ser uno de: ${REPLAY_MODES.join(", ")}`);
    }
    f.mode = mode as ReplayMode;
  }

  const result = single(query, "result");
  if (result !== undefined) {
    if (!(REPLAY_RESULTS as readonly string[]).includes(result)) {
      throw badRequest(`«result» debe ser uno de: ${REPLAY_RESULTS.join(", ")}`);
    }
    f.result = result as ReplayResultFilter;
  }

  const bot = single(query, "bot");
  if (bot !== undefined) f.bot = parseEntity("bot", bot);
  const team = single(query, "team");
  if (team !== undefined) f.team = parseEntity("team", team);
  const user = single(query, "user");
  if (user !== undefined) f.user = parseEntity("user", user);

  const includeTotal = single(query, "includeTotal");
  if (includeTotal !== undefined) {
    if (includeTotal !== "true" && includeTotal !== "false") throw badRequest("«includeTotal» debe ser true o false");
    f.includeTotal = includeTotal === "true";
  }
  return f;
}

/** Escapa `\`, `%` y `_` para un patrón LIKE con `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const contains = (s: string) => `%${escapeLike(s)}%`;

/** ¿Hay algún filtro sobre los bots participantes? */
function hasEntityFilter(f: ReplayListFilters): boolean {
  return Boolean(f.bot || f.team || f.user);
}

/** Condiciones de UN participante (alias `bots`) según un filtro de entidad. */
function applyEntity(db: Db, sub: any, kind: "bot" | "team" | "user", ref: EntityRef): any {
  if (kind === "bot") {
    return "id" in ref
      ? sub.where("bots.id", ref.id)
      : sub.whereRaw("bots.name ILIKE ? ESCAPE '\\'", [contains(ref.name)]);
  }
  if (kind === "team") {
    if ("id" in ref) return sub.where("bots.team_id", ref.id);
    return sub.whereExists(
      db("teams")
        .whereRaw("teams.id = bots.team_id")
        .whereRaw("teams.name ILIKE ? ESCAPE '\\'", [contains(ref.name)]),
    );
  }
  if ("id" in ref) return sub.where("bots.owner_id", ref.id);
  return sub.whereExists(
    db("users")
      .whereRaw("users.id = bots.owner_id")
      .whereRaw("users.display_name ILIKE ? ESCAPE '\\'", [contains(ref.name)]),
  );
}

/** Subconsulta «algún participante identificable de esta batalla cumple `fn`». */
function participantExists(db: Db, auth: Auth, fn: (sub: any) => any): any {
  const sub = db("participants")
    .join("bots", "bots.id", "participants.bot_id")
    .whereRaw("participants.battle_id = battles.id");
  whereBotIdentifiable(db, sub, auth);
  return fn(sub);
}

/**
 * Aplica los filtros a una consulta sobre `battles` que YA está restringida por
 * `whereReplayReadable`. Semántica:
 *  - `battleId`: UUID exacto o prefijo (`battles.id::text LIKE 'prefijo%'`).
 *  - `from`/`to`: `battles.created_at` (la misma columna que ordena y pagina), ambos inclusivos.
 *  - `bot`/`team`/`user`: cada uno, que ALGÚN bot participante identificable sea ese
 *    bot (id o nombre), de ese equipo (id o nombre) o de ese usuario (id o display_name).
 *  - `result`: `draw` = empate; `aborted` = con incidencia (failure_kind distinto de
 *    `none` o fin por walkover/fallo deportivo); `win`/`loss` = desde el punto de vista
 *    de los bots del filtro (los que cumplen A LA VEZ bot/team/user) o, sin filtro de
 *    bots, de los bots PROPIOS del solicitante (anónimo ⇒ nada). `loss` incluye
 *    descalificación.
 */
export function applyReplayListFilters(db: Db, q: any, f: ReplayListFilters, auth: Auth): any {
  if (f.battleId) {
    q =
      "exact" in f.battleId
        ? q.where("battles.id", f.battleId.exact)
        : q.whereRaw("battles.id::text LIKE ?", [`${escapeLike(f.battleId.prefix)}%`]);
  }
  if (f.from) q = q.where("battles.created_at", ">=", f.from);
  if (f.to) q = q.where("battles.created_at", "<=", f.to);
  if (f.mode) q = q.where("battles.mode", f.mode);
  for (const kind of ["bot", "team", "user"] as const) {
    const ref = f[kind];
    if (ref) q = q.whereExists(participantExists(db, auth, (sub) => applyEntity(db, sub, kind, ref)));
  }
  if (f.result === "draw") {
    q = q.where((w: any) =>
      w
        .whereRaw("battles.result->>'winner' = 'draw'")
        .orWhereExists(
          db("participants").whereRaw("participants.battle_id = battles.id").where("participants.outcome", "draw"),
        ),
    );
  } else if (f.result === "aborted") {
    q = q.where((w: any) =>
      w
        .whereNot("battles.failure_kind", "none")
        .orWhereRaw("battles.result->>'endReason' IN ('walkover', 'sporting_failure')"),
    );
  } else if (f.result === "win" || f.result === "loss") {
    const outcomes = f.result === "win" ? ["win"] : ["loss", "disqualified"];
    if (hasEntityFilter(f)) {
      q = q.whereExists(
        participantExists(db, auth, (sub) => {
          for (const kind of ["bot", "team", "user"] as const) {
            const ref = f[kind];
            if (ref) applyEntity(db, sub, kind, ref);
          }
          return sub.whereIn("participants.outcome", outcomes);
        }),
      );
    } else if (auth?.userId) {
      q = q.whereExists(
        db("participants")
          .join("bots", "bots.id", "participants.bot_id")
          .whereRaw("participants.battle_id = battles.id")
          .where("bots.owner_id", auth.userId)
          .whereIn("participants.outcome", outcomes),
      );
    } else {
      q = q.whereRaw("false");
    }
  }
  return q;
}

/** Valida un cursor ya decodificado: fecha y UUID con forma, o 400 (antes acababa en un 500 de PostgreSQL). */
export function assertCursorShape(cursor: { createdAt: string; id: string } | null): void {
  if (!cursor) return;
  if (Number.isNaN(new Date(cursor.createdAt).getTime()) || !isUuid(cursor.id)) {
    throw badRequest("Cursor de paginación inválido");
  }
}
