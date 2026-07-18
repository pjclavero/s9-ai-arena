/**
 * T7.5 · Torneos: creación (organizador), inscripción que congela código+loadout
 * juntos (cap. 17.2) y cierre de inscripciones (congela versiones y revela semillas).
 * La generación del calendario y la ejecución son de E9 — pendiente de reconciliación.
 */
import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { defineOperation, defineExtension } from "../registry.js";
import { battleToJson } from "./battles.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { applyTransition } from "../services/bots.js";
// H6 (issue #10) · La tabla por equipos es la de E9; se importa, no se duplica.
import { leagueTable } from "../../../tournament-worker/src/results.js";

const FORMATS = ["league", "round_robin", "single_elimination", "double_elimination", "swiss", "teams"];
const MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];

export function tournamentToJson(t: Record<string, unknown>) {
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    mode: t.mode,
    rulesetId: t.ruleset_id,
    budgetCredits: t.budget_credits ?? undefined,
    catalogVersion: t.catalog_version ?? undefined,
    mapPool: t.map_pool ?? [],
    roundsPerPairing: t.rounds_per_pairing ?? undefined,
    entriesCloseAt: t.entries_close_at ? (t.entries_close_at as Date).toISOString() : undefined,
    seedCommitment: t.seed_commitment ?? undefined,
    seedsRevealed: t.seeds_revealed ?? undefined,
    state: t.state,
  };
}

export function tournamentRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listTournaments", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("tournaments").orderBy([{ column: "created_at", order: "desc" }, { column: "id", order: "desc" }]).limit(limit + 1);
    if (cursor) q = q.whereRaw("(created_at, id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    res.json({
      items: page.map(tournamentToJson),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  defineOperation(router, "createTournament", async (req, res) => {
    const { name, format, mode, rulesetId, budgetCredits, catalogVersion, mapPool, roundsPerPairing, entriesCloseAt, seedCommitment } =
      req.body ?? {};
    if (typeof name !== "string" || !name || name.length > 64) throw badRequest("name obligatorio (máx. 64)");
    if (!FORMATS.includes(format)) throw badRequest(`format debe ser uno de ${FORMATS.join(", ")}`);
    if (!MODES.includes(mode)) throw badRequest(`mode debe ser uno de ${MODES.join(", ")}`);
    if (!(await db("rulesets").where({ id: rulesetId }).first())) throw badRequest("rulesetId desconocido");
    // ADR-000/D7: presupuesto por competición dentro de [200, 5000]; si se omite, manda el ruleset.
    if (budgetCredits !== undefined && !(Number.isInteger(budgetCredits) && budgetCredits >= 200 && budgetCredits <= 5000)) {
      throw badRequest("budgetCredits debe ser un entero en [200, 5000]");
    }
    const [t] = await db("tournaments")
      .insert({
        name,
        format,
        mode,
        ruleset_id: rulesetId,
        budget_credits: budgetCredits ?? null,
        catalog_version: catalogVersion ?? null,
        map_pool: JSON.stringify(mapPool ?? []),
        rounds_per_pairing: roundsPerPairing ?? null,
        entries_close_at: entriesCloseAt ?? null,
        seed_commitment: seedCommitment ?? null,
        state: "open",
        created_by: req.auth!.userId,
      })
      .returning("*");
    await audit(db, {
      actorId: req.auth!.userId,
      action: "tournament.created",
      target: `tournament:${t.id}`,
      correlationId: req.correlationId,
    });
    res.status(201).json(tournamentToJson(t));
  });

  /**
   * R3.7 (ERR-VIS-02) · Extensiones de lectura para el panel: el contrato de E1
   * no tenía ni el detalle de un torneo ni sus batallas, así que la UI no podía
   * "seguir" un torneo (cola, en curso, cuadro) sin teclear UUIDs a mano.
   */
  defineExtension(
    router,
    { operationId: "getTournament", method: "get", path: "/tournaments/{tournamentId}", minRole: "visitor" },
    async (req, res) => {
      const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
      if (!t) throw notFound();
      const entries = await db("entries").where({ tournament_id: t.id }).count("* as n").first();
      res.json({ ...tournamentToJson(t), entryCount: Number(entries?.n ?? 0) });
    },
  );

  defineExtension(
    router,
    { operationId: "listTournamentBattles", method: "get", path: "/tournaments/{tournamentId}/battles", minRole: "visitor" },
    async (req, res) => {
      const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
      if (!t) throw notFound();
      const battles = await db("battles").where({ tournament_id: t.id }).orderBy("created_at", "asc");
      const matches = await db("matches").where({ tournament_id: t.id });
      const roundByMatch = new Map(matches.map((m: Record<string, unknown>) => [m.id as string, Number(m.round)]));
      const items = await Promise.all(
        battles.map(async (b: Record<string, unknown>) => ({
          ...battleToJson(b, await db("participants").where({ battle_id: b.id })),
          round: b.match_id ? (roundByMatch.get(b.match_id as string) ?? 1) : 1,
        })),
      );
      res.setHeader("Cache-Control", "public, max-age=5");
      res.json({ items });
    },
  );

  defineOperation(router, "enterTournament", async (req, res) => {
    const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
    if (!t) throw notFound();
    if (t.state !== "open") throw conflict("entries_closed", "Las inscripciones no están abiertas");
    const { botId, version } = req.body ?? {};
    const bot = await db("bots").where({ id: botId }).first().catch(() => null);
    if (!bot) throw badRequest("botId desconocido");
    if (bot.owner_id !== req.auth!.userId) throw forbidden("Solo el dueño inscribe su bot");
    const v = await db("bot_versions").where({ bot_id: botId, version }).first();
    if (!v || v.state !== "published") {
      throw conflict("bot_not_published", "Solo se inscriben versiones publicadas (no suspendidas ni retiradas)");
    }
    if (await db("entries").where({ tournament_id: t.id, bot_id: botId }).first()) {
      throw conflict("already_entered", "El bot ya está inscrito en este torneo");
    }
    // Congela la COMBINACIÓN exacta código+loadout (cap. 17.2).
    const [entry] = await db("entries")
      .insert({
        tournament_id: t.id,
        bot_id: botId,
        version,
        loadout_revision: v.loadout_revision,
        frozen: false,
      })
      .returning("*");
    res.status(201).json({
      id: entry.id,
      tournamentId: t.id,
      botId,
      version,
      loadoutRevision: entry.loadout_revision,
      frozen: entry.frozen,
    });
  });

  defineOperation(router, "closeEntries", async (req, res) => {
    const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
    if (!t) throw notFound();
    if (t.state !== "open") {
      throw conflict("illegal_transition", `El torneo está en estado ${t.state}`, {
        currentState: t.state,
        allowedTransitions: t.state === "draft" ? ["open"] : [],
      });
    }

    const entries = await db("entries").where({ tournament_id: t.id });
    await db("entries").where({ tournament_id: t.id }).update({ frozen: true });
    // Congela las versiones inscritas (published → frozen, cap. 17.1), auditado.
    for (const e of entries) {
      const v = await db("bot_versions").where({ bot_id: e.bot_id, version: e.version }).first();
      if (v.state === "published") {
        await applyTransition(db, req.auth, v, "freeze", {}, req.correlationId);
      }
    }
    // Commit-reveal de semillas (E9/T9.4): si el organizador publicó el hash
    // del lote ANTES del cierre (seedCommitment al crear el torneo), ahora
    // debe revelar las semillas que casan con él; ambos quedan en la BD y son
    // verificables públicamente (endpoint de auditoría). Sin compromiso
    // previo, el servidor genera lote y compromiso juntos (auto-commit).
    const revealed: string[] | null = Array.isArray(req.body?.seeds) ? req.body.seeds.map(String) : null;
    let seeds: string[];
    let commitment: string;
    if (t.seed_commitment) {
      if (!revealed || revealed.length === 0) {
        throw conflict("seeds_required", "El torneo publicó un compromiso: el cierre debe revelar las semillas");
      }
      commitment = t.seed_commitment;
      const proof = createHash("sha256").update(revealed.join("|")).digest("hex");
      if (proof !== commitment) {
        throw conflict("seed_reveal_mismatch", "Las semillas reveladas no casan con el compromiso publicado");
      }
      seeds = revealed;
    } else {
      seeds = Array.from({ length: 8 }, () => randomBytes(16).toString("hex"));
      commitment = createHash("sha256").update(seeds.join("|")).digest("hex");
    }
    const [updated] = await db("tournaments")
      .where({ id: t.id })
      .update({ state: "closed", seeds_revealed: JSON.stringify(seeds), seed_commitment: commitment })
      .returning("*");
    await db("jobs").insert({
      kind: "generate_schedule",
      payload: JSON.stringify({ tournamentId: t.id, seedProof: commitment }),
      dedupe_key: `generate_schedule:${t.id}`,
    });
    await audit(db, {
      actorId: req.auth!.userId,
      action: "tournament.entries_closed",
      target: `tournament:${t.id}`,
      detail: { entries: entries.length },
      correlationId: req.correlationId,
    });
    res.json(tournamentToJson(updated));
  });

  defineOperation(router, "dryRunTournament", async (req, res) => {
    const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
    if (!t) throw notFound();
    // Simulacro con bots de ejemplo (E9.M): lo consume el tournament-worker de E9.
    await db("jobs").insert({ kind: "tournament_dry_run", payload: JSON.stringify({ tournamentId: t.id }) });
    res.status(202).json({ status: "queued" });
  });

  /**
   * H6 (issue #10) · Clasificación por EQUIPOS de un torneo `teams`: la tabla
   * de liga REAL de E9 (leagueTable con isTeams, desempates documentados en
   * formats.ts), que E7 dejó "pendiente de reconciliación si la API pública
   * quiere tabla por equipos". No se reimplementa: se importa.
   */
  defineOperation(router, "getTeamStandings", async (req, res) => {
    const t = await db("tournaments").where({ id: req.params.tournamentId }).first().catch(() => null);
    if (!t) throw notFound();
    if (t.format !== "teams") {
      throw conflict("not_a_team_tournament", "La clasificación por equipos solo existe en torneos de formato 'teams'");
    }
    const table = await leagueTable(db, t.id as string, /*isTeams*/ true);
    const teamIds = table.map((r) => r.id).filter((id) => id !== null && id !== undefined);
    const teams = teamIds.length > 0 ? await db("teams").whereIn("id", teamIds) : [];
    const nameById = new Map(teams.map((row: Record<string, unknown>) => [row.id as string, row.name as string]));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(
      table.map((row, i) => ({
        rank: i + 1,
        teamId: row.id,
        teamName: nameById.get(row.id),
        points: row.points,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        scoreDiff: row.scoreDiff,
        seed: row.seed,
      })),
    );
  });

  return router;
}
