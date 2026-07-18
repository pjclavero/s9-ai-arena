/**
 * H6 (issue #10) · Rutas públicas nuevas del contrato 0.2.0 (minor,
 * docs/compatibilidad.md §2):
 *
 *  - getBotRatingHistory: expone el libro mayor rating_events de E9 (T9.3),
 *    con reconstrucción histórica ?at= (ratingAt). Funciones probadas desde
 *    la entrega de E9; faltaba la ruta HTTP.
 *  - getTeamStandings: la tabla por equipos de E9 (leagueTable/isTeams) que
 *    E7 dejó "pendiente de reconciliación" — ahora con contrato.
 *
 * Los datos se generan con las piezas REALES: applyBattleRating de E9 sobre
 * una batalla oficial terminada (no se insertan rating_events a mano).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { applyBattleRating, INITIAL_RATING } from "../../tournament-worker/src/ratings.js";
import { createBots, insertScheduledBattle, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let bots: TestBot[];
let battleId: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  bots = await createBots(h.db, 2, "h6");

  // Batalla OFICIAL terminada con outcomes → rating REAL de E9 (T9.3).
  battleId = await insertScheduledBattle(h.db, bots[0], bots[1], { official: true, seed: "h6-rating" });
  await h
    .db("battles")
    .where({ id: battleId })
    .update({
      status: "finished",
      finished_at: h.db.fn.now(),
      result: JSON.stringify({ winner: "A", ticks: 100, score: { A: 1, B: 0 }, disqualified: [] }),
    });
  await h.db("participants").where({ battle_id: battleId, bot_id: bots[0].botId }).update({ outcome: "win" });
  await h.db("participants").where({ battle_id: battleId, bot_id: bots[1].botId }).update({ outcome: "loss" });
  const applied = await applyBattleRating(h.db, battleId);
  expect(applied).toBe(true);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("H6 · getBotRatingHistory (contrato 0.2.0)", () => {
  it("devuelve el libro mayor de E9 SIN cuenta (visitor): before/delta/after por batalla", async () => {
    const res = await request(app).get(`/bots/${bots[0].botId}/rating-history`); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body.botId).toBe(bots[0].botId);
    expect(res.body.seasonId).toBe("season-1");
    expect(res.body.mode).toBe("deathmatch");
    expect(res.body.events.length).toBe(1);
    const e = res.body.events[0];
    expect(e.battleId).toBe(battleId);
    expect(e.before).toBe(INITIAL_RATING);
    expect(e.delta).toBeGreaterThan(0); // el ganador sube
    expect(e.after).toBe(e.before + e.delta);
    expect(e.reverted).toBe(false);
    // El rating vigente coincide con el último `after` del libro mayor.
    expect(res.body.rating).toBe(e.after);
    // Suma conservada (propiedad de E9): el perdedor baja lo que sube el ganador.
    const loser = await request(app).get(`/bots/${bots[1].botId}/rating-history`);
    expect(loser.body.events[0].delta).toBeCloseTo(-e.delta, 9);
  });

  it("?at= reconstruye el rating histórico (ratingAt de E9)", async () => {
    const res = await request(app).get(`/bots/${bots[0].botId}/rating-history`).query({ at: "1970-01-01T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(res.body.ratingAt).toBe(INITIAL_RATING); // antes de la batalla: rating inicial
    const now = await request(app).get(`/bots/${bots[0].botId}/rating-history`).query({ at: new Date().toISOString() });
    expect(now.body.ratingAt).toBe(now.body.rating);
  });

  it("validación: bot inexistente → 404, fecha inválida → 400, sin eventos → rating inicial", async () => {
    expect((await request(app).get("/bots/00000000-0000-4000-8000-000000000000/rating-history")).status).toBe(404);
    expect((await request(app).get(`/bots/${bots[0].botId}/rating-history`).query({ at: "ayer" })).status).toBe(400);
    const other = await request(app).get(`/bots/${bots[0].botId}/rating-history`).query({ mode: "capture_the_flag" });
    expect(other.status).toBe(200);
    expect(other.body.rating).toBe(INITIAL_RATING);
    expect(other.body.events).toEqual([]);
  });
});

describe("H6 · getTeamStandings (contrato 0.2.0)", () => {
  let tournamentId: string;
  let teamA: string;
  let teamB: string;

  beforeAll(async () => {
    const captain = await h.db("users").where({ email: DEV_USERS.organizer }).first();
    const [ta] = await h.db("teams").insert({ name: "h6-alfa", captain_id: captain.id }).returning("id");
    const [tb] = await h.db("teams").insert({ name: "h6-beta", captain_id: captain.id }).returning("id");
    teamA = ta.id as string;
    teamB = tb.id as string;
    await h.db("bots").where({ id: bots[0].botId }).update({ team_id: teamA });
    await h.db("bots").where({ id: bots[1].botId }).update({ team_id: teamB });

    const [t] = await h
      .db("tournaments")
      .insert({
        name: "h6-teams",
        format: "teams",
        mode: "team_deathmatch",
        ruleset_id: "mvp-default",
        state: "running",
      })
      .returning("id");
    tournamentId = t.id as string;
    for (const b of bots) {
      await h.db("entries").insert({
        tournament_id: tournamentId,
        bot_id: b.botId,
        version: b.version,
        loadout_revision: b.loadoutRevision,
        frozen: true,
      });
    }
    // Serie terminada: gana el equipo A (leagueTable de E9 hace el resto).
    await h.db("matches").insert({
      tournament_id: tournamentId,
      round: 1,
      state: "finished",
      slot: "h6-r1m1",
      pairing: JSON.stringify({ home: teamA, away: teamB, slot: "h6-r1m1", round: 1 }),
      winner_team_id: teamA,
    });
  });

  it("publica la tabla por equipos SIN cuenta, ordenada con los desempates de E9", async () => {
    const res = await request(app).get(`/tournaments/${tournamentId}/team-standings`); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    const [first, second] = res.body;
    expect(first.rank).toBe(1);
    expect(first.teamId).toBe(teamA);
    expect(first.teamName).toBe("h6-alfa");
    expect(first.points).toBe(3); // victoria = 3 (formats.ts de E9)
    expect(first.wins).toBe(1);
    expect(second.rank).toBe(2);
    expect(second.teamId).toBe(teamB);
    expect(second.losses).toBe(1);
    expect(second.points).toBe(0);
  });

  it("un torneo que NO es de formato teams devuelve 409; inexistente, 404", async () => {
    const [rr] = await h
      .db("tournaments")
      .insert({
        name: "h6-individual",
        format: "round_robin",
        mode: "deathmatch",
        ruleset_id: "mvp-default",
        state: "running",
      })
      .returning("id");
    const res = await request(app).get(`/tournaments/${rr.id}/team-standings`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_team_tournament");
    expect((await request(app).get("/tournaments/00000000-0000-4000-8000-000000000000/team-standings")).status).toBe(
      404,
    );
  });
});
