/**
 * R12 (slice 1, solo lectura) · Cuadro de torneo público:
 * GET /tournaments/{tournamentId}/matches.
 *
 * DoD: torneo inexistente → 404; torneo con matches sembradas → 200 ordenado
 * por ronda/slot con SOLO las claves del contrato (proyección explícita, sin
 * seeds/commitments); accesible SIN cuenta (visitor). Nada de POSTs nuevos ni
 * jobs encolados: esta ruta es puramente de lectura (T7.5).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { createBots, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  bots = await createBots(h.db, 1, "r12");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("R12 · GET /tournaments/{tournamentId}/matches (slice 1, solo lectura)", () => {
  it("torneo inexistente → 404", async () => {
    const res = await request(app).get("/tournaments/00000000-0000-4000-8000-000000000000/matches");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it("torneo con matches sembradas → 200, orden round/slot, SOLO las claves esperadas, sin cuenta", async () => {
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "r12-bracket",
        format: "single_elimination",
        mode: "deathmatch",
        ruleset_id: "mvp-default",
        state: "running",
        seed_commitment: "r12-should-never-leak-commitment",
      })
      .returning("id");
    const tournamentId = t.id as string;

    await h.db("matches").insert([
      {
        tournament_id: tournamentId,
        round: 2,
        state: "scheduled",
        slot: "r12-r2m1",
        pairing: JSON.stringify({ home: "r12-r1m1", away: "r12-r1m2", slot: "r12-r2m1", round: 2 }),
      },
      {
        tournament_id: tournamentId,
        round: 1,
        state: "finished",
        slot: "r12-r1m2",
        pairing: JSON.stringify({ home: "bye", away: "bye", slot: "r12-r1m2", round: 1 }),
      },
      {
        tournament_id: tournamentId,
        round: 1,
        state: "finished",
        slot: "r12-r1m1",
        pairing: JSON.stringify({ home: "bye", away: "bye", slot: "r12-r1m1", round: 1 }),
        winner_bot_id: bots[0].botId,
        final: false,
      },
    ]);

    const res = await request(app).get(`/tournaments/${tournamentId}/matches`); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body.matches.length).toBe(3);

    // Orden: round asc, slot asc dentro de cada ronda.
    const slots = res.body.matches.map((m: { round: number; slot: string }) => [m.round, m.slot]);
    expect(slots).toEqual([
      [1, "r12-r1m1"],
      [1, "r12-r1m2"],
      [2, "r12-r2m1"],
    ]);

    // Proyección EXPLÍCITA: solo las claves del contrato, nada más (sin tournament_id/created_at...).
    for (const m of res.body.matches) {
      expect(Object.keys(m).sort()).toEqual(
        ["final", "id", "pairing", "round", "slot", "state", "winnerBotId", "winnerTeamId"].sort(),
      );
    }

    const first = res.body.matches[0];
    expect(first.state).toBe("finished");
    expect(first.winnerBotId).toBe(bots[0].botId);
    expect(first.winnerTeamId).toBeNull();
    expect(first.final).toBe(false);

    // Nunca viaja el seed_commitment sembrado en el torneo (eso vive en `tournaments`, no en `matches`).
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("r12-should-never-leak-commitment");
  });

  it("torneo sin matches → 200 con matches: []", async () => {
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "r12-empty",
        format: "single_elimination",
        mode: "deathmatch",
        ruleset_id: "mvp-default",
        state: "open",
      })
      .returning("id");
    const res = await request(app).get(`/tournaments/${t.id}/matches`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [] });
  });
});
