/**
 * R13.5 · Slice 1 — checkpoint por resimulación (docs/R13_5_SAVE_SHARDING.md).
 *
 * Propiedad central: una batalla reanudada desde un checkpoint en el tick N debe
 * producir EXACTAMENTE los mismos hashes (intermedios y final) que la ejecución
 * continua. Los stubs no tienen estado (stubs.ts), así que un agente "fresco"
 * acoplado tras el restore decide idéntico al de la ejecución continua — la
 * equivalencia que se prueba es la del ESTADO DEL MOTOR, como fija el diseño.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle, type BattleConfig, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { mvpArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, DeadBot, ForwardBot, HunterBot } from "../src/stubs.js";
import {
  checkpointFromJsonl,
  checkpointToJsonl,
  restoreCheckpoint,
  saveCheckpoint,
  type BattleCheckpoint,
} from "../src/checkpoint.js";

beforeAll(async () => {
  await initPhysics();
});

function makeConfig(seed: string, recordReplay = true): BattleConfig {
  return {
    battleId: "ckpt_test",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, scoreToWin: 99 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
    ],
    recordReplay,
  };
}

/** Bots frescos por batalla: los stubs no guardan estado, pero no se comparten instancias. */
function freshAgents(): Record<string, BotAgent> {
  return {
    veh_1: new HunterBot("bot_a"),
    veh_2: new CircleBot("bot_b"),
    veh_3: new HunterBot("bot_c"),
    veh_4: new ForwardBot("bot_d"),
  };
}

function attachAll(b: Battle, agents: Record<string, BotAgent>): void {
  for (const [id, a] of Object.entries(agents)) b.attachBot(id, a);
}

/** Ejecución continua de referencia: resultado + hashes intermedios. */
function runContinuous(seed: string) {
  const b = new Battle(makeConfig(seed));
  attachAll(b, freshAgents());
  const result = b.run(600);
  const hashes = [...b.stateHashes];
  b.free();
  return { result, hashes };
}

/** Corre una batalla VIVA hasta el tick N exacto sin rematarla (run() haría finish). */
function stepTo(b: Battle, tick: number): void {
  while (!b.isFinished() && b.tick < tick) b.step();
  expect(b.isFinished()).toBe(false);
  expect(b.tick).toBe(tick);
}

describe("checkpoint por resimulación: reanudar reproduce la ejecución continua", () => {
  it("finalStateHash y hashes intermedios idénticos tras save(N=300) + restore + continuar", async () => {
    const continua = runContinuous("ckpt-alpha");

    // Batalla que se interrumpe en N=300 y se checkpointea.
    const b1 = new Battle(makeConfig("ckpt-alpha"));
    attachAll(b1, freshAgents());
    stepTo(b1, 300);
    const ckpt = saveCheckpoint(b1);
    b1.free();
    expect(ckpt.tick).toBe(300);
    expect(ckpt.commands.every((c) => c.tick < 300)).toBe(true);

    // Restaurar (verifica el hash en N por dentro) y continuar hasta el final.
    const b2 = await restoreCheckpoint(ckpt, freshAgents());
    expect(b2.tick).toBe(300);
    expect(b2.isFinished()).toBe(false);
    expect(b2.stateHash()).toBe(ckpt.stateHash);
    const result = b2.run(600);
    const hashes = [...b2.stateHashes];
    b2.free();

    expect(result.finalStateHash).toBe(continua.result.finalStateHash);
    expect(result.ticks).toBe(continua.result.ticks);
    expect(result.winner).toBe(continua.result.winner);
    // No solo el final: TODOS los hashes intermedios (pre y post checkpoint) coinciden.
    expect(hashes).toEqual(continua.hashes);
  });

  it("checkpoint en el tick 0 (sin comandos): restaurar reproduce el estado inicial", async () => {
    const b1 = new Battle(makeConfig("ckpt-zero"));
    attachAll(b1, freshAgents());
    const ckpt = saveCheckpoint(b1);
    const hashInicial = b1.stateHash();
    b1.free();
    expect(ckpt.tick).toBe(0);
    expect(ckpt.commands).toHaveLength(0);

    const b2 = await restoreCheckpoint(ckpt, freshAgents());
    expect(b2.tick).toBe(0);
    expect(b2.stateHash()).toBe(hashInicial);
    b2.free();
  });

  it("la reanudación reproduce también los timeouts grabados (DeadBot)", async () => {
    // Un bot que nunca responde: sus null NO se graban como comandos, y la
    // resimulación debe reproducir esos timeouts igualmente.
    const agents = (): Record<string, BotAgent> => ({ ...freshAgents(), veh_2: new DeadBot("bot_b") });
    const bRef = new Battle(makeConfig("ckpt-dead"));
    attachAll(bRef, agents());
    const refResult = bRef.run(600);
    bRef.free();

    const b1 = new Battle(makeConfig("ckpt-dead"));
    attachAll(b1, agents());
    stepTo(b1, 240);
    const ckpt = saveCheckpoint(b1);
    b1.free();
    expect(ckpt.commands.some((c) => c.vehicleId === "veh_2")).toBe(false);

    const b2 = await restoreCheckpoint(ckpt, agents());
    const result = b2.run(600);
    b2.free();
    expect(result.finalStateHash).toBe(refResult.finalStateHash);
    expect(result.disqualified).toEqual(refResult.disqualified);
  });
});

describe("rechazos estrictos", () => {
  async function makeCkpt(seed = "ckpt-neg", tick = 60): Promise<BattleCheckpoint> {
    const b = new Battle(makeConfig(seed));
    attachAll(b, freshAgents());
    stepTo(b, tick);
    const ckpt = saveCheckpoint(b);
    b.free();
    return ckpt;
  }

  it("save sin recordReplay: rechazado", () => {
    const b = new Battle(makeConfig("ckpt-norec", false));
    attachAll(b, freshAgents());
    expect(() => saveCheckpoint(b)).toThrow(/recordReplay/);
    b.free();
  });

  it("save de una batalla terminada: rechazado", () => {
    const b = new Battle(makeConfig("ckpt-fin"));
    attachAll(b, freshAgents());
    b.run(600);
    expect(() => saveCheckpoint(b)).toThrow(/terminó/);
    b.free();
  });

  it("formatVersion desconocida: rechazada", async () => {
    const ckpt = await makeCkpt();
    const malo = { ...ckpt, formatVersion: 2 as any };
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(/formatVersion desconocida/);
  });

  it("hash guardado adulterado: divergencia detectada, con ambos hashes en el error", async () => {
    const ckpt = await makeCkpt();
    const malo = { ...ckpt, stateHash: "0".repeat(64) };
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(new RegExp(`divergencia.*${"0".repeat(64)}`));
  });

  it("comando adulterado (payload distinto): el hash en N deja de coincidir", async () => {
    const ckpt = await makeCkpt("ckpt-tamper", 120);
    const conMove = ckpt.commands.findIndex((c) => c.command?.move);
    expect(conMove).toBeGreaterThanOrEqual(0);
    const malo = structuredClone(ckpt);
    malo.commands[conMove].command.move.throttle = -1;
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(/divergencia/);
  });

  it("mismatch de versión de motor: rechazado con ambos valores", async () => {
    const ckpt = await makeCkpt();
    const malo = structuredClone(ckpt);
    const original = malo.header.versions.engine;
    malo.header.versions.engine = "999.0.0";
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(/999\.0\.0/);
    malo.header.versions.engine = original;
    malo.header.versions.physics = "otra@0.0.1";
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(/physics/);
  });

  it("comando con tick ≥ N: checkpoint corrupto, rechazado sin resimular", async () => {
    const ckpt = await makeCkpt("ckpt-late", 60);
    const malo = structuredClone(ckpt);
    malo.commands.push({ tick: 60, vehicleId: "veh_1", command: { forTick: 60 } });
    await expect(restoreCheckpoint(malo, freshAgents())).rejects.toThrow(/≥ tick del checkpoint/);
  });

  it("agentes incompletos o desconocidos: rechazados", async () => {
    const ckpt = await makeCkpt();
    const { veh_4: _omitido, ...incompletos } = freshAgents();
    await expect(restoreCheckpoint(ckpt, incompletos)).rejects.toThrow(/faltan agentes.*veh_4/);
    await expect(restoreCheckpoint(ckpt, { ...freshAgents(), veh_9: new DeadBot("bot_x") })).rejects.toThrow(
      /desconocido: veh_9/,
    );
  });
});

describe("serialización JSONL", () => {
  it("round-trip: parse(serialize(ckpt)) es equivalente y sigue siendo restaurable", async () => {
    const b = new Battle(makeConfig("ckpt-jsonl"));
    attachAll(b, freshAgents());
    while (!b.isFinished() && b.tick < 150) b.step();
    const ckpt = saveCheckpoint(b);
    b.free();

    const vuelta = checkpointFromJsonl(checkpointToJsonl(ckpt));
    expect(vuelta).toEqual(ckpt);

    const b2 = await restoreCheckpoint(vuelta, freshAgents());
    expect(b2.tick).toBe(150);
    b2.free();
  });

  it("archivos corruptos: sin ckpt, sin cabecera o con registro desconocido", () => {
    expect(() => checkpointFromJsonl("")).toThrow(/sin registro ckpt/);
    expect(() => checkpointFromJsonl('{"t":"ckpt","formatVersion":1,"tick":0,"stateHash":"x"}\n')).toThrow(
      /sin cabecera/,
    );
    expect(() =>
      checkpointFromJsonl('{"t":"ckpt","formatVersion":1,"tick":0,"stateHash":"x"}\n{"t":"raro"}\n'),
    ).toThrow(/registro desconocido/);
  });
});
