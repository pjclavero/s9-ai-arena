/** Proyecciones a los shapes del contrato de E1. Los campos x-private solo salen para el propio usuario/admin. */
import { badRequest } from "./errors.js";

export function userToJson(
  user: Record<string, unknown>,
  roles: string[],
  opts: { includePrivate: boolean },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: user.id,
    displayName: user.display_name,
    createdAt: (user.created_at as Date).toISOString(),
  };
  if (opts.includePrivate) {
    base.email = user.email;
    base.roles = roles;
    base.twoFactorEnabled = user.totp_secret != null;
  }
  return base;
}

export function publicProfile(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: user.id,
    displayName: user.display_name,
    createdAt: (user.created_at as Date).toISOString(),
  };
}

export function sessionToJson(s: Record<string, unknown>): Record<string, unknown> {
  return {
    id: s.id,
    createdAt: (s.created_at as Date).toISOString(),
    lastSeenAt: (s.last_seen_at as Date).toISOString(),
    userAgent: s.user_agent ?? undefined,
  };
}

export function teamToJson(team: Record<string, unknown>, memberIds: string[]): Record<string, unknown> {
  return { id: team.id, name: team.name, captainId: team.captain_id, memberIds };
}

/**
 * Cursor keyset opaco (el contrato prohíbe paginación por offset).
 *
 * EQ1 · P2 (EQ6, #216) · el cursor guardaba `created_at` con `Date#toISOString()`, que
 * TRUNCA a milisegundos, mientras PostgreSQL guarda MICROsegundos. La condición
 * `(created_at, id) < (cursor)` descartaba entonces todas las filas del mismo
 * milisegundo que la última de la página: con 230 bots de una misma sentencia sólo
 * salían 100. Arreglo único para todos los listados:
 *
 *  - el instante del cursor sale de SQL con precisión completa (`cursorTsSql`, texto
 *    UTC con 6 decimales), nunca de un `Date` de JS;
 *  - el cursor lleva la clave COMPLETA del orden (`created_at` + desempates), así que el
 *    orden es total y estable;
 *  - la comparación se hace siempre con `applyCursor` (`?::timestamptz`).
 *
 * Formato v2: base64url(JSON `{"v":2,"t":"2026-11-02T05:00:00.123456Z","k":[id, …]}`).
 * Un cursor antiguo (v1, `ISO-con-ms|id`) o mal formado se RECHAZA con 400: el v1 no
 * contiene el instante exacto y cualquier interpretación podría saltarse filas del
 * milisegundo frontera; antes, uno mal formado devolvía en silencio la primera página.
 * Los cursores son estado efímero de la UI («Cargar más»): el cliente reinicia el listado.
 */
export const CURSOR_TS = "cursor_ts";
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export type CursorKey = string | number;
export interface PageCursor {
  /** Instante exacto (µs, UTC) de la última fila de la página anterior. */
  createdAt: string;
  /** Primer desempate (el id de la fila); compatibilidad con los usos existentes. */
  id: string;
  /** Todos los desempates, en el orden de la clave. */
  keys: CursorKey[];
}

/** Columna SELECT con el instante exacto de `column` para el cursor (alias `cursor_ts`). */
export function cursorTsSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${CURSOR_TS}`;
}

/** Cursor de la fila `row` (que debe traer `cursor_ts`, ver `cursorTsSql`) con sus desempates. */
export function encodeCursor(row: Record<string, unknown>, keys: CursorKey[]): string {
  const t = row[CURSOR_TS];
  if (typeof t !== "string" || !CURSOR_TS_RE.test(t)) {
    // Error de programación: la consulta no seleccionó `cursorTsSql(...)`.
    throw new Error(`encodeCursor: la fila no trae ${CURSOR_TS} con precisión completa`);
  }
  if (keys.length === 0) throw new Error("encodeCursor: falta al menos un desempate");
  return Buffer.from(JSON.stringify({ v: 2, t, k: keys })).toString("base64url");
}

/**
 * Decodifica un cursor v2 con `arity` desempates. Sin cursor → null (primera página).
 * Cursor antiguo o inválido → 400 (nunca se reinterpreta).
 */
export function decodeCursor(cursor: string | undefined, arity = 1): PageCursor | null {
  if (cursor === undefined || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const p = parsed as { v?: unknown; t?: unknown; k?: unknown } | undefined;
  const ok =
    p !== null &&
    typeof p === "object" &&
    p.v === 2 &&
    typeof p.t === "string" &&
    CURSOR_TS_RE.test(p.t) &&
    !Number.isNaN(Date.parse(p.t)) &&
    Array.isArray(p.k) &&
    p.k.length === arity &&
    p.k.every((x) => (typeof x === "string" && x.length > 0 && x.length <= 200) || Number.isInteger(x));
  if (!ok) throw badRequest("Cursor de paginación inválido o caducado: vuelve a cargar el listado desde el principio");
  const keys = p!.k as CursorKey[];
  return { createdAt: p!.t as string, id: String(keys[0]), keys };
}

/**
 * Aplica la condición keyset `(tsColumn, keyColumns…) < (cursor)` con el instante
 * exacto. El ORDER BY de la consulta debe ser `tsColumn DESC, keyColumns… DESC`.
 */
export function applyCursor<Q extends { whereRaw: (...args: any[]) => any }>(
  q: Q,
  cursor: PageCursor | null,
  tsColumn: string,
  keyColumns: string[],
): Q {
  if (!cursor) return q;
  if (cursor.keys.length !== keyColumns.length) throw badRequest("Cursor de paginación inválido o caducado");
  const cols = [tsColumn, ...keyColumns].join(", ");
  const marks = ["?::timestamptz", ...keyColumns.map(() => "?")].join(", ");
  return q.whereRaw(`(${cols}) < (${marks})`, [cursor.createdAt, ...cursor.keys]);
}

export function parseLimit(raw: unknown): number {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 100);
}
