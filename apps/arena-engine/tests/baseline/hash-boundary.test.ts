/**
 * OLA 2 · ME · BASELINE · frontera hash ↔ proyección (F3, visibilityEpoch fuera del hash).
 *
 * Contrato YA vigente en el BASE_SHA que MA y MD no pueden romper: proyectar (snapshot
 * público, cadencia de snapshots) no es simulación. Si MA mete `visibilityEpoch` (o
 * cualquier contador de proyección) en el hash, cambiar la cadencia de proyección
 * cambiaría los stateHashes y estos tests se ponen en rojo (mutante MA-EPOCH-HASH).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { gunnerLoadout, minerLoadout, mvpArena } from "../../src/fixtures.js";
import { HunterBot } from "../../src/stubs.js";
import { MinerHunterBot } from "./reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

function run(opts: { snapshotEveryNTicks: number; projectEveryTick: boolean }) {
  const b = new Battle({
    battleId: "me_hashb",
    seed: "me-hash-boundary",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 450 }),
    map: mvpArena(),
    snapshotEveryNTicks: opts.snapshotEveryNTicks,
    hashEveryNTicks: 15,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: minerLoadout() },
    ],
  });
  b.attachBot("veh_1", new HunterBot("b1"));
  b.attachBot("veh_2", new MinerHunterBot("b2"));
  while (!b.isFinished() && b.tick < 450) {
    b.step();
    if (opts.projectEveryTick) b.getPublicSnapshot();
  }
  const res = b.run(450);
  const hashes = b.stateHashes.map((h) => h.hash);
  b.free();
  return { final: res.finalStateHash, hashes };
}

describe("baseline · la proyección no entra en el hash (F3)", () => {
  it("cambiar la cadencia de snapshots (1, 3, 7) no cambia ningún stateHash", () => {
    const a = run({ snapshotEveryNTicks: 3, projectEveryTick: false });
    const b = run({ snapshotEveryNTicks: 1, projectEveryTick: false });
    const c = run({ snapshotEveryNTicks: 7, projectEveryTick: false });
    expect(b.hashes).toEqual(a.hashes);
    expect(c.hashes).toEqual(a.hashes);
    expect(b.final).toBe(a.final);
  });

  it("proyectar el snapshot público en cada tick (getPublicSnapshot) no cambia el hash", () => {
    const a = run({ snapshotEveryNTicks: 3, projectEveryTick: false });
    const b = run({ snapshotEveryNTicks: 3, projectEveryTick: true });
    expect(b.hashes).toEqual(a.hashes);
    expect(b.final).toBe(a.final);
  });
});
