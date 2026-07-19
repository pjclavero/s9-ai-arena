/**
 * T7.5 · Recursos públicos de espectador (rol visitante): batallas en directo,
 * ticket WebSocket, auditoría de batalla, estadísticas y replays.
 *
 * El canal WebSocket real lo sirve el gateway/visor (E8/E10): aquí se emite el
 * ticket firmado — pendiente de reconciliación con E8 para el consumo del ticket.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fromJsonl, type Replay } from "../../../arena-engine/src/replay.js";
import { decompress, sha256 } from "../../../replay-service/src/format.js";
import { verifyLoaded } from "../../../replay-service/src/store.js";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { ROLE_RANK } from "../openapi.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { signSpectateTicket } from "../auth/tokens.js";
import { anonQuota, type AnonQuotaConfig } from "../middleware/anon-quota.js";
import { isSignedDigest, type BattleRunConfig } from "../battle-run.js";

const SPECTATE_TICKET_TTL_S = 60;

/**
 * R2.6 (ERR-SEC-16): base del WebSocket de espectador. En producción es
 * OBLIGATORIO configurar SPECTATE_WS_URL con esquema wss:// (el ticket viaja
 * por ese canal); si falta o va en claro, se falla CERRADO con 500 de
 * configuración en vez de emitir tickets que viajarían sin cifrar.
 */
export function spectateWsBase(): string {
  const wsBase = process.env.SPECTATE_WS_URL ?? "ws://localhost:8081/spectate";
  if (process.env.NODE_ENV === "production" && !wsBase.startsWith("wss://")) {
    throw new ApiError(500, "spectate_ws_misconfigured", "SPECTATE_WS_URL debe ser wss:// en producción");
  }
  return wsBase;
}

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
  const battle = await db("battles")
    .where({ id })
    .first()
    .catch(() => null);
  if (!battle) throw notFound();
  return battle;
}

export function battleRoutes(db: Db, quota: AnonQuotaConfig, runCfg?: BattleRunConfig): Router {
  const router = Router();

  defineOperation(router, "listBattles", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("battles")
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(limit + 1);
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
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  defineOperation(router, "getBattle", async (req, res) => {
    const battle = await getBattleOr404(db, pathParam(req, "battleId"));
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
      const v = await db("bot_versions")
        .where({ bot_id: p.botId, version: p.version })
        .first()
        .catch(() => null);
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
      const battle = await getBattleOr404(db, pathParam(req, "battleId"));
      // E8/T8.2: jti ⇒ el gateway hace el ticket de UN SOLO USO; debug ⇒ capas de
      // depuración (sensores, rutas, colisiones) solo para roles autorizados: el flag
      // viaja FIRMADO por la API, el visor no puede autoconcedérselo.
      const debug = (req.auth?.rank ?? 0) >= ROLE_RANK.moderator;
      const ticket = signSpectateTicket({ battleId: battle.id, jti: randomUUID(), debug }, SPECTATE_TICKET_TTL_S);
      // El canal transporta SOLO snapshots públicos (D8): lo sirve el gateway (E8/E10).
      // R2.6 (ERR-SEC-16): en producción se EXIGE wss:// — el defecto en claro
      // solo vale para dev/test. Falla cerrado: mejor 500 que un ticket que
      // viajaría sin cifrar (y acabaría en logs de red intermedios).
      const wsBase = spectateWsBase();
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
    const battle = await getBattleOr404(db, pathParam(req, "battleId"));
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
    const battle = await getBattleOr404(db, pathParam(req, "battleId"));
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
      const battle = await getBattleOr404(db, pathParam(req, "battleId"));
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

  /**
   * E8/T8.1 · verifyReplay: re-simula el replay con el motor de E2 (versión registrada
   * en la cabecera) y compara resultado y hashes con el oficial. Era la operación
   * pendiente declarada por E7 en conformance.test.ts — la implementa E8 sobre el
   * replay-service real, no en paralelo. Es cara (re-simulación completa): cuota
   * anónima propia, más estricta que la de descarga.
   */
  defineOperation(
    router,
    "verifyReplay",
    async (req, res) => {
      const battle = await getBattleOr404(db, pathParam(req, "battleId"));
      if (!battle.replay_ref) throw notFound("La batalla no tiene replay publicado");
      let bytes: Buffer;
      try {
        bytes = await readFile(battle.replay_ref);
      } catch {
        throw notFound("Replay no disponible");
      }
      // Manipulación byte a byte: el hash registrado en la BD manda (DoD T8.1).
      if (battle.replay_hash && sha256(bytes) !== battle.replay_hash) {
        res.json({ matches: false, valid: false, reason: "checksum_mismatch" });
        return;
      }
      let replay: Replay;
      try {
        replay = fromJsonl(decompress(bytes).toString("utf8"));
      } catch (e) {
        res.json({ matches: false, valid: false, reason: `corrupt_file: ${(e as Error).message}` });
        return;
      }
      const r = await verifyLoaded(battle.id, replay);
      // Cinturón extra: el resultado oficial del ARCHIVO debe ser el que registró la BD.
      const dbHashOk = !battle.final_state_hash || battle.final_state_hash === replay.result?.finalStateHash;
      res.json({
        matches: (r.verification?.matches ?? false) && dbHashOk,
        officialHash: r.verification?.officialHash,
        recomputedHash: r.verification?.recomputedHash,
        valid: r.valid && dbHashOk,
        reason: !dbHashOk ? "final_state_hash_mismatch_with_db" : r.reason,
        divergedAtTick: r.verification?.divergedAtTick ?? undefined,
      });
    },
    (req, res, next) => anonQuota(db, "replay-verify", quota)(req, res, next),
  );

  // R6.2/R9-B · Ejecución containerizada REAL (gateada y validada). Delega en un launcher
  // inyectado; la API nunca llama a Docker. Apagado por defecto → 503.
  defineOperation(router, "runBattle", async (req, res) => {
    const battleId = pathParam(req, "battleId");

    if (!runCfg?.enabled) {
      res
        .status(503)
        .json({ error: "real_battle_runs_disabled", message: "Real battle execution is disabled in this environment" });
      return;
    }

    const battle = await getBattleOr404(db, battleId);
    if (battle.status !== "scheduled") {
      res.status(409).json({ error: "invalid_state", message: `La batalla está en estado ${battle.status}` });
      return;
    }

    // Mapa publicado.
    const map = await db("map_versions")
      .where({ map_id: battle.map_id, version: battle.map_version, state: "published" })
      .first();
    if (!map) {
      res.status(409).json({ error: "map_not_published", message: "El mapa de la batalla no está publicado" });
      return;
    }

    // Bots ready/signed con digest válido.
    const parts = await db("participants").where({ battle_id: battleId });
    const participants: { botId: string; version: number; team: string; artifactHash: string }[] = [];
    for (const p of parts) {
      const v = await db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first();
      if (!v || !["published", "frozen"].includes(v.state)) {
        res.status(409).json({ error: "bot_not_ready", message: `El bot ${p.bot_id} v${p.version} no está publicado` });
        return;
      }
      if (!isSignedDigest(v.artifact_hash)) {
        res
          .status(409)
          .json({ error: "bot_not_signed", message: `El bot ${p.bot_id} v${p.version} no tiene digest firmado` });
        return;
      }
      participants.push({ botId: p.bot_id, version: p.version, team: p.team, artifactHash: v.artifact_hash });
    }

    // Runner disponible (aún no cableado en producción → 503 hasta el paso VM108).
    if (!runCfg.runner) {
      res
        .status(503)
        .json({ error: "runner_unavailable", message: "Battle runner not configured in this environment" });
      return;
    }

    const result = await runCfg.runner.launch({
      battleId,
      mode: battle.mode,
      mapId: battle.map_id,
      mapVersion: battle.map_version,
      seed: battle.seed ?? null,
      participants,
    });
    res.status(200).json({
      battleId,
      status: result.status,
      runner: result.runner,
      replay: result.replay ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
  });

  return router;
}
