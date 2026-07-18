/**
 * T7.2/T7.4 · Equipos: crear (el creador queda capitán y gana el rol team_captain),
 * listar y gestionar miembros con autorización DE OBJETO (solo el capitán de ESE equipo).
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit, teamToJson } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";

async function memberIds(db: Db, teamId: string): Promise<string[]> {
  return (await db("team_members").where({ team_id: teamId })).map((m: { user_id: string }) => m.user_id);
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
    const items = await Promise.all(
      page.map(async (t: Record<string, unknown>) => teamToJson(t, await memberIds(db, t.id as string))),
    );
    res.json({
      items,
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  defineOperation(router, "createTeam", async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || !name || name.length > 48) throw badRequest("name obligatorio (máx. 48)");
    if (await db("teams").where({ name }).first())
      throw conflict("team_name_taken", "Ya existe un equipo con ese nombre");

    const userId = req.auth!.userId;
    const [team] = await db("teams").insert({ name, captain_id: userId }).returning("*");
    await db("team_members").insert({ team_id: team.id, user_id: userId, role: "captain" });
    // Jerarquía acumulativa del cap. 16: crear un equipo te hace team_captain.
    await db("user_roles").insert({ user_id: userId, role: "team_captain" }).onConflict(["user_id", "role"]).ignore();
    await audit(db, {
      actorId: userId,
      action: "team.created",
      target: `team:${team.id}`,
      correlationId: req.correlationId,
    });
    res.status(201).json(teamToJson(team, [userId]));
  });

  defineOperation(router, "addTeamMember", async (req, res) => {
    const team = await db("teams")
      .where({ id: req.params.teamId })
      .first()
      .catch(() => null);
    if (!team) throw notFound();
    if (team.captain_id !== req.auth!.userId && req.auth!.rank < ROLE_RANK.admin) {
      throw forbidden("Solo el capitán del equipo gestiona sus miembros");
    }
    const { userId } = req.body ?? {};
    const user =
      typeof userId === "string" &&
      (await db("users")
        .where({ id: userId })
        .first()
        .catch(() => null));
    if (!user) throw badRequest("userId inválido");
    await db("team_members").insert({ team_id: team.id, user_id: userId }).onConflict(["team_id", "user_id"]).ignore();
    res.status(201).json(teamToJson(team, await memberIds(db, team.id)));
  });

  defineOperation(router, "removeTeamMember", async (req, res) => {
    const team = await db("teams")
      .where({ id: req.params.teamId })
      .first()
      .catch(() => null);
    if (!team) throw notFound();
    if (team.captain_id !== req.auth!.userId && req.auth!.rank < ROLE_RANK.admin) {
      throw forbidden("Solo el capitán del equipo gestiona sus miembros");
    }
    if (req.params.userId === team.captain_id)
      throw conflict("captain_required", "El capitán no puede salir de su propio equipo");
    await db("team_members").where({ team_id: team.id, user_id: req.params.userId }).delete();
    res.status(204).end();
  });

  return router;
}
