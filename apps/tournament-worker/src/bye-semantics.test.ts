/**
 * D-OP-24 · Semántica del bye (opción B), contra PostgreSQL REAL.
 * El bye es un avance/descanso administrativo: NO es victoria, derrota ni empate, no suma puntos
 * (0 también en el suizo), no cuenta como partida disputada y NO da Elo. Va en su propia columna
 * (`byes`); los enfrentamientos sin resultado deportivo van en `technical`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { applyBattleRating } from "./ratings.js";
import { leagueTable, swissStandings } from "./results.js";
import { createBots, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let adminId: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

async function tournament(format: string, bots: TestBot[]): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `bye-${Math.random().toString(36).slice(2, 8)}`,
      format,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
      created_by: adminId,
      season_id: "Sbye-sem",
    })
    .returning("id");
  for (const b of bots) {
    await h
      .db("entries")
      .insert({ tournament_id: t.id, bot_id: b.botId, version: b.version, loadout_revision: 1, frozen: true });
  }
  return t.id as string;
}

async function match(
  tid: string,
  slot: string,
  round: number,
  pairing: Record<string, unknown>,
  state: string,
  winner: string | null,
): Promise<string> {
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round,
      slot,
      state,
      pairing: JSON.stringify({ slot, round, bracket: "main", ...pairing }),
      winner_bot_id: winner,
    })
    .returning("id");
  return m.id as string;
}

describe("D-OP-24 · bye en la tabla del torneo", () => {
  it("BYE_table: el bye no puntúa, no es victoria ni partida; va en `byes`; lo jugado cuenta igual", async () => {
    const [a, b, c] = await createBots(h.db, 3, "bsem");
    const t = await tournament("round_robin", [a, b, c]);
    await match(t, "RR1M1", 1, { home: c.botId, away: null, bye: true }, "finished", c.botId);
    const mid = await match(t, "RR1M2", 1, { home: a.botId, away: b.botId }, "finished", a.botId);
    await h.db("battles").insert({
      tournament_id: t,
      match_id: mid,
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 1,
      result: JSON.stringify({ winner: "A", score: { A: 1, B: 0 }, endReason: "completed" }),
    });
    const rows = new Map((await leagueTable(h.db, t, false)).map((r) => [r.id, r]));
    const rc = rows.get(c.botId)!;
    expect({ pts: rc.points, w: rc.wins, l: rc.losses, d: rc.draws, byes: rc.byes }).toEqual({
      pts: 0,
      w: 0,
      l: 0,
      d: 0,
      byes: 1,
    });
    expect(rows.get(a.botId)).toMatchObject({ points: 3, wins: 1, byes: 0 });
    expect(rows.get(b.botId)).toMatchObject({ points: 0, losses: 1, byes: 0 });
  });

  it("BYE_technical: un enfrentamiento `failed` se cuenta en `technical`, no como victoria/derrota/empate", async () => {
    const [a, b] = await createBots(h.db, 2, "btech");
    const t = await tournament("round_robin", [a, b]);
    await match(t, "RR1M1", 1, { home: a.botId, away: b.botId }, "failed", a.botId);
    const rows = new Map((await leagueTable(h.db, t, false)).map((r) => [r.id, r]));
    for (const id of [a.botId, b.botId])
      expect(rows.get(id)).toMatchObject({ points: 0, wins: 0, losses: 0, draws: 0, technical: 1, byes: 0 });
  });
});

describe("D-OP-24 · bye en el suizo", () => {
  it("BYE_swiss_zero: el bye da 0 puntos y queda contado (hadBye/byes)", async () => {
    const [a, b, c] = await createBots(h.db, 3, "bsw");
    const t = await tournament("swiss", [a, b, c]);
    await match(t, "S1BYE", 1, { home: c.botId, away: null, bye: true }, "finished", c.botId);
    await match(t, "S1M1", 1, { home: a.botId, away: b.botId }, "finished", a.botId);
    const { standings } = await swissStandings(h.db, t);
    const byId = new Map(standings.map((s) => [s.id, s]));
    expect(byId.get(c.botId)).toMatchObject({ points: 0, hadBye: true, byes: 1 });
    expect(byId.get(a.botId)).toMatchObject({ points: 3, hadBye: false, byes: 0 });
  });
});

describe("D-OP-24 · invariante Elo", () => {
  it("BYE_no_elo: ni una batalla colgada de un match bye genera rating_event", async () => {
    const [a, b] = await createBots(h.db, 2, "belo");
    const t = await tournament("round_robin", [a, b]);
    const mid = await match(t, "RR1M1", 1, { home: a.botId, away: null, bye: true }, "finished", a.botId);
    const [bt] = await h
      .db("battles")
      .insert({
        tournament_id: t,
        match_id: mid,
        status: "finished",
        official: true,
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        map_id: "mvp-arena-01",
        map_version: 1,
        game_index: 1,
        result: JSON.stringify({ winner: "A", score: { A: 1, B: 0 }, endReason: "completed" }),
      })
      .returning("id");
    await h.db("participants").insert([
      { battle_id: bt.id, bot_id: a.botId, version: 1, team: "A", outcome: "win" },
      { battle_id: bt.id, bot_id: b.botId, version: 1, team: "B", outcome: "loss" },
    ]);
    expect(await applyBattleRating(h.db, bt.id as string)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: bt.id })).toHaveLength(0);
  });
});
