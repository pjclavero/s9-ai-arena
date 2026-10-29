/**
 * ELIG · Ejecución (H7/H8): una batalla AGENDADA antes del fix (práctica o de torneo)
 * con una versión publicada cuyo loadout histórico ya no es válido no se lanza con ella:
 * descalificación administrativa, igual que una versión suspendida tras agendar. La
 * versión sigue `published` y su loadout intacto. Control: la versión corregida juega.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { createLoadoutRevision } from "../../api/src/services/bots.js";
import { makeRunBattleHandler, type BattleContext, type BattleExecution } from "./battle-runner.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

let h: TestDbHandle;
let bots: TestBot[];
let invalidV2: TestBot;

const cannonStandard = {
  catalogVersion: "mvp@1",
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@2" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: "ammo.standard@1" },
  ],
};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 3, "elig");
  // bots[1] publica una v2 con la combinación de antes de RC5.3 (rev 2 guardada sin validar).
  await createLoadoutRevision(h.db, bots[1].botId, cannonStandard, { massKg: 0, costCredits: 0, energyBalanceEUs: 0 });
  await h.db("bot_versions").insert({
    bot_id: bots[1].botId,
    version: 2,
    state: "published",
    runtime: "node",
    loadout_revision: 2,
    artifact_hash: "hash-elig-v2",
  });
  invalidV2 = { ...bots[1], version: 2, loadoutRevision: 2 };
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

describe("ELIG · ejecución", () => {
  it("agendada con una versión publicada NO elegible → walkover y esa versión descalificada, sin tocar el histórico", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], invalidV2);
    const log: string[] = [];
    await makeRunBattleHandler({ executor: scripted(log) })(job(id, "00000000-0000-0000-0000-0000000e1101"), {
      db: h.db,
      workerId: "E",
    });
    expect(log).toEqual([]); // no se lanzó
    const row = await h.db("battles").where({ id }).first();
    expect(row.result.endReason).toBe("walkover");
    const dq = await h.db("participants").where({ battle_id: id, bot_id: invalidV2.botId }).first();
    expect(dq.outcome).toBe("disqualified");
    const v = await h.db("bot_versions").where({ bot_id: invalidV2.botId, version: 2 }).first();
    expect(v.state).toBe("published");
  });

  it("control: con versiones elegibles la batalla se lanza normalmente", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[2]);
    const log: string[] = [];
    await makeRunBattleHandler({ executor: scripted(log) })(job(id, "00000000-0000-0000-0000-0000000e1102"), {
      db: h.db,
      workerId: "E",
    });
    expect(log).toEqual([id]);
  });
});
