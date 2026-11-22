/**
 * V1 REPLAYS · PR-1 · ReplaySink, FrameLog y determinismo. Cada test R<n> tiene mutante
 * nombrado en apps/arena-engine/scripts/replay-sink-mutants.mjs.
 *
 * Ligero por defecto (S9_SINK_TICKS=3000). La prueba pesada de memoria (45 000 ticks) la
 * ejecuta el laboratorio con S9_SINK_TICKS=45000.
 */
import { beforeAll, describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { Battle, type BattleConfig } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset, maxBattleTicks } from "../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout, mvpArena, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot } from "../src/stubs.js";
import {
  MemoryReplaySink,
  ReplayNotRetainedError,
  ReplaySinkOverflowError,
  memoryLimitsFor,
  WindowLog,
  type ReplaySink,
} from "../src/sim/replay-sink.js";

beforeAll(async () => {
  await initPhysics();
});

function config(
  seed: string,
  ticks: number,
  extra: Partial<BattleConfig> = {},
  vehicles = 4,
  score = 9999,
): BattleConfig {
  const participants = [];
  for (let i = 0; i < vehicles; i++) {
    participants.push({
      id: `veh_${i + 1}`,
      botId: `bot_${i + 1}`,
      team: i % 2 === 0 ? "red" : "blue",
      spec: i % 2 === 0 ? gunnerLoadout() : scoutLoadout(),
    });
  }
  return {
    battleId: "sink_test",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: ticks, scoreToWin: score }),
    map: mvpArena(),
    participants,
    recordReplay: true,
    ...extra,
  };
}

function attach(b: Battle, vehicles = 4): void {
  const kinds = [HunterBot, CircleBot, HunterBot, ForwardBot];
  for (let i = 0; i < vehicles; i++) b.attachBot(`veh_${i + 1}`, new kinds[i % 4](`bot_${i + 1}`));
}

function run(seed: string, ticks: number, extra: Partial<BattleConfig> = {}, score = 9999) {
  const b = new Battle(config(seed, ticks, extra, 4, score));
  attach(b);
  const result = b.run(ticks);
  return { b, result };
}

describe("R1 WindowLog: ventana acotada con índices absolutos", () => {
  it("R1 length es absoluto, base avanza, lo expulsado devuelve undefined y la ventana nunca supera la capacidad", () => {
    const w = new WindowLog<number>(4);
    for (let i = 0; i < 10; i++) w.push(i);
    expect(w.length).toBe(10);
    expect(w.base).toBe(6);
    expect(w.get(5)).toBeUndefined();
    expect(w.get(6)).toBe(6);
    expect(w.get(9)).toBe(9);
    expect(w.get(10)).toBeUndefined();
    expect([...w.window()]).toEqual([6, 7, 8, 9]);
    expect(w.last()).toBe(9);
    const small = new WindowLog<number>(3);
    small.push(1);
    expect(small.base).toBe(0);
    expect([...small.window()]).toEqual([1]);
    expect(() => new WindowLog(0)).toThrow(RangeError);
  });
});

describe("R1b WindowLog.onEvict", () => {
  it("R1b avisa en orden de cada elemento expulsado con su índice absoluto, tolera callbacks rotos y se da de baja", () => {
    const w = new WindowLog<string>(3);
    const seen: [number, string][] = [];
    const off = w.onEvict((i, x) => void seen.push([i, x]));
    w.onEvict(() => {
      throw new Error("consumidor roto");
    });
    for (const x of ["a", "b", "c"]) w.push(x);
    expect(seen).toEqual([]);
    for (const x of ["d", "e"]) w.push(x);
    expect(seen).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    off();
    w.push("f");
    expect(seen.length).toBe(2);
    expect([...w.window()]).toEqual(["d", "e", "f"]);
  });
});

describe("R2 determinismo con y sin sink", () => {
  it("R2 mismo finalStateHash, stateHashes y checkpoints con sink por defecto, externo, retainFrames:false y ventanas 1 y grande", () => {
    const ref = run("seed-r2", 600);
    expect(ref.b.stateHashes.length).toBeGreaterThan(5);
    const ext = new MemoryReplaySink();
    const variants: Partial<BattleConfig>[] = [
      { replaySink: ext },
      { retainFrames: false },
      { frameWindow: 1 },
      { frameWindow: 100000 },
    ];
    for (const v of variants) {
      const r = run("seed-r2", 600, v);
      expect(r.result.finalStateHash).toBe(ref.result.finalStateHash);
      expect(r.result.ticks).toBe(ref.result.ticks);
      expect(r.result.score).toEqual(ref.result.score);
      if (!v.replaySink) {
        expect(r.b.stateHashes).toEqual(ref.b.stateHashes);
        expect(r.b.checkpoints).toEqual(ref.b.checkpoints);
      }
    }
    expect(ext.stateHashes).toEqual(ref.b.stateHashes);
    expect(ext.checkpoints).toEqual(ref.b.checkpoints);
    expect(ext.checkpoints.length).toBeGreaterThan(1);
  });
});

/** Cazadores en arena vacía sin reaparición: garantiza bajas y eventos públicos. */
function killingBattle(extra: Partial<BattleConfig> = {}): Battle {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push({
      id: `veh_${i + 1}`,
      botId: `b${i + 1}`,
      team: i % 2 === 0 ? "red" : "blue",
      spec: i % 3 === 2 ? scoutLoadout() : gunnerLoadout(),
    });
  }
  const b = new Battle({
    battleId: "sink_kill",
    seed: "rules-seed",
    ruleset: loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 }, scoreToWin: 99 }),
    map: emptyArena(),
    participants: parts,
    recordReplay: true,
    ...extra,
  });
  for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
  for (let t = 0; t < 2000 && !b.isFinished(); t++) b.step();
  return b;
}

describe("R3 el sink recibe exactamente los flujos de antes", () => {
  it("R3 comandos, snapshots, eventos, hashes y checkpoints del sink externo igualan a los del sink por defecto", () => {
    const ref = killingBattle();
    const ext = new MemoryReplaySink();
    killingBattle({ replaySink: ext });
    expect(ref.replayCommands.length).toBeGreaterThan(100);
    expect(ref.snapshots.length).toBeGreaterThan(50);
    expect(ref.publicEvents.length).toBeGreaterThan(0);
    expect(ref.checkpoints.length).toBeGreaterThan(0);
    expect(ext.commands).toEqual(ref.replayCommands);
    expect(ext.snapshots).toEqual(ref.snapshots);
    expect(ext.events).toEqual(ref.publicEvents);
    expect(ext.stateHashes).toEqual(ref.stateHashes);
    expect(ext.checkpoints).toEqual(ref.checkpoints);
    // el último snapshot es siempre el del tick final (garantía existente)
    expect(ext.snapshots[ext.snapshots.length - 1].tick).toBeGreaterThanOrEqual(ref.tick - 3);
  });
});

describe("R4 sink externo: las lecturas antiguas fallan alto", () => {
  it("R4 battle.snapshots/publicEvents/stateHashes/checkpoints/replayCommands lanzan ReplayNotRetainedError", () => {
    const { b } = run("seed-r4", 120, { replaySink: new MemoryReplaySink() });
    for (const k of ["snapshots", "publicEvents", "stateHashes", "checkpoints", "replayCommands"] as const) {
      expect(() => (b as any)[k], k).toThrow(ReplayNotRetainedError);
    }
  });
});

describe("R5 retainFrames:false", () => {
  it("R5 el sink interno no retiene snapshots ni eventos, pero sí hashes, checkpoints y comandos; el directo conserva su ventana", () => {
    const { b } = run("seed-r5", 300, { retainFrames: false });
    // no retenido: lectura explícitamente fallida, no un [] silencioso
    expect(() => b.snapshots).toThrow(ReplayNotRetainedError);
    expect(() => b.publicEvents).toThrow(ReplayNotRetainedError);
    expect(b.stateHashes.length).toBeGreaterThan(5);
    expect(b.checkpoints.length).toBeGreaterThan(0);
    expect(b.replayCommands.length).toBeGreaterThan(50);
    expect(b.frames.length).toBeGreaterThan(50);
  });
});

describe("R6 FrameLog del motor", () => {
  it("R6 el log de frames del motor no supera frameWindow y conserva la numeración absoluta", () => {
    const total = run("seed-r6", 600).b.frames.length;
    const { b } = run("seed-r6", 600, { frameWindow: 16 });
    expect(b.frames.length).toBe(total);
    expect(b.frames.base).toBe(total - 16);
    expect([...b.frames.window()].length).toBe(16);
    expect(b.frames.get(b.frames.base - 1)).toBeUndefined();
    expect(b.frames.get(total - 1).tick).toBe(b.tick);
  });
});

describe("R7 MemoryReplaySink acotado", () => {
  it("R7 al superar un tope lanza ReplaySinkOverflowError y no acumula más", () => {
    const s = new MemoryReplaySink({ limits: { maxCommands: 3 } });
    for (let i = 0; i < 3; i++) s.command({ tick: i, vehicleId: "v", command: {} });
    expect(() => s.command({ tick: 4, vehicleId: "v", command: {} })).toThrow(ReplaySinkOverflowError);
    expect(s.commands.length).toBe(3);
  });

  it("R7 los topes por defecto derivan de los ticks máximos, los vehículos y las cadencias reales (no son 200 000)", () => {
    const l = memoryLimitsFor({ maxTicks: 45000, vehicles: 8, snapshotEvery: 3, hashEvery: 30, checkpointEvery: 300 });
    expect(l.maxSnapshots).toBeGreaterThanOrEqual(15000);
    expect(l.maxSnapshots).toBeLessThanOrEqual(17000);
    expect(l.maxCommands).toBeGreaterThanOrEqual(360000);
    expect(l.maxCommands).toBeLessThanOrEqual(400000);
    expect(l.maxHashes).toBeLessThanOrEqual(1800);
    expect(l.maxCheckpoints).toBeLessThanOrEqual(200);
    // una batalla real recibe exactamente los topes que le corresponden y los cumple holgadamente
    const b = new Battle(config("seed-r7", 600));
    const lim = (b as any).memory.limits;
    const snapEvery = 3;
    expect(lim.maxSnapshots).toBeLessThan(Math.ceil((maxBattleTicks(b.config.ruleset) / snapEvery) * 1.1) + 5);
    attach(b);
    b.run(600);
    expect(b.snapshots.length).toBeLessThanOrEqual(lim.maxSnapshots);
    expect(b.replayCommands.length).toBeLessThanOrEqual(lim.maxCommands);
    expect(b.stateHashes.length).toBeLessThanOrEqual(lim.maxHashes);
    expect(b.checkpoints.length).toBeLessThanOrEqual(lim.maxCheckpoints);
    expect(b.recordingFault).toBeNull();
  });
});

describe("R7b fallo del sink: la batalla termina limpia, nunca a mitad de step()", () => {
  function faulty(over: Partial<ReplaySink>) {
    const base = new MemoryReplaySink();
    const calls = { total: 0, afterFault: 0, faulted: false };
    const wrap =
      <K extends keyof ReplaySink>(k: K) =>
      (x: any) => {
        calls.total++;
        if (calls.faulted) calls.afterFault++;
        if (over[k]) {
          try {
            (over[k] as any)(x);
          } catch (e) {
            calls.faulted = true;
            throw e;
          }
        }
        (base[k] as any)(x);
      };
    const sink: ReplaySink = {
      command: wrap("command"),
      snapshot: wrap("snapshot"),
      event: wrap("event"),
      hash: wrap("hash"),
      checkpoint: wrap("checkpoint"),
    };
    return { sink, base, calls };
  }

  it("R7b un ReplaySinkOverflowError a mitad de batalla no lanza, termina al final del tick con winner null y deja recordingFault", () => {
    const ref = run("seed-r7b", 600);
    const sink = new MemoryReplaySink({ limits: { maxSnapshots: 5 } });
    const { b, result } = run("seed-r7b", 600, { replaySink: sink });
    expect(b.isFinished()).toBe(true);
    expect(result.winner).toBeNull();
    expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ticks).toBeLessThan(ref.result.ticks);
    expect(b.recordingFault).not.toBeNull();
    expect(b.recordingFault!.stream).toBe("snapshots");
    expect(b.recordingFault!.cause).toBeInstanceOf(ReplaySinkOverflowError);
    expect(sink.snapshots.length).toBe(5);
    // lo emitido antes del fallo coincide con la batalla sin fallo (el determinismo no se toca)
    expect(sink.stateHashes).toEqual(ref.b.stateHashes.slice(0, sink.stateHashes.length));
    // la batalla ya terminada no avanza ni emite más
    const tick = b.tick;
    b.step();
    expect(b.tick).toBe(tick);
  });

  it("R7b cualquier excepción del sink (p. ej. disco) se captura igual y deja de llamarse al sink", () => {
    const { sink, calls } = faulty({
      command: () => {
        throw Object.assign(new Error("ENOSPC simulado"), { code: "ENOSPC" });
      },
    });
    const { b, result } = run("seed-r7b2", 600, { replaySink: sink });
    expect(result.winner).toBeNull();
    expect((b.recordingFault!.cause as any).code).toBe("ENOSPC");
    expect(b.recordingFault!.stream).toBe("commands");
    expect(calls.afterFault).toBe(0);
  });
});

describe("R8 memoria acotada con sink de streaming", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const MiB = 1024 * 1024;
  const TICKS = Number(process.env.S9_SINK_TICKS ?? 3000);
  // Completo (LAB, 45 000 ticks): 64 MiB de pico y 8 MiB de crecimiento. Ligero (3000 ticks):
  // umbrales proporcionales, medidos: sink que descarta ~2,7 MiB y ~0,2 MiB; sink que acumula ~8 MiB y ~2,7 MiB.
  const LIGHT = TICKS < 20000;
  const PEAK_MAX = LIGHT ? 5 * MiB : 64 * MiB;
  const GROWTH_MAX = LIGHT ? 1 * MiB : 8 * MiB;

  /** Sink "escritor falso": cuenta y descarta; nada se retiene. */
  function drainSink() {
    const n = { commands: 0, snapshots: 0, events: 0, hashes: 0, checkpoints: 0 };
    // Mutante de calibración (R8-accumulating-sink): el sink retiene todo lo que recibe.
    const keep: string[] | null = process.env.S9_SINK_MUTANT === "accumulate" ? [] : null;
    const sink: ReplaySink = {
      command: (c) => void (n.commands++, keep?.push(JSON.stringify(c))),
      snapshot: (f) => void (n.snapshots++, keep?.push(JSON.stringify(f))),
      event: () => void n.events++,
      hash: () => void n.hashes++,
      checkpoint: () => void n.checkpoints++,
    };
    return { sink, n };
  }

  it("R8 8 vehículos, heapUsed tras gc() sin pendiente y por debajo de 64 MiB; las cuentas coinciden con el sink por defecto", () => {
    // Cuentas de referencia con un tramo corto (el sink por defecto retiene: sólo ligero).
    const refSink = new MemoryReplaySink();
    const probe = new Battle(config("seed-r8", 600, { replaySink: refSink }, 8));
    attach(probe, 8);
    probe.run(600);
    probe.free();
    expect(refSink.commands.length).toBeGreaterThan(1000);

    const { sink, n } = drainSink();
    const b = new Battle(config("seed-r8", TICKS, { replaySink: sink }, 8));
    attach(b, 8);
    gc();
    const base = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    const every = Math.max(1, Math.floor(TICKS / 20));
    for (let t = 0; t < TICKS && !b.isFinished(); t++) {
      b.step();
      if (t % every === every - 1) {
        gc();
        samples.push(process.memoryUsage().heapUsed - base);
      }
    }
    b.free();
    expect(n.commands).toBeGreaterThan(1000);
    expect(n.snapshots).toBeGreaterThan(100);
    expect(samples.length).toBeGreaterThan(5);
    const peak = Math.max(...samples);
    expect(peak, `pico ${(peak / MiB).toFixed(1)} MiB`).toBeLessThan(PEAK_MAX);
    // pendiente ~ 0: la segunda mitad no crece más de 8 MiB sobre la primera
    const half = Math.floor(samples.length / 2);
    const first = Math.max(...samples.slice(0, half));
    const second = Math.max(...samples.slice(half));
    expect(second - first, `crecimiento ${((second - first) / MiB).toFixed(1)} MiB`).toBeLessThan(GROWTH_MAX);
    // la ventana del directo no crece con la duración
    expect([...b.frames.window()].length).toBeLessThanOrEqual(512);
  }, 600_000);
});
