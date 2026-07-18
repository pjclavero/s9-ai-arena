/**
 * T7.3 · CRUD de bots, revisiones de loadout (validador E3 en servidor),
 * versiones de código y transiciones de estado como acciones explícitas.
 */
import { Router } from "express";
import multer from "multer";
import type { Db } from "../db/connection.js";
import { defineOperation, defineExtension } from "../registry.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";
import {
  applyTransition,
  assertOwner,
  canSeeBot,
  createLoadoutRevision,
  getVisibleBot,
  isStaff,
  validateLoadoutServerSide,
} from "../services/bots.js";
import { PIPELINE_STAGES, type BotManagerClient } from "../services/bot-manager.js";

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
  };
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
  const stages = (typeof b.stages === "string" ? JSON.parse(b.stages) : (b.stages as unknown[])) as Record<string, unknown>[];
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
    })),
    artifactHash: b.artifact_hash ?? undefined,
    createdAt: (b.created_at as Date).toISOString(),
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

export function botRoutes(db: Db, botManager: BotManagerClient): Router {
  const router = Router();

  // ------------------------------------------------------------------ CRUD
  defineOperation(router, "listBots", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("bots").orderBy([{ column: "created_at", order: "desc" }, { column: "id", order: "desc" }]).limit(200);
    if (typeof req.query.ownerId === "string") q = q.where({ owner_id: req.query.ownerId });
    if (cursor) q = q.whereRaw("(created_at, id) < (?, ?)", [cursor.createdAt, cursor.id]);

    const rows = await q;
    const visible: Record<string, unknown>[] = [];
    for (const bot of rows) {
      if (await canSeeBot(db, req.auth, bot)) visible.push(bot);
      if (visible.length > limit) break;
    }
    const page = visible.slice(0, limit);
    const items = await Promise.all(page.map(async (b) => botToJson(b, await latestPublishedVersion(db, b.id as string))));
    res.json({
      items,
      nextCursor:
        visible.length > limit
          ? encodeCursor(page[page.length - 1].created_at as Date, page[page.length - 1].id as string)
          : undefined,
    });
  });

  defineOperation(router, "createBot", async (req, res) => {
    const { name, visibility, teamId } = req.body ?? {};
    if (typeof name !== "string" || !name || name.length > 48) throw badRequest("name obligatorio (máx. 48)");
    if (visibility !== undefined && !["private", "team", "public"].includes(visibility)) {
      throw badRequest("visibility inválida");
    }
    if (teamId !== undefined) {
      const member = await db("team_members").where({ team_id: teamId, user_id: req.auth!.userId }).first().catch(() => null);
      if (!member) throw forbidden("No perteneces a ese equipo");
    }
    if (await db("bots").where({ owner_id: req.auth!.userId, name }).first()) {
      throw conflict("bot_name_taken", "Ya tienes un bot con ese nombre");
    }
    const [bot] = await db("bots")
      .insert({ name, owner_id: req.auth!.userId, team_id: teamId ?? null, visibility: visibility ?? "private" })
      .returning("*");
    res.status(201).json(botToJson(bot));
  });

  defineOperation(router, "getBot", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    res.json(botToJson(bot, await latestPublishedVersion(db, bot.id as string)));
  });

  defineOperation(router, "updateBot", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
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
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
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
  defineOperation(router, "listBotVersions", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    const versions = await db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "asc");
    res.json(versions.map(versionToJson));
  });

  defineOperation(
    router,
    "createBotVersion",
    async (req, res) => {
      const bot = await getVisibleBot(db, req.auth, req.params.botId);
      assertOwner(req.auth, bot);
      const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
      const { runtime, loadoutRevision } = req.body ?? {};
      if (!file) throw badRequest("source obligatorio (archivo)");
      if (!["python", "node"].includes(runtime)) throw badRequest("runtime debe ser python|node");
      const rev = Number(loadoutRevision);
      const loadout = await db("bot_loadouts").where({ bot_id: bot.id, revision: rev }).first();
      if (!loadout) throw badRequest(`loadoutRevision ${loadoutRevision} no existe para este bot`);

      const max = await db("bot_versions").where({ bot_id: bot.id }).max("version as m").first();
      const [version] = await db("bot_versions")
        .insert({
          bot_id: bot.id,
          version: Number(max?.m ?? 0) + 1,
          state: "draft",
          runtime,
          loadout_revision: rev,
          source: file.buffer,
          source_filename: file.originalname,
        })
        .returning("*");
      res.status(201).json(versionToJson(version));
    },
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
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    const v = await getVersionOr404(db, bot.id as string, req.params.version);
    const isOwner = req.auth!.userId === bot.owner_id;
    const isTeamMate =
      bot.team_id != null &&
      !!(await db("team_members").where({ team_id: bot.team_id, user_id: req.auth!.userId }).first());
    const isPublicCode = v.state === "published" && v.code_public === true;
    if (!isOwner && !isTeamMate && !isStaff(req.auth) && !isPublicCode) {
      throw forbidden("El código de un bot es privado salvo publicación explícita (D9)");
    }
    res
      .status(200)
      .setHeader("Content-Type", "application/octet-stream")
      .setHeader("Content-Disposition", `attachment; filename="${v.source_filename ?? "source.zip"}"`)
      .send(v.source);
  });

  // -------------------------------------------- transiciones (cap. 17.1)
  defineOperation(router, "submitBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    assertOwner(req.auth, bot);
    const v = await getVersionOr404(db, bot.id as string, req.params.version);
    await applyTransition(db, req.auth, v, "submit", {}, req.correlationId);

    const [build] = await db("builds")
      .insert({
        bot_id: bot.id,
        version: v.version,
        status: "queued",
        stages: JSON.stringify(PIPELINE_STAGES.map((name) => ({ name, status: "pending" }))),
      })
      .returning("*");
    // Delegación en bot-manager (E6/T6.1) — pendiente de reconciliación con E6.
    await botManager.enqueueBuild({ buildId: build.id, botId: bot.id as string, version: v.version, runtime: v.runtime });
    const fresh = await db("builds").where({ id: build.id }).first();
    res.status(202).json(buildToJson(fresh, { includeLogs: true }));
  });

  defineOperation(router, "publishBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    assertOwner(req.auth, bot);
    const v = await getVersionOr404(db, bot.id as string, req.params.version);
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
    const bot = await db("bots").where({ id: req.params.botId }).first().catch(() => null);
    if (!bot) throw notFound();
    const v = await getVersionOr404(db, bot.id as string, req.params.version);
    const { reason } = req.body ?? {};
    if (typeof reason !== "string" || !reason || reason.length > 256) throw badRequest("reason obligatorio (máx. 256)");
    const updated = await applyTransition(db, req.auth, v, "suspend", { suspend_reason: reason }, req.correlationId);
    res.json(versionToJson(updated));
  });

  defineOperation(router, "retireBotVersion", async (req, res) => {
    const bot = await getVisibleBot(db, req.auth, req.params.botId);
    assertOwner(req.auth, bot);
    const v = await getVersionOr404(db, bot.id as string, req.params.version);
    const updated = await applyTransition(db, req.auth, v, "retire", {}, req.correlationId);
    res.json(versionToJson(updated));
  });

  return router;
}

export function buildRoutes(db: Db): Router {
  const router = Router();
  defineOperation(router, "getBuild", async (req, res) => {
    const build = await db("builds").where({ id: req.params.buildId }).first().catch(() => null);
    if (!build) throw notFound();
    const bot = await db("bots").where({ id: build.bot_id }).first();
    if (!(await canSeeBot(db, req.auth, bot))) throw notFound();
    // Los logs (x-private) solo para dueño/equipo con acceso o moderador/admin.
    const includeLogs = req.auth!.userId === bot.owner_id || isStaff(req.auth);
    res.json(buildToJson(build, { includeLogs }));
  });
  return router;
}
