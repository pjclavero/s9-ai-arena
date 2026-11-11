/**
 * T7.2/T7.4 · Equipos: crear (el creador queda capitán y gana el rol team_captain),
 * listar y gestionar miembros con autorización DE OBJETO (solo el capitán de ESE equipo).
 *
 * FC-C (TD-011) · gestión completa: ver, renombrar y borrar el equipo; añadir y quitar
 * miembros (por email, sin teclear UUID); asignar y quitar BOTS del equipo (antes solo
 * se podía al crear el bot). Y el listado ANÓNIMO ya no expone identificadores de
 * usuarios: solo nombre y recuentos.
 *
 * Reglas de objeto (todas comprobadas aquí, no en la UI):
 *  - renombrar, borrar, añadir/quitar miembros: capitán del equipo (o admin);
 *  - añadir un bot: su DUEÑO, que además debe ser miembro del equipo (o admin);
 *  - quitar un bot: su dueño o el capitán del equipo (o admin);
 *  - ver miembros y bots: miembros del equipo (o staff); el resto ve solo recuentos;
 *  - #255 · hacer públicos los bots del equipo: lo pide un miembro (o admin), pero cada
 *    bot sólo cambia si quien lo pide es su DUEÑO (`isBotOwner`, la misma regla que
 *    PATCH /bots/{id}). Ser capitán no da autoridad sobre bots ajenos.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { applyCursor, cursorTsSql, decodeCursor, encodeCursor, parseLimit, runCursorQuery } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";
import { pathParam } from "../params.js";
import { isBotOwner } from "../services/bots.js";

type Auth = { userId: string; rank: number } | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (auth: Auth) => !!auth && auth.rank >= ROLE_RANK.admin;
const isStaff = (auth: Auth) => !!auth && auth.rank >= ROLE_RANK.moderator;

async function getTeamOr404(db: Db, teamId: string): Promise<Record<string, unknown>> {
  if (!UUID_RE.test(teamId)) throw notFound();
  const team = await db("teams").where({ id: teamId }).first();
  if (!team) throw notFound();
  return team;
}

function assertCaptain(auth: Auth, team: Record<string, unknown>): void {
  if (!auth) throw forbidden();
  if (team.captain_id === auth.userId || isAdmin(auth)) return;
  throw forbidden("Solo el capitán del equipo puede hacer esto");
}

/**
 * Proyección de un equipo según quién mira. Anónimo o ajeno: SIN identificadores de
 * usuarios (ni captainId ni memberIds). Miembro o staff: miembros con nombre visible
 * y bots del equipo.
 */
async function teamToJson(db: Db, team: Record<string, unknown>, auth: Auth): Promise<Record<string, unknown>> {
  const members = await db("team_members")
    .join("users", "users.id", "team_members.user_id")
    .where({ team_id: team.id })
    .orderBy([
      { column: "team_members.role", order: "asc" },
      { column: "team_members.added_at", order: "asc" },
    ])
    .select("team_members.user_id", "team_members.role", "users.display_name");
  const bots = await db("bots").where({ team_id: team.id }).orderBy("name", "asc").select("id", "name", "owner_id");
  const base: Record<string, unknown> = {
    id: team.id,
    name: team.name,
    memberCount: members.length,
    botCount: bots.length,
  };
  if (!auth) return base;
  const isMember = members.some((m: { user_id: string }) => m.user_id === auth.userId);
  base.isCaptain = team.captain_id === auth.userId;
  base.isMember = isMember;
  if (isMember || isStaff(auth)) {
    base.members = members.map((m: { user_id: string; role: string; display_name: string }) => ({
      userId: m.user_id,
      displayName: m.display_name,
      role: m.role,
    }));
    base.bots = bots.map((b: { id: string; name: string; owner_id: string }) => ({
      id: b.id,
      name: b.name,
      mine: b.owner_id === auth.userId,
    }));
  }
  return base;
}

function validName(name: unknown): string {
  if (typeof name !== "string") throw badRequest("name obligatorio (máx. 48)");
  const n = name.trim();
  if (!n || n.length > 48) throw badRequest("name obligatorio (máx. 48)");
  return n;
}

export function teamRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listTeams", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("teams")
      .select("teams.*", db.raw(cursorTsSql("teams.created_at")))
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(limit + 1);
    q = applyCursor(q, cursor, "teams.created_at", ["teams.id"]);
    const rows = await runCursorQuery(q, cursor);
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((t: Record<string, unknown>) => teamToJson(db, t, req.auth)));
    res.json({
      items,
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1], [page[page.length - 1].id]) : undefined,
    });
  });

  defineOperation(router, "getTeam", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    res.json(await teamToJson(db, team, req.auth));
  });

  defineOperation(router, "createTeam", async (req, res) => {
    const name = validName(req.body?.name);
    if (await db("teams").where({ name }).first())
      throw conflict("team_name_taken", "Ya existe un equipo con ese nombre");

    const userId = req.auth!.userId;
    const team = await db.transaction(async (trx) => {
      const [t] = await trx("teams").insert({ name, captain_id: userId }).returning("*");
      await trx("team_members").insert({ team_id: t.id, user_id: userId, role: "captain" });
      // Jerarquía acumulativa del cap. 16: crear un equipo te hace team_captain.
      await trx("user_roles")
        .insert({ user_id: userId, role: "team_captain" })
        .onConflict(["user_id", "role"])
        .ignore();
      return t;
    });
    await audit(db, {
      actorId: userId,
      action: "team.created",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.status(201).json(await teamToJson(db, team, req.auth));
  });

  defineOperation(router, "updateTeam", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    assertCaptain(req.auth, team);
    const name = validName(req.body?.name);
    const clash = await db("teams").where({ name }).whereNot({ id: team.id }).first();
    if (clash) throw conflict("team_name_taken", "Ya existe un equipo con ese nombre");
    const [updated] = await db("teams").where({ id: team.id }).update({ name }).returning("*");
    await audit(db, {
      actorId: req.auth!.userId,
      action: "team.renamed",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.json(await teamToJson(db, updated, req.auth));
  });

  defineOperation(router, "deleteTeam", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    assertCaptain(req.auth, team);
    try {
      // team_members: ON DELETE CASCADE; bots.team_id: ON DELETE SET NULL (los bots
      // NO se borran, vuelven a no tener equipo). Torneos: winner_team_id SET NULL.
      await db("teams").where({ id: team.id }).delete();
    } catch (e) {
      // FK RESTRICT de otra tabla (p. ej. inscripciones por equipo): no se borra a medias.
      if ((e as { code?: string }).code === "23503") {
        throw conflict("team_in_use", "El equipo está referenciado por una competición y no se puede borrar");
      }
      throw e;
    }
    await audit(db, {
      actorId: req.auth!.userId,
      action: "team.deleted",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

  defineOperation(router, "addTeamMember", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    if (team.captain_id !== req.auth!.userId && req.auth!.rank < ROLE_RANK.admin) {
      throw forbidden("Solo el capitán del equipo gestiona sus miembros");
    }
    const { userId, email } = req.body ?? {};
    let user: Record<string, unknown> | undefined;
    if (typeof email === "string" && email) {
      user = await db("users").whereRaw("lower(email) = lower(?)", [email.trim()]).first();
    } else if (typeof userId === "string" && UUID_RE.test(userId)) {
      user = await db("users").where({ id: userId }).first();
    }
    // Mismo mensaje exista o no el usuario y venga por email o por id.
    if (!user) throw badRequest("Usuario no encontrado (email o userId)");
    await db("team_members")
      .insert({ team_id: team.id, user_id: user.id, role: "member" })
      .onConflict(["team_id", "user_id"])
      .ignore();
    await audit(db, {
      actorId: req.auth!.userId,
      action: "team.member_added",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.status(201).json(await teamToJson(db, team, req.auth));
  });

  defineOperation(router, "removeTeamMember", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    if (team.captain_id !== req.auth!.userId && req.auth!.rank < ROLE_RANK.admin) {
      throw forbidden("Solo el capitán del equipo gestiona sus miembros");
    }
    const target = pathParam(req, "userId");
    if (target === team.captain_id) throw conflict("captain_required", "El capitán no puede salir de su propio equipo");
    if (!UUID_RE.test(target)) throw notFound();
    await db.transaction(async (trx) => {
      await trx("team_members").where({ team_id: team.id, user_id: target }).delete();
      // Un bot del miembro expulsado deja de pertenecer al equipo: si no, seguiría
      // representando a un equipo del que su dueño ya no forma parte.
      await trx("bots").where({ team_id: team.id, owner_id: target }).update({ team_id: null });
    });
    await audit(db, {
      actorId: req.auth!.userId,
      action: "team.member_removed",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

  defineOperation(router, "addTeamBot", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    const auth = req.auth!;
    const { botId } = req.body ?? {};
    if (typeof botId !== "string" || !UUID_RE.test(botId)) throw badRequest("botId obligatorio");
    const bot = await db("bots").where({ id: botId }).first();
    // Un bot ajeno (o inexistente) es 404: no se revela la existencia de bots privados.
    if (!bot || (bot.owner_id !== auth.userId && !isAdmin(auth))) throw notFound("Bot no encontrado entre los tuyos");
    const member = await db("team_members").where({ team_id: team.id, user_id: bot.owner_id }).first();
    if (!member) throw forbidden("El dueño del bot debe ser miembro del equipo");
    await db("bots").where({ id: bot.id }).update({ team_id: team.id });
    await audit(db, {
      actorId: auth.userId,
      action: "team.bot_added",
      target: `team:${team.id}`,
      detail: { botId: bot.id },
      correlationId: req.correlationId,
    });
    res.status(201).json(await teamToJson(db, team, req.auth));
  });

  defineOperation(router, "removeTeamBot", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    const auth = req.auth!;
    const botId = pathParam(req, "botId");
    if (!UUID_RE.test(botId)) throw notFound();
    const bot = await db("bots").where({ id: botId, team_id: team.id }).first();
    if (!bot) throw notFound();
    const allowed = bot.owner_id === auth.userId || team.captain_id === auth.userId || isAdmin(auth);
    if (!allowed) throw forbidden("Solo el dueño del bot o el capitán pueden quitarlo del equipo");
    await db("bots").where({ id: bot.id }).update({ team_id: null });
    await audit(db, {
      actorId: auth.userId,
      action: "team.bot_removed",
      target: `team:${team.id}`,
      detail: { botId: bot.id },
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

  /**
   * #255 · «Hacer públicos los bots que administras» desde la pantalla de Equipo.
   *
   * Por qué un endpoint y no N × PATCH /bots/{id} desde la web (B17): (1) la
   * PREVISUALIZACIÓN tiene que salir de la misma regla que el cambio, y sólo el
   * servidor la conoce (si la web decidiera qué bots «puede» cambiar, duplicaría la
   * autorización); (2) los bots autorizados cambian en UNA transacción (todos o
   * ninguno), y el resultado por bot dice la verdad también en los parciales
   * (autorizados y no autorizados), sin ocultar los rechazos.
   *
   * Reglas:
   *  - quien pide: miembro del equipo o admin (si no, 403);
   *  - cada bot: SÓLO su dueño (`isBotOwner`); el resto → `not_authorized`, sin tocarlo
   *    y sin revelar su visibilidad;
   *  - `dryRun: true` no escribe nada (previsualización);
   *  - el CÓDIGO nunca se publica por defecto: sólo con `includeCode: true` explícito, y
   *    sólo el de la versión publicada más reciente del bot autorizado (misma autoridad
   *    que PUT …/code-visibility: el dueño). Versiones, equipamiento y código del resto
   *    de versiones no se tocan.
   *  - cada cambio se audita igual que el individual (bot.visibility_changed /
   *    bot.code_visibility_changed), con `via: team_bulk`;
   *  - #255 R1 (P3-2) · un bot RETIRADO del dueño no cambia: sale como `retired`.
   *    «Retirado» lo saca de «Mis bots» activos (migración 015); una acción masiva
   *    sobre «los bots que administras» no debe publicar uno archivado sin que su
   *    dueño lo decida en su ficha (PATCH /bots/{id} lo sigue permitiendo). Los
   *    ajenos salen como `not_authorized` ANTES de mirar si están retirados: de un
   *    bot ajeno no se revela nada más;
   *  - #255 R1 (P3-1) · `expectBotIds` ata la confirmación a lo previsualizado: si
   *    el conjunto de bots del equipo ya no es ese (entró o salió alguno), 409
   *    `team_bots_changed` sin escribir nada, y la web vuelve a previsualizar.
   */
  defineOperation(router, "publishTeamBots", async (req, res) => {
    const team = await getTeamOr404(db, pathParam(req, "teamId"));
    const auth = req.auth!;
    const body = req.body ?? {};
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw badRequest("dryRun debe ser booleano");
    if (body.includeCode !== undefined && typeof body.includeCode !== "boolean") {
      throw badRequest("includeCode debe ser booleano");
    }
    let expected: Set<string> | null = null;
    if (body.expectBotIds !== undefined) {
      if (
        !Array.isArray(body.expectBotIds) ||
        body.expectBotIds.length > 1000 ||
        body.expectBotIds.some((x: unknown) => typeof x !== "string")
      ) {
        throw badRequest("expectBotIds debe ser una lista de ids de bot");
      }
      expected = new Set(body.expectBotIds as string[]);
    }
    const dryRun = body.dryRun === true;
    const includeCode = body.includeCode === true;
    const member = await db("team_members").where({ team_id: team.id, user_id: auth.userId }).first();
    if (!member && !isAdmin(auth)) throw forbidden("Solo los miembros del equipo pueden hacer esto");

    type CodeResult = { version: number | null; outcome: string };
    type BotResult = {
      botId: string;
      name: string;
      outcome: "made_public" | "would_make_public" | "already_public" | "not_authorized" | "retired";
      previousVisibility?: string;
      code?: CodeResult;
    };
    const results: BotResult[] = await db.transaction(async (trx) => {
      // Cerrojo de fila: lo que se previsualiza o cambia es el estado vigente, no uno
      // que otra petición esté modificando a la vez.
      const bots = await trx("bots").where({ team_id: team.id }).orderBy("name", "asc").forUpdate();
      if (expected) {
        const now = new Set(bots.map((b: { id: string }) => b.id));
        const same = now.size === expected.size && [...now].every((id) => expected!.has(id));
        if (!same) {
          throw conflict(
            "team_bots_changed",
            "Los bots del equipo han cambiado desde la previsualización: revisa la lista nueva antes de confirmar.",
          );
        }
      }
      const out: BotResult[] = [];
      for (const bot of bots) {
        const base = { botId: bot.id as string, name: bot.name as string };
        if (!isBotOwner(auth, bot)) {
          out.push({ ...base, outcome: "not_authorized" });
          continue;
        }
        if (bot.retired_at) {
          out.push({ ...base, outcome: "retired", previousVisibility: bot.visibility as string });
          continue;
        }
        const already = bot.visibility === "public";
        let code: CodeResult | undefined;
        if (includeCode) {
          const v = await trx("bot_versions")
            .where({ bot_id: bot.id, state: "published" })
            .orderBy("version", "desc")
            .first();
          if (!v) code = { version: null, outcome: "no_published_version" };
          else if (v.code_public === true) code = { version: v.version, outcome: "already_public" };
          else if (dryRun) code = { version: v.version, outcome: "would_make_public" };
          else {
            await trx("bot_versions").where({ id: v.id }).update({ code_public: true });
            await audit(trx, {
              actorId: auth.userId,
              action: "bot.code_visibility_changed",
              target: `bot:${bot.id}:v${v.version}`,
              detail: { from: false, to: true, via: "team_bulk", teamId: team.id },
              correlationId: req.correlationId,
            });
            code = { version: v.version, outcome: "made_public" };
          }
        }
        if (already) {
          out.push({ ...base, outcome: "already_public", previousVisibility: "public", ...(code ? { code } : {}) });
          continue;
        }
        if (!dryRun) {
          await trx("bots").where({ id: bot.id }).update({ visibility: "public" });
          await audit(trx, {
            actorId: auth.userId,
            action: "bot.visibility_changed",
            target: `bot:${bot.id}`,
            detail: { from: bot.visibility, to: "public", via: "team_bulk", teamId: team.id },
            correlationId: req.correlationId,
          });
        }
        out.push({
          ...base,
          outcome: dryRun ? "would_make_public" : "made_public",
          previousVisibility: bot.visibility as string,
          ...(code ? { code } : {}),
        });
      }
      return out;
    });
    const count = (o: BotResult["outcome"]) => results.filter((r) => r.outcome === o).length;
    res.json({
      teamId: team.id,
      dryRun,
      includeCode,
      results,
      summary: {
        changed: count(dryRun ? "would_make_public" : "made_public"),
        alreadyPublic: count("already_public"),
        notAuthorized: count("not_authorized"),
        retired: count("retired"),
      },
    });
  });

  return router;
}
