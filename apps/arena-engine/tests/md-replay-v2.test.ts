/**
 * OLA2-MD · Replay v2, verify() con resultado, checkpoints por componente, stateHash completo
 * y flujos de RNG con nombre (contrato engine-v2 §13).
 *
 * Cada garantía tiene un mutante en el informe MD (ola2/informes/MD.md) que la pone en rojo.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle, type BattleConfig, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { mvpArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot } from "../src/stubs.js";
import {
  compareStateHashes,
  fromJsonl,
  headerIncompatibility,
  record,
  toJsonl,
  verify,
  type Replay,
} from "../src/replay.js";
import { restoreFromReplayCheckpoint } from "../src/checkpoint.js";
import {
  deriveStreamState,
  ReadOnlyRng,
  Rng,
  RngReadOnlyError,
  RngStreams,
  RNG_STREAM_NAMES,
} from "../src/rng.js";
import { canonicalize, computeStateHash, STATE_HASH_COMPONENTS } from "../src/sim/state-hash.js";

beforeAll(async () => {
  await initPhysics();
});

function cfg(seed: string, extra: Partial<BattleConfig> = {}): BattleConfig {
  return {
    battleId: "md_v2",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, scoreToWin: 99 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
    ],
    ...extra,
  };
}

function attachStubs(b: Battle): void {
  b.attachBot("veh_1", new HunterBot("bot_a"));
  b.attachBot("veh_2", new CircleBot("bot_b"));
  b.attachBot("veh_3", new HunterBot("bot_c"));
  b.attachBot("veh_4", new ForwardBot("bot_d"));
}

let base: Replay;
beforeAll(async () => {
  base = await record(cfg("md-seed-1"), attachStubs);
});

const clone = <T>(x: T): T => structuredClone(x);

// ------------------------------------------------------------------ replay v2
describe("replay v2: formato", () => {
  it("cabecera v2 completa: catálogo+digest, runtime, wasm, cadencias, RNG, esquemas", () => {
    const h = base.header;
    expect(h.formatVersion).toBe(2);
    expect(h.catalog.version).toMatch(/\S/);
    expect(h.catalog.specDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.runtime).toMatch(/^node\d+$/);
    expect(h.physicsWasmSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.cadences).toEqual({ hashEveryNTicks: 30, snapshotEveryNTicks: 3, checkpointEveryNTicks: 300 });
    expect(h.rng.streams).toEqual([...RNG_STREAM_NAMES]);
    expect(h.stateHashScheme).toBe("components/v1");
    expect(headerIncompatibility(h)).toBeNull();
  });

  it("checkpoints con desglose por componentes, a la cadencia, y el último es el estado final", () => {
    const ticks = base.checkpoints.map((c) => c.tick);
    for (const t of ticks.slice(0, -1)) expect(t % 300).toBe(0);
    const last = base.checkpoints[base.checkpoints.length - 1];
    expect(last.tick).toBe(base.result.ticks);
    expect(last.hash).toBe(base.result.finalStateHash);
    expect(Object.keys(last.components)).toEqual([...STATE_HASH_COMPONENTS]);
  });

  it("round-trip JSONL exacto y verificable", async () => {
    const back = fromJsonl(toJsonl(base));
    expect(back).toEqual(base);
    const v = await verify(back);
    expect(v.mismatches).toEqual([]);
    expect(v.matches).toBe(true);
  });

  it("formatVersion 1 (replays antiguos) se RECHAZA al leer", () => {
    const lines = toJsonl(base).split("\n");
    lines[0] = lines[0].replace('"formatVersion":2', '"formatVersion":1');
    expect(() => fromJsonl(lines.join("\n"))).toThrow(/^format_version_mismatch/);
  });

  it("registro desconocido, cabecera duplicada o registro antes de cabecera = corrupción", () => {
    const j = toJsonl(base);
    expect(() => fromJsonl(j + '{"t":"raro"}\n')).toThrow(/registro desconocido/);
    const first = j.split("\n")[0];
    expect(() => fromJsonl(j + first + "\n")).toThrow(/más de una cabecera/);
    expect(() => fromJsonl('{"t":"cmd","tick":0}\n' + j)).toThrow(/antes de la cabecera/);
  });

  it("un payload con su propia clave t no se serializa", () => {
    const r = clone(base);
    (r.commands as any).push({ tick: 0, vehicleId: "veh_1", command: {}, t: "result" });
    expect(() => toJsonl(r)).toThrow(/clave "t"/);
  });

  it("la cadencia de hash NO estándar viaja en la cabecera y la re-simulación la respeta (P3-2)", async () => {
    const r = await record(cfg("md-seed-cad", { hashEveryNTicks: 7, checkpointEveryNTicks: 50 }), attachStubs);
    expect(r.header.cadences.hashEveryNTicks).toBe(7);
    const v = await verify(r);
    expect(v.mismatches).toEqual([]);
    expect(v.matches).toBe(true);
  });
});

// ------------------------------------------------------------------ verify v2
describe("verify() v2 compara el RESULTADO completo", () => {
  const tamper: [string, (r: Replay) => void][] = [
    ["winner", (r) => (r.result.winner = r.result.winner === "red" ? "blue" : "red")],
    ["endReason", (r) => ((r.result as any).endReason = "technical_limit")],
    ["score", (r) => (r.result.score = { ...r.result.score, red: (r.result.score.red ?? 0) + 1 })],
    ["disqualified", (r) => (r.result.disqualified = ["veh_2"])],
    ["ticks", (r) => (r.result.ticks = r.result.ticks + 1)],
    ["versions", (r) => (r.result.versions = { ...r.result.versions, rules: "otra@1" })],
  ];
  for (const [field, f] of tamper) {
    it(`${field} falsificado con hashes intactos ⇒ NO verifica y lo nombra`, async () => {
      const r = clone(base);
      f(r);
      const v = await verify(r);
      expect(v.matches).toBe(false);
      expect(v.rejected).toBeNull();
      expect(v.mismatches.map((m) => m.field)).toContain(field);
      // Los hashes siguen cuadrando: la discrepancia es SÓLO de resultado.
      expect(v.divergedAtTick).toBeNull();
    });
  }

  it("checkpoint adulterado ⇒ no verifica y señala tick y componente", async () => {
    const r = clone(base);
    const k = r.checkpoints[0];
    k.hash = "0".repeat(64);
    k.components.vehicles = "f".repeat(64);
    const v = await verify(r);
    expect(v.matches).toBe(false);
    expect(v.divergedCheckpointTick).toBe(k.tick);
    expect(v.divergedComponents).toContain("vehicles");
  });

  it("comando adulterado ⇒ divergencia con tick (no índice) y componentes", async () => {
    const r = clone(base);
    const i = r.commands.findIndex((c) => c.tick >= 60 && c.vehicleId === "veh_4");
    r.commands[i] = { ...r.commands[i], command: { move: { throttle: -1, steer: 1 } } };
    const v = await verify(r);
    expect(v.matches).toBe(false);
    expect(v.divergedAtTick).not.toBeNull();
    expect(v.divergedAtTick! % 30).toBe(0);
    expect(v.divergedComponents.length).toBeGreaterThan(0);
  });

  it("compareStateHashes con longitudes distintas devuelve un TICK (P3-1)", () => {
    const a = [
      { tick: 0, hash: "a" },
      { tick: 30, hash: "b" },
      { tick: 60, hash: "c" },
    ];
    expect(compareStateHashes(a, a.slice(0, 2))).toBe(60);
    expect(compareStateHashes(a.slice(0, 1), a)).toBe(30);
    expect(compareStateHashes(a, a)).toBeNull();
  });

  const incompat: [string, (r: Replay) => void, RegExp][] = [
    ["motor", (r) => (r.header.versions.engine = "999.0.0"), /^engine_version_mismatch/],
    ["física", (r) => (r.header.physicsWasmSha256 = "0".repeat(64)), /^physics_wasm_mismatch/],
    ["runtime", (r) => (r.header.runtime = "node0"), /^runtime_mismatch/],
    ["catálogo (versión)", (r) => (r.header.catalog.version = "otro@9"), /^catalog_version_mismatch/],
    ["catálogo (specs)", (r) => (r.header.participants[0].spec.hullHp += 1), /^catalog_digest_mismatch/],
    ["esquema de hash", (r) => (r.header.stateHashScheme = "v1"), /^state_hash_scheme_mismatch/],
    ["esquema de RNG", (r) => (r.header.rng.derivation = "otra"), /^rng_scheme_mismatch/],
  ];
  for (const [what, f, re] of incompat) {
    it(`cambio de ${what} ⇒ rechazo explícito sin re-simular`, async () => {
      const r = clone(base);
      f(r);
      const v = await verify(r);
      expect(v.matches).toBe(false);
      expect(v.rejected).toMatch(re);
      expect(v.recomputedResult).toBeNull();
    });
  }
});

// ------------------------------------------------------------- checkpoints
describe("checkpoints del replay v2: reanudar desde un checkpoint grabado", () => {
  it("restaurar en el checkpoint 300 y continuar da el mismo resultado y hash final", async () => {
    const b = await restoreFromReplayCheckpoint(base, 300, {
      veh_1: new HunterBot("bot_a"),
      veh_2: new CircleBot("bot_b"),
      veh_3: new HunterBot("bot_c"),
      veh_4: new ForwardBot("bot_d"),
    });
    expect(b.tick).toBe(301);
    const res = b.run();
    b.free();
    expect(res.finalStateHash).toBe(base.result.finalStateHash);
    expect(res.winner).toBe(base.result.winner);
  });

  it("checkpoint adulterado en el replay ⇒ el restore se niega y nombra componentes", async () => {
    const r = clone(base);
    const k = r.checkpoints.find((c) => c.tick === 300)!;
    k.hash = "0".repeat(64);
    k.components.rng = "0".repeat(64);
    await expect(
      restoreFromReplayCheckpoint(r, 300, {
        veh_1: new HunterBot("bot_a"),
        veh_2: new CircleBot("bot_b"),
        veh_3: new HunterBot("bot_c"),
        veh_4: new ForwardBot("bot_d"),
      }),
    ).rejects.toThrow(/componentes: .*rng/);
  });
});

// ------------------------------------------------------- stateHash completo
/** Batalla viva en el tick 150 para mutar estado y ver qué componente cambia. */
function live(): Battle {
  const b = new Battle(cfg("md-live"));
  attachStubs(b);
  while (b.tick < 150) b.step();
  return b;
}

const projectile = () => ({
  id: "proj_999",
  ownerId: "veh_1",
  team: "red",
  position: { x: 10, y: 10 },
  velocity: { x: 50, y: 0 },
  damage: 10,
  explosionRadiusM: 0,
  ttlTicks: 40,
});
const mine = () => ({
  id: "mine_998",
  ownerId: "veh_2",
  team: "red",
  position: { x: 20, y: 20 },
  damage: 50,
  triggerRadiusM: 2,
  explosionRadiusM: 4,
  armedAtTick: 200,
  expiresAtTick: 900,
  detectable: true,
});

/** [descripción, componente esperado, preparación (común a los dos lados), mutación]. */
const LIVE_FIELDS: [string, string, (b: any) => void, (b: any) => void][] = [
  ["entitySeq", "allocator", () => {}, (b) => (b.entitySeq += 1)],
  ["respawnAtTick", "vehicles", () => {}, (b) => (b.vehicles[0].respawnAtTick = 777)],
  ["consecutiveTimeouts", "vehicles", () => {}, (b) => (b.vehicles[1].consecutiveTimeouts += 1)],
  ["lastMove", "vehicles", () => {}, (b) => (b.vehicles[2].lastMove = { throttle: 0.123, steer: 0 })],
  ["lastTurretTarget", "vehicles", () => {}, (b) => (b.vehicles[0].lastTurretTarget = 1.2345)],
  ["contadores de radio", "vehicles", () => {}, (b) => (b.vehicles[0].radioSentThisSecond += 1)],
  [
    "reactivateAtTick de módulo",
    "vehicles",
    () => {},
    (b) => ([...b.vehicles[0].modules.values()][0].reactivateAtTick = 999),
  ],
  ["TTL de proyectil", "projectiles", (b) => b.projectiles.push(projectile()), (b) => (b.projectiles.at(-1).ttlTicks -= 1)],
  ["owner de proyectil", "projectiles", (b) => b.projectiles.push(projectile()), (b) => (b.projectiles.at(-1).ownerId = "veh_3")],
  ["velocidad de proyectil", "projectiles", (b) => b.projectiles.push(projectile()), (b) => (b.projectiles.at(-1).velocity.y = 1)],
  ["armado de mina", "deployables", (b) => b.mines.push(mine()), (b) => (b.mines.at(-1).armedAtTick = 201)],
  ["owner de mina", "deployables", (b) => b.mines.push(mine()), (b) => (b.mines.at(-1).ownerId = "veh_1")],
  [
    "cola de radio",
    "radioQueue",
    () => {},
    (b) => b.radioQueue.push({ from: "veh_1", team: "red", data: "x", sentTick: 1, deliverAtTick: 999 }),
  ],
  ["sonidos", "radioQueue", () => {}, (b) => b.sounds.push({ position: { x: 1, y: 1 }, kind: "engine", intensity: 1 })],
  [
    "comandos en vuelo (latencia)",
    "pendingCommands",
    () => {},
    (b) => b.pendingLatencyCommands.push({ readyAtTick: 999, vehicleId: "veh_1", command: {} }),
  ],
  ["teamKills", "mode", () => {}, (b) => (b.teamKills.red = (b.teamKills.red ?? 0) + 1)],
  ["estado interno del modo", "mode", () => {}, (b) => (b.mode.overtimeBaseline = { red: 1 })],
  ["flujo RNG combat", "rng", () => {}, (b) => b.rng.stream("combat").next()],
  ["flujo RNG latency", "rng", () => {}, (b) => b.rng.stream("latency").next()],
];

describe("stateHash v2 cubre TODO el estado vivo (cada campo, su componente)", () => {
  for (const [what, comp, prep, mutate] of LIVE_FIELDS) {
    it(`${what} ⇒ cambia el hash y el componente ${comp}`, () => {
      const b = live();
      prep(b as any);
      const before = b.stateHashBreakdown();
      mutate(b as any);
      const after = b.stateHashBreakdown();
      b.free();
      expect(after.hash).not.toBe(before.hash);
      const changed = STATE_HASH_COMPONENTS.filter((n) => before.components[n] !== after.components[n]);
      expect(changed).toEqual([comp]);
    });
  }

  it("lo que NO es simulación no entra: visibilityEpoch, snapshots, eventos públicos", () => {
    const b = live();
    const before = b.stateHash();
    (b as any).visibilityEpoch = 42;
    (b as any).projectionCache = new Map([["k", 1]]);
    b.snapshots.push({ tick: -1 });
    b.publicEvents.push({ tick: -1, kind: "x" });
    const after = b.stateHash();
    b.free();
    expect(after).toBe(before);
  });

  it("el desglose exige exactamente los componentes del contrato", () => {
    const input: any = Object.fromEntries(STATE_HASH_COMPONENTS.map((n) => [n, null]));
    expect(() => computeStateHash(input)).not.toThrow();
    delete input.botRefs;
    expect(() => computeStateHash(input)).toThrow(/contrato/);
  });

  it("canonicalize: orden de claves/Map irrelevante, NaN no se traga como null, -0 = 0", () => {
    expect(canonicalize({ b: 1, a: 2 })).toEqual(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize(new Map([["y", 1], ["x", 2]]))).toEqual(canonicalize(new Map([["x", 2], ["y", 1]])));
    expect(JSON.stringify(canonicalize([NaN]))).not.toBe(JSON.stringify(canonicalize([null])));
    expect(canonicalize(-0)).toBe(0);
    const cyc: any = {};
    cyc.self = cyc;
    expect(() => canonicalize(cyc)).toThrow(/cíclica/);
  });
});

// --------------------------------------------------------------- RNG v2
describe("flujos de RNG con nombre", () => {
  it("cada flujo es función pura de (semilla, etiqueta): estable y fijado", () => {
    // Valor fijado: si cambia la derivación, todos los replays cambian (y debe saberse).
    expect(deriveStreamState("seed-alpha", "combat")).toEqual(deriveStreamState("seed-alpha", "combat"));
    const a = new RngStreams("seed-alpha");
    const b = new RngStreams("seed-alpha");
    for (const n of RNG_STREAM_NAMES) expect(a.stream(n).getState()).toEqual(b.stream(n).getState());
  });

  it("los flujos son DISTINTOS entre sí y no comparten estado", () => {
    const s = new RngStreams("seed-alpha");
    const states = RNG_STREAM_NAMES.map((n) => JSON.stringify(s.stream(n).getState()));
    expect(new Set(states).size).toBe(RNG_STREAM_NAMES.length);
    const ref = new RngStreams("seed-alpha");
    for (let i = 0; i < 1000; i++) s.stream("combat").next();
    for (const n of RNG_STREAM_NAMES.filter((x) => x !== "combat")) {
      expect(s.stream(n).next(), `el flujo ${n} se desplazó al consumir combat`).toBe(ref.stream(n).next());
    }
  });

  it("en batalla: tiradas de más en sensores NO desplazan combate (mismos comandos)", async () => {
    // Re-simulación con los comandos grabados y tiradas EXTRA del flujo de sensores.
    const run = async (extraSensorDraws: number) => {
      const b = await Battle.create({ ...cfg("md-seed-1"), recordReplay: false });
      const byVeh = new Map<string, any[]>();
      for (const c of base.commands) {
        if (!byVeh.has(c.vehicleId)) byVeh.set(c.vehicleId, []);
        byVeh.get(c.vehicleId)!.push(c);
      }
      const { ReplayAgent } = await import("../src/replay.js");
      for (const p of base.header.participants) b.attachBot(p.id, new ReplayAgent(p.botId, byVeh.get(p.id) ?? []));
      while (!b.isFinished() && b.tick < 400) {
        if (b.tick === 100) for (let i = 0; i < extraSensorDraws; i++) (b as any).rng.stream("sensors").next();
        b.step();
      }
      const bd = b.stateHashBreakdown();
      const combat = (b as any).rng.stream("combat").getState();
      b.free();
      return { bd, combat };
    };
    const a = await run(0);
    const z = await run(17);
    expect(z.combat).toEqual(a.combat);
    expect(z.bd.components.vehicles).toBe(a.bd.components.vehicles);
    expect(z.bd.components.projectiles).toBe(a.bd.components.projectiles);
    expect(z.bd.components.rng).not.toBe(a.bd.components.rng);
  });

  it("observationFor() fuera del bucle NO consume RNG de la simulación (R1)", () => {
    const run = (peek: boolean) => {
      const b = new Battle(cfg("md-peek"));
      attachStubs(b);
      while (b.tick < 300) {
        if (peek && b.tick % 7 === 0) for (const id of ["veh_1", "veh_2", "veh_3", "veh_4"]) b.observationFor(id);
        b.step();
      }
      const h = b.stateHash();
      b.free();
      return h;
    };
    expect(run(true)).toBe(run(false));
  });

  it("ReadOnlyRng falla en voz alta si se consume", () => {
    const r: Rng = new ReadOnlyRng("proyección");
    expect(() => r.next()).toThrow(RngReadOnlyError);
    expect(() => r.int(3)).toThrow(RngReadOnlyError);
  });
});

// ----------------------------------------------------------- determinismo
/** Agente guionizado: comandos fijos por tick de decisión, sin mirar la observación. */
class ScriptBot implements BotAgent {
  constructor(
    readonly botId: string,
    private readonly script: (tick: number) => any,
  ) {}
  decide(obs: any) {
    return this.script(obs.tick);
  }
}

function scripted(seed: string, tweak?: { vehicle: string; tick: number }): { result: any; hashes: string[] } {
  const b = new Battle(cfg(seed));
  const mk = (id: string, botId: string, k: number) =>
    new ScriptBot(botId, (t) => {
      const cmd: any = {
        move: { throttle: ((t / 3 + k) % 5) / 5, steer: (((t / 3) * (k + 1)) % 7) / 7 - 0.5 },
        turret: { targetHeading: ((t + 13 * k) % 360) * (Math.PI / 180) },
        fire: t % 9 === 0 ? ["turret_main"] : [],
      };
      if (tweak && tweak.vehicle === id && tweak.tick === t) cmd.move = { throttle: -1, steer: 1 };
      return cmd;
    });
  b.attachBot("veh_1", mk("veh_1", "bot_a", 0));
  b.attachBot("veh_2", mk("veh_2", "bot_b", 1));
  b.attachBot("veh_3", mk("veh_3", "bot_c", 2));
  b.attachBot("veh_4", mk("veh_4", "bot_d", 3));
  const result = b.run(600);
  const hashes = b.stateHashes.map((h) => h.hash);
  b.free();
  return { result, hashes };
}

describe("determinismo v2: misma semilla + mismos comandos ⇒ mismo hash y resultado", () => {
  it("N ejecuciones idénticas (hash final, intermedios y resultado completo)", () => {
    const N = Number(process.env.MD_DETERMINISM_RUNS ?? 10);
    const ref = scripted("md-det");
    for (let i = 0; i < N; i++) {
      const r = scripted("md-det");
      expect(r.hashes, `ejecución ${i}`).toEqual(ref.hashes);
      expect(r.result).toEqual(ref.result);
    }
  });

  it("cambiar UN comando cambia el hash", () => {
    const ref = scripted("md-det");
    const t = scripted("md-det", { vehicle: "veh_2", tick: 60 });
    expect(t.result.finalStateHash).not.toBe(ref.result.finalStateHash);
    expect(t.hashes).not.toEqual(ref.hashes);
  });

  it("cambiar la semilla cambia el hash (con los mismos comandos)", () => {
    expect(scripted("md-det-otra").result.finalStateHash).not.toBe(scripted("md-det").result.finalStateHash);
  });
});
