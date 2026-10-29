/**
 * 4v4 (fase 5) · Del worker al motor, participante a participante.
 *
 *  1. `loadBattleParticipants` devuelve las participaciones en orden ESTABLE
 *     (team COLLATE "C", bot_id), con independencia del orden de inserción y del
 *     orden físico del heap (que un UPDATE cambia). Es el orden en que
 *     engine-executor numera `veh_<i+1>`.
 *  2. Cada participante llega al motor REAL con su bando, su bot, su versión y el
 *     loadout EXACTO de esa versión (revisiones distintas por versión).
 *  3. En TDM 4v4 el ganador es un BANDO y `participants.outcome` lo refleja para
 *     los 8 (4 win, 4 loss).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { getCatalog } from "../../api/src/services/catalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { IdleBot } from "../../arena-engine/src/stubs.js";
import type { Battle, BattleResult, BotAgent } from "../../arena-engine/src/sim/battle.js";
import { replayFromBattle } from "../../arena-engine/src/replay.js";
import { loadBattleParticipants, makeRunBattleHandler } from "./battle-runner.js";
import { makeEngineExecutor, type AgentDriver, type AgentDriverInput } from "./engine-executor.js";
import { createPublishedBot, EXAMPLE_LOADOUT, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

let h: TestDbHandle;
const bots: TestBot[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  for (let i = 0; i < 8; i++) {
    const b = await createPublishedBot(h.db, `t4v4-${i + 1}`);
    bots.push(b);
    // Los bots pares tienen además una v2 con OTRO loadout (rev 2): si el worker
    // tomara la revisión equivocada, el chasis del motor lo delataría.
    if (i % 2 === 0) {
      const alt = i % 4 === 0 ? ARCHETYPES.heavy : ARCHETYPES.scout;
      await h.db("bot_loadouts").insert({
        bot_id: b.botId,
        revision: 2,
        name: `t4v4-${i + 1}-rev2`,
        catalog_version: alt.catalogVersion,
        chassis: alt.chassis,
        modules: JSON.stringify(alt.modules),
      });
      await h.db("bot_versions").insert({
        bot_id: b.botId,
        version: 2,
        state: "published",
        runtime: "node",
        loadout_revision: 2,
        artifact_hash: `hash-t4v4-${i + 1}-v2`,
      });
    }
  }
}, 120_000);

afterAll(async () => {
  await h.stop();
});

/** 4v4 TDM en mvp-arena-01; los participantes se insertan en el orden dado. */
async function insert4v4(order: { bot: TestBot; version: number; team: string }[]): Promise<string> {
  const [battle] = await h
    .db("battles")
    .insert({
      status: "scheduled",
      official: false,
      mode: "team_deathmatch",
      ruleset_id: "team-deathmatch-mvp",
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "t4v4-seed",
    })
    .returning("id");
  for (const o of order) {
    await h.db("participants").insert({ battle_id: battle.id, bot_id: o.bot.botId, version: o.version, team: o.team });
  }
  return battle.id as string;
}

/** Bots 0-3 rojos, 4-7 azules; los pares juegan con su v2. */
function lineup() {
  return bots.map((bot, i) => ({ bot, version: i % 2 === 0 ? 2 : 1, team: i < 4 ? "red" : "blue" }));
}

describe("loadBattleParticipants · ORDER BY estable", () => {
  it("mismo orden (team, bot_id) sea cual sea el orden de inserción, también tras un UPDATE", async () => {
    const a = await insert4v4(lineup());
    const b = await insert4v4([...lineup()].reverse());
    // Un UPDATE reescribe la tupla al final del heap: sin ORDER BY, el orden cambia.
    await h.db("participants").where({ battle_id: a, bot_id: bots[0].botId }).update({ outcome: null });
    const key = (rows: any[]) => rows.map((r) => `${r.team}/${r.bot_id}`);
    const ra = key(await loadBattleParticipants(h.db, a));
    const rb = key(await loadBattleParticipants(h.db, b));
    expect(ra).toEqual(rb);
    const expected = lineup()
      .map((o) => `${o.team}/${o.bot.botId}`)
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); // orden por bytes = COLLATE "C"
    expect(ra).toEqual(expected);
  });
});

/**
 * Artillero ORÁCULO de test: quieto, apunta la torreta al rojo vivo más cercano
 * (lee la pose del motor: no depende de qué sensor lleve el loadout) y dispara al
 * estar alineado. Es sólo el "piloto": el daño, las muertes y la puntuación los
 * resuelve el motor.
 */
class OracleGunner implements BotAgent {
  constructor(
    readonly botId: string,
    private engine: Battle,
    private selfId: string,
  ) {}
  decide(obs: any) {
    const phys = this.engine.getPhysics();
    const me = phys.pose(this.selfId)!.position;
    const reds = this.engine
      .getVehicles()
      .filter((v) => v.team === "red" && v.alive)
      .map((v) => phys.pose(v.id)!.position)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    const cmd: any = { forTick: obs.tick, move: { throttle: 0, steer: 0 } };
    if (reds.length === 0) return cmd;
    const t = reds[0];
    cmd.turret = { targetPoint: t };
    const bearing = Math.atan2(t.y - me.y, t.x - me.x);
    let err = (obs.self.turretHeading ?? 0) - bearing;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) < 0.1) cmd.fire = ["turret_main"];
    return cmd;
  }
}

/**
 * Driver de test sobre el motor REAL: registra lo que recibe y conduce los
 * vehículos (azules OracleGunner, rojos quietos). Para que la batalla se decida en
 * pocos ticks, coloca a los rojos frente a los azules ANTES del primer tick (sólo
 * física; la puntuación, el ganador y los outcomes los calculan motor y runner).
 */
function recordingDriver(seen: { input?: AgentDriverInput; specs?: Map<string, any> }): AgentDriver {
  return {
    kind: "in_process_stub",
    async run(input) {
      const { engine, vehicles } = input;
      seen.input = input;
      seen.specs = new Map(engine.getVehicles().map((v) => [v.id, { team: v.team, botId: v.botId, spec: v.spec }]));
      const phys = engine.getPhysics();
      let k = 0;
      for (const v of vehicles) {
        if (v.team === "red") {
          engine.attachBot(v.vehicleId, new IdleBot(v.botId));
          phys.get(v.vehicleId)!.rb.setTranslation({ x: 96, y: 30 + 6 * k++ }, true);
        } else {
          engine.attachBot(v.vehicleId, new OracleGunner(v.botId, engine, v.vehicleId));
        }
      }
      while (!engine.isFinished() && engine.tick < 20_000) engine.step();
      const result: BattleResult = engine.run(20_000);
      return { result, replay: replayFromBattle(engine, result) };
    },
  };
}

describe("4v4 TDM · del worker al motor", () => {
  it("cada participante llega con su bando, bot, versión y loadout exacto; gana un BANDO", async () => {
    const battleId = await insert4v4(lineup());
    const seen: { input?: AgentDriverInput; specs?: Map<string, any> } = {};
    const handler = makeRunBattleHandler({
      executor: makeEngineExecutor({
        db: h.db,
        agents: recordingDriver(seen),
        rulesetOverrides: { scoreToWin: 1, timeLimitTicks: 20_000 },
      }),
    });
    await handler({ id: "t4v4-job", payload: { battleId }, attempts: 0 } as unknown as JobRow, {
      db: h.db,
      workerId: "t4v4",
    });

    // --- 8 vehículos, numerados en el orden estable del worker
    const ordered = await loadBattleParticipants(h.db, battleId);
    const vehicles = seen.input!.vehicles;
    expect(vehicles).toHaveLength(8);
    expect(vehicles.map((v) => v.vehicleId)).toEqual(ordered.map((_, i) => `veh_${i + 1}`));
    expect(vehicles.map((v) => [v.botId, v.version, v.team])).toEqual(
      ordered.map((p) => [p.bot_id, p.version, p.team]),
    );

    // --- en el MOTOR: mismo bando/bot y el spec del loadout de ESA versión
    const latest = await h.db("catalog_versions").orderBy("imported_at", "desc").first();
    const catalog = await getCatalog(h.db, latest.catalog_version);
    for (const v of vehicles) {
      const inEngine = seen.specs!.get(v.vehicleId)!;
      expect(inEngine.team).toBe(v.team);
      expect(inEngine.botId).toBe(v.botId);
      const idx = bots.findIndex((b) => b.botId === v.botId);
      const loadout =
        v.version === 2
          ? idx % 4 === 0
            ? ARCHETYPES.heavy
            : ARCHETYPES.scout
          : {
              loadoutId: "x",
              revision: 1,
              catalogVersion: EXAMPLE_LOADOUT.catalogVersion,
              chassis: EXAMPLE_LOADOUT.chassis,
              modules: EXAMPLE_LOADOUT.modules,
            };
      const expected = resolveVehicle(loadout as any, catalog);
      expect(inEngine.spec.chassisId).toBe(expected.chassisId);
      expect(inEngine.spec).toEqual(expected);
    }
    // Hay chasis distintos de verdad (si no, la comprobación de arriba no discrimina).
    expect(new Set([...seen.specs!.values()].map((s) => s.spec.chassisId)).size).toBeGreaterThanOrEqual(3);

    // --- ganador por BANDO y outcome de los 8
    const row = await h.db("battles").where({ id: battleId }).first();
    expect(row.status).toBe("finished");
    const result = typeof row.result === "string" ? JSON.parse(row.result) : row.result;
    expect(result.winner).toBe("blue");
    const outcomes = await h.db("participants").where({ battle_id: battleId });
    for (const p of outcomes) expect(p.outcome).toBe(p.team === "blue" ? "win" : "loss");
    expect(outcomes.filter((p: any) => p.outcome === "win")).toHaveLength(4);
  }, 180_000);
});
