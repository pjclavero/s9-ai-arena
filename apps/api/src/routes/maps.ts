/**
 * T7.5 · Mapas: lectura pública, importación validada con el validador REAL de E4,
 * publicación inmutable y generación procedural determinista (generador real de E4).
 */
import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { ApiError, badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
// Código REAL de E4 (T4.2/T4.4): validador de seis comprobaciones y generador con semilla.
import { validateMap, isPublishable } from "../../../map-service/src/validate/index.js";
import { generateMap as e4GenerateMap } from "../../../map-service/src/generate/index.js";
import { importTiled } from "../../../map-service/src/import-tiled.js";
import { makeThumbnail } from "../../../map-service/src/service.js";
import type { InternalMap } from "../../../map-service/src/types.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export function mapVersionToJson(m: Record<string, unknown>) {
  return {
    mapId: m.map_id,
    version: m.version,
    state: m.state,
    checksum: m.checksum ?? undefined,
    widthM: m.width_m ?? undefined,
    heightM: m.height_m ?? undefined,
    supportedModes: m.supported_modes ?? [],
    thumbnailUrl: m.thumbnail_url ?? undefined,
    generation: m.generation ?? undefined,
  };
}

async function insertMapVersion(
  db: Db,
  map: InternalMap,
  createdBy: string,
  extra: Record<string, unknown> = {},
) {
  const checksum = map.checksum ?? createHash("sha256").update(JSON.stringify(map)).digest("hex");
  await db("maps").insert({ id: map.mapId, name: map.mapId, created_by: createdBy }).onConflict("id").ignore();
  const max = await db("map_versions").where({ map_id: map.mapId }).max("version as m").first();
  const version = Number(max?.m ?? 0) + 1;
  const [row] = await db("map_versions")
    .insert({
      map_id: map.mapId,
      version,
      state: "validated",
      checksum,
      width_m: map.widthM,
      height_m: map.heightM,
      supported_modes: JSON.stringify(map.supportedModes ?? []),
      content: JSON.stringify(map),
      ...extra,
    })
    .returning("*");
  return row;
}

export function mapRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listMaps", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("map_versions")
      .orderBy([{ column: "created_at", order: "desc" }, { column: "map_id", order: "desc" }])
      .limit(limit + 1);
    if (cursor) q = q.whereRaw("(created_at, map_id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    res.json({
      items: page.map(mapVersionToJson),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].map_id) : undefined,
    });
  });

  defineOperation(router, "getMapVersion", async (req, res) => {
    const row = await db("map_versions")
      .where({ map_id: req.params.mapId, version: Number(req.params.version) })
      .first()
      .catch(() => null);
    if (!row) throw notFound();
    res.json(mapVersionToJson(row));
  });

  defineOperation(
    router,
    "importMap",
    async (req, res) => {
      const file = (req as unknown as { file?: { buffer: Buffer } }).file;
      if (!file) throw badRequest("file obligatorio");
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(file.buffer.toString("utf8"));
      } catch {
        throw badRequest("El archivo debe ser JSON (mapa interno o export JSON de Tiled)");
      }
      // TMX exportado a JSON de Tiled → importador real de E4; si no, mapa interno.
      let map: InternalMap;
      if (doc.type === "map" || doc.tiledversion) {
        try {
          map = importTiled(doc as never, {}).map;
        } catch (e) {
          res.status(422).json({
            error: "map_invalid",
            checks: [{ check: "geometry", severity: "error", message: (e as Error).message }],
          });
          return;
        }
      } else {
        map = doc as unknown as InternalMap;
      }

      const result = validateMap(map);
      if (!isPublishable(result)) {
        res.status(422).json({
          error: "map_invalid",
          checks: result.checks,
        });
        return;
      }
      const row = await insertMapVersion(db, map, req.auth!.userId);
      res.status(201).json(mapVersionToJson(row));
    },
    (req, res, next) => upload.single("file")(req, res, next),
  );

  defineOperation(router, "replaceMapVersion", async (req, res) => {
    // SIEMPRE 409: una versión publicada es inmutable (cap. 14.2).
    void req;
    void res;
    throw new ApiError(409, "immutable", "Una versión de mapa es inmutable: cree una versión nueva");
  });

  defineOperation(router, "publishMapVersion", async (req, res) => {
    const row = await db("map_versions")
      .where({ map_id: req.params.mapId, version: Number(req.params.version) })
      .first()
      .catch(() => null);
    if (!row) throw notFound();
    if (row.state === "published") {
      throw new ApiError(409, "illegal_transition", "Ya está publicada", {
        currentState: row.state,
        allowedTransitions: [],
      });
    }
    const map = row.content as InternalMap;
    const result = validateMap(map);
    if (!isPublishable(result)) {
      throw new ApiError(409, "illegal_transition", "La validación no pasó sin errores", {
        currentState: row.state,
        allowedTransitions: [],
      });
    }
    const thumbnail = makeThumbnail(map);
    const [updated] = await db("map_versions")
      .where({ map_id: row.map_id, version: row.version })
      .update({
        state: "published",
        published_at: db.fn.now(),
        thumbnail_url: `data:image/svg+xml;base64,${Buffer.from(thumbnail).toString("base64")}`,
      })
      .returning("*");
    await audit(db, {
      actorId: req.auth!.userId,
      action: "map.published",
      target: `map:${row.map_id}@${row.version}`,
      correlationId: req.correlationId,
    });
    res.json(mapVersionToJson(updated));
  });

  defineOperation(router, "generateMap", async (req, res) => {
    const { params, seed } = req.body ?? {};
    if (typeof seed !== "string" || !seed || typeof params !== "object" || params === null) {
      throw badRequest("params y seed obligatorios");
    }
    let generated;
    try {
      // Generador determinista de E4: misma semilla ⇒ mismo checksum.
      generated = e4GenerateMap(params as never, seed);
    } catch (e) {
      throw badRequest(`Parámetros de generación inválidos: ${(e as Error).message}`);
    }
    const map = generated.map;
    const result = validateMap(map);
    if (!isPublishable(result)) {
      res.status(422).json({
        error: "map_invalid",
        checks: result.checks,
      });
      return;
    }
    const row = await insertMapVersion(db, map, req.auth!.userId, {
      generation: JSON.stringify({ seed, generator: "e4-procedural" }),
    });
    res.status(201).json(mapVersionToJson(row));
  });

  return router;
}
