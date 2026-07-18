/**
 * E9 · T9.3 — DoD de ratings:
 *  - Propiedad de suma: en un sistema cerrado la suma de Elo se conserva.
 *  - Idempotencia: reprocesar una batalla no aplica el rating dos veces.
 *  - Una batalla anulada por fallo técnico revierte su efecto.
 *  - El historial permite reconstruir el rating de cualquier bot en cualquier
 *    fecha (replay del libro mayor).
 *  Además: las batallas NO oficiales no afectan; temporadas y modos separados.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import {
  applyBattleRating,
  EloSystem,
  expectedScore,
  ratingAt,
  ratingHistory,
  revertBattleRating,
  INITIAL_RATING,
  type RatedSide,
} from "./ratings.js";
import { createBots, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "r");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

/** Batalla terminada directa en BD (los caminos E2/worker ya se prueban en el E2E). */
async function finishedBattle(
  a: TestBot,
  b: TestBot,
  opts: { winner?: "A" | "B" | "draw"; official?: boolean; tournamentId?: string; mode?: string } = {},
): Promise<string> {
  const winner = opts.winner ?? "A";
  const [battle] = await h
    .db("battles")
    .insert({
      tournament_id: opts.tournamentId ?? null,
      status: "finished",
      official: opts.official ?? true,
      mode: opts.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "s",
      result: JSON.stringify({
        winner,
        score: winner === "draw" ? { A: 1, B: 1 } : { A: winner === "A" ? 1 : 0, B: winner === "B" ? 1 : 0 },
      }),
    })
    .returning("id");
  const out = (team: "A" | "B") => (winner === "draw" ? "draw" : winner === team ? "win" : "loss");
  await h.db("participants").insert([
    { battle_id: battle.id, bot_id: a.botId, version: a.version, team: "A", outcome: out("A") },
    { battle_id: battle.id, bot_id: b.botId, version: b.version, team: "B", outcome: out("B") },
  ]);
  return battle.id as string;
}

async function ratingOf(botId: string, seasonId = "season-1", mode = "deathmatch"): Promise<number> {
  const r = await h.db("ratings").where({ bot_id: botId, season_id: seasonId, mode }).first();
  return (r?.rating as number) ?? INITIAL_RATING;
}

describe("T9.3 · núcleo Elo puro", () => {
  it("expectedScore es la curva logística estándar", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1400, 1000)).toBeCloseTo(1 / (1 + 10 ** -1), 10);
  });

  it("DoD · propiedad de suma: los deltas suman EXACTAMENTE cero (1v1 y por equipos)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            rating: fc.integer({ min: 400, max: 2800 }),
            team: fc.constantFrom("A", "B", "C"),
            score: fc.constantFrom(0, 0.5, 1),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        fc.integer({ min: 8, max: 64 }),
        (raw, k) => {
          const sides: RatedSide[] = raw.map((r, i) => ({ botId: `b${i}`, ...r }));
          const deltas = EloSystem.deltas(sides, k);
          const sum = [...deltas.values()].reduce((acc, d) => acc + d, 0);
          expect(Math.abs(sum)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("el que gana sube y el que pierde baja lo mismo (K configurable por liga)", () => {
    const deltas = EloSystem.deltas(
      [
        { botId: "a", team: "A", rating: 1000, score: 1 },
        { botId: "b", team: "B", rating: 1000, score: 0 },
      ],
      32,
    );
    expect(deltas.get("a")).toBeCloseTo(16, 10); // 32 · (1 − 0.5)
    expect(deltas.get("b")).toBeCloseTo(-16, 10);
  });
});

describe("T9.3 · pipeline sobre la BD (libro mayor)", () => {
  it("DoD · suma conservada en un sistema cerrado de 4 bots tras varias batallas", async () => {
    const before =
      (await ratingOf(bots[0].botId)) +
      (await ratingOf(bots[1].botId)) +
      (await ratingOf(bots[2].botId)) +
      (await ratingOf(bots[3].botId));
    await applyBattleRating(h.db, await finishedBattle(bots[0], bots[1], { winner: "A" }));
    await applyBattleRating(h.db, await finishedBattle(bots[2], bots[3], { winner: "B" }));
    await applyBattleRating(h.db, await finishedBattle(bots[0], bots[2], { winner: "draw" }));
    const after =
      (await ratingOf(bots[0].botId)) +
      (await ratingOf(bots[1].botId)) +
      (await ratingOf(bots[2].botId)) +
      (await ratingOf(bots[3].botId));
    expect(after).toBeCloseTo(before, 6);
  });

  it("DoD · idempotencia: reprocesar la batalla no puntúa dos veces", async () => {
    const battleId = await finishedBattle(bots[0], bots[1], { winner: "A" });
    const first = await applyBattleRating(h.db, battleId);
    const ratingAfterFirst = await ratingOf(bots[0].botId);
    const second = await applyBattleRating(h.db, battleId); // reprocesado
    expect(first).toBe(true);
    expect(second).toBe(false); // no-op
    expect(await ratingOf(bots[0].botId)).toBe(ratingAfterFirst);
    const events = await h.db("rating_events").where({ battle_id: battleId });
    expect(events.length).toBe(2); // un evento por bot, una sola vez
  });

  it("DoD · una batalla anulada por fallo técnico revierte su efecto", async () => {
    const before0 = await ratingOf(bots[0].botId);
    const before1 = await ratingOf(bots[1].botId);
    const battleId = await finishedBattle(bots[0], bots[1], { winner: "A" });
    await applyBattleRating(h.db, battleId);
    expect(await ratingOf(bots[0].botId)).toBeGreaterThan(before0);

    // Anulación (p. ej. se descubre fallo de infraestructura): reversión.
    await h.db("battles").where({ id: battleId }).update({ status: "failed", failure_kind: "infrastructure" });
    expect(await revertBattleRating(h.db, battleId)).toBe(true);
    expect(await ratingOf(bots[0].botId)).toBeCloseTo(before0, 9);
    expect(await ratingOf(bots[1].botId)).toBeCloseTo(before1, 9);
    // Reversión idempotente y trazada en el libro mayor.
    expect(await revertBattleRating(h.db, battleId)).toBe(false);
    const history = await ratingHistory(h.db, bots[0].botId, "season-1", "deathmatch");
    expect(history.find((e) => e.battleId === battleId)?.reverted).toBe(true);
  });

  it("las batallas NO oficiales (práctica privada) no afectan al rating", async () => {
    const before = await ratingOf(bots[2].botId);
    const battleId = await finishedBattle(bots[2], bots[3], { winner: "A", official: false });
    expect(await applyBattleRating(h.db, battleId)).toBe(false);
    expect(await ratingOf(bots[2].botId)).toBe(before);
    expect(await h.db("rating_events").where({ battle_id: battleId })).toEqual([]);
  });

  it("ratings separados por temporada y por modo de juego", async () => {
    // Torneo de otra temporada y con K propio de liga (ADR-E9-002).
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "liga-2027",
        format: "league",
        mode: "team_deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "running",
        season_id: "season-2027",
        elo_k: 40,
      })
      .returning("id");
    const battleId = await finishedBattle(bots[0], bots[1], {
      winner: "A",
      tournamentId: t.id as string,
      mode: "team_deathmatch",
    });
    await applyBattleRating(h.db, battleId);

    // La temporada/modo nuevos arrancan de 1000 y aplican K=40 (delta ±20).
    expect(await ratingOf(bots[0].botId, "season-2027", "team_deathmatch")).toBeCloseTo(1020, 6);
    // …y no contaminan la temporada season-1/deathmatch.
    const e = await h.db("rating_events").where({ battle_id: battleId }).first();
    expect(e.season_id).toBe("season-2027");
    expect(Number(e.k)).toBe(40);
  });

  it("DoD · el historial reconstruye el rating de cualquier bot en cualquier fecha", async () => {
    // Serie de batallas con fechas controladas en el libro mayor.
    const b1 = await finishedBattle(bots[3], bots[2], { winner: "A" });
    await applyBattleRating(h.db, b1);
    const b2 = await finishedBattle(bots[3], bots[0], { winner: "B" });
    await applyBattleRating(h.db, b2);
    const b3 = await finishedBattle(bots[3], bots[1], { winner: "draw" });
    await applyBattleRating(h.db, b3);

    const t1 = new Date("2026-01-10T00:00:00Z");
    const t2 = new Date("2026-02-10T00:00:00Z");
    const t3 = new Date("2026-03-10T00:00:00Z");
    await h.db("rating_events").where({ battle_id: b1 }).update({ created_at: t1 });
    await h.db("rating_events").where({ battle_id: b2 }).update({ created_at: t2 });
    await h.db("rating_events").where({ battle_id: b3 }).update({ created_at: t3 });

    const bot = bots[3].botId;
    const events = await ratingHistory(h.db, bot, "season-1", "deathmatch");
    const upTo = (d: Date) =>
      INITIAL_RATING +
      events
        .filter((e) => !e.reverted && e.at <= d && [b1, b2, b3].includes(e.battleId as string))
        .reduce((acc, e) => acc + e.delta, 0);

    // Antes de la primera batalla: rating inicial.
    expect(await ratingAt(h.db, bot, "season-1", "deathmatch", new Date("2026-01-01T00:00:00Z"))).toBe(INITIAL_RATING);
    // En fechas intermedias, ratingAt == replay manual del libro mayor.
    for (const d of [t1, t2, t3]) {
      expect(await ratingAt(h.db, bot, "season-1", "deathmatch", d)).toBeCloseTo(upTo(d), 9);
    }
    // Y la última foto coincide con la tabla ratings materializada.
    expect(await ratingAt(h.db, bot, "season-1", "deathmatch", new Date())).toBeCloseTo(await ratingOf(bot), 9);
  });
});
