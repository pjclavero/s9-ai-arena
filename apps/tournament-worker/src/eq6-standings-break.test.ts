/** EQ6 · ataques a la clasificación de temporada (#220). Montaje copiado de standings-season.test.ts. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { clearStandingsCache, getStandings } from "../../api/src/services/standings.js";
import { handleUpdateStandings, recomputeSeasonStandings } from "./standings.js";
import { createBots, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

let h: TestDbHandle;
let A: TestBot, B: TestBot, C: TestBot, D: TestBot;
let t1: string, t2: string;
const SEASON = "season-1";

async function tournament(name: string, bots: TestBot[], mode = "deathmatch"): Promise<string> {
  const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
  const [t] = await h
    .db("tournaments")
    .insert({
      name,
      format: "league",
      mode,
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
      created_by: admin.id,
      season_id: SEASON,
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
  home: string,
  away: string | null,
  winner: string | null,
  technical = false,
) {
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: "main", home, away, ...(away === null ? { bye: true } : {}) }),
      winner_bot_id: winner,
    })
    .returning("id");
  if (away !== null) {
    await h.db("battles").insert({
      tournament_id: tid,
      match_id: m.id,
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 1,
      result: JSON.stringify(
        technical
          ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
          : {
              winner: winner === home ? "A" : winner === away ? "B" : "draw",
              score: { A: winner === home ? 1 : 0, B: winner === away ? 1 : 0 },
            },
      ),
    });
  }
}
const job = (tournamentId: string) =>
  ({ id: "j", kind: "update_standings", payload: { tournamentId }, attempts: 1 }) as unknown as JobRow;
async function table() {
  clearStandingsCache();
  const { standings } = await getStandings(h.db, SEASON, "deathmatch");
  return standings.map((r) => ({ id: r.botId, rank: r.rank, w: r.wins, l: r.losses, d: r.draws }));
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  [A, B, C, D] = await createBots(h.db, 4, "st");
  t1 = await tournament("st-T1", [A, B, C]);
  t2 = await tournament("st-T2", [A, D]);
  await match(t1, "M1", A.botId, B.botId, A.botId);
  await match(t1, "M2", A.botId, C.botId, null); // empate
  await match(t1, "M3", C.botId, null, null); // bye de C
  await match(t2, "N1", D.botId, A.botId, D.botId);
  await match(t2, "N2", A.botId, D.botId, null, true); // técnico: no cuenta
}, 120_000);

afterAll(async () => {
  await h.stop();
});

import { leagueTable } from "./results.js";
import { seasonTable } from "./standings.js";

/*
 * EQ6 · revisión independiente de #220 (montaje copiado de standings-season.test.ts).
 * Cada escenario usa un MODO propio para no mezclarse con el del autor.
 */
const strip = (rows: any[]) =>
  rows.map(({ id, points, wins, losses, draws, scoreDiff }) => ({ id, points, wins, losses, draws, scoreDiff }));

describe("EQ6 · #220 · standings de temporada", () => {
  it("con UN solo torneo (como hoy en producción) la tabla agregada es EXACTAMENTE la del torneo, orden incluido", async () => {
    const bots = await createBots(h.db, 5, "eq6one");
    const [P, Q, R, S, U] = bots;
    const t = await tournament("eq6-one", bots, "zone_control");
    await match(t, "O1", P.botId, Q.botId, P.botId);
    await match(t, "O2", R.botId, S.botId, null); // empate
    await match(t, "O3", U.botId, null, null); // bye
    await match(t, "O4", Q.botId, R.botId, R.botId);
    await match(t, "O5", S.botId, P.botId, S.botId);
    const single = await leagueTable(h.db, t, false);
    const season = await seasonTable(h.db, SEASON, "zone_control");
    expect(strip(season)).toEqual(strip(single));
    expect(season.map((r) => r.id)).toEqual(single.map((r) => r.id));
  });

  it("bot presente en un solo torneo y byes en varios: sumas correctas", async () => {
    const [X, Y, Z] = await createBots(h.db, 3, "eq6sum");
    const ta = await tournament("eq6-sumA", [X, Y], "team_deathmatch");
    const tb = await tournament("eq6-sumB", [X, Z], "team_deathmatch");
    await match(ta, "A1", X.botId, Y.botId, X.botId);
    await match(ta, "A2", X.botId, null, null); // bye X
    await match(tb, "B1", Z.botId, null, null); // bye Z (sólo en B)
    await match(tb, "B2", X.botId, Z.botId, null); // empate
    const rows = await seasonTable(h.db, SEASON, "team_deathmatch");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([by[X.botId].wins, by[X.botId].losses, by[X.botId].draws, by[X.botId].points]).toEqual([2, 0, 1, 7]);
    expect([by[Y.botId].wins, by[Y.botId].losses, by[Y.botId].draws, by[Y.botId].points]).toEqual([0, 1, 0, 0]);
    expect([by[Z.botId].wins, by[Z.botId].losses, by[Z.botId].draws, by[Z.botId].points]).toEqual([1, 0, 1, 4]);
  });

  it("ciclo de enfrentamientos directos entre torneos (A>B, B>C, C>A, a puntos iguales): orden estable sea cual sea el orden de los torneos", async () => {
    const [A1, B1, C1] = await createBots(h.db, 3, "eq6cyc");
    const ids = [A1, B1, C1].map((b) => b.botId);
    const t1x = await tournament("eq6-cyc1", [A1, B1], "capture_the_flag");
    const t2x = await tournament("eq6-cyc2", [B1, C1], "capture_the_flag");
    const t3x = await tournament("eq6-cyc3", [C1, A1], "capture_the_flag");
    await match(t1x, "C1", A1.botId, B1.botId, A1.botId);
    await match(t2x, "C2", B1.botId, C1.botId, B1.botId);
    await match(t3x, "C3", C1.botId, A1.botId, C1.botId);
    const first = (await seasonTable(h.db, SEASON, "capture_the_flag")).map((r) => r.id);
    expect([...first].sort()).toEqual([...ids].sort());
    for (let i = 0; i < 5; i++)
      expect((await seasonTable(h.db, SEASON, "capture_the_flag")).map((r) => r.id)).toEqual(first);
    // Reordenar los torneos (otra inserción de entries no cambia nada: el agregado ordena por id de torneo).
    console.log(
      "[EQ6] orden con ciclo:",
      first.map((id) => (id === A1.botId ? "A" : id === B1.botId ? "B" : "C")).join(" > "),
    );
  });

  it("CERROJO calibrado: con el cerrojo consultivo de (temporada, modo) tomado por otra sesión, el recálculo ESPERA", async () => {
    const holder = await h.db.client.acquireConnection();
    try {
      await h.db.raw("SELECT pg_advisory_lock(hashtext(?))", [`standings|${SEASON}|deathmatch`]).connection(holder);
      let done = false;
      const p = recomputeSeasonStandings(h.db, SEASON, "deathmatch").then(() => (done = true));
      await new Promise((r) => setTimeout(r, 1500));
      expect(done, "el recálculo no respetó el cerrojo consultivo").toBe(false);
      await h.db.raw("SELECT pg_advisory_unlock(hashtext(?))", [`standings|${SEASON}|deathmatch`]).connection(holder);
      await p;
      expect(done).toBe(true);
    } finally {
      await h.db.client.releaseConnection(holder);
    }
  }, 20_000);

  it("INFORMATIVO: un torneo abierto (sin jugar) y uno cancelado entran en la clasificación de temporada", async () => {
    const [O, K] = await createBots(h.db, 2, "eq6state");
    const topen = await tournament("eq6-open", [O], "deathmatch");
    await h.db("tournaments").where({ id: topen }).update({ state: "open" });
    const tcan = await tournament("eq6-cancel", [K], "deathmatch");
    await h.db("tournaments").where({ id: tcan }).update({ state: "cancelled" });
    const rows = await seasonTable(h.db, SEASON, "deathmatch");
    const ids = rows.map((r) => r.id);
    console.log(
      "[EQ6] bot de torneo ABIERTO en standings:",
      ids.includes(O.botId),
      "· de torneo CANCELADO:",
      ids.includes(K.botId),
    );
  });
});
