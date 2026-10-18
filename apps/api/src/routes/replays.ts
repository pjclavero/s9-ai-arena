/**
 * PRC (TD-004) · Replays para el navegador: la API es la ÚNICA puerta.
 *
 * Antes el visor leía índice y segmentos DIRECTAMENTE del replay-service a
 * través del gateway (`location /replays/` → `proxy_pass` sin autenticación):
 * cualquier anónimo descargaba inventario, archivo, índice y segmentos de
 * replays privados. Ahora el gateway responde 404 en `/replays*` y estas rutas
 * (bajo `/api/v1/replays…`) aplican la política de `replay-access.ts` ANTES de
 * abrir ningún archivo. La API ya montaba el volumen de replays en sólo lectura
 * (`arena_replays:/data/replays:ro`) y lee `battles.replay_ref`; el
 * replay-service queda interno (ingesta del worker).
 *
 * Toda respuesta lleva `Cache-Control: private, no-store`: un contenido
 * autorizado por usuario no se puede quedar en una caché compartida.
 */
import { Router, type Response } from "express";
import { readFile } from "node:fs/promises";
import { fromJsonl, type Replay } from "../../../arena-engine/src/replay.js";
import { decompress, sha256 } from "../../../replay-service/src/format.js";
import { verifyLoaded } from "../../../replay-service/src/store.js";
import { DecodedReplayCache, indexFileFor, readIndexFile, sliceSegment } from "../../../replay-service/src/segment.js";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { badRequest } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { anonQuota, type AnonQuotaConfig } from "../middleware/anon-quota.js";
import { publicReplaysEnabledFromEnv } from "../public-replays.js";
import { getReadableReplayBattleOr404, replayNotFound, whereReplayReadable } from "../replay-access.js";

const NO_STORE = "private, no-store";

function noStore(res: Response): Response {
  return res.setHeader("Cache-Control", NO_STORE);
}

export function replayRoutes(
  db: Db,
  quota: AnonQuotaConfig,
  publicReplaysEnabled: boolean = publicReplaysEnabledFromEnv(),
): Router {
  const router = Router();
  const decoded = new DecodedReplayCache();

  /** Índice del replay de una batalla YA autorizada, o 404 uniforme. */
  function indexOf(battle: Record<string, any>) {
    const index = readIndexFile(indexFileFor(battle.replay_ref));
    if (!index) throw replayNotFound();
    return index;
  }

  // ------------------------------------------------------------- listado
  // Sustituye al `GET /replays` del replay-service (inventario de TODOS los
  // ficheros, anónimo). Sólo lo que el solicitante puede leer.
  defineOperation(router, "listReplays", async (req, res) => {
    const limit = parseLimit(req.query.limit ?? 100);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("battles")
      .whereNotNull("battles.replay_ref")
      .select(
        "battles.id",
        "battles.official",
        "battles.result",
        "battles.replay_ref",
        "battles.created_at",
        "battles.finished_at",
      )
      .orderBy([
        { column: "battles.created_at", order: "desc" },
        { column: "battles.id", order: "desc" },
      ])
      .limit(limit + 1);
    q = whereReplayReadable(db, q, req.auth, publicReplaysEnabled);
    if (cursor) q = q.whereRaw("(battles.created_at, battles.id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    const items = page.map((b: Record<string, any>) => {
      let index = null;
      try {
        index = readIndexFile(indexFileFor(b.replay_ref));
      } catch {
        index = null; // índice corrupto: la fila sale con los datos de la BD
      }
      const result = (b.result ?? {}) as { winner?: string; ticks?: number };
      return {
        battleId: b.id,
        ticks: index?.ticks ?? result.ticks ?? 0,
        winner: index?.result?.winner ?? result.winner ?? "unknown",
        official: Boolean(b.official),
        createdAt: new Date(index?.createdAt ?? b.finished_at ?? b.created_at).toISOString(),
        sizeBytes: index?.sizeBytes ?? 0,
      };
    });
    noStore(res).json({
      items,
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  // ---------------------------------------------------- archivo completo
  defineOperation(
    router,
    "getReplay",
    async (req, res) => {
      const battle = await getReadableReplayBattleOr404(db, pathParam(req, "battleId"), req.auth, publicReplaysEnabled);
      // Política 23.1: el replay vive en un archivo; la BD solo guarda la referencia.
      let bytes: Buffer;
      try {
        bytes = await readFile(battle.replay_ref);
      } catch {
        throw replayNotFound();
      }
      noStore(res).status(200).setHeader("Content-Type", "application/octet-stream").send(bytes);
    },
    (req, res, next) => anonQuota(db, "replays", quota)(req, res, next),
  );

  // -------------------------------------------------------------- índice
  defineOperation(
    router,
    "getReplayIndex",
    async (req, res) => {
      const battle = await getReadableReplayBattleOr404(db, pathParam(req, "battleId"), req.auth, publicReplaysEnabled);
      noStore(res).json(indexOf(battle));
    },
    (req, res, next) => anonQuota(db, "replay-index", quota)(req, res, next),
  );

  // ------------------------------------- segmento por ticks (salto temporal)
  defineOperation(
    router,
    "getReplaySegment",
    async (req, res) => {
      const battle = await getReadableReplayBattleOr404(db, pathParam(req, "battleId"), req.auth, publicReplaysEnabled);
      const index = indexOf(battle);
      const d = decoded.get(battle.id, battle.replay_ref, index);
      if (!d) throw replayNotFound();
      const seg = sliceSegment(index, d, req.query.fromTick, req.query.toTick);
      if (!seg.ok) throw badRequest("Rango de ticks inválido (fromTick <= toTick, numéricos)");
      noStore(res).json(seg.body);
    },
    (req, res, next) => anonQuota(db, "replay-segment", quota)(req, res, next),
  );

  /**
   * E8/T8.1 · verifyReplay: re-simula el replay con el motor de E2 (versión registrada
   * en la cabecera) y compara resultado y hashes con el oficial. Es cara
   * (re-simulación completa): cuota anónima propia. PRC (TD-004): misma política
   * de acceso que la lectura (verificar un replay privado revela su resultado).
   */
  defineOperation(
    router,
    "verifyReplay",
    async (req, res) => {
      const battle = await getReadableReplayBattleOr404(db, pathParam(req, "battleId"), req.auth, publicReplaysEnabled);
      let bytes: Buffer;
      try {
        bytes = await readFile(battle.replay_ref);
      } catch {
        throw replayNotFound();
      }
      noStore(res);
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

  return router;
}
