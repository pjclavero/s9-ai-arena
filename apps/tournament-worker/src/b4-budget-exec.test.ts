/**
 * V1 · B4 · D-OP-18 (c) · ÚLTIMA GARANTÍA del presupuesto del torneo en la ejecución. Un
 * participante que supera `budgetCredits` (con la revisión de loadout FIJADA en su inscripción)
 * no juega: descalificación administrativa explícita (walkover), sin tocar la versión ni el
 * histórico. Etiquetas B4_EXEC_* para scripts/budget-ammo-mutants.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { makeRunBattleHandler, type BattleContext, type BattleExecution } from "./battle-runner.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";
import { MAX_MODULE_COST_FRACTION } from "../../../packages/game-rules/index.js";

let h: TestDbHandle;
let bots: TestBot[]; // loadout de ejemplo: 900 créditos con la munición embebida

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 6, "b4x");
}, 120_000);
afterAll(async () => {
  await h.stop();
});

function scripted(log: string[]) {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    log.push(ctx.battle.id);
    return {
      winner: "A",
      ticks: 10,
      score: { A: 1, B: 0 },
      finalStateHash: "h",
      disqualified: [],
      versions: { engine: "test" },
    };
  };
}
const job = (battleId: string, id: string) =>
  ({ id, kind: "run_battle", payload: { battleId }, attempts: 1 }) as unknown as JobRow;
let n = 0;

async function tournamentWith(budget: number | null, a: TestBot, b: TestBot) {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `b4x-${++n}`,
      format: "round_robin",
      mode: "deathmatch",
      ruleset_id: "deathmatch-mvp",
      budget_credits: budget,
      state: "running",
    })
    .returning("id");
  for (const x of [a, b]) {
    await h.db("entries").insert({
      tournament_id: t.id,
      bot_id: x.botId,
      version: x.version,
      loadout_revision: x.loadoutRevision,
      frozen: true,
    });
  }
  return t.id as string;
}
const run = async (tournamentId: string | undefined, a: TestBot, b: TestBot) => {
  const id = await insertScheduledBattle(h.db, a, b, tournamentId ? { tournamentId } : {});
  const log: string[] = [];
  await makeRunBattleHandler({ executor: scripted(log) })(
    job(id, `00000000-0000-0000-0000-00000000b4${String(++n).padStart(2, "0")}`),
    {
      db: h.db,
      workerId: "B4",
    },
  );
  return { id, log };
};

describe("B4 · ejecución: presupuesto del torneo", () => {
  it("B4_EXEC_GUARD · un participante por encima del presupuesto no juega (walkover y DQ explícita)", async () => {
    const t = await tournamentWith(500, bots[0], bots[1]);
    const { id, log } = await run(t, bots[0], bots[1]);
    expect(log).toEqual([]);
    const row = await h.db("battles").where({ id }).first();
    expect(row.result.endReason).toBe("walkover");
    const dq = await h.db("participants").where({ battle_id: id }).orderBy("team");
    expect(dq.map((p: { outcome: string }) => p.outcome)).toEqual(["disqualified", "disqualified"]);
    const v = await h.db("bot_versions").where({ bot_id: bots[0].botId, version: 1 }).first();
    expect(v.state).toBe("published");
  });

  it("B4_EXEC_CONTROL · con presupuesto suficiente, o sin presupuesto propio, se lanza", async () => {
    const ok = await tournamentWith(900, bots[2], bots[3]);
    const r1 = await run(ok, bots[2], bots[3]);
    expect(r1.log).toEqual([r1.id]);
    const none = await tournamentWith(null, bots[2], bots[3]);
    const r2 = await run(none, bots[2], bots[3]);
    expect(r2.log).toEqual([r2.id]);
    const practice = await run(undefined, bots[2], bots[3]);
    expect(practice.log).toEqual([practice.id]);
  });

  it("B4_EXEC_PINNED · manda la revisión FIJADA en la inscripción, no la actual de la versión", async () => {
    // La versión apunta a la rev. 1 (900 cr) pero la inscripción fijó la rev. 2 (barata): con 880
    // de presupuesto juega. Con la revisión actual de la versión se descalificaría (control en B4_EXEC_GUARD).
    const cheap = {
      catalog_version: "mvp@1",
      chassis: "chassis.light@2",
      modules: JSON.stringify([{ slot: "drive", moduleId: "movement.wheels@1" }]),
    };
    for (const b of [bots[4], bots[5]]) await h.db("bot_loadouts").insert({ bot_id: b.botId, revision: 2, ...cheap });
    const a = { ...bots[4], loadoutRevision: 2 };
    const b = { ...bots[5], loadoutRevision: 2 };
    const t = await tournamentWith(880, a, b);
    const { id, log } = await run(t, a, b);
    expect(log).toEqual([id]);
  });

  it("B4_EXEC_IDEMPOTENT · repetir la comprobación da el mismo resultado y no escribe nada propio", async () => {
    const t = await tournamentWith(500, bots[0], bots[1]);
    const before = await h.db("entries").where({ tournament_id: t }).orderBy("bot_id");
    await run(t, bots[0], bots[1]);
    await run(t, bots[0], bots[1]);
    const after = await h.db("entries").where({ tournament_id: t }).orderBy("bot_id");
    expect(after).toEqual(before);
  });

  it("B4_EXEC_CAP · el worker aplica también el tope por pieza (aunque el total quepa)", async () => {
    // Chasis pesado (280) + orugas + generador: 485 cr de total, así que sólo decide el tope por pieza.
    const mini = {
      catalog_version: "mvp@1",
      chassis: "chassis.heavy@1",
      modules: JSON.stringify([
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@2" },
      ]),
    };
    const cap = await createBots(h.db, 4, "b4xc");
    for (const b of cap) await h.db("bot_loadouts").where({ bot_id: b.botId, revision: 1 }).update(mini);
    let min = 485;
    while (min * MAX_MODULE_COST_FRACTION < 280) min++;
    const over = await tournamentWith(min - 1, cap[0], cap[1]);
    const r1 = await run(over, cap[0], cap[1]);
    expect(r1.log).toEqual([]);
    const fits = await tournamentWith(min, cap[2], cap[3]);
    const r2 = await run(fits, cap[2], cap[3]);
    expect(r2.log).toEqual([r2.id]);
  });
});
