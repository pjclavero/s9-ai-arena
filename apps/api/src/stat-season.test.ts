/**
 * DEV-B · TD-029 · STAT_SEASON: una sola temporada activa para API, worker y web.
 * Antes la API consultaba `current` (que nadie escribe) y el worker escribía en
 * `season-1`: la clasificación pública salía SIEMPRE vacía.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { clearStandingsCache, updateStandings } from "./services/standings.js";
import { ACTIVE_SEASON_ID, resolveSeasonId } from "../../tournament-worker/src/season.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("TD-029 · STAT_SEASON", () => {
  it("la constante coincide con el DEFAULT de tournaments.season_id (lo que escribe el worker)", async () => {
    const r = await h.db.raw(
      `SELECT column_default FROM information_schema.columns WHERE table_name='tournaments' AND column_name='season_id'`,
    );
    expect(String(r.rows[0].column_default)).toContain(`'${ACTIVE_SEASON_ID}'`);
  });

  it("alias: ausente / '' / 'current' ⇒ temporada activa; otro id ⇒ literal", () => {
    expect(resolveSeasonId(undefined)).toBe(ACTIVE_SEASON_ID);
    expect(resolveSeasonId("")).toBe(ACTIVE_SEASON_ID);
    expect(resolveSeasonId("current")).toBe(ACTIVE_SEASON_ID);
    expect(resolveSeasonId("season-0")).toBe("season-0");
  });

  it("GET /standings SIN seasonId (como la web) devuelve la clasificación que escribió el worker", async () => {
    const bot = await createPublishedBot(h.db, "season-bot");
    await updateStandings(h.db, ACTIVE_SEASON_ID, "deathmatch", [
      { botId: bot.botId, rank: 1, rating: 1234, wins: 3, losses: 1, draws: 0 },
    ]);
    clearStandingsCache();
    const r = await request(app).get("/standings?mode=deathmatch");
    expect(r.status).toBe(200);
    expect(r.headers["x-s9-season"]).toBe(ACTIVE_SEASON_ID);
    expect(r.body.map((s: { botId: string }) => s.botId)).toContain(bot.botId);
    const alias = await request(app).get("/standings?mode=deathmatch&seasonId=current");
    expect(alias.body.length).toBe(r.body.length);
  });
});
