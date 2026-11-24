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
 * PRE-1 · Leer no es recibir el crudo: el fichero, el índice de almacén y los
 * segmentos sin proyectar sólo salen con `rawReplayAllowed` (replay-projection.ts);
 * cualquier otro lector recibe índice y segmentos PROYECTADOS (sin semilla, sin
 * comandos, sin loadouts) y un 404 uniforme en el fichero.
 *
 * Toda respuesta lleva `Cache-Control: private, no-store`: un contenido
 * autorizado por usuario no se puede quedar en una caché compartida.
 */
import { Router, type Request, type Response } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { ApiError, badRequest } from "../errors.js";
import { applyCursor, cursorTsSql, decodeCursor, encodeCursor, parseLimit, runCursorQuery } from "../serialize.js";
import { anonQuota, type AnonQuotaConfig } from "../middleware/anon-quota.js";
import { flagSource } from "../runtime-settings.js";
import { getReadableReplayBattleOr404, replayNotFound, whereReplayReadable } from "../replay-access.js";
import { applyReplayListFilters, assertCursorShape, parseReplayListFilters } from "../services/replay-list.js";
import { projectIndex, rawReplayAllowed } from "../replay-projection.js";
import {
  MAX_SEGMENT_TICKS,
  isS9rReplayRef,
  openView,
  parseRange,
  projectedSegment,
  rawSegment,
  storeIndexOf,
  streamRecipe,
  verifyRecipe,
  viewerMetaFromView,
  whereS9rReplay,
} from "../replay-s9r.js";

const NO_STORE = "private, no-store";

function noStore(res: Response): Response {
  return res.setHeader("Cache-Control", NO_STORE);
}

export function replayRoutes(
  db: Db,
  quota: AnonQuotaConfig,
  // MG · booleano fijo (tests) o getter de los ajustes de runtime: se lee por petición.
  publicReplaysEnabled?: boolean | (() => boolean),
): Router {
  const router = Router();
  const replaysOn = flagSource(publicReplaysEnabled, () => false);

  /**
   * V1 REPLAYS PR-4 · batalla legible CON replay S9R/1; cualquier otra referencia (formato
   * anterior, corte D-OP-30) es «sin replay»: el MISMO 404 que un replay inexistente.
   */
  async function readableS9r(req: Request) {
    const battle = await getReadableReplayBattleOr404(db, pathParam(req, "battleId"), req.auth, replaysOn());
    if (!isS9rReplayRef(battle.replay_ref)) throw replayNotFound();
    return battle;
  }

  // ------------------------------------------------------------- listado
  // Sustituye al `GET /replays` del replay-service (inventario de TODOS los
  // ficheros, anónimo). Sólo lo que el solicitante puede leer. PR-4 · los datos salen de la
  // BD (`battles` + `replay_artifacts`): el listado no abre ningún fichero.
  defineOperation(router, "listReplays", async (req, res) => {
    const limit = parseLimit(req.query.limit ?? 100);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    assertCursorShape(cursor);
    // EQ4 · filtros en servidor (aditivos): se validan ANTES de tocar la BD y se
    // aplican sobre la consulta YA restringida por la política de acceso.
    const filters = parseReplayListFilters(req.query);
    /** Batallas con replay legibles por el solicitante y que cumplen los filtros (sin orden ni página). */
    const readable = () =>
      applyReplayListFilters(
        db,
        // Diseño §8 · sólo cuenta como «con replay» una receta S9R/1 (whereS9rReplay).
        whereReplayReadable(
          db,
          whereS9rReplay(db("battles").whereNotNull("battles.replay_ref")),
          req.auth,
          replaysOn(),
        ),
        filters,
        req.auth,
      );
    let q = readable()
      .leftJoin("replay_artifacts as ra", "ra.battle_id", "battles.id")
      .select(
        "battles.id",
        "battles.official",
        "battles.result",
        "battles.created_at",
        "battles.finished_at",
        "ra.recipe_bytes as ra_recipe_bytes",
        "ra.view_bytes as ra_view_bytes",
        "ra.created_at as ra_created_at",
        db.raw(cursorTsSql("battles.created_at")),
      )
      .orderBy([
        { column: "battles.created_at", order: "desc" },
        { column: "battles.id", order: "desc" },
      ])
      .limit(limit + 1);
    q = applyCursor(q, cursor, "battles.created_at", ["battles.id"]);
    const rows = await runCursorQuery(q, cursor);
    const page = rows.slice(0, limit);
    const items = page.map((b: Record<string, any>) => {
      const result = (b.result ?? {}) as { winner?: string; ticks?: number; endReason?: string };
      // ADR-022 · detenida por la salvaguarda técnica: sin ganador ni empate («none» + motivo).
      // V1 REPLAYS PR-5 · `recording_limit` (tope de bytes de la grabación, replay truncado) tampoco tiene ganador.
      const technical = result.endReason === "technical_limit" || result.endReason === "recording_limit";
      return {
        battleId: b.id,
        ticks: result.ticks ?? 0,
        winner: technical ? "none" : (result.winner ?? "unknown"),
        ...(technical ? { endReason: result.endReason } : {}),
        official: Boolean(b.official),
        createdAt: new Date(b.ra_created_at ?? b.finished_at ?? b.created_at).toISOString(),
        sizeBytes: Number(b.ra_recipe_bytes ?? 0) + Number(b.ra_view_bytes ?? 0),
      };
    });
    // `total` SÓLO si se pide (includeTotal=true): cuenta de lo legible y filtrado,
    // independiente del cursor. Sin pedirlo, la respuesta es la histórica.
    let total: number | undefined;
    if (filters.includeTotal) {
      const [{ n }] = await readable().count({ n: "*" });
      total = Number(n);
    }
    noStore(res).json({
      items,
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1], [page[page.length - 1].id]) : undefined,
      ...(total !== undefined ? { total } : {}),
    });
  });

  // ---------------------------------------------------- archivo completo
  defineOperation(
    router,
    "getReplay",
    async (req, res) => {
      const battle = await readableS9r(req);
      // PRE-1 · el FICHERO CRUDO (semilla + comandos + loadouts) sólo con autorización
      // explícita (replay-projection.ts). Quien sólo puede leer la proyección recibe el
      // MISMO 404 que un replay inexistente: el visor usa índice y segmentos.
      if (!(await rawReplayAllowed(db, battle.id, req.auth))) throw replayNotFound();
      // PR-4 · la RECETA en streaming (nunca entera en memoria); el sha va en cabecera.
      noStore(res);
      try {
        await streamRecipe(res, battle);
      } catch {
        if (!res.headersSent) throw replayNotFound();
        res.destroy();
      }
    },
    (req, res, next) => anonQuota(db, "replays", quota)(req, res, next),
  );

  // -------------------------------------------------------------- índice
  defineOperation(
    router,
    "getReplayIndex",
    async (req, res) => {
      const battle = await readableS9r(req);
      const view = await openView(db, battle);
      if (!view) throw replayNotFound();
      try {
        const meta = await viewerMetaFromView(db, view.header);
        const index = storeIndexOf(battle, view);
        // PRE-1 · índice de almacén completo sólo con acceso al crudo; el resto, proyectado.
        if (await rawReplayAllowed(db, battle.id, req.auth)) {
          noStore(res).json({ ...index, world: meta.world, roster: meta.roster });
          return;
        }
        noStore(res).json(projectIndex(index, meta));
      } finally {
        await view.close();
      }
    },
    (req, res, next) => anonQuota(db, "replay-index", quota)(req, res, next),
  );

  // ------------------------------------- segmento por ticks (salto temporal)
  defineOperation(
    router,
    "getReplaySegment",
    async (req, res) => {
      const battle = await readableS9r(req);
      const view = await openView(db, battle);
      if (!view) throw replayNotFound();
      try {
        const ticks = Number((battle.result as { ticks?: number } | null)?.ticks ?? view.summary.lastTick);
        const range = parseRange(req.query.fromTick, req.query.toTick, ticks);
        if (!range) throw badRequest("Rango de ticks inválido (fromTick <= toTick, numéricos)");
        // PR-4 · tope de anchura: el segmento nunca materializa la vista entera.
        if (range === "too_large") {
          throw new ApiError(
            400,
            "segment_range_too_large",
            `Rango de ticks demasiado ancho (máximo ${MAX_SEGMENT_TICKS} ticks por segmento)`,
            { maxTicks: MAX_SEGMENT_TICKS },
          );
        }
        // Sólo los fragmentos de la vista que cubren [keyframe, toTick].
        const body = await rawSegment(battle, view, range);
        // PRE-1 · sin acceso al crudo: snapshots y eventos públicos, NUNCA comandos.
        if (await rawReplayAllowed(db, battle.id, req.auth)) {
          noStore(res).json(body);
          return;
        }
        // OLA 2 · MA · los ids públicos son los del documento ENTERO: la vista se recorre en
        // streaming hasta pasar el rango, sin retener nada fuera de él.
        const meta = await viewerMetaFromView(db, view.header);
        noStore(res).json(await projectedSegment(battle, view, meta, body));
      } finally {
        await view.close();
      }
    },
    (req, res, next) => anonQuota(db, "replay-segment", quota)(req, res, next),
  );

  /**
   * E8/T8.1 · verifyReplay: re-simula la RECETA con el motor (versión registrada en la
   * cabecera) leyéndola por fragmentos y compara hashes intermedios, checkpoints y resultado
   * con el oficial; antes, integridad del fichero entero contra el sha de la BD. Es cara
   * (re-simulación completa): cuota anónima propia. PRC (TD-004): misma política de acceso
   * que la lectura (verificar un replay privado revela su resultado).
   */
  defineOperation(
    router,
    "verifyReplay",
    async (req, res) => {
      const battle = await readableS9r(req);
      noStore(res).json(await verifyRecipe(battle));
    },
    (req, res, next) => anonQuota(db, "replay-verify", quota)(req, res, next),
  );

  return router;
}
