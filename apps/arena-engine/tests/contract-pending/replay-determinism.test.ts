/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MD (replay v2, verify, stateHash, RNG con nombre).
 *
 * En ROJO sobre el BASE_SHA f07ff6f (declarados con `contractIt("MD", …)` = it.fails).
 * MD los activa en su PR cambiando `contractIt("MD", …)` por `it(…)`; para verlos en rojo
 * real antes: `S9_CONTRACT_ENFORCE=MD npx vitest run apps/arena-engine/tests/contract-pending`.
 * Interfaces usadas: sólo las del BASE_SHA (`verify`, `Battle.stateHash`,
 * `observationFor`), contrato §13 de docs/technical/engine-v2-contracts.md.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { verify, type Replay } from "../../src/replay.js";
import { emptyArena, gunnerLoadout, minerLoadout, scoutLoadout } from "../../src/fixtures.js";
import { HunterBot, IdleBot } from "../../src/stubs.js";
import { ScriptBot, contractIt } from "../baseline/helpers.js";
import { recordReference } from "../baseline/reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

let reference: Replay | null = null;
async function ref(): Promise<Replay> {
  reference ??= await recordReference();
  return reference;
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("MD · verify() v2 compara el RESULTADO, no sólo los hashes", () => {
  contractIt("MD", "un replay con winner manipulado (hashes intactos) NO verifica", async () => {
    const r = clone(await ref());
    r.result.winner = r.result.winner === "red" ? "blue" : "red";
    expect((await verify(r)).matches).toBe(false);
  });

  contractIt("MD", "un replay con endReason manipulado NO verifica", async () => {
    const r = clone(await ref());
    (r.result as any).endReason = "technical_limit";
    expect((await verify(r)).matches).toBe(false);
  });

  contractIt("MD", "un replay con score manipulado NO verifica", async () => {
    const r = clone(await ref());
    r.result.score = { ...r.result.score, red: (r.result.score.red ?? 0) + 7 };
    expect((await verify(r)).matches).toBe(false);
  });

  contractIt("MD", "un replay con disqualifications manipuladas NO verifica", async () => {
    const r = clone(await ref());
    r.result.disqualified = [...r.result.disqualified, "veh_2"];
    expect((await verify(r)).matches).toBe(false);
  });
});

/**
 * Batalla con un proyectil en vuelo y una mina armándose en el tick 6, para mutar
 * campos de estado vivo y exigir que el stateHash lo note.
 */
function liveStateBattle(): Battle {
  const b = new Battle({
    battleId: "me_hashcov",
    seed: "me-hashcov",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 600 }),
    map: emptyArena(200, 80),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: minerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
    ],
  });
  b.attachBot(
    "veh_1",
    new ScriptBot("b1", (t) => {
      if (t === 0) return { fire: ["turret_main"], deployMine: { slot: "mine_bay", armDelayTicks: 200 } };
      if (t === 6) return { fire: ["turret_main"], turret: { targetHeading: Math.PI / 2 } };
      return undefined;
    }),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  for (let t = 0; t < 7; t++) b.step();
  return b;
}

/** Aplica `mutate`, comprueba que el hash cambia y deshace con `undo`. */
function hashSees(b: Battle, mutate: () => void, undo: () => void): boolean {
  const h0 = b.stateHash();
  mutate();
  const h1 = b.stateHash();
  undo();
  expect(b.stateHash()).toBe(h0); // la sonda no deja rastro
  return h1 !== h0;
}

describe("MD · el stateHash cubre todo el estado vivo que determina el futuro", () => {
  // Control positivo: lo que el hash YA cubre (sin esto, un «false» de abajo no prueba nada).
  it("(control, verde en la base) posición de proyectil y vida de casco ya están en el hash", () => {
    const b = liveStateBattle();
    const p = (b as any).projectiles[0];
    const v = b.getVehicle("veh_2")!;
    const ok = hashSees(b, () => (p.position.x += 1), () => (p.position.x -= 1)) &&
      hashSees(b, () => (v.hullHp -= 1), () => (v.hullHp += 1));
    b.free();
    expect(ok).toBe(true);
  });

  const probes: [string, (b: Battle) => [() => void, () => void]][] = [
    ["TTL del proyectil", (b) => { const p = (b as any).projectiles[0]; return [() => p.ttlTicks--, () => p.ttlTicks++]; }],
    ["owner del proyectil", (b) => { const p = (b as any).projectiles[0]; const o = p.ownerId; return [() => (p.ownerId = "veh_2"), () => (p.ownerId = o)]; }],
    ["equipo del proyectil", (b) => { const p = (b as any).projectiles[0]; const o = p.team; return [() => (p.team = "blue"), () => (p.team = o)]; }],
    ["armedAtTick de la mina", (b) => { const m = b.getMines()[0]; return [() => m.armedAtTick++, () => m.armedAtTick--]; }],
    ["expiresAtTick de la mina", (b) => { const m = b.getMines()[0]; return [() => m.expiresAtTick++, () => m.expiresAtTick--]; }],
    ["owner de la mina", (b) => { const m = b.getMines()[0]; const o = m.ownerId; return [() => (m.ownerId = "veh_2"), () => (m.ownerId = o)]; }],
    ["entitySeq (asignador de ids)", (b) => [() => (b as any).entitySeq++, () => (b as any).entitySeq--]],
    ["respawnAtTick", (b) => { const v = b.getVehicle("veh_2")!; return [() => (v.respawnAtTick = 999), () => (v.respawnAtTick = 0)]; }],
    ["cola de radio", (b) => [
      () => (b as any).radioQueue.push({ from: "veh_1", team: "red", data: "AA==", sentTick: 6, deliverAtTick: 12 }),
      () => (b as any).radioQueue.pop(),
    ]],
    ["comandos en vuelo (latencia)", (b) => [
      () => (b as any).pendingLatencyCommands.push({ readyAtTick: 9, vehicleId: "veh_1", command: {} }),
      () => (b as any).pendingLatencyCommands.pop(),
    ]],
    ["última orden de movimiento (lastMove)", (b) => { const v = b.getVehicle("veh_1")!; const o = v.lastMove; return [() => (v.lastMove = { throttle: 1, steer: 1 }), () => (v.lastMove = o)]; }],
    ["timeouts consecutivos", (b) => { const v = b.getVehicle("veh_1")!; return [() => v.consecutiveTimeouts++, () => v.consecutiveTimeouts--]; }],
  ];
  for (const [name, probe] of probes) {
    contractIt("MD", `el stateHash cambia si cambia: ${name}`, () => {
      const b = liveStateBattle();
      const [m, u] = probe(b);
      const seen = hashSees(b, m, u);
      b.free();
      expect(seen).toBe(true);
    });
  }
});

describe("MD · RNG con nombre: la observación no consume el flujo de simulación", () => {
  contractIt("MD", "llamar a observationFor() fuera del bucle no cambia el finalStateHash", () => {
    const run = (observe: boolean) => {
      const map = emptyArena(200, 80);
      map.spawns = [
        { team: "red", position: { x: 40, y: 40 }, heading: 0 },
        { team: "blue", position: { x: 70, y: 40 }, heading: Math.PI },
      ];
      const b = new Battle({
        battleId: "me_rngobs",
        seed: "me-rngobs",
        ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 240 }),
        map,
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
        ],
      });
      b.attachBot("veh_1", new HunterBot("b1"));
      b.attachBot("veh_2", new HunterBot("b2"));
      while (!b.isFinished() && b.tick < 240) {
        b.step();
        if (observe) b.observationFor("veh_1"); // p. ej. el inspector o un endpoint de depuración
      }
      const res = b.run(240);
      b.free();
      return res.finalStateHash;
    };
    expect(run(true)).toBe(run(false));
  });
});
