/**
 * Participantes de una batalla de práctica: UNA sola regla para POST /battles y para
 * POST /battles/rules-check (revisión R-RULES, PR #204: la visibilidad estaba copiada
 * en las dos rutas y podían divergir). Código movido tal cual desde routes/battles.ts.
 */
import type { Request } from "express";
import type { Db } from "../db/connection.js";
import { ROLE_RANK } from "../openapi.js";
import { ApiError, badRequest, conflict } from "../errors.js";
import { assertVersionsEligible, canonicalUuid } from "./version-eligibility.js";

export interface BattleParticipantInput {
  botId: string;
  version: number;
  team: string;
}

/**
 * DEV-B · forma de cada participante y composición mínima. PK de participants
 * = (battle_id, bot_id): un mismo bot NO puede ir en dos bandos (ni dos veces
 * en el mismo); antes eso acababa en un 500 por violación de PK.
 * ELIG · normaliza `botId` a su forma canónica (PG acepta MAYÚSCULAS/{llaves}).
 */
export function assertParticipantsShape(participants: unknown[]): asserts participants is BattleParticipantInput[] {
  const seen = new Set<string>();
  for (const p of participants as any[]) {
    if (!p || typeof p !== "object") throw badRequest("participants: cada elemento debe ser un objeto");
    if (typeof p.botId !== "string" || p.botId.length === 0) throw badRequest("participants[].botId obligatorio");
    if (!Number.isInteger(p.version) || p.version < 1) throw badRequest("participants[].version: entero >= 1");
    if (typeof p.team !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(p.team)) {
      throw badRequest("participants[].team: 1-32 caracteres [A-Za-z0-9_-]");
    }
    p.botId = canonicalUuid(p.botId); // ELIG · PG acepta MAYÚSCULAS/{llaves}: una sola forma
    if (seen.has(p.botId)) throw badRequest("participants: un bot solo puede aparecer una vez por batalla");
    seen.add(p.botId);
  }
}

/**
 * TD-005 · PROPIEDAD/VISIBILIDAD: sólo se puede meter en una batalla un bot
 * propio, público o de un equipo del que el solicitante es miembro (los
 * admin, cualquiera). Un bot privado ajeno responde EXACTAMENTE igual que uno
 * inexistente (404): no se revela que existe. Después: versión publicada/congelada
 * y (ELIG) elegible con el validador actual.
 */
export async function assertParticipantsUsable(
  db: Db,
  auth: Request["auth"] | undefined,
  participants: BattleParticipantInput[],
): Promise<void> {
  const userId = auth?.userId ?? null;
  const isAdmin = (auth?.rank ?? 0) >= ROLE_RANK.admin;
  for (const p of participants) {
    const bot = await db("bots")
      .where({ id: p.botId })
      .first()
      .catch(() => null);
    let visible = Boolean(bot) && (isAdmin || bot.owner_id === userId || bot.visibility === "public");
    if (bot && !visible && bot.visibility === "team" && bot.team_id && userId) {
      visible = Boolean(await db("team_members").where({ team_id: bot.team_id, user_id: userId }).first());
    }
    if (!visible) throw new ApiError(404, "bot_not_found", `El bot ${p.botId} no existe o no es accesible`);
  }

  for (const p of participants) {
    const v = await db("bot_versions")
      .where({ bot_id: p.botId, version: p.version })
      .first()
      .catch(() => null);
    if (!v || !["published", "frozen"].includes(v.state)) {
      throw conflict("bot_not_published", `El bot ${p.botId} v${p.version} no está publicado`);
    }
  }
  // ELIG · publicada ≠ elegible: el loadout histórico se revalida con el validador actual.
  await assertVersionsEligible(db, participants);
}
