/**
 * [REVIEW] #229 ronda 2 (revisor independiente) · STANDINGS_POLICY = official_played_not_reverted.
 * NO MERGEAR. Tests de rotura contra PostgreSQL REAL (embedded-postgres) sobre 3b24d0e:
 *  - D · reglas de rating sin cambios: diferencial contra una copia LITERAL del
 *    applyBattleRating de main (e3bf2fa), sin concurrencia, con victorias, empates,
 *    descalificaciones, técnicas, prácticas, 2v2 y K propio. Igualdad EXACTA (===).
 *  - P · réplica del torneo finished de producción con los números reales del libro mayor
 *    (EQ4 phase1/phase2, solo lectura): ratings bit a bit, posiciones, V-D-E sólo cambia por bye.
 *  - H2 · reversión antes / durante / después del Elo, doble, concurrente, valor de retorno.
 *  - H3 · concurrencia del Elo: mismo bot, Elo + su reversión, dos torneos simultáneos;
 *    ledger = ratings, cadena before/after continua, W/L/D = eventos vivos, sin interbloqueos.
 *  - H4 / H5 · serie en juego y draft. Política: open sin batallas, cancelled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { clearStandingsCache, getStandings } from "../../api/src/services/standings.js";
import { handleUpdateStandings, recomputeSeasonStandings, revertOfficialBattle, seasonTable } from "./standings.js";
import {
  applyBattleRating,
  revertBattleRating,
  EloSystem,
  INITIAL_RATING,
  DEFAULT_K,
  type RatedSide,
} from "./ratings.js";
import { resolveSeasonId } from "./season.js";
import { leagueTableDetailed, sortTable, type TableRow } from "./results.js";
import { createBots, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

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

// ------------------------------------------------------------------ utilidades

async function tournament(o: {
  season: string;
  mode?: string;
  state?: string;
  format?: string;
  eloK?: number;
  bots: TestBot[];
}): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `r2-${Math.random().toString(36).slice(2, 8)}`,
      format: o.format ?? "league",
      mode: o.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: o.state ?? "running",
      created_by: adminId,
      season_id: o.season,
      ...(o.eloK ? { elo_k: o.eloK } : {}),
    })
    .returning("id");
  for (const b of o.bots) {
    await h
      .db("entries")
      .insert({ tournament_id: t.id, bot_id: b.botId, version: b.version, loadout_revision: 1, frozen: true });
  }
  return t.id as string;
}

async function match(
  tid: string,
  home: string,
  away: string | null,
  o: { bracket?: string; state?: string; slot?: string; bye?: boolean; winner?: string | null } = {},
): Promise<string> {
  const slot = o.slot ?? `S${Math.random().toString(36).slice(2, 8)}`;
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: o.state ?? "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: o.bracket ?? "main", home, away, bye: o.bye ?? false }),
      winner_bot_id: o.winner ?? null,
    })
    .returning("id");
  return m.id as string;
}

/** Batalla cruda: participantes [bot, team, outcome] y resultado literal. Sin Elo. */
async function rawBattle(
  tid: string,
  mid: string | null,
  gi: number,
  parts: [TestBot, string, string | null][],
  result: Record<string, unknown> | null,
  o: { official?: boolean; status?: string; mode?: string } = {},
): Promise<string> {
  const [b] = await h
    .db("battles")
    .insert({
      tournament_id: tid,
      match_id: mid,
      status: o.status ?? "finished",
      official: o.official ?? true,
      mode: o.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: gi,
      result: result ? JSON.stringify(result) : null,
    })
    .returning("id");
  await h
    .db("participants")
    .insert(parts.map(([bot, team, outcome]) => ({ battle_id: b.id, bot_id: bot.botId, version: 1, team, outcome })));
  return b.id as string;
}

/** Juego 1v1 de un enfrentamiento (juego impar: home = A). Sin Elo salvo rate. */
async function game(
  tid: string,
  mid: string,
  home: TestBot,
  away: TestBot,
  gi: number,
  w: "home" | "away" | "draw" | "technical",
  o: { rate?: boolean; official?: boolean; status?: string } = {},
): Promise<string> {
  const hT = gi % 2 === 1 ? "A" : "B";
  const aT = gi % 2 === 1 ? "B" : "A";
  const score: Record<string, number> = { A: 0, B: 0 };
  if (w === "home") score[hT] = 1;
  if (w === "away") score[aT] = 1;
  const result =
    w === "technical"
      ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
      : { winner: w === "home" ? hT : w === "away" ? aT : "draw", score, endReason: "completed" };
  const out = (s: "home" | "away") => (w === "technical" ? null : w === "draw" ? "draw" : w === s ? "win" : "loss");
  const id = await rawBattle(
    tid,
    mid,
    gi,
    [
      [home, hT, out("home")],
      [away, aT, out("away")],
    ],
    o.status && o.status !== "finished" ? null : result,
    o,
  );
  if (o.rate) await applyBattleRating(h.db, id);
  return id;
}

const job = (tournamentId: string, battleId?: string) =>
  ({ id: "j", kind: "update_standings", payload: { tournamentId, battleId }, attempts: 1 }) as unknown as JobRow;
async function update(tid: string, battleId?: string) {
  await handleUpdateStandings(job(tid, battleId), { db: h.db } as never);
}
async function table(season: string, mode = "deathmatch") {
  clearStandingsCache();
  const { standings } = await getStandings(h.db, season, mode);
  return standings.map((r) => ({ id: r.botId, rank: r.rank, w: r.wins, l: r.losses, d: r.draws, rating: r.rating }));
}
const vde = (rows: Awaited<ReturnType<typeof table>>, b: TestBot) => {
  const r = rows.find((x) => x.id === b.botId);
  return r ? [r.w, r.l, r.d] : null;
};

/**
 * Auditoría del libro mayor de (temporada, modo):
 *  - ratings.rating = 1000 + Σ deltas NO revertidos (1e-9);
 *  - ratings.wins/losses/draws = nº de eventos NO revertidos con ese resultado;
 *  - si no hay reversiones del bot: cadena before/after continua por orden de id;
 *  - standings.rating = ratings.rating.
 */
async function ledgerAudit(season: string, mode = "deathmatch"): Promise<string[]> {
  const bad: string[] = [];
  const ratings = await h.db("ratings").where({ season_id: season, mode });
  for (const r of ratings) {
    const ev = await h
      .db("rating_events as e")
      .join("participants as p", function () {
        this.on("p.battle_id", "e.battle_id").andOn("p.bot_id", "e.bot_id");
      })
      .where({ "e.bot_id": r.bot_id, "e.season_id": season, "e.mode": mode })
      .orderBy("e.id")
      .select("e.*", "p.outcome");
    const live = ev.filter((e: Record<string, any>) => !e.reverted);
    const sum = live.reduce((s: number, e: Record<string, any>) => s + Number(e.delta), INITIAL_RATING);
    if (Math.abs(sum - Number(r.rating)) > 1e-9) bad.push(`${r.bot_id}: ratings=${r.rating} ledger=${sum}`);
    const cnt = (f: (o: string | null) => boolean) => live.filter((e: Record<string, any>) => f(e.outcome)).length;
    const w = cnt((o) => o === "win");
    const d = cnt((o) => o === "draw");
    const l = live.length - w - d;
    if (r.wins !== w || r.losses !== l || r.draws !== d)
      bad.push(`${r.bot_id}: W/L/D ratings=${r.wins}/${r.losses}/${r.draws} ledger=${w}/${l}/${d}`);
    if (ev.every((e: Record<string, any>) => !e.reverted)) {
      let prev = INITIAL_RATING;
      for (const e of ev) {
        if (Number(e.rating_before) !== prev)
          bad.push(`${r.bot_id}: cadena rota en ev ${e.id} (${e.rating_before}≠${prev})`);
        prev = Number(e.rating_after);
      }
    }
  }
  for (const s of await h.db("standings").where({ season_id: season, mode })) {
    const r = ratings.find((x: Record<string, unknown>) => x.bot_id === s.bot_id);
    const expected = r ? Number(r.rating) : INITIAL_RATING;
    if (Math.abs(expected - Number(s.rating)) > 1e-9)
      bad.push(`${s.bot_id}: standings=${s.rating} ratings=${expected}`);
  }
  return bad;
}

// --------------------------------------------- copia LITERAL de main @ e3bf2fa (referencia)

function outcomeScoreMain(outcome: string | null): number {
  if (outcome === "win") return 1;
  if (outcome === "draw") return 0.5;
  return 0;
}
function resultOfMain(battle: Record<string, unknown>): { endReason?: string } | null {
  const r = battle.result;
  if (!r) return null;
  return (typeof r === "string" ? JSON.parse(r) : r) as { endReason?: string };
}
async function applyBattleRatingMain(db: Knex, battleId: string): Promise<boolean> {
  const system = EloSystem;
  const battle = await db("battles").where({ id: battleId }).first();
  if (!battle || battle.status !== "finished") return false;
  if (!battle.official) return false;
  if (resultOfMain(battle)?.endReason === "technical_limit") return false;
  const tournament = battle.tournament_id ? await db("tournaments").where({ id: battle.tournament_id }).first() : null;
  const seasonId = resolveSeasonId(tournament?.season_id);
  const mode = battle.mode as string;
  const k = (tournament?.elo_k as number) ?? DEFAULT_K;
  return db.transaction(async (trx) => {
    const existing = await trx("rating_events").where({ battle_id: battleId }).forUpdate().first();
    if (existing) return false;
    const participants = await trx("participants").where({ battle_id: battleId });
    if (participants.length < 2) return false;
    const sides: RatedSide[] = [];
    for (const p of participants) {
      const current = await trx("ratings").where({ bot_id: p.bot_id, season_id: seasonId, mode }).first();
      sides.push({
        botId: p.bot_id,
        team: p.team,
        rating: (current?.rating as number) ?? INITIAL_RATING,
        score: outcomeScoreMain(p.outcome),
      });
    }
    const deltas = system.deltas(sides, k);
    for (const p of participants) {
      const side = sides.find((s) => s.botId === p.bot_id)!;
      const delta = deltas.get(p.bot_id) ?? 0;
      const after = side.rating + delta;
      await trx("rating_events").insert({
        battle_id: battleId,
        bot_id: p.bot_id,
        bot_version: p.version,
        season_id: seasonId,
        mode,
        k,
        rating_before: side.rating,
        delta,
        rating_after: after,
      });
      await trx("ratings")
        .insert({
          bot_id: p.bot_id,
          season_id: seasonId,
          mode,
          rating: after,
          wins: side.score === 1 ? 1 : 0,
          losses: side.score === 0 ? 1 : 0,
          draws: side.score === 0.5 ? 1 : 0,
          updated_at: trx.fn.now(),
        })
        .onConflict(["bot_id", "season_id", "mode"])
        .merge({
          rating: after,
          wins: trx.raw("ratings.wins + ?", [side.score === 1 ? 1 : 0]),
          losses: trx.raw("ratings.losses + ?", [side.score === 0 ? 1 : 0]),
          draws: trx.raw("ratings.draws + ?", [side.score === 0.5 ? 1 : 0]),
          updated_at: trx.fn.now(),
        });
    }
    return true;
  });
}

async function seasonTableMain(db: Knex, seasonId: string, mode: string): Promise<TableRow[]> {
  const tournaments = await db("tournaments")
    .where({ season_id: seasonId, mode })
    .whereNot({ format: "teams" })
    .orderBy("id", "asc")
    .select("id");
  const total = new Map<string, TableRow>();
  const h2h = new Map<string, number>();
  for (const { id } of tournaments as { id: string }[]) {
    const { rows, headToHead } = await leagueTableDetailed(db, id, false);
    for (const r of rows.values()) {
      const acc = total.get(r.id);
      if (!acc) total.set(r.id, { ...r });
      else {
        acc.points += r.points;
        acc.wins += r.wins;
        acc.losses += r.losses;
        acc.draws += r.draws;
        acc.scoreDiff += r.scoreDiff;
        acc.seed = Math.min(acc.seed, r.seed);
      }
    }
    for (const [k, n] of headToHead) h2h.set(k, (h2h.get(k) ?? 0) + n);
  }
  return sortTable(total.values(), h2h);
}

/** PRNG determinista (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ D · reglas de rating

describe("[R2 #229] D · reglas de rating sin cambios (diferencial contra main)", () => {
  it("D1 · constantes: K=24, inicial 1000, empate 0,5; victoria a 1000-1000 = +12 exacto", async () => {
    expect(DEFAULT_K).toBe(24);
    expect(INITIAL_RATING).toBe(1000);
    const [a, b, c, d] = await createBots(h.db, 4, "d1");
    const t = await tournament({ season: "D1", bots: [a, b, c, d] });
    const win = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home", { rate: true });
    const draw = await game(t, await match(t, c.botId, d.botId), c, d, 1, "draw", { rate: true });
    const ev = async (bid: string, bot: TestBot) =>
      Number((await h.db("rating_events").where({ battle_id: bid, bot_id: bot.botId }).first()).delta);
    expect(await ev(win, a)).toBe(12);
    expect(await ev(win, b)).toBe(-12);
    expect(await ev(draw, c)).toBe(0);
    // descalificación = derrota
    const [e, f] = await createBots(h.db, 2, "d1q");
    const t2 = await tournament({ season: "D1q", bots: [e, f] });
    const dq = await rawBattle(
      t2,
      await match(t2, e.botId, f.botId),
      1,
      [
        [e, "A", "win"],
        [f, "B", "disqualified"],
      ],
      { winner: "A", score: { A: 1, B: 0 }, endReason: "completed", disqualified: [f.botId] },
    );
    expect(await applyBattleRating(h.db, dq)).toBe(true);
    expect(await ev(dq, f)).toBe(-12);
    // técnico excluido
    const tech = await game(t2, await match(t2, e.botId, f.botId), e, f, 1, "technical");
    expect(await applyBattleRating(h.db, tech)).toBe(false);
  });

  it("D2 · 60 batallas aleatorias (1v1, 2v2, DQ, técnicas, prácticas, K=32): ratings y libro mayor IDÉNTICOS a main", async () => {
    const bots = await createBots(h.db, 8, "d2");
    for (const [season, apply] of [
      ["D2-main", applyBattleRatingMain],
      ["D2-pr", applyBattleRating],
    ] as const) {
      const rr = rng(229);
      const tK = await tournament({ season, bots, eloK: 32 });
      const tD = await tournament({ season, bots });
      for (let i = 0; i < 60; i++) {
        const t = rr() < 0.3 ? tK : tD;
        const kind = rr();
        const pick = () => bots[Math.floor(rr() * bots.length)];
        let parts: [TestBot, string, string | null][];
        let result: Record<string, unknown>;
        const roll = rr();
        const ow = roll < 0.4 ? "A" : roll < 0.8 ? "B" : "draw";
        const out = (team: string) => (ow === "draw" ? "draw" : team === ow ? "win" : "loss");
        if (kind < 0.25) {
          // 2v2
          const pool = [...bots].sort(() => rr() - 0.5).slice(0, 4);
          parts = [
            [pool[0], "A", out("A")],
            [pool[1], "A", out("A")],
            [pool[2], "B", out("B")],
            [pool[3], "B", rr() < 0.2 && ow !== "B" ? "disqualified" : out("B")],
          ];
        } else {
          const a = pick();
          let b = pick();
          while (b.botId === a.botId) b = pick();
          parts = [
            [a, "A", out("A")],
            [b, "B", rr() < 0.15 && ow !== "B" ? "disqualified" : out("B")],
          ];
        }
        const special = rr();
        const technical = special < 0.08;
        const practice = !technical && special < 0.16;
        result = technical
          ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
          : { winner: ow, endReason: "completed", score: { A: ow === "A" ? 1 : 0, B: ow === "B" ? 1 : 0 } };
        const bid = await rawBattle(t, null, 1, parts, result, { official: !practice });
        await apply(h.db, bid);
      }
    }
    const snap = async (season: string) => {
      const ratings = (await h.db("ratings").where({ season_id: season }).orderBy(["bot_id", "mode"])).map(
        (x: Record<string, any>) => [x.bot_id, x.mode, x.rating, x.wins, x.losses, x.draws],
      );
      const events = (await h.db("rating_events").where({ season_id: season }).orderBy("id")).map(
        (x: Record<string, any>) => [x.bot_id, x.k, x.rating_before, x.delta, x.rating_after, x.reverted],
      );
      return { ratings, events };
    };
    const main = await snap("D2-main");
    const pr = await snap("D2-pr");
    expect(main.events.length).toBeGreaterThan(80);
    expect(pr).toEqual(main); // toEqual sobre números = igualdad exacta (Object.is)
  });
});

// ------------------------------------------------------------------ P · producción

describe("[R2 #229] P · réplica del torneo finished de producción (EQ4, solo lectura)", () => {
  it("P1 · ratings bit a bit iguales a producción, posiciones iguales, V-D-E sólo cambia por bye", async () => {
    // Orden de inscripción = seed (scheduler.ts: seed = i+1 por entries.created_at); se deduce
    // del bracket publicado con seedPositions(8) = 1,8,4,5,2,7,3,6 (todos del mismo dueño:
    // avoidSameOwnerRound1 no permuta).
    const names = ["A-ATK-2", "A-DEF", "A-ATK-1", "B-DEF", "B-ATK-1", "prueba1"];
    const bots = await createBots(h.db, 6, "prd");
    const by = Object.fromEntries(names.map((n, i) => [n, bots[i]]));
    const t = await tournament({ season: "PRD", format: "single_elimination", state: "running", bots });
    const W = { bracket: "winners" };
    await match(t, by["A-ATK-2"].botId, null, { ...W, slot: "W1M1", bye: true, winner: by["A-ATK-2"].botId });
    const m2 = await match(t, by["B-DEF"].botId, by["B-ATK-1"].botId, {
      ...W,
      slot: "W1M2",
      winner: by["B-ATK-1"].botId,
    });
    await match(t, by["A-DEF"].botId, null, { ...W, slot: "W1M3", bye: true, winner: by["A-DEF"].botId });
    const m4 = await match(t, by["A-ATK-1"].botId, by["prueba1"].botId, {
      ...W,
      slot: "W1M4",
      winner: by["prueba1"].botId,
    });
    const m5 = await match(t, by["A-ATK-2"].botId, by["B-ATK-1"].botId, {
      ...W,
      slot: "W2M1",
      winner: by["B-ATK-1"].botId,
    });
    const m6 = await match(t, by["A-DEF"].botId, by["prueba1"].botId, {
      ...W,
      slot: "W2M2",
      winner: by["A-DEF"].botId,
    });
    const m7 = await match(t, by["B-ATK-1"].botId, by["A-DEF"].botId, {
      ...W,
      slot: "W3M1",
      winner: by["B-ATK-1"].botId,
    });
    const win = (s: "A" | "B") => ({
      score: { A: s === "A" ? 1 : 0, B: s === "B" ? 1 : 0 },
      winner: s,
      endReason: "completed",
      disqualified: [],
    });
    const draw = { score: { A: 0, B: 0 }, winner: "draw", endReason: "completed", disqualified: [] };
    // Las 5 batallas oficiales, en el orden real de finishedAt (cb90771b, da091a53, 6abcf42f, fdacf019, c27fc8a6).
    const seq: [string, number, [TestBot, string, string][], Record<string, unknown>][] = [
      [
        m2,
        1,
        [
          [by["B-DEF"], "A", "loss"],
          [by["B-ATK-1"], "B", "win"],
        ],
        win("B"),
      ],
      [
        m4,
        1,
        [
          [by["A-ATK-1"], "A", "loss"],
          [by["prueba1"], "B", "win"],
        ],
        win("B"),
      ],
      [
        m5,
        1,
        [
          [by["A-ATK-2"], "A", "loss"],
          [by["B-ATK-1"], "B", "win"],
        ],
        win("B"),
      ],
      [
        m6,
        1,
        [
          [by["A-DEF"], "A", "draw"],
          [by["prueba1"], "B", "draw"],
        ],
        draw,
      ],
      [
        m7,
        1,
        [
          [by["B-ATK-1"], "A", "draw"],
          [by["A-DEF"], "B", "draw"],
        ],
        draw,
      ],
    ];
    for (const [mid, gi, parts, res] of seq) {
      const bid = await rawBattle(t, mid, gi, parts, res);
      await update(t, bid); // el job real: Elo + recálculo
    }
    await h.db("tournaments").where({ id: t }).update({ state: "finished" });
    await recomputeSeasonStandings(h.db, "PRD", "deathmatch");
    const rows = await table("PRD");
    const nm = (id: string) => names[bots.findIndex((b) => b.botId === id)];
    // Producción (phase1.standings.deathmatch): rank, rating EXACTO.
    const PROD: [string, number, string][] = [
      ["B-ATK-1", 1022.7865721147986, "3-0-0"],
      ["A-DEF", 1001.2134278852014, "2-1-0"],
      ["prueba1", 1011.5856994136229, "1-1-0"],
      ["A-ATK-2", 988.4143005863771, "1-1-0"],
      ["A-ATK-1", 988, "0-1-0"],
      ["B-DEF", 988, "0-1-0"],
    ];
    expect(rows.map((r) => [nm(r.id), r.rating])).toEqual(PROD.map(([n, rt]) => [n, rt]));
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    const byeChange: Record<string, string> = { "A-DEF": "1-1-0", "A-ATK-2": "0-1-0" };
    expect(rows.map((r) => `${nm(r.id)} ${r.w}-${r.l}-${r.d}`)).toEqual(
      PROD.map(([n, , v]) => `${n} ${byeChange[n] ?? v}`),
    );
    // Calibración de la réplica: con la tabla de main sale EXACTAMENTE lo publicado hoy.
    const main = await seasonTableMain(h.db, "PRD", "deathmatch");
    expect(main.map((r) => `${nm(r.id)} ${r.wins}-${r.losses}-${r.draws}`)).toEqual(
      PROD.map(([n, , v]) => `${n} ${v}`),
    );
    // Libro mayor de producción (phase2.hist): B-ATK-1 y A-DEF, before/delta/after exactos.
    const ev = async (n: string) =>
      (await h.db("rating_events").where({ bot_id: by[n].botId }).orderBy("id")).map((e: Record<string, any>) => [
        e.rating_before,
        e.delta,
        e.rating_after,
      ]);
    expect(await ev("B-ATK-1")).toEqual([
      [1000, 12, 1012],
      [1012, 11.585699413622972, 1023.5856994136229],
      [1023.5856994136229, -0.799127298824363, 1022.7865721147986],
    ]);
    expect(await ev("A-DEF")).toEqual([
      [1000, 0.4143005863770286, 1000.4143005863771],
      [1000.4143005863771, 0.799127298824363, 1001.2134278852014],
    ]);
    expect(await ledgerAudit("PRD")).toEqual([]);
  });
});

// ------------------------------------------------------------------ H2 · reversión

describe("[R2 #229] H2 · reversión con marca propia", () => {
  it("V1 · antes del Elo: reverted; el job tardío no puntúa; no aparece", async () => {
    const [a, b] = await createBots(h.db, 2, "v1");
    const t = await tournament({ season: "RV1", bots: [a, b] });
    const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    expect(await revertOfficialBattle(h.db, bid)).toBe("reverted");
    await update(t, bid);
    expect(await applyBattleRating(h.db, bid)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await table("RV1")).toEqual([]);
  });

  it("V2 · después del Elo: rating vuelve a 1000 exacto; doble = already_reverted; recálculo estable", async () => {
    const [a, b] = await createBots(h.db, 2, "v2");
    const t = await tournament({ season: "RV2", bots: [a, b] });
    const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    await update(t, bid);
    expect(vde(await table("RV2"), a)).toEqual([1, 0, 0]);
    expect(await revertOfficialBattle(h.db, bid)).toBe("reverted");
    expect(await revertOfficialBattle(h.db, bid)).toBe("already_reverted");
    const r = await h.db("ratings").where({ season_id: "RV2" });
    expect(r.map((x: Record<string, any>) => [x.rating, x.wins, x.losses, x.draws])).toEqual([
      [1000, 0, 0, 0],
      [1000, 0, 0, 0],
    ]);
    await recomputeSeasonStandings(h.db, "RV2", "deathmatch");
    expect(await table("RV2")).toEqual([]);
    expect(await ledgerAudit("RV2")).toEqual([]);
  });

  it("V3 · nothing_to_revert ≠ already_reverted: práctica, inexistente, no terminada, técnica", async () => {
    const [a, b] = await createBots(h.db, 2, "v3");
    const t = await tournament({ season: "RV3", bots: [a, b] });
    const m = await match(t, a.botId, b.botId, { state: "running" });
    const practice = await game(t, m, a, b, 1, "home", { official: false });
    const running = await game(t, m, a, b, 2, "home", { status: "running" });
    const tech = await game(t, m, a, b, 3, "technical");
    expect(await revertOfficialBattle(h.db, practice)).toBe("nothing_to_revert");
    expect(await revertOfficialBattle(h.db, running)).toBe("nothing_to_revert");
    expect(await revertOfficialBattle(h.db, tech)).toBe("nothing_to_revert");
    expect(await revertOfficialBattle(h.db, "00000000-0000-4000-8000-000000000000")).toBe("nothing_to_revert");
    const marked = await h.db("battles").whereIn("id", [practice, running, tech]).whereNotNull("reverted_at");
    expect(marked).toHaveLength(0);
  });

  it("V4 · DURANTE: reversión y job de Elo simultáneos (30 rondas, en ambos órdenes) ⇒ nunca queda Elo vivo", async () => {
    const bad: string[] = [];
    for (let i = 0; i < 30; i++) {
      const season = `RV4-${i}`;
      const [a, b] = await createBots(h.db, 2, `v4${i}`);
      const t = await tournament({ season, bots: [a, b] });
      const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
      const ops = [() => revertOfficialBattle(h.db, bid), () => update(t, bid), () => applyBattleRating(h.db, bid)];
      const res = await Promise.allSettled(i % 2 ? ops.map((f) => f()) : ops.reverse().map((f) => f()));
      for (const r of res) if (r.status === "rejected") bad.push(`${season}: ${String(r.reason)}`);
      const live = await h.db("rating_events").where({ battle_id: bid, reverted: false });
      if (live.length) bad.push(`${season}: ${live.length} eventos vivos tras revertir`);
      await recomputeSeasonStandings(h.db, season, "deathmatch");
      if ((await table(season)).length) bad.push(`${season}: aparece en standings`);
      bad.push(...(await ledgerAudit(season)));
    }
    expect(bad).toEqual([]);
  });

  it("V5 · doble reversión SIMULTÁNEA: exactamente una 'reverted' y la otra 'already_reverted'", async () => {
    for (let i = 0; i < 10; i++) {
      const [a, b] = await createBots(h.db, 2, `v5${i}`);
      const t = await tournament({ season: `RV5-${i}`, bots: [a, b] });
      const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home", { rate: true });
      const out = await Promise.all([revertOfficialBattle(h.db, bid), revertOfficialBattle(h.db, bid)]);
      expect(out.sort()).toEqual(["already_reverted", "reverted"]);
      expect(await ledgerAudit(`RV5-${i}`)).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ H3 · concurrencia

describe("[R2 #229] H3 · concurrencia del Elo", () => {
  it("C1 · 8 Elo simultáneos del MISMO bot, 15 rondas: ledger, cadena y W/L/D cuadran", async () => {
    const bad: string[] = [];
    for (let round = 0; round < 15; round++) {
      const season = `C1-${round}`;
      const bots = await createBots(h.db, 9, `rc1${round}`);
      const [x, ...opp] = bots;
      const t = await tournament({ season, bots });
      const ids: string[] = [];
      for (let i = 0; i < opp.length; i++)
        ids.push(
          await game(
            t,
            await match(t, x.botId, opp[i].botId),
            x,
            opp[i],
            1,
            i % 3 === 0 ? "draw" : i % 3 === 1 ? "home" : "away",
          ),
        );
      const res = await Promise.allSettled(ids.map((id) => update(t, id)));
      for (const r of res) if (r.status === "rejected") bad.push(`${season}: ${String(r.reason)}`);
      bad.push(...(await ledgerAudit(season)));
      const xr = await h.db("ratings").where({ season_id: season, bot_id: x.botId }).first();
      if (xr.wins + xr.losses + xr.draws !== 8) bad.push(`${season}: x con ${xr.wins + xr.losses + xr.draws} partidas`);
    }
    expect(bad).toEqual([]);
  });

  it("C2 · Elo + reversión mezclados (otras batallas y la misma), dos torneos de la misma temporada, 15 rondas", async () => {
    const bad: string[] = [];
    for (let round = 0; round < 15; round++) {
      const season = `C2-${round}`;
      const bots = await createBots(h.db, 5, `rc2${round}`);
      const t1 = await tournament({ season, bots });
      const t2 = await tournament({ season, bots });
      const pre: [string, string][] = [];
      const fresh: [string, string][] = [];
      for (let i = 0; i < 10; i++) {
        const t = i % 2 ? t1 : t2;
        const a = bots[i % 5];
        const b = bots[(i + 1 + (i % 3)) % 5];
        const id = await game(t, await match(t, a.botId, b.botId), a, b, 1, i % 3 === 0 ? "draw" : "home");
        if (i < 5) {
          await applyBattleRating(h.db, id);
          pre.push([t, id]);
        } else fresh.push([t, id]);
      }
      const toRevert = [pre[0], pre[2], fresh[0]]; // dos puntuadas y una sin puntuar
      const ops: Promise<unknown>[] = [
        ...fresh.map(([t, id]) => update(t, id)),
        ...toRevert.map(([, id]) => revertOfficialBattle(h.db, id)),
        update(t1, pre[2][1]), // reintento del job de una batalla que se está revirtiendo
        recomputeSeasonStandings(h.db, season, "deathmatch"),
        update(t2),
      ];
      const res = await Promise.allSettled(ops);
      for (const r of res) if (r.status === "rejected") bad.push(`${season}: ${String(r.reason)}`);
      await recomputeSeasonStandings(h.db, season, "deathmatch");
      bad.push(...(await ledgerAudit(season)));
      for (const [, id] of toRevert) {
        const live = await h.db("rating_events").where({ battle_id: id, reverted: false });
        if (live.length) bad.push(`${season}: revertida ${id} con Elo vivo`);
      }
      // Todas las no revertidas tienen Elo exactamente una vez.
      for (const [, id] of [...pre, ...fresh].filter((p) => !toRevert.includes(p))) {
        const n = (await h.db("rating_events").where({ battle_id: id, reverted: false })).length;
        if (n !== 2) bad.push(`${season}: ${id} con ${n} eventos vivos`);
      }
      // V-D-E de standings = eventos vivos.
      const rows = await table(season);
      for (const r of rows) {
        const rt = await h.db("ratings").where({ season_id: season, bot_id: r.id }).first();
        if (rt.wins !== r.w || rt.losses !== r.l || rt.draws !== r.d)
          bad.push(`${season}: V-D-E ${r.w}-${r.l}-${r.d} ≠ ratings ${rt.wins}-${rt.losses}-${rt.draws}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ------------------------------------------------------------------ H4 / H5 / política

describe("[R2 #229] política por estado del torneo", () => {
  it("H4 · eliminatoria en juego 1-1 (bo3): empate, no victoria por seed; cerrada 1-1: decide el seed", async () => {
    const [a, b, c, d] = await createBots(h.db, 4, "h4");
    const t = await tournament({ season: "H4", format: "single_elimination", bots: [a, b, c, d] });
    const open = await match(t, a.botId, b.botId, { bracket: "winners", state: "running" });
    await game(t, open, a, b, 1, "home");
    await game(t, open, a, b, 2, "away");
    await game(t, open, a, b, 3, "home", { status: "scheduled" });
    const closed = await match(t, c.botId, d.botId, { bracket: "winners", winner: c.botId });
    await game(t, closed, c, d, 1, "home");
    await game(t, closed, c, d, 2, "away");
    await update(t);
    const rows = await table("H4");
    expect(vde(rows, a)).toEqual([0, 0, 1]);
    expect(vde(rows, b)).toEqual([0, 0, 1]);
    expect(vde(rows, c)).toEqual([1, 0, 0]);
    expect(vde(rows, d)).toEqual([0, 1, 0]);
  });

  it("H5 · draft: ni Elo ni clasificación; open sin batallas: nadie a 0-0-0", async () => {
    const [a, b, c] = await createBots(h.db, 3, "h5");
    const t = await tournament({ season: "H5", state: "draft", bots: [a, b] });
    const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    await update(t, bid);
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await h.db("ratings").where({ season_id: "H5" })).toHaveLength(0);
    expect(await table("H5")).toEqual([]);
    const t2 = await tournament({ season: "H5", state: "open", bots: [a, b, c] });
    await update(t2);
    expect(await table("H5")).toEqual([]);
  });

  it("CN · cancelled: cuenta lo jugado, no lo revertido", async () => {
    const [a, b, c] = await createBots(h.db, 3, "cn");
    const t = await tournament({ season: "CN", bots: [a, b, c] });
    const keep = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    const rev = await game(t, await match(t, c.botId, a.botId), c, a, 1, "home");
    await update(t, keep);
    await update(t, rev);
    await h.db("tournaments").where({ id: t }).update({ state: "cancelled" });
    expect(await revertOfficialBattle(h.db, rev)).toBe("reverted");
    const rows = await table("CN");
    expect(vde(rows, a)).toEqual([1, 0, 0]);
    expect(vde(rows, b)).toEqual([0, 1, 0]);
    expect(vde(rows, c)).toBeNull();
    expect(await ledgerAudit("CN")).toEqual([]);
  });
});
