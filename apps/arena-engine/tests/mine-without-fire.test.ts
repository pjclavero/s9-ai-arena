/**
 * OLA 2 · MC · `deployMine` se procesa aunque el comando NO traiga `fire`
 * (antes resolveFiring hacía `continue` si `fire` estaba vacío: la mina se ignoraba en silencio).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, minerLoadout, sandbagLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

function mines(cmd: (tick: number) => Record<string, unknown>): number {
  const map = emptyArena(200, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 150, y: 40 }, heading: Math.PI },
  ];
  const b = new Battle({
    battleId: "mc_mine",
    seed: "mc-mine",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 100 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: minerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  b.attachBot("veh_1", { botId: "b1", decide: (obs: any) => ({ forTick: obs.tick, ...(obs.tick === 0 ? cmd(0) : {}) }) });
  b.attachBot("veh_2", new IdleBot("b2"));
  for (let t = 0; t < 5; t++) b.step();
  const n = b.getMines().length;
  b.free();
  return n;
}

describe("MC · minar no exige disparar", () => {
  it("deployMine sin fire siembra la mina", () => {
    expect(mines(() => ({ deployMine: { slot: "mine_bay" } }))).toBe(1);
  });
  it("deployMine con fire vacío siembra la mina", () => {
    expect(mines(() => ({ fire: [], deployMine: { slot: "mine_bay" } }))).toBe(1);
  });
  it("deployMine con fire sigue sembrando (sin regresión)", () => {
    expect(mines(() => ({ fire: ["turret_main"], deployMine: { slot: "mine_bay" } }))).toBe(1);
  });
  it("sin deployMine no hay mina", () => {
    expect(mines(() => ({ fire: ["turret_main"] }))).toBe(0);
  });
});
