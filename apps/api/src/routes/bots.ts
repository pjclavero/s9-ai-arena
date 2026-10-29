/**
 * T7.3 · CRUD de bots, revisiones de loadout (validador E3 en servidor),
 * versiones de código y transiciones de estado como acciones explícitas.
 */
import { Router } from "express";
import multer from "multer";
import type { Db } from "../db/connection.js";
import { defineOperation, defineExtension } from "../registry.js";
import { pathParam } from "../params.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";
import {
  applyTransition,
  assertLoadoutRevisionUsable,
  assertOwner,
  canSeeBot,
  createLoadoutRevision,
  getVisibleBot,
  isStaff,
  validateLoadoutServerSide,
} from "../services/bots.js";
import { PIPELINE_STAGES, type BotManagerClient } from "../services/bot-manager.js";
import { sharedRateLimit, type RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { contentDispositionAttachment, sanitizeSourceFilename } from "../services/filenames.js";
import { decodePackage, PackageValidationError } from "../services/source-package.js";
import { diffFiles } from "../services/bot-version-diff.js";
import { findVersionArtifact } from "../../../bot-manager/src/launch-verify.js";
import type { Auth } from "../services/bots.js";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MB (E6.M)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SOURCE_BYTES } });

export function botToJson(bot: Record<string, unknown>, latestPublished?: number, rating?: number) {
  return {
    id: bot.id,
    name: bot.name,
    ownerId: bot.owner_id,
    teamId: bot.team_id ?? undefined,
    visibility: bot.visibility,
    latestPublishedVersion: latestPublished,
    rating,
    createdAt: (bot.created_at as Date).toISOString(),
  };
}

export function versionToJson(v: Record<string, unknown>) {
  return {
    botId: v.bot_id,
    version: v.version,
    state: v.state,
    runtime: v.runtime,
    loadoutRevision: v.loadout_revision,
    artifactHash: v.artifact_hash ?? undefined,
    codePublic: v.code_public,
    rejectionReason: v.rejection_reason ?? undefined,
    createdAt: (v.created_at as Date).toISOString(),
    // DEV-A · A9: identidad y procedencia de la versión.
    id: v.id,
    parentVersion: v.parent_version ?? undefined,
    validatedBuildId: v.validated_build_id ?? undefined,
    publishedAt: v.published_at ? (v.published_at as Date).toISOString() : undefined,
  };
}

export function artifactToJson(botId: string, version: number, a: Record<string, unknown>) {
  return {
    botId,
    version,
    hash: a.hash,
    signature: a.signature ?? undefined,
    sizeBytes: a.size_bytes != null ? Number(a.size_bytes) : undefined,
    buildId: a.build_id,
    createdAt: (a.created_at as Date).toISOString(),
  };
}

/**
 * A9.16 · ¿Puede `auth` leer el CÓDIGO de esta versión? Única regla para
 * source, files y diff: dueño, compañero del equipo del bot, staff, o versión
 * published con code_public (D9). Quien no ve el bot ya recibió 404 antes.
 */
export async function canReadSource(
  db: Db,
  auth: Auth,
  bot: Record<string, unknown>,
  v: Record<string, unknown>,
): Promise<boolean> {
  if (!auth) return v.state === "published" && v.code_public === true;
  if (auth.userId === bot.owner_id || isStaff(auth)) return true;
  if (bot.team_id != null && (await db("team_members").where({ team_id: bot.team_id, user_id: auth.userId }).first())) {
    return true;
  }
  return v.state === "published" && v.code_public === true;
}

function decodeVersionFiles(v: Record<string, unknown>) {
  const raw = v.source ? Buffer.from(v.source as Buffer) : Buffer.alloc(0);
  let packaged = false;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    packaged = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && "files" in parsed;
  } catch {
    packaged = false;
  }
  try {
    return { packaged, files: decodePackage(raw, v.runtime as "python" | "node") };
  } catch (e) {
    if (e instanceof PackageValidationError) {
      throw new ApiError(422, "source_package_invalid", e.message);
    }
    throw e;
  }
}

/** Inserta la versión siguiente; reintenta si otra petición tomó el número (UNIQUE). */
async function insertNextVersion(db: Db, botId: string, row: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    const max = await db("bot_versions").where({ bot_id: botId }).max("version as m").first();
    try {
      const [version] = await db("bot_versions")
        .insert({ ...row, bot_id: botId, version: Number(max?.m ?? 0) + 1, state: "draft" })
        .returning("*");
      return version;
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && attempt < 4) continue;
      throw e;
    }
  }
}

export function loadoutToJson(l: Record<string, unknown>) {
  return {
    loadoutId: l.id,
    revision: l.revision,
    name: l.name ?? undefined,
    catalogVersion: l.catalog_version,
    chassis: l.chassis,
    modules: typeof l.modules === "string" ? JSON.parse(l.modules) : l.modules,
    summary: typeof l.summary === "string" ? JSON.parse(l.summary) : (l.summary ?? undefined),
  };
}

export function buildToJson(b: Record<string, unknown>, opts: { includeLogs: boolean }) {
  const stages = (typeof b.stages === "string" ? JSON.parse(b.stages) : (b.stages as unknown[])) as Record<
    string,
    unknown
  >[];
  return {
    id: b.id,
    botId: b.bot_id,
    version: b.version,
    status: b.status,
    stages: stages.map((s) => ({
      name: s.name,
      status: s.status,
      message: s.message ?? undefined,
      // logUrl es x-private: solo dueño, moderador o admin (contrato E1).
      ...(opts.includeLogs && s.logUrl ? { logUrl: s.logUrl } : {}),
      // DEV-A · A4: logs persistidos (x-private) y métricas de la etapa.
      ...(opts.includeLogs && Array.isArray(s.logs) ? { logs: s.logs } : {}),
      ...(s.metrics ? { metrics: s.metrics } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
    })),
    artifactHash: b.artifact_hash ?? undefined,
    createdAt: (b.created_at as Date).toISOString(),
    updatedAt: b.updated_at ? (b.updated_at as Date).toISOString() : undefined,
  };
}

async function latestPublishedVersion(db: Db, botId: string): Promise<number | undefined> {
  const r = await db("bot_versions").where({ bot_id: botId, state: "published" }).max("version as m").first();
  return r?.m ?? undefined;
}

async function getVersionOr404(db: Db, botId: string, version: string) {
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  const v = await db("bot_versions").where({ bot_id: botId, version: n }).first();
  if (!v) throw notFound();
  return v;
}

/** Limitadores por usuario de la creación de versiones y del encolado de builds (R2.5 · ERR-SEC-12). */
export interface BotBuildLimiters {
  createVersion: RateLimiterLike;
  submit: RateLimiterLike;
}

export function botRoutes(db: Db, botManager: BotManagerClient, limiters?: BotBuildLimiters): Router {
  const router = Router();
  // Sin limitadores inyectados (tests antiguos), no se limita: la app SIEMPRE los cablea.
  const limitCreateVersion = limiters ? [sharedRateLimit(limiters.createVersion)] : [];
  const limitSubmit = limiters ? [sharedRateLimit(limiters.submit)] : [];

  // ------------------------------------------------------------------ CRUD
  defineOperation(router, "listBots", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("bots")
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(200);
    if (typeof req.query.ownerId === "string") q = q.where({ owner_id: req.query.ownerId });
    if (cursor) q = q.whereRaw("(created_at, id) < (?, ?)", [cursor.createdAt, cursor.id]);

    const rows = await q;
    const visible: Record<string, unknown>[] = [];
    for (const bot of rows) {
      if (await canSeeBot(db, req.auth, bot)) visible.push(bot);
      if (visible.length > limit) break;
    }
    const page = visible.slice(0, limit);
    const items = await Promise.all(
      page.map(async (b) => botToJson(b, await latestPublishedVersion(db, b.id as string))),
    );
    res.json({
      items,
      nextCursor:
        visible.length > limit
          ? encodeCursor(page[page.length - 1].created_at as Date, page[page.length - 1].id as string)
          : undefined,
    });
  });

  defineOperation(router, "createBot", async (req, res) => {
    const { visibility, teamId } = req.body ?? {};
    // UX-B · B1: el nombre se recorta (un nombre de sólo espacios no es un nombre) y
    // el error dice qué falla en vez de un genérico.
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
    if (typeof name !== "string" || !name) throw badRequest("El nombre del bot es obligatorio.");
    if (name.length > 48) {
      throw badRequest(`El nombre del bot admite como máximo 48 caracteres (tiene ${name.length}).`);
    }
    if (visibility !== undefined && !["private", "team", "public"].includes(visibility)) {
      throw badRequest("visibility inválida");
    }
    if (teamId !== undefined) {
      const member = await db("team_members")
        .where({ team_id: teamId, user_id: req.auth!.userId })
        .first()
        .catch(() => null);
      if (!member) throw forbidden("No perteneces a ese equipo");
    }
    // UX-B · B1: comprobar-e-insertar bajo un cerrojo transaccional por (dueño,
    // nombre). Sin él, dos POST simultáneos (doble clic) pasaban los dos la
    // comprobación de duplicado y el perdedor chocaba con la restricción única
    // (bots_owner_id_name_key): 500 «error interno» en vez del 409 legible.
    const bot = await db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`bot-name:${req.auth!.userId}:${name}`]);
      if (await trx("bots").where({ owner_id: req.auth!.userId, name }).first()) {
        throw conflict("bot_name_taken", `Ya tienes un bot llamado «${name}»: elige otro nombre.`);
      }
      const [row] = await trx("bots")
        .insert({ name, owner_id: req.auth!.userId, team_id: teamId ?? null, visibility: visibility ?? "private" })
        .returning("*");
      return row;
    });
    res.status(201).json(botToJson(bot));
  });

  defineOperation(router, "getBot", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    res.json(botToJson(bot, await latestPublishedVersion(db, bot.id as string)));
  });

  defineOperation(router, "updateBot", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    assertOwner(req.auth, bot); // metadatos: SOLO el dueño (contrato)
    const patch: Record<string, unknown> = {};
    const { name, visibility } = req.body ?? {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name || name.length > 48) throw badRequest("name inválido");
      patch.name = name;
    }
    if (visibility !== undefined) {
      if (!["private", "team", "public"].includes(visibility)) throw badRequest("visibility inválida");
      patch.visibility = visibility;
    }
    const [updated] = Object.keys(patch).length
      ? await db("bots").where({ id: bot.id }).update(patch).returning("*")
      : [bot];
    res.json(botToJson(updated, await latestPublishedVersion(db, bot.id as string)));
  });

  // -------------------------------------------------------------- loadouts
  defineOperation(router, "createLoadoutRevision", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    assertOwner(req.auth, bot);
    const { chassis, modules } = req.body ?? {};
    if (typeof chassis !== "string" || !Array.isArray(modules)) {
      throw badRequest("chassis y modules obligatorios");
    }
    // El validador de E3 corre SIEMPRE en servidor (DoD T7.3/T7.4).
    const result = await validateLoadoutServerSide(db, req.body);
    if (result.violations.length > 0) {
      res.status(422).json({ error: "loadout_invalid", violations: result.violations });
      return;
    }
    const loadout = await createLoadoutRevision(db, bot.id as string, req.body, result.summary!);
    res.status(201).json(loadoutToJson(loadout));
  });

  /**
   * R3.7 (ERR-VIS-04) · Extensión: listar las revisiones de loadout de un bot.
   * El contrato de E1 solo tenía el POST, así que el editor del panel no podía
   * cargar la revisión vigente (arrancaba siempre vacío). Misma visibilidad que
   * el propio bot (getVisibleBot); la última revisión es la "vigente".
   */
  defineExtension(
    router,
    { operationId: "listBotLoadouts", method: "get", path: "/bots/{botId}/loadouts", minRole: "user" },
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, String(req.params.botId));
      const rows = await db("bot_loadouts").where({ bot_id: bot.id }).orderBy("revision", "asc");
      res.json(rows.map(loadoutToJson));
    },
  );

  // -------------------------------------------------------------- versiones
  /**
   * B11 · Extensión: builds de UNA versión concreta, del más reciente al más
   * antiguo. El contrato solo tenía GET /builds/{buildId}, cuyo id únicamente
   * conoce quien acaba de hacer submit: tras un F5 el panel se quedaba SIN
   * forma de saber en qué estado terminó el pipeline y pintaba para siempre
   * "queued · todas las etapas pending". Misma visibilidad que el bot y misma
   * regla de logs (x-private) que getBuild.
   */
  defineExtension(
    router,
    {
      operationId: "listBotVersionBuilds",
      method: "get",
      path: "/bots/{botId}/versions/{version}/builds",
      minRole: "user",
    },
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, String(req.params.botId));
      const v = await getVersionOr404(db, bot.id as string, String(req.params.version));
      const includeLogs = req.auth!.userId === bot.owner_id || isStaff(req.auth);
      const rows = await db("builds")
        .where({ bot_id: bot.id, version: v.version })
        .orderBy([
          { column: "created_at", order: "desc" },
          { column: "id", order: "desc" },
        ]);
      res.json(rows.map((b) => buildToJson(b, { includeLogs })));
    },
  );

  defineOperation(router, "listBotVersions", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const versions = await db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "asc");
    res.json(versions.map(versionToJson));
  });

  defineOperation(
    router,
    "createBotVersion",
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
      assertOwner(req.auth, bot);
      const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
      const { runtime, loadoutRevision } = req.body ?? {};
      if (!file) throw badRequest("source obligatorio (archivo)");
      if (!["python", "node"].includes(runtime)) throw badRequest("runtime debe ser python|node");
      const rev = Number(loadoutRevision);
      const loadout = await db("bot_loadouts").where({ bot_id: bot.id, revision: rev }).first();
      if (!loadout) throw badRequest(`loadoutRevision ${loadoutRevision} no existe para este bot`);
      await assertLoadoutRevisionUsable(db, bot.id as string, rev);

      // A9.13 · «nueva versión desde X»: la versión de partida queda registrada.
      let parentVersion: number | null = null;
      if (req.body?.parentVersion !== undefined && req.body.parentVersion !== "") {
        const pv = Number(req.body.parentVersion);
        const parent = Number.isInteger(pv)
          ? await db("bot_versions").where({ bot_id: bot.id, version: pv }).first()
          : undefined;
        if (!parent) throw badRequest(`parentVersion ${req.body.parentVersion} no existe para este bot`);
        parentVersion = pv;
      }
      const version = await insertNextVersion(db, bot.id as string, {
        runtime,
        loadout_revision: rev,
        source: file.buffer,
        // R2.6 (ERR-SEC-09): el nombre lo controla el cliente — se normaliza al
        // recibirlo (base, allowlist, longitud); si no queda nada, null y el
        // GET aplicará el nombre por defecto derivado del id de versión.
        source_filename: sanitizeSourceFilename(file.originalname),
        parent_version: parentVersion,
      });
      res.status(201).json(versionToJson(version));
    },
    ...limitCreateVersion,
    (req, res, next) => {
      upload.single("source")(req, res, (err: unknown) => {
        if (err && (err as { code?: string }).code === "LIMIT_FILE_SIZE") {
          return next(new ApiError(413, "source_too_large", "El código supera el límite de 10 MB (E6.M)"));
        }
        next(err);
      });
    },
  );

  defineOperation(router, "getBotSource", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    if (!(await canReadSource(db, req.auth, bot, v))) {
      throw forbidden("El código de un bot es privado salvo publicación explícita (D9)");
    }
    // R2.6 (ERR-SEC-09): cabecera con codificación estándar de parámetros
    // (RFC 6266/5987). El nombre almacenado se re-sanea al emitir (defensa en
    // profundidad frente a filas anteriores al saneado); el defecto deriva del
    // id de versión (botId + nº de versión), no del cliente.
    const fallback = `bot-${bot.id}-v${v.version}-source.bin`;
    const filename = sanitizeSourceFilename(v.source_filename) ?? fallback;
    res
      .status(200)
      .setHeader("Content-Type", "application/octet-stream")
      .setHeader("Content-Disposition", contentDispositionAttachment(filename))
      .send(v.source);
  });

  // ------------------------------------- DEV-A · A9: versionado real
  defineOperation(router, "getBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    const readable = await canReadSource(db, req.auth, bot, v);
    const includeLogs = !!req.auth && (req.auth.userId === bot.owner_id || isStaff(req.auth));
    const latest = await db("builds")
      .where({ bot_id: bot.id, version: v.version })
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .first();
    const art = await findVersionArtifact(db, v);
    const children = await db("bot_versions")
      .where({ bot_id: bot.id, parent_version: v.version })
      .orderBy("version", "asc")
      .pluck("version");
    res.json({
      ...versionToJson(v),
      ...(readable ? { sourceSha256: v.source_sha256 ?? undefined } : {}),
      canReadSource: readable,
      latestBuild: latest ? buildToJson(latest, { includeLogs }) : undefined,
      artifact: art ? artifactToJson(bot.id as string, v.version, art) : undefined,
      childVersions: children,
    });
  });

  defineOperation(router, "getBotVersionFiles", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    if (!(await canReadSource(db, req.auth, bot, v))) {
      throw forbidden("El código de un bot es privado salvo publicación explícita (D9)");
    }
    const { packaged, files } = decodeVersionFiles(v);
    res.json({ botId: bot.id, version: v.version, sourceSha256: v.source_sha256 ?? undefined, packaged, files });
  });

  defineOperation(router, "getBotVersionArtifact", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    const art = await findVersionArtifact(db, v);
    if (!art) throw notFound("Esta versión no tiene artefacto (no ha pasado el pipeline)");
    res.json(artifactToJson(bot.id as string, v.version, art));
  });

  defineOperation(router, "diffBotVersions", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    const to = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    const againstRaw = req.query.against;
    if (typeof againstRaw !== "string" || !/^[1-9][0-9]*$/.test(againstRaw)) {
      throw badRequest("against obligatorio (número de versión)");
    }
    const from = await getVersionOr404(db, bot.id as string, againstRaw);
    for (const v of [from, to]) {
      if (!(await canReadSource(db, req.auth, bot, v))) {
        throw forbidden("El código de un bot es privado salvo publicación explícita (D9)");
      }
    }
    res.json({
      botId: bot.id,
      from: from.version,
      to: to.version,
      files: diffFiles(decodeVersionFiles(from).files, decodeVersionFiles(to).files),
    });
  });

  defineOperation(
    router,
    "cloneBotVersion",
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
      assertOwner(req.auth, bot);
      const src = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
      let rev = src.loadout_revision as number;
      if (req.body?.loadoutRevision !== undefined) {
        rev = Number(req.body.loadoutRevision);
        const loadout = await db("bot_loadouts").where({ bot_id: bot.id, revision: rev }).first();
        if (!loadout) throw badRequest(`loadoutRevision ${req.body.loadoutRevision} no existe para este bot`);
      }
      await assertLoadoutRevisionUsable(db, bot.id as string, rev);
      const version = await insertNextVersion(db, bot.id as string, {
        runtime: src.runtime,
        loadout_revision: rev,
        source: src.source,
        source_filename: src.source_filename,
        parent_version: src.version,
      });
      res.status(201).json(versionToJson(version));
    },
    ...limitCreateVersion,
  );

  // -------------------------------------------- transiciones (cap. 17.1)
  defineOperation(
    router,
    "submitBotVersion",
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
      assertOwner(req.auth, bot);
      const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
      // Un loadout que hoy no valida no llega al pipeline (build, protocol_test, smoke…).
      await assertLoadoutRevisionUsable(db, bot.id as string, v.loadout_revision as number);
      // B11 · `submit` viene de draft O de rejected (cap. 17.1). Al reenviar una
      // versión rechazada el motivo del rechazo ANTERIOR se quedaba en la fila
      // (solo se limpiaba al pasar a `validated`): quedaba una versión
      // `validating` arrastrando el error de su intento previo, y cualquier
      // pantalla que lo pintase mentía. El dato sucio se limpia en el origen.
      await applyTransition(db, req.auth, v, "submit", { rejection_reason: null }, req.correlationId);

      const [build] = await db("builds")
        .insert({
          bot_id: bot.id,
          version: v.version,
          status: "queued",
          stages: JSON.stringify(PIPELINE_STAGES.map((name) => ({ name, status: "pending" }))),
        })
        .returning("*");
      // R2.5 (ERR-SEC-12): encolado REAL — el cliente por defecto (QueueBotManager)
      // solo persiste el trabajo en `jobs`; el pipeline corre en el worker del
      // bot-manager, no en el proceso de la API. 202 = aceptado, no completado.
      await botManager.enqueueBuild({
        buildId: build.id,
        botId: bot.id as string,
        version: v.version,
        runtime: v.runtime,
      });
      const fresh = await db("builds").where({ id: build.id }).first();
      res.status(202).json(buildToJson(fresh, { includeLogs: true }));
    },
    ...limitSubmit,
  );

  defineOperation(router, "publishBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    assertOwner(req.auth, bot);
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    await assertLoadoutRevisionUsable(db, bot.id as string, v.loadout_revision as number);
    const codePublic = req.body?.codePublic === true;
    const updated = await applyTransition(
      db,
      req.auth,
      v,
      "publish",
      { published_at: db.fn.now(), ...(codePublic ? { code_public: true } : {}) },
      req.correlationId,
    );
    res.json(versionToJson(updated));
  });

  defineOperation(router, "suspendBotVersion", async (req, res) => {
    // x-min-role: moderator (del contrato); no requiere ser dueño.
    const bot = await db("bots")
      .where({ id: req.params.botId })
      .first()
      .catch(() => null);
    if (!bot) throw notFound();
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    const { reason } = req.body ?? {};
    if (typeof reason !== "string" || !reason || reason.length > 256) throw badRequest("reason obligatorio (máx. 256)");
    const updated = await applyTransition(db, req.auth, v, "suspend", { suspend_reason: reason }, req.correlationId);
    res.json(versionToJson(updated));
  });

  defineOperation(router, "retireBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));
    assertOwner(req.auth, bot);
    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));
    const updated = await applyTransition(db, req.auth, v, "retire", {}, req.correlationId);
    res.json(versionToJson(updated));
  });

  return router;
}

export function buildRoutes(db: Db): Router {
  const router = Router();
  defineOperation(router, "getBuild", async (req, res) => {
    const build = await db("builds")
      .where({ id: req.params.buildId })
      .first()
      .catch(() => null);
    if (!build) throw notFound();
    const bot = await db("bots").where({ id: build.bot_id }).first();
    if (!(await canSeeBot(db, req.auth, bot))) throw notFound();
    // Los logs (x-private) solo para dueño/equipo con acceso o moderador/admin.
    const includeLogs = req.auth!.userId === bot.owner_id || isStaff(req.auth);
    res.json(buildToJson(build, { includeLogs }));
  });
  return router;
}
