/**
 * UX-D (G-08 · TD-047) · Política ÚNICA de lectura de una BATALLA.
 *
 * Antes `GET /battles`, `GET /battles/{id}`, `/stats`, `/audit` y
 * `POST /spectate-ticket` no miraban la visibilidad de los bots participantes:
 * cualquier anónimo listaba batallas de bots privados con su botId, su versión,
 * su CPU y sus estadísticas. Ahora todas esas vistas pasan por aquí, y esto
 * REUTILIZA la política canónica de replays (`whereReplayReadable`,
 * replay-access.ts) en vez de definir otra: lo que puedes ver de una batalla es
 * exactamente lo que podrías ver de su replay, más el directo cuando el
 * espectador público está activado.
 *
 * Quién puede leer la batalla B (cualquiera de estas):
 *  1-3. STAFF, PARTICIPANTE (dueño de un bot de B) o EQUIPO (bot no privado de
 *       B en un equipo del que eres miembro): igual que replay-access.ts, en
 *       cualquier estado (programada, en curso, terminada, fallida).
 *  4.   PÚBLICO con `S9_PUBLIC_REPLAYS_ENABLED`: B `finished` y sin bots no públicos.
 *  5.   PÚBLICO con `S9_PUBLIC_SPECTATE_ENABLED`: B `running` y sin bots no públicos.
 * Fuera de eso: 404 uniforme, idéntico al de un id inexistente.
 *
 * Los DIAGNÓSTICOS por bot (y la CPU) son un nivel más estricto: sólo el dueño
 * de ESE bot y el staff (`canSeeBotDiagnostics`). Un rival o un miembro del
 * equipo ve la batalla, no las tripas del bot ajeno.
 */
import type { Request } from "express";
import type { Db } from "./db/connection.js";
import { notFound } from "./errors.js";
import { isReplayStaff, whereReplayReadable } from "./replay-access.js";

type Auth = Request["auth"];

export interface BattleVisibility {
  publicReplays: boolean;
  publicSpectate: boolean;
}

/** Mensaje único de denegación de una batalla (inexistente = no autorizada). */
export const BATTLE_NOT_FOUND_MESSAGE = "Batalla no encontrada";
export const battleNotFound = () => notFound(BATTLE_NOT_FOUND_MESSAGE);

/** Ningún bot participante de la batalla es no-público. */
export function whereOnlyPublicBots(db: Db, q: any): any {
  return q.whereNotExists(
    db("participants")
      .join("bots", "bots.id", "participants.bot_id")
      .whereRaw("participants.battle_id = battles.id")
      .whereNot("bots.visibility", "public"),
  );
}

/** Restringe una consulta sobre `battles` a las que el solicitante puede leer. */
export function whereBattleReadable(db: Db, q: any, auth: Auth, vis: BattleVisibility): any {
  if (isReplayStaff(auth)) return q;
  return q.where((w: any) => {
    // Vías 1-4: la política de replays tal cual (no se duplica).
    w.where((sub: any) => {
      whereReplayReadable(db, sub, auth, vis.publicReplays);
    });
    // Vía 5: el directo público.
    if (vis.publicSpectate) {
      w.orWhere((sub: any) => whereOnlyPublicBots(db, sub.where("battles.status", "running")));
    }
  });
}

/** Batalla legible por el solicitante o 404 uniforme. */
export async function getReadableBattleOr404(
  db: Db,
  battleId: string,
  auth: Auth,
  vis: BattleVisibility,
): Promise<Record<string, any>> {
  const q = whereBattleReadable(db, db("battles").where("battles.id", battleId).select("battles.*"), auth, vis);
  const battle = await q.first().catch(() => null); // id no-UUID ⇒ mismo 404
  if (!battle) throw battleNotFound();
  return battle;
}

/** Diagnóstico y CPU de un bot: sólo su dueño y el staff (TD-047). */
export function canSeeBotDiagnostics(auth: Auth, botOwnerId: string | null | undefined): boolean {
  if (isReplayStaff(auth)) return true;
  return Boolean(auth?.userId) && botOwnerId === auth!.userId;
}

/**
 * UX-F (DEF-R3) · De estos ids, cuáles son bots que el solicitante NO puede
 * identificar (id, nombre, versión, resultado). Misma regla que la ficha del bot
 * (`canSeeBot`): se identifican el público, los propios, todos para el staff y los
 * `team` de un equipo del que eres miembro. Lo usan las vistas que nombran
 * participantes fuera del detalle de una batalla (cuadro de un torneo,
 * clasificación) para proyectarlos como «Bot privado». Un id que no es de ningún
 * bot (p. ej. `bye` o un hueco del cuadro) no se oculta.
 */
export async function hiddenBotIds(db: Db, auth: Auth, ids: readonly unknown[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (wanted.length === 0 || isReplayStaff(auth)) return new Set();
  // Sólo ids con forma de UUID llegan a la consulta (bots.id es uuid).
  const uuids = wanted.filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x));
  if (uuids.length === 0) return new Set();
  const rows: { id: string; owner_id: string | null; visibility: string; team_id: string | null }[] = await db("bots")
    .whereIn("id", uuids)
    .whereNot("visibility", "public")
    .select("id", "owner_id", "visibility", "team_id");
  const userId = auth?.userId ?? null;
  const teams = new Set<string>();
  if (userId && rows.some((r) => r.visibility === "team" && r.team_id)) {
    for (const m of await db("team_members").where({ user_id: userId }).select("team_id")) teams.add(m.team_id);
  }
  const out = new Set<string>();
  for (const r of rows) {
    if (userId && r.owner_id === userId) continue;
    if (r.visibility === "team" && r.team_id && teams.has(r.team_id)) continue;
    out.add(r.id);
  }
  return out;
}

/** Texto único con el que se nombra a un participante que el solicitante no puede identificar. */
export const PRIVATE_BOT_LABEL = "Bot privado";
