/**
 * T7.5 · Mapas: lectura pública, importación validada con el validador REAL de E4,
 * publicación inmutable y generación procedural determinista (generador real de E4).
 */
import { Router } from "express";
import multer from "multer";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { ApiError, badRequest, forbidden, notFound } from "../errors.js";
import { ROLE_RANK } from "../openapi.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
// Código REAL de E4 (T4.2/T4.4): validador de seis comprobaciones y generador con semilla.
import { validateMap, isPublishable } from "../../../map-service/src/validate/index.js";
import { generateMap as e4GenerateMap } from "../../../map-service/src/generate/index.js";
import { importTiled } from "../../../map-service/src/import-tiled.js";
import { makeThumbnail } from "../../../map-service/src/service.js";
import { withChecksum } from "../../../map-service/src/canonical.js";
import type { InternalMap } from "../../../map-service/src/types.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Comprobación mínima de forma (no de contenido: eso lo hace `validateMap`). Solo
 * rechaza basura que haría explotar el validador (campos ausentes con `.` sobre
 * `undefined`), NO gatea con `isPublishable` — un borrador incompleto se guarda igual.
 */
function assertMapShape(doc: unknown): asserts doc is InternalMap {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw badRequest("El borrador debe ser un objeto de mapa (InternalMap)");
  }
  const m = doc as Record<string, unknown>;
  if (typeof m.mapId !== "string" || !m.mapId) {
    throw badRequest("mapId obligatorio (string no vacío)");
  }
  assertMapId(m.mapId);
  if (typeof m.widthM !== "number" || typeof m.heightM !== "number") {
    throw badRequest("widthM y heightM obligatorios (number)");
  }
  const layers = m.layers as Record<string, unknown> | undefined;
  if (typeof layers !== "object" || layers === null) {
    throw badRequest("layers obligatorio");
  }
  const ground = layers.ground as Record<string, unknown> | undefined;
  if (
    typeof ground !== "object" ||
    ground === null ||
    typeof ground.cols !== "number" ||
    typeof ground.rows !== "number" ||
    !Array.isArray(ground.data)
  ) {
    throw badRequest("layers.ground obligatorio (cols, rows, data)");
  }
  if (!Array.isArray(layers.walls)) throw badRequest("layers.walls obligatorio (array)");
  if (!Array.isArray(layers.spawns)) throw badRequest("layers.spawns obligatorio (array)");
  if (!Array.isArray(m.materials)) throw badRequest("materials obligatorio (array)");
  const meta = m.meta as Record<string, unknown> | undefined;
  if (typeof meta !== "object" || meta === null || !Array.isArray(meta.supportedModes)) {
    throw badRequest("meta.supportedModes obligatorio (array)");
  }
}

/** Patrón de `mapId` del esquema de E1 (packages/map-schema/map.schema.json). */
const MAP_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
function assertMapId(mapId: string): void {
  if (!MAP_ID_RE.test(mapId)) {
    throw badRequest("mapId inválido: minúsculas, dígitos y guiones (2-63), como exige el esquema de mapa");
  }
}

/**
 * FC-C · Formato de AUTORÍA antiguo del editor (slice 1: `{schemaVersion, id, name,
 * width, height, walls[], obstacles[], spawns[]}`, el de `maps/training-yard.json`).
 * No es un mapa interno: antes llegaba a `validateMap` y explotaba (500). Se detecta
 * y se rechaza con un mensaje accionable; el editor sí sabe abrirlo y convertirlo.
 */
function isLegacyAuthoringJson(doc: Record<string, unknown>): boolean {
  return typeof doc.id === "string" && typeof doc.width === "number" && doc.layers === undefined;
}

/** `validateMap` lanza con documentos malformados: se traduce a 400, nunca a 500. */
function safeValidate(map: InternalMap) {
  try {
    return validateMap(map);
  } catch (e) {
    throw badRequest(`El documento no es un mapa interno válido: ${(e as Error).message}`);
  }
}

export function mapVersionToJson(m: Record<string, unknown>, viewer?: { userId: string } | undefined) {
  const content = (typeof m.content === "string" ? safeParse(m.content) : m.content) as
    | { meta?: { name?: unknown } }
    | undefined;
  const name = typeof content?.meta?.name === "string" ? content.meta.name : undefined;
  return {
    mapId: m.map_id,
    name,
    // `mine` en vez de `createdBy`: el listado es público y no debe exponer UUID de usuarios.
    mine: viewer && m.created_by ? m.created_by === viewer.userId : false,
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

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

type Auth = { userId: string; rank: number };

/**
 * FC-C · Propiedad por mapa (TD-010): SOLO el creador del mapa (o un admin) puede
 * añadirle versiones o editar sus borradores. Un mapa sin dueño (`created_by` NULL:
 * contenido base de `seedContent`) solo lo versiona un admin. Bloquea la fila del mapa
 * (FOR UPDATE) para que el cálculo de la siguiente versión no compita con otro guardado.
 */
async function lockMapForWrite(trx: Db, mapId: string, auth: Auth): Promise<Record<string, unknown> | undefined> {
  const map = await trx("maps").where({ id: mapId }).forUpdate().first();
  if (!map) return undefined;
  if (auth.rank >= ROLE_RANK.admin) return map;
  if (map.created_by && map.created_by === auth.userId) return map;
  throw forbidden("Ese mapa pertenece a otro usuario: no puedes añadirle versiones ni editarlo");
}

/**
 * Normaliza el documento a la fila que lo indexa: `mapId`/`version` del propio
 * documento = los de la fila, y `checksum` = checksum CANÓNICO (map-service/canonical).
 * Es exactamente lo que `resolveBattleMap` exige para jugar el mapa: sin esto, un
 * mapa importado o guardado desde el editor se publicaba pero no era jugable
 * (`map_content_mismatch` / `map_checksum_mismatch`).
 */
function normalizeContent(map: InternalMap, version: number): InternalMap {
  const { checksum: _drop, ...rest } = map;
  return withChecksum({ ...rest, mapId: map.mapId, version });
}

function versionColumns(content: InternalMap) {
  return {
    checksum: content.checksum,
    width_m: content.widthM,
    height_m: content.heightM,
    // R2.1 (ERR-GES-03): los modos viven en meta.supportedModes (InternalMap).
    supported_modes: JSON.stringify(content.meta?.supportedModes ?? []),
    content: JSON.stringify(content),
  };
}

async function insertMapVersion(db: Db, map: InternalMap, auth: Auth, extra: Record<string, unknown> = {}) {
  return db.transaction(async (trx) => {
    const name = typeof map.meta?.name === "string" && map.meta.name ? map.meta.name.slice(0, 120) : map.mapId;
    const existing = await lockMapForWrite(trx, map.mapId, auth);
    if (!existing) {
      await trx("maps").insert({ id: map.mapId, name, created_by: auth.userId });
    }
    const max = await trx("map_versions").where({ map_id: map.mapId }).max("version as m").first();
    const version = Number(max?.m ?? 0) + 1;
    const content = normalizeContent(map, version);
    const [row] = await trx("map_versions")
      .insert({ map_id: map.mapId, version, state: "validated", ...versionColumns(content), ...extra })
      .returning("*");
    return { ...row, created_by: existing ? existing.created_by : auth.userId };
  });
}

/**
 * FC-C · Guardado del editor: un borrador es MUTABLE mientras siga en `draft`. Si la
 * última versión del mapa es un borrador, se reescribe EN SITIO (misma versión); si
 * no (no existe, o la última está validada/publicada, que son inmutables), se crea
 * una versión nueva en `draft`. Así "guardar" diez veces no fabrica diez versiones.
 */
async function upsertDraft(db: Db, map: InternalMap, auth: Auth) {
  return db.transaction(async (trx) => {
    const name = typeof map.meta?.name === "string" && map.meta.name ? map.meta.name.slice(0, 120) : map.mapId;
    const existing = await lockMapForWrite(trx, map.mapId, auth);
    if (!existing) {
      await trx("maps").insert({ id: map.mapId, name, created_by: auth.userId });
    } else {
      await trx("maps").where({ id: map.mapId }).update({ name });
    }
    const latest = await trx("map_versions").where({ map_id: map.mapId }).orderBy("version", "desc").first();
    const owner = existing ? existing.created_by : auth.userId;
    if (latest && latest.state === "draft") {
      const content = normalizeContent(map, latest.version);
      const [row] = await trx("map_versions")
        .where({ map_id: map.mapId, version: latest.version, state: "draft" })
        .update(versionColumns(content))
        .returning("*");
      return { row: { ...row, created_by: owner }, created: false };
    }
    const version = Number(latest?.version ?? 0) + 1;
    const content = normalizeContent(map, version);
    const [row] = await trx("map_versions")
      .insert({ map_id: map.mapId, version, state: "draft", ...versionColumns(content) })
      .returning("*");
    return { row: { ...row, created_by: owner }, created: true };
  });
}

/**
 * Visibilidad de versiones: `validated`/`published` son públicas; un `draft` solo
 * lo ve su dueño (o un admin). Para el resto, un borrador NO existe (404, sin
 * revelar que hay trabajo en curso).
 */
function canSeeVersion(row: Record<string, unknown>, auth: Auth | undefined): boolean {
  if (row.state !== "draft") return true;
  if (!auth) return false;
  if (auth.rank >= ROLE_RANK.admin) return true;
  return !!row.created_by && row.created_by === auth.userId;
}

async function getVersionRow(db: Db, mapId: string, version: unknown) {
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return db("map_versions")
    .join("maps", "maps.id", "map_versions.map_id")
    .where({ "map_versions.map_id": mapId, "map_versions.version": n })
    .select("map_versions.*", "maps.created_by")
    .first()
    .catch(() => undefined);
}

export function mapRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listMaps", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const auth = req.auth;
    let q = db("map_versions")
      .join("maps", "maps.id", "map_versions.map_id")
      .select("map_versions.*", "maps.created_by")
      .orderBy([
        { column: "map_versions.created_at", order: "desc" },
        { column: "map_versions.map_id", order: "desc" },
        { column: "map_versions.version", order: "desc" },
      ])
      .limit(limit + 1);
    // FC-C · los borradores solo los ve su dueño (o un admin): el listado es público.
    if (!auth) {
      q = q.whereNot("map_versions.state", "draft");
    } else if (auth.rank < ROLE_RANK.admin) {
      q = q.where((w) => w.whereNot("map_versions.state", "draft").orWhere("maps.created_by", auth.userId));
    }
    if (req.query.mine === "true") {
      if (!auth) throw badRequest("mine=true exige sesión");
      q = q.where("maps.created_by", auth.userId);
    }
    if (cursor) q = q.whereRaw("(map_versions.created_at, map_versions.map_id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    res.json({
      items: page.map((r: Record<string, unknown>) => mapVersionToJson(r, auth)),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].map_id) : undefined,
    });
  });

  defineOperation(router, "getMapVersion", async (req, res) => {
    const row = await getVersionRow(db, String(req.params.mapId), req.params.version);
    if (!row || !canSeeVersion(row, req.auth)) throw notFound();
    res.json(mapVersionToJson(row, req.auth));
  });

  // FC-C · el documento completo (InternalMap) de una versión: lo que el editor
  // necesita para REABRIR un mapa guardado y lo que exporta. Misma visibilidad
  // que getMapVersion.
  defineOperation(router, "getMapVersionContent", async (req, res) => {
    const row = await getVersionRow(db, String(req.params.mapId), req.params.version);
    if (!row || !canSeeVersion(row, req.auth)) throw notFound();
    const content = typeof row.content === "string" ? safeParse(row.content) : row.content;
    res.json(content);
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
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        throw badRequest("El archivo debe contener un objeto JSON de mapa");
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
      } else if (isLegacyAuthoringJson(doc)) {
        throw badRequest(
          "Formato de autoría antiguo del editor (id/width/walls): ábrelo en el editor de mapas, que lo convierte, y guárdalo o expórtalo como mapa interno",
        );
      } else {
        // Antes iba directo a validateMap, que LANZA sin `layers` → 500 (TD-010).
        assertMapShape(doc);
        map = doc as unknown as InternalMap;
      }
      assertMapId(map.mapId);

      const result = safeValidate(map);
      if (!isPublishable(result)) {
        res.status(422).json({
          error: "map_invalid",
          checks: result.checks,
        });
        return;
      }
      const row = await insertMapVersion(db, map, req.auth!);
      res.status(201).json(mapVersionToJson(row, req.auth));
    },
    (req, res, next) => upload.single("file")(req, res, next),
  );

  // N4/R10 slice 2 + FC-C: el editor visual guarda progreso a medias (WIP). NO gatea
  // con isPublishable: se persiste con warnings o incluso errores, y se devuelven los
  // checks para que el editor los muestre. Un borrador es mutable en sitio
  // (upsertDraft); solo el dueño del mapa lo guarda (lockMapForWrite).
  //
  // El cuerpo cae bajo el límite global de express.json (1mb, app.ts): amplio a
  // propósito para un mapa de editor (grid ~120×80 ≈ decenas de KB).
  defineOperation(router, "saveMapDraft", async (req, res) => {
    assertMapShape(req.body);
    const map = req.body as InternalMap;
    const result = safeValidate(map);
    const { row, created } = await upsertDraft(db, map, req.auth!);
    await audit(db, {
      actorId: req.auth!.userId,
      action: created ? "map.draft_saved" : "map.draft_updated",
      target: `map:${row.map_id}@${row.version}`,
      correlationId: req.correlationId,
    });
    res.status(created ? 201 : 200).json({ ...mapVersionToJson(row, req.auth), checks: result.checks });
  });

  defineOperation(router, "replaceMapVersion", async (req, res) => {
    // SIEMPRE 409: una versión publicada es inmutable (cap. 14.2).
    void req;
    void res;
    throw new ApiError(409, "immutable", "Una versión de mapa es inmutable: cree una versión nueva");
  });

  defineOperation(router, "publishMapVersion", async (req, res) => {
    const row = await getVersionRow(db, String(req.params.mapId), req.params.version);
    if (!row || !canSeeVersion(row, req.auth)) throw notFound();
    // FC-C · publica el DUEÑO del mapa; organizer+ puede publicar cualquiera (curación
    // de mapas para competiciones). Publicar no cambia el contenido: lo congela.
    const auth = req.auth!;
    const isOwner = !!row.created_by && row.created_by === auth.userId;
    if (!isOwner && auth.rank < ROLE_RANK.organizer) {
      throw forbidden("Solo el dueño del mapa (u organizer) puede publicarlo");
    }
    if (row.state === "published") {
      throw new ApiError(409, "illegal_transition", "Ya está publicada", {
        currentState: row.state,
        allowedTransitions: [],
      });
    }
    const map = (typeof row.content === "string" ? safeParse(row.content) : row.content) as InternalMap;
    const result = safeValidate(map);
    if (!isPublishable(result)) {
      throw new ApiError(409, "illegal_transition", "La validación no pasó sin errores", {
        currentState: row.state,
        allowedTransitions: [],
        checks: result.checks,
      });
    }
    const thumbnail = makeThumbnail(map);
    const [updated] = await db("map_versions")
      .where({ map_id: row.map_id, version: row.version })
      .whereNot({ state: "published" })
      .update({
        state: "published",
        published_at: db.fn.now(),
        thumbnail_url: `data:image/svg+xml;base64,${Buffer.from(thumbnail).toString("base64")}`,
      })
      .returning("*");
    if (!updated) {
      throw new ApiError(409, "illegal_transition", "Ya está publicada", {
        currentState: "published",
        allowedTransitions: [],
      });
    }
    await audit(db, {
      actorId: auth.userId,
      action: "map.published",
      target: `map:${row.map_id}@${row.version}`,
      correlationId: req.correlationId,
    });
    res.json(mapVersionToJson({ ...updated, created_by: row.created_by }, auth));
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
    assertMapId(map.mapId);
    const result = safeValidate(map);
    if (!isPublishable(result)) {
      res.status(422).json({
        error: "map_invalid",
        checks: result.checks,
      });
      return;
    }
    const row = await insertMapVersion(db, map, req.auth!, {
      generation: JSON.stringify({ seed, generator: "e4-procedural" }),
    });
    res.status(201).json(mapVersionToJson(row, req.auth));
  });

  return router;
}
