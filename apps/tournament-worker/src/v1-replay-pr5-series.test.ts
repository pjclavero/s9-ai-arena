/**
 * V1 REPLAYS · PR-5 · revisión de #346 · un `recording_limit` NO decide enfrentamientos de torneo.
 *
 * S1..S5  una serie en la que NINGÚN juego tiene resultado deportivo se cierra por la rama «sin resultado» (match
 *         `failed`): sin ganador, sin campeón, sin punto de empate. Eliminatoria simple (final), doble eliminación,
 *         suizo, liga y round robin, con PG real y la batalla cerrada exactamente como la deja `finishBattle`.
 * S6      el control de una serie mixta (juego real + `recording_limit`): se resuelve con el real.
 * S7      P1-2 · el desempate (`scoreDiff`) excluye la puntuación parcial de un juego truncado (serie mixta).
 * S8      P2-1 · `storage_unavailable` tiene política de reintento propia: 5 fallos, esperas 1/2/5/10 min.
 * S9      P2-2 · el PATCH rechaza claves `replays.*` incoherentes entre sí.
 * S10     P2-3/P3 · un truncado no se anuncia como reproducible y su descarga/verify lo dicen.
 * Mutantes: apps/replay-service/scripts/replay-pr5-mutants.mjs (M-SERIES-*, M-RETRY-*, M-CROSS-*, M-TRUNC-*).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { handleGenerateSchedule } from "./scheduler.js";
import { handleProcessResult, isTechnicalLimit, leagueTable, settleFailedBattle, swissStandings } from "./results.js";
import type { JobRow } from "./queue.js";
import { createPublishedBot } from "./testing/fixtures.js";
import { replayCrossErrors } from "../../../packages/system-settings/replay-settings.js";
import { RETRY_POLICY, STORAGE_BACKOFF_MS, retryPolicyFor } from "./errors.js";

type Row = Record<string, any>;
let h: TestDbHandle;
let app: Express;
let organizer: string;
let admin: string;
let n = 0;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  admin = await tokenFor(h.db, DEV_USERS.admin);
}, 180_000);
afterAll(async () => {
  await h.stop();
});

async function tournament(format: string, nBots: number, rounds = 1) {
  const bots = [];
  for (let i = 0; i < nBots; i++) bots.push(await createPublishedBot(h.db, `pr5s-${++n}`));
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({ name: `pr5s-${n}`, format, mode: "deathmatch", rulesetId: "mvp-default", roundsPerPairing: rounds });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const tid = t.body.id as string;
  for (const b of bots) {
    await h.db("entries").insert({
      tournament_id: tid,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
  }
  const close = await request(app)
    .post(`/tournaments/${tid}/actions/close-entries`)
    .set("Authorization", `Bearer ${organizer}`);
  expect(close.status, JSON.stringify(close.body)).toBe(200);
  const gen = await h
    .db("jobs")
    .where({ dedupe_key: `generate_schedule:${tid}` })
    .first();
  await handleGenerateSchedule(gen as JobRow, { db: h.db, workerId: "pr5s" });
  return { tid, bots: bots.map((b) => b.botId) };
}

/** Cierra una batalla EXACTAMENTE como `finishBattle` cierra un final sin ganador (winner null, outcome NULL). */
async function finishAs(battleId: string, endReason: string, winner: string | null, score: Record<string, number>) {
  await h
    .db("battles")
    .where({ id: battleId })
    .update({
      status: "finished",
      failure_kind: "none",
      finished_at: h.db.fn.now(),
      result: JSON.stringify({
        schema: "battle-result/v1",
        winner,
        ticks: 100,
        score,
        disqualified: [],
        endReason,
        agents: "scripted",
      }),
    });
  if (winner === null) await h.db("participants").where({ battle_id: battleId }).update({ outcome: null });
  await handleProcessResult({ payload: { battleId } } as unknown as JobRow, { db: h.db, workerId: "pr5s" } as never);
}

/** Juega TODO el torneo con el mismo final sin resultado, ronda a ronda, hasta que no quedan batallas programadas. */
async function playAll(tid: string, endReason = "recording_limit"): Promise<number> {
  let played = 0;
  for (let i = 0; i < 20; i++) {
    const open = (await h.db("battles").where({ tournament_id: tid, status: "scheduled" })) as Row[];
    if (open.length === 0) break;
    for (const b of open) {
      await finishAs(b.id, endReason, null, { A: 3, B: 0 });
      played++;
    }
  }
  return played;
}

const matchesOf = (tid: string) => h.db("matches").where({ tournament_id: tid }) as Promise<Row[]>;
const tournamentOf = async (tid: string) => (await h.db("tournaments").where({ id: tid }).first()) as Row;

describe("PR-5 · P1-1 · una serie sin resultado deportivo no decide nada", () => {
  it("S1 eliminatoria simple: la final recording_limit queda `failed`, sin ganador ni campeón (la API no publica ganador)", async () => {
    const { tid } = await tournament("single_elimination", 2);
    const b = (await h.db("battles").where({ tournament_id: tid }).first()) as Row;
    await finishAs(b.id, "recording_limit", null, { A: 3, B: 0 });
    const [m] = await matchesOf(tid);
    expect(m.state).toBe("failed");
    const t = await tournamentOf(tid);
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeNull();
    const api = await request(app).get(`/tournaments/${tid}/matches`);
    const item = api.body.items?.[0] ?? api.body.matches?.[0] ?? api.body[0];
    expect(item.winnerBotId).toBeNull();
    expect(item.state).toBe("failed");
  });

  it("S1b eliminatoria simple de 4: ninguna ronda avanza por «ganar» y el torneo termina sin campeón", async () => {
    const { tid } = await tournament("single_elimination", 4);
    await playAll(tid);
    const ms = await matchesOf(tid);
    const isBye = (m: Row) => JSON.stringify(m.pairing).includes('"bye":true');
    expect(ms.filter((m) => !isBye(m)).every((m) => m.state === "failed")).toBe(true);
    const t = await tournamentOf(tid);
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeNull();
  });

  it("S2 doble eliminación: todo recording_limit, sin campeón y ningún match con ganador por el juego", async () => {
    const { tid } = await tournament("double_elimination", 4);
    await playAll(tid);
    const ms = await matchesOf(tid);
    // (la final de reinicio condicional GF2 no se juega si no hace falta: se cierra sin batallas)
    const real = ms.filter(
      (m) => !JSON.stringify(m.pairing).includes('"bye":true') && !JSON.stringify(m.pairing).includes("conditionalOn"),
    );
    expect(real.length).toBeGreaterThan(0);
    expect(
      real.some((m) => m.state === "finished"),
      JSON.stringify(real.map((m) => [m.slot, m.state, m.pairing])),
    ).toBe(false);
    expect(real.some((m) => m.state === "failed")).toBe(true);
    const t = await tournamentOf(tid);
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeNull();
  });

  it("S3 suizo: una ronda entera recording_limit NO da un punto de empate a nadie", async () => {
    const { tid } = await tournament("swiss", 4);
    const bs = (await h.db("battles").where({ tournament_id: tid })) as Row[];
    for (const b of bs) await finishAs(b.id, "recording_limit", null, { A: 0, B: 0 });
    const s = await swissStandings(h.db, tid);
    expect(s.standings.map((x) => x.points)).toEqual([0, 0, 0, 0]);
    const round1 = (await matchesOf(tid)).filter((m) => m.round === 1);
    expect(round1.length).toBe(2);
    expect(round1.every((m) => m.state === "failed")).toBe(true);
  });

  it.each(["league", "round_robin"] as const)(
    "S4 %s: todo recording_limit ⇒ nadie puntúa, ni V-D-E ni empate, y no hay campeón",
    async (format) => {
      const { tid } = await tournament(format, 3);
      await playAll(tid);
      const table = await leagueTable(h.db, tid, false);
      for (const r of table) {
        expect([r.points, r.wins, r.losses, r.draws, r.scoreDiff]).toEqual([0, 0, 0, 0, 0]);
        expect(r.technical).toBeGreaterThan(0);
      }
      const real = (await matchesOf(tid)).filter((m) => !JSON.stringify(m.pairing).includes('"bye":true'));
      expect(real.length).toBeGreaterThan(0);
      expect(real.every((m) => m.state === "failed")).toBe(true);
      const t = await tournamentOf(tid);
      expect(t.state).toBe("finished");
      expect(t.champion_bot_id).toBeNull();
    },
  );

  it("S5 mezcla failed + recording_limit en una serie: también «sin resultado»", async () => {
    const { tid } = await tournament("single_elimination", 2, 2);
    const bs = (await h.db("battles").where({ tournament_id: tid }).orderBy("game_index")) as Row[];
    expect(bs.length).toBe(2);
    await h.db("battles").where({ id: bs[0].id }).update({ status: "failed", failure_kind: "infrastructure" });
    await finishAs(bs[1].id, "recording_limit", null, { A: 5, B: 0 });
    const [m] = await matchesOf(tid);
    expect(m.state).toBe("failed");
    expect((await tournamentOf(tid)).champion_bot_id).toBeNull();
  });

  it("S6 control: una serie con un juego REAL sí se resuelve (el truncado no cuenta, el real decide)", async () => {
    const { tid } = await tournament("single_elimination", 2, 2);
    const bs = (await h.db("battles").where({ tournament_id: tid }).orderBy("game_index")) as Row[];
    await finishAs(bs[0].id, "completed", "A", { A: 2, B: 0 }); // juego 1: home = equipo A
    await finishAs(bs[1].id, "recording_limit", null, { A: 0, B: 9 });
    const [m] = await matchesOf(tid);
    expect(m.state).toBe("finished");
    expect(m.winner_bot_id).not.toBeNull();
    expect((await tournamentOf(tid)).champion_bot_id).toBe(m.winner_bot_id);
  });
});

/** Invariante: ningún match `finished` con ganador, con los dos lados y sin bye, que no tenga una batalla CON resultado deportivo. */
async function expectNoWinnerWithoutBattles(tid: string) {
  const ms = await matchesOf(tid);
  for (const m of ms) {
    const pr = typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing;
    if (m.state !== "finished" || !m.winner_bot_id || pr.bye || !pr.home || !pr.away) continue;
    const bs = (await h.db("battles").where({ match_id: m.id, status: "finished" })) as Row[];
    const real = bs.filter((b) => {
      const r = typeof b.result === "string" ? JSON.parse(b.result) : b.result;
      return !isTechnicalLimit(r);
    });
    expect(real.length, `match ${m.slot} finished con ganador y 0 batallas con resultado`).toBeGreaterThan(0);
  }
}

/** Doble eliminación: todo real (gana el lado A) salvo la GRAN FINAL, que termina `gfMode`. */
async function playDoubleElimGfWithout(tid: string, gfMode: "recording_limit" | "failed") {
  for (let i = 0; i < 20; i++) {
    const open = (await h.db("battles").where({ tournament_id: tid, status: "scheduled" })) as Row[];
    if (open.length === 0) break;
    for (const b of open) {
      const m = (await h.db("matches").where({ id: b.match_id }).first()) as Row;
      if (m.slot === "GF") {
        if (gfMode === "failed") {
          await h.db("battles").where({ id: b.id }).update({ status: "failed", failure_kind: "infrastructure" });
          await settleFailedBattle(h.db, b.id);
        } else await finishAs(b.id, "recording_limit", null, { A: 3, B: 0 });
      } else await finishAs(b.id, "completed", "A", { A: 3, B: 0 });
    }
  }
}

describe("PR-5 · P1-R1 · la gran final sin resultado no corona (GF2 no es una formalidad)", () => {
  it.each([
    ["P-D 2 bots, GF recording_limit", 2, "recording_limit"],
    ["P-D4 4 bots, GF recording_limit", 4, "recording_limit"],
    ["P-D4f 4 bots, GF failed", 4, "failed"],
    ["P-D2f 2 bots, GF failed", 2, "failed"],
  ] as const)("S10 %s: GF2 se cierra sin resultado, sin batallas, y no hay campeón", async (_n, bots, gfMode) => {
    const { tid } = await tournament("double_elimination", bots);
    await playDoubleElimGfWithout(tid, gfMode);
    const ms = await matchesOf(tid);
    const gf = ms.find((m) => m.slot === "GF")!;
    const gf2 = ms.find((m) => m.slot === "GF2")!;
    expect(gf.state).toBe("failed");
    expect(gf2.state).toBe("failed");
    expect(gf2.winner_bot_id).toBeNull();
    expect(await h.db("battles").where({ match_id: gf2.id })).toHaveLength(0);
    const t = await tournamentOf(tid);
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeNull();
    await expectNoWinnerWithoutBattles(tid);
  });

  it("S10b control: con la GF REAL ganada por el invicto, GF2 sí es una formalidad (finished, ganador, sin batallas) y corona", async () => {
    const { tid } = await tournament("double_elimination", 2);
    for (let i = 0; i < 20; i++) {
      const open = (await h.db("battles").where({ tournament_id: tid, status: "scheduled" })) as Row[];
      if (open.length === 0) break;
      for (const b of open) await finishAs(b.id, "completed", "A", { A: 3, B: 0 });
    }
    const gf2 = (await matchesOf(tid)).find((m) => m.slot === "GF2")!;
    expect(gf2.state).toBe("finished");
    expect(gf2.winner_bot_id).not.toBeNull();
    expect((await tournamentOf(tid)).champion_bot_id).toBe(gf2.winner_bot_id);
  });

  it("S10c el invariante se cumple en los casos «todo sin resultado»", async () => {
    for (const f of ["single_elimination", "double_elimination", "round_robin"] as const) {
      const { tid } = await tournament(f, 4);
      await playAll(tid);
      await expectNoWinnerWithoutBattles(tid);
    }
  });
});

describe("PR-5 · P1-2 · el desempate excluye la puntuación parcial", () => {
  it("S7 serie mixta (empate real 1-1 + recording_limit 0-7): empate en V-D-E y scoreDiff 0", async () => {
    const { tid } = await tournament("round_robin", 2, 2);
    const bs = (await h.db("battles").where({ tournament_id: tid }).orderBy("game_index")) as Row[];
    await finishAs(bs[0].id, "completed", "draw", { A: 1, B: 1 });
    await finishAs(bs[1].id, "recording_limit", null, { A: 0, B: 7 });
    const table = await leagueTable(h.db, tid, false);
    for (const r of table) {
      expect(r.draws).toBe(1);
      expect(r.points).toBe(1);
      expect(r.scoreDiff).toBe(0);
    }
  });
});

describe("PR-5 · P2-1 · política de reintentos de storage_unavailable", () => {
  it("S8 5 fallos con esperas de 1, 2, 5 y 10 min (propia, no la de 2 s/4 s del defecto)", () => {
    const p = RETRY_POLICY.storage_unavailable!;
    expect(p).toBeDefined();
    expect(retryPolicyFor("storage_unavailable")).toBe(p);
    expect(p.maxFailures).toBe(5);
    expect(p.overridesJobMax).toBe(true);
    expect([1, 2, 3, 4].map((f) => p.backoffMs(f))).toEqual([60_000, 120_000, 300_000, 600_000]);
    expect(STORAGE_BACKOFF_MS).toEqual([60_000, 120_000, 300_000, 600_000]);
    // más allá de la tabla, se queda en el último valor
    expect(p.backoffMs(9)).toBe(600_000);
    // y el defecto de otra clase sigue siendo de segundos
    expect(retryPolicyFor("map_unavailable").backoffMs(1)).toBeLessThan(10_000);
  });
});

describe("PR-5 · P2-2 · coherencia entre claves replays.*", () => {
  const GiB = 1024 ** 3;
  const patch = (changes: unknown) =>
    request(app)
      .patch("/admin/settings")
      .set("Authorization", `Bearer ${admin}`)
      .send({ changes } as object);

  it("S9 el PATCH rechaza reserva ≥ cuota y tope por batalla > cuota/4, con un error claro; lo coherente pasa", async () => {
    await h.db("system_settings").delete();
    const MiB = 1024 ** 2;
    // reserva (5 GiB por defecto) ≥ cuota nueva (1 GiB): rechazado aunque sólo se toque la cuota
    let r = await patch([{ key: "replays.quota.max_bytes", value: 1 * GiB, expectedVersion: 0 }]);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/min_free_bytes.*menor que.*max_bytes/);
    // cuota 1 GiB con tope 512 MiB (> cuota/4 = 256 MiB): rechazado (P3-R1)
    r = await patch([
      { key: "replays.quota.min_free_bytes", value: 512 * MiB, expectedVersion: 0 },
      { key: "replays.quota.max_bytes", value: 1 * GiB, expectedVersion: 0 },
      { key: "replays.limits.max_bytes_per_battle", value: 512 * MiB, expectedVersion: 0 },
    ]);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/un cuarto de/);
    // coherente: tope 256 MiB = cuota/4
    r = await patch([
      { key: "replays.quota.min_free_bytes", value: 512 * MiB, expectedVersion: 0 },
      { key: "replays.quota.max_bytes", value: 1 * GiB, expectedVersion: 0 },
      { key: "replays.limits.max_bytes_per_battle", value: 256 * MiB, expectedVersion: 0 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // subir la reserva hasta la cuota: rechazado, y nada de lo rechazado se guardó
    r = await patch([{ key: "replays.quota.min_free_bytes", value: 1 * GiB, expectedVersion: 1 }]);
    expect(r.status).toBe(400);
    const rows = await h.db("system_settings").select("key", "value");
    expect(Object.fromEntries(rows.map((x: Row) => [x.key, x.value]))).toEqual({
      "replays.quota.min_free_bytes": 512 * MiB,
      "replays.quota.max_bytes": 1 * GiB,
      "replays.limits.max_bytes_per_battle": 256 * MiB,
    });
    await h.db("system_settings").delete();
  });

  it("S9c dos PATCH concurrentes sobre claves distintas, coherentes por separado e incoherentes juntos: nunca los dos (P3-R2)", async () => {
    const MiB = 1024 ** 2;
    for (let round = 0; round < 6; round++) {
      await h.db("system_settings").delete();
      const r = await patch([
        { key: "replays.quota.min_free_bytes", value: 512 * MiB, expectedVersion: 0 },
        { key: "replays.quota.max_bytes", value: 4 * GiB, expectedVersion: 0 },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const [x, y] = await Promise.all([
        patch([{ key: "replays.quota.max_bytes", value: 1 * GiB, expectedVersion: 1 }]), // por sí sola: 64 MiB <= 256 MiB
        patch([{ key: "replays.limits.max_bytes_per_battle", value: 512 * MiB, expectedVersion: 0 }]), // por sí sola: <= 1 GiB
      ]);
      expect([x.status, y.status].sort(), `ronda ${round}`).toEqual([200, 400]);
      const rows = await h.db("system_settings").select("key", "value");
      const v = Object.fromEntries(rows.map((q: Row) => [q.key, q.value]));
      const quota = Number(v["replays.quota.max_bytes"] ?? 20 * GiB);
      const per = Number(v["replays.limits.max_bytes_per_battle"] ?? 64 * MiB);
      expect(per).toBeLessThanOrEqual(quota / 4);
    }
    await h.db("system_settings").delete();
  });

  it("S9b la regla «tope por batalla ≤ cuota/4» y «reserva < cuota»", () => {
    expect(replayCrossErrors({ quotaMaxBytes: 4 * GiB, minFreeBytes: 1 * GiB, maxBytesPerBattle: 1 * GiB })).toEqual(
      [],
    );
    expect(
      replayCrossErrors({ quotaMaxBytes: 4 * GiB, minFreeBytes: 1 * GiB, maxBytesPerBattle: 1 * GiB + 1 }),
    ).toEqual([expect.stringMatching(/max_bytes_per_battle.*un cuarto de/)]);
    expect(replayCrossErrors({ quotaMaxBytes: 2 * GiB, minFreeBytes: 2 * GiB, maxBytesPerBattle: 1 })).toEqual([
      expect.stringMatching(/min_free_bytes.*menor que/),
    ]);
  });
});
