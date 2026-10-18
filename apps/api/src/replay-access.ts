/**
 * PRC (TD-004) · Política CANÓNICA de acceso a replays. ÚNICA autoridad.
 *
 * Todo camino que entregue bytes o metadatos de un replay al exterior pasa por
 * aquí ANTES de leer el archivo: `GET /replays` (listado), `GET /replays/{id}`
 * (archivo), `/index`, `/segment`, `POST /verify` y las rutas `/public/replays*`.
 * El gateway ya no enruta `/replays*` al replay-service (responde 404), así que
 * no queda otro camino desde fuera.
 *
 * Quién puede leer el replay de la batalla B (cualquiera de estas):
 *  1. STAFF: rol >= organizer (organizer, moderator, admin). Supervisan
 *     competiciones y juego limpio; necesitan ver cualquier partida.
 *  2. PARTICIPANTE: dueño (`bots.owner_id`) de algún bot que participó en B.
 *  3. EQUIPO: miembro (`team_members`) del equipo (`bots.team_id`) de algún bot
 *     participante cuya visibilidad NO sea `private` (`team` o `public`). Mismo
 *     criterio que TD-005 (`POST /battles`, `rating-history`): un bot `private`
 *     no se comparte ni con su equipo.
 *  4. PÚBLICO (anónimos y ajenos): SÓLO si `S9_PUBLIC_REPLAYS_ENABLED` está
 *     activada explícitamente Y B está `finished` Y NINGÚN bot participante es
 *     no-público (`private`/`team`). Activar la capability NO publica todos los
 *     ficheros: una batalla con un bot privado sigue siendo privada (coherente
 *     con la visibilidad de bots, TD-005/TD-047).
 *
 * En cualquier otro caso: 404 `not_found`, IDÉNTICO al de un id que no existe o
 * de una batalla sin replay (sin enumeración por UUID: ni el código ni el
 * mensaje distinguen «no existe» de «no autorizado»).
 */
import type { Request } from "express";
import type { Db } from "./db/connection.js";
import { ROLE_RANK } from "./openapi.js";
import { notFound } from "./errors.js";

type Auth = Request["auth"];
type Knexish = Db;

/** Mensaje único de denegación: el mismo para inexistente, sin replay y no autorizado. */
export const REPLAY_NOT_FOUND_MESSAGE = "Replay no encontrado";
export const replayNotFound = () => notFound(REPLAY_NOT_FOUND_MESSAGE);

export function isReplayStaff(auth: Auth): boolean {
  return (auth?.rank ?? 0) >= ROLE_RANK.organizer;
}

/**
 * Restringe una consulta sobre `battles` a las que el solicitante puede leer
 * por las vías 2-4 (la 1, staff, no filtra). Una sola definición para el
 * listado y para el acceso por id: imposible que diverjan.
 */
export function whereReplayReadable(db: Knexish, q: any, auth: Auth, publicEnabled: boolean): any {
  if (isReplayStaff(auth)) return q;
  const userId = auth?.userId ?? null;
  return q.where((w: any) => {
    let any = false;
    if (userId) {
      any = true;
      w.whereExists(
        db("participants")
          .join("bots", "bots.id", "participants.bot_id")
          .whereRaw("participants.battle_id = battles.id")
          .where((p: any) =>
            p
              .where("bots.owner_id", userId)
              .orWhere((t: any) =>
                t
                  .whereNot("bots.visibility", "private")
                  .whereNotNull("bots.team_id")
                  .whereExists(
                    db("team_members")
                      .whereRaw("team_members.team_id = bots.team_id")
                      .where("team_members.user_id", userId),
                  ),
              ),
          ),
      );
    }
    if (publicEnabled) {
      const pub = (x: any) => wherePublicReplay(db, x);
      if (any) w.orWhere(pub);
      else w.where(pub);
      any = true;
    }
    // Sin sesión y sin capability pública: nada es legible.
    if (!any) w.whereRaw("false");
  });
}

/**
 * Batalla con replay que el solicitante PUEDE leer, o 404 uniforme. Se llama
 * antes de abrir ningún archivo.
 */
export async function getReadableReplayBattleOr404(
  db: Db,
  battleId: string,
  auth: Auth,
  publicEnabled: boolean,
): Promise<Record<string, any>> {
  let q = db("battles").where("battles.id", battleId).whereNotNull("battles.replay_ref").select("battles.*");
  q = whereReplayReadable(db, q, auth, publicEnabled);
  const battle = await q.first().catch(() => null); // id no-UUID ⇒ mismo 404
  if (!battle) throw replayNotFound();
  return battle;
}

/**
 * Predicado de replay PÚBLICO (vía 4) para las rutas `/public/replays*`, que no
 * miran la sesión: finished + capability + ningún bot no-público.
 */
export function wherePublicReplay(db: Knexish, q: any): any {
  return q
    .where("battles.status", "finished")
    .whereNotExists(
      db("participants")
        .join("bots", "bots.id", "participants.bot_id")
        .whereRaw("participants.battle_id = battles.id")
        .whereNot("bots.visibility", "public"),
    );
}
