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
 *  - ver miembros y bots: miembros del equipo (o staff); el resto ve solo recuentos.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";
import { pathParam } from "../params.js";

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
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(limit + 1);
    if (cursor) {
      q = q.whereRaw("(created_at, id) < (?, ?)", [cursor.createdAt, cursor.id]);
    }
    const rows = await q;
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((t: Record<string, unknown>) => teamToJson(db, t, req.auth)));
    res.json({
      items,
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
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

  return router;
}
