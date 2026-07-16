/**
 * T7.5 · Recursos públicos de espectador (rol visitante): batallas en directo,
 * ticket WebSocket, auditoría de batalla, estadísticas y replays.
 *
 * El canal WebSocket real lo sirve el gateway/visor (E8/E10): aquí se emite el
 * ticket firmado — pendiente de reconciliación con E8 para el consumo del ticket.
 */
import { Router } from "express";
import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { jwtSecret } from "../auth/tokens.js";
import { anonQuota, type AnonQuotaConfig } from "../middleware/anon-quota.js";

const SPECTATE_TICKET_TTL_S = 60;

export function battleToJson(b: Record<string, unknown>, participants: Record<string, unknown>[]) {
  return {
    id: b.id,
    tournamentId: b.tournament_id ?? undefined,
    status: b.status,
    official: b.official,
    mode: b.mode,
    mapId: b.map_id,
    mapVersion: b.map_version,
    participants: participants.map((p) => ({
      botId: p.bot_id,
      version: p.version,
      team: p.team,
      outcome: p.outcome ?? undefined,
    })),
    result: b.result ?? undefined,
    failureKind: b.failure_kind,
  };
}

async function getBattleOr404(db: Db, id: string) {
  const battle = await db("battles").where({ id }).first().catch(() => null);
  if (!battle) throw notFound();
  return battle;
}

export function battleRoutes(db: Db, quota: AnonQuotaConfig): Router {
  const router = Router();

  defineOperation(router, "listBattles", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("battles").orderBy([{ column: "created_at", order: "desc" }, { column: "id", order: "desc" }]).limit(limit + 1);
    if (typeof req.query.status === "string") q = q.where({ status: req.query.status });
    if (cursor) q = q.whereRaw("(created_at, id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async (b: Record<string, unknown>) =>
        battleToJson(b, await db("participants").where({ battle_id: b.id })),
      ),
    );
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json({
      items,
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  defineOperation(router, "getBattle", async (req, res) => {
    const battle = await getBattleOr404(db, req.params.battleId);
    res.json(battleToJson(battle, await db("participants").where({ battle_id: battle.id })));
  });

  defineOperation(router, "createPracticeBattle", async (req, res) => {
    const { mode, rulesetId, mapId, mapVersion, seed, participants } = req.body ?? {};
    if (!["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"].includes(mode)) {
      throw badRequest("mode inválido");
    }
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > 8) {
      throw badRequest("participants: entre 1 y 8");
    }
    const ruleset = await db("rulesets").where({ id: rulesetId }).first();
    if (!ruleset) throw badRequest("rulesetId desconocido");
    const map = await db("map_versions")
      .where({ map_id: mapId, state: "published" })
      .modify((q) => {
        if (mapVersion) q.where({ version: mapVersion });
      })
      .orderBy("version", "desc")
      .first();
    if (!map) throw badRequest("Mapa inexistente o no publicado");

    for (const p of participants) {
      const v = await db("bot_versions").where({ bot_id: p.botId, version: p.version }).first().catch(() => null);
      if (!v || !["published", "frozen"].includes(v.state)) {
        throw conflict("bot_not_published", `El bot ${p.botId} v${p.version} no está publicado`);
      }
    }

    const [battle] = await db("battles")
      .insert({
        status: "scheduled",
        official: false, // las de práctica no afectan al rating
        mode,
        ruleset_id: rulesetId,
        map_id: map.map_id,
        map_version: map.version,
        seed: seed ?? null,
      })
      .returning("*");
    await db("participants").insert(
      participants.map((p: { botId: string; version: number; team: string }) => ({
        battle_id: battle.id,
        bot_id: p.botId,
        version: p.version,
        team: p.team,
      })),
    );
    // La ejecuta el worker de E9 sobre el motor de E2 — pendiente de reconciliación.
    await db("jobs").insert({ kind: "run_battle", payload: JSON.stringify({ battleId: battle.id }) });
    res.status(202).json(battleToJson(battle, await db("participants").where({ battle_id: battle.id })));
  });

  defineOperation(
    router,
    "getSpectateTicket",
    async (req, res) => {
      const battle = await getBattleOr404(db, req.params.battleId);
      const ticket = jwt.sign({ kind: "spectate", battleId: battle.id }, jwtSecret(), {
        expiresIn: SPECTATE_TICKET_TTL_S,
      });
      // El canal transporta SOLO snapshots públicos (D8): lo sirve el gateway (E8/E10).
      const wsBase = process.env.SPECTATE_WS_URL ?? "ws://localhost:8081/spectate";
      res.status(201).json({
        ticket,
        wsUrl: `${wsBase}/${battle.id}`,
        expiresAt: new Date(Date.now() + SPECTATE_TICKET_TTL_S * 1000).toISOString(),
      });
    },
    // Cuota anónima (DoD T7.5)
    (req, res, next) => anonQuota(db, "spectate-ticket", quota)(req, res, next),
  );

  defineOperation(router, "getBattleAudit", async (req, res) => {
    const battle = await getBattleOr404(db, req.params.battleId);
    const map = await db("map_versions").where({ map_id: battle.map_id, version: battle.map_version }).first();
    const participants = await db("participants").where({ battle_id: battle.id });
    const artifacts = [];
    for (const p of participants) {
      const v = await db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first();
      const art = v?.artifact_hash ? await db("artifacts").where({ hash: v.artifact_hash }).first() : null;
      artifacts.push({
        botId: p.bot_id,
        version: p.version,
        artifactHash: v?.artifact_hash ?? undefined,
        signature: art?.signature ?? undefined,
      });
    }
    // Público: la auditabilidad no exige revelar código (contrato E1).
    res.json({
      battleId: battle.id,
      seed: battle.seed ?? undefined,
      seedCommitment: battle.seed_commitment ?? undefined,
      seedRevealProof: battle.seed_reveal_proof ?? undefined,
      versions: battle.engine_versions ?? {},
      map: { mapId: battle.map_id, version: battle.map_version, checksum: map?.checksum ?? undefined },
      artifacts,
      finalStateHash: battle.final_state_hash ?? undefined,
    });
  });

  defineOperation(router, "getBattleStats", async (req, res) => {
    const battle = await getBattleOr404(db, req.params.battleId);
    const rows = await db("battle_stats").where({ battle_id: battle.id });
    const stats: Record<string, unknown> = {};
    for (const r of rows) stats[r.bot_id] = r.stats;
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ battleId: battle.id, perBot: stats });
  });

  // ------------------------------------------------------------- replays
  defineOperation(
    router,
    "getReplay",
    async (req, res) => {
      const battle = await getBattleOr404(db, req.params.battleId);
      if (!battle.replay_ref) throw notFound("La batalla no tiene replay publicado");
      // Política 23.1: el replay vive en un archivo; la BD solo guarda la referencia.
      let bytes: Buffer;
      try {
        bytes = await readFile(battle.replay_ref);
      } catch {
        throw notFound("Replay no disponible");
      }
      res
        .status(200)
        .setHeader("Content-Type", "application/octet-stream")
        .setHeader("Cache-Control", "public, max-age=3600, immutable")
        .send(bytes);
    },
    (req, res, next) => anonQuota(db, "replays", quota)(req, res, next),
  );

  return router;
}
