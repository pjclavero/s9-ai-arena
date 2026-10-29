/**
 * R-API · POST /battles/rules-check (`checkBattleRules`): la checklist de la FASE 11.
 *
 * Hace las MISMAS comprobaciones que POST /battles (contenido, forma de participantes,
 * composición por bando, visibilidad TD-005, versión publicada, reglas y topes de
 * composición) SIN crear nada, y devuelve el informe por bando y bot. Es una ayuda
 * para la UI: POST /battles lo recalcula todo y es la única autoridad.
 *
 * Privacidad: sólo se informa de bots que el solicitante PUEDE meter en una batalla
 * (un bot privado ajeno da 404, igual que en la creación). Su coste y masa ya los
 * revela la cabecera del replay (spec completo de cada vehículo) a quien lee la batalla.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { ROLE_RANK } from "../openapi.js";
import { ApiError, badRequest, conflict } from "../errors.js";
import { checkBattleContent } from "./catalog.js";
import { assertTeamComposition } from "./battles.js";
import { buildBattleRules, rulesToJson } from "../services/battle-rules.js";
import { MAX_BATTLE_PARTICIPANTS } from "../../../../packages/game-rules/battle-rules.js";

export function battleRulesRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "checkBattleRules", async (req, res) => {
    const { mode, rulesetId, mapId, mapVersion, participants, rules } = req.body ?? {};
    const content = await checkBattleContent(db, { mode, rulesetId, mapId, mapVersion });
    if (!content.ok) throw new ApiError(content.status, content.code, content.message);
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > MAX_BATTLE_PARTICIPANTS) {
      throw badRequest(`participants: entre 1 y ${MAX_BATTLE_PARTICIPANTS}`);
    }
    const seen = new Set<string>();
    for (const p of participants) {
      if (!p || typeof p !== "object") throw badRequest("participants: cada elemento debe ser un objeto");
      if (typeof p.botId !== "string" || p.botId.length === 0) throw badRequest("participants[].botId obligatorio");
      if (!Number.isInteger(p.version) || p.version < 1) throw badRequest("participants[].version: entero >= 1");
      if (typeof p.team !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(p.team)) {
        throw badRequest("participants[].team: 1-32 caracteres [A-Za-z0-9_-]");
      }
      if (seen.has(p.botId)) throw badRequest("participants: un bot solo puede aparecer una vez por batalla");
      seen.add(p.botId);
    }
    assertTeamComposition(mode, participants);

    // Visibilidad (TD-005): la MISMA regla que POST /battles. Invisible = 404 idéntico
    // a inexistente: no se revela nada de un bot privado ajeno.
    const userId = req.auth?.userId ?? null;
    const isAdmin = (req.auth?.rank ?? 0) >= ROLE_RANK.admin;
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

    // Reglas inválidas: 200 con ok:false y los errores por campo (la UI los pinta);
    // composición fuera de los topes: 200 con ok:false y el informe por bando/bot.
    try {
      const built = await buildBattleRules(
        db,
        { mode, rulesetId, rules, participants },
        { allowCompositionFailure: true },
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        ok: built.composition.ok,
        rules: rulesToJson(built.snapshot),
        composition: built.composition,
        errors: [],
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "rules_invalid" || err.code === "rules_team_size" || err.code === "rules_mode_mismatch")
      ) {
        res.setHeader("Cache-Control", "private, no-store");
        res.json({
          ok: false,
          rules: null,
          composition: null,
          errors: (err.extra.errors as unknown[]) ?? [{ field: "rules", code: err.code, message: err.message }],
        });
        return;
      }
      throw err;
    }
  });

  return router;
}
