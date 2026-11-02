/**
 * EQ2 · ADR-022 · Motor 0.4.0: prórroga de CTF, criterio `kills` y vidas exactas para
 * maxRespawns 0, 1, 2 y N. Todo con la simulación REAL (Battle + Rapier).
 *
 * La prueba más fuerte de «la prórroga no reinicia el estado»: la batalla con tiempo
 * reglamentario corto y prórroga captura EXACTAMENTE en el mismo tick que la misma
 * batalla sin límite de tiempo. Si la prórroga recolocara bots
 * o banderas, el tick cambiaría.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { OVERTIME_TECHNICAL_LIMIT_TICKS, loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { resolveRulesRequest } from "../../../packages/game-rules/battle-rules.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { resolveTimeoutTiebreak, type ModeContext } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, emptyArena, gunnerLoadout, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { FlagRunnerBot, HunterBot, IdleBot } from "../src/stubs.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { fromJsonl, record, toJsonl, verify } from "../src/replay.js";

beforeAll(async () => {
  await initPhysics();
});

function ctfPreset(): Ruleset {
  const r = resolveRulesRequest({ preset: "ctf", teamSize: 2 });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.engineRuleset;
}

const ctfParts = (): Participant[] => [
  { id: "veh_1", botId: "runner", team: "red", spec: scoutLoadout() },
  { id: "veh_2", botId: "idle", team: "blue", spec: sandbagLoadout() },
];

function ctfBattle(ruleset: Ruleset, runner = true) {
  const map = ctfArena();
  const b = new Battle({ battleId: "ot", seed: "ot-seed", ruleset, map, participants: ctfParts() });
  const blueFlag = map.flags.find((f) => f.team === "blue")!.position;
  const redBase = map.bases.find((x) => x.team === "red")!.position;
  b.attachBot("veh_1", runner ? new FlagRunnerBot("runner", blueFlag, redBase) : new IdleBot("runner"));
  b.attachBot("veh_2", new IdleBot("idle"));
  return b;
}

describe("CTF · prórroga (next_score_wins)", () => {
  it("sin capturas: prórroga sin límite competitivo hasta la salvaguarda TÉCNICA, que NO es un empate", () => {
    const rs: Ruleset = { ...ctfPreset(), timeLimitTicks: 90 };
    const b = ctfBattle(rs, false);
    const res = b.run(200_000);
    // Detenida por la salvaguarda técnica: sin resultado deportivo, nunca "draw".
    expect(res.endReason).toBe("technical_limit");
    expect(res.winner).toBeNull();
    expect(res.winner).not.toBe("draw");
    expect(res.ticks).toBe(90 + OVERTIME_TECHNICAL_LIMIT_TICKS);
    const ot = b.publicEvents.filter((e: any) => e.kind === "overtime_started");
    expect(ot).toHaveLength(1);
    expect(ot[0]).toMatchObject({
      tick: 90,
      score: { red: 0, blue: 0 },
      technicalLimitTicks: OVERTIME_TECHNICAL_LIMIT_TICKS,
    });
    expect(b.publicEvents.filter((e: any) => e.kind === "technical_limit")).toHaveLength(1);
    expect(b.snapshots.at(-1).overtime).toBe(true);
    b.free();
  }, 120_000);

  it("prórroga SIN tope de 3 min: un empate al tiempo sigue más allá de 3 min y la primera captura gana", () => {
    // El corredor espera quieto 8 minutos (14 400 ticks) y luego va a por la bandera.
    const map = ctfArena();
    const late = new FlagRunnerBot(
      "runner",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    );
    const lazy = { botId: "runner", decide: (obs: any) => (obs.tick < 14_400 ? {} : late.decide(obs)) };
    const b = new Battle({
      battleId: "ot-late",
      seed: "ot-late",
      ruleset: { ...ctfPreset(), timeLimitTicks: 90 },
      map,
      participants: ctfParts(),
    });
    b.attachBot("veh_1", lazy as never);
    b.attachBot("veh_2", new IdleBot("idle"));
    const res = b.run(200_000);
    expect(res.endReason).toBeUndefined();
    expect(res.winner).toBe("red");
    expect(res.score).toEqual({ red: 1, blue: 0 });
    expect(res.ticks).toBeGreaterThan(90 + 3 * 60 * 30); // más de 3 min de prórroga
    expect(res.ticks).toBeGreaterThan(14_400);
    b.free();
  }, 120_000);

  it("la siguiente captura gana y el estado NO se reinicia (mismo tick y hash que sin límite)", () => {
    // Referencia: misma batalla sin límite de tiempo efectivo.
    const ref = ctfBattle({ ...ctfPreset(), scoreToWin: 1, timeLimitTicks: 100_000 });
    const refRes = ref.run(20_000);
    ref.free();
    expect(refRes.winner).toBe("red");
    const captureTick = refRes.ticks;
    expect(captureTick).toBeGreaterThan(120);

    // Tiempo reglamentario 60 ticks antes de la captura: 0-0 ⇒ prórroga ⇒ la captura gana.
    const rs: Ruleset = { ...ctfPreset(), timeLimitTicks: captureTick - 60 };
    const b = ctfBattle(rs);
    const res = b.run(20_000);
    expect(res.winner).toBe("red");
    expect(res.score).toEqual({ red: 1, blue: 0 });
    expect(res.ticks).toBe(captureTick);
    expect(b.publicEvents.find((e: any) => e.kind === "overtime_started")?.tick).toBe(captureTick - 60);
    b.free();
    // Control: la misma batalla SIN prórroga declarada acaba en tablas al agotar el tiempo.
    const ctrl = ctfBattle({ ...ctfPreset(), timeLimitTicks: captureTick - 60, overtime: undefined });
    const ctrlRes = ctrl.run(20_000);
    ctrl.free();
    // Sin prórroga, la misma batalla termina en tablas al acabar el tiempo: es la prórroga
    // la que decide, no otra cosa.
    expect(ctrlRes.winner).toBe("draw");
    expect(ctrlRes.ticks).toBe(captureTick - 60);
  }, 60_000);

  it("sin empate al acabar el tiempo no hay prórroga: gana quien tenga más capturas", () => {
    const ref = ctfBattle({ ...ctfPreset(), scoreToWin: 1, timeLimitTicks: 100_000 });
    const t = ref.run(20_000).ticks;
    ref.free();
    const b = ctfBattle({ ...ctfPreset(), scoreToWin: 5, timeLimitTicks: t + 30 });
    const res = b.run(20_000);
    expect(res.winner).toBe("red");
    expect(res.ticks).toBe(t + 30);
    expect(b.publicEvents.some((e: any) => e.kind === "overtime_started")).toBe(false);
    b.free();
  }, 60_000);

  it("una batalla con prórroga se graba y se VERIFICA (determinismo de 0.4.0)", async () => {
    const rs: Ruleset = { ...ctfPreset(), timeLimitTicks: 300 };
    const map = ctfArena();
    const replay = await record(
      { battleId: "ot-rec", seed: "ot-rec", ruleset: rs, map, participants: ctfParts() },
      (b) => {
        b.attachBot(
          "veh_1",
          new FlagRunnerBot(
            "runner",
            map.flags.find((f) => f.team === "blue")!.position,
            map.bases.find((x) => x.team === "red")!.position,
          ),
        );
        b.attachBot("veh_2", new IdleBot("idle"));
      },
    );
    expect(replay.header.versions.engine).toBe("0.4.0");
    expect(replay.header.ruleset.overtime).toEqual({ kind: "next_score_wins" });
    const v = await verify(fromJsonl(toJsonl(replay)));
    expect(v.matches).toBe(true);
  }, 60_000);

  it("los rulesets clásicos (sin overtime) no entran en prórroga: ctf_mvp@1 empatado acaba en draw", () => {
    const b = ctfBattle(loadRuleset("ctf_mvp@1", { timeLimitTicks: 90 }), false);
    const res = b.run(10_000);
    expect(res.winner).toBe("draw");
    expect(res.ticks).toBe(90);
    expect(b.publicEvents.some((e: any) => e.kind === "overtime_started")).toBe(false);
    b.free();
  });
});

// ------------------------------------------------------------------ desempate
function veh(id: string, team: string, alive: boolean, used = 0) {
  const v = new Vehicle(id, team, id, gunnerLoadout());
  v.alive = alive;
  v.respawnsUsed = used;
  return v;
}
function ctx(vehicles: Vehicle[], ruleset: Ruleset, kills: Record<string, number> = {}): ModeContext {
  return { tick: 0, ruleset, vehicles, poses: new Map(), map: emptyArena(), emit: () => {}, kills };
}

describe("criterios de desempate de 0.4.0", () => {
  const limited = loadRuleset("tdm_mvp@1", { respawn: { enabled: true, delayTicks: 150, maxRespawns: 2 } });
  const none = loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 } });
  const teams = ["red", "blue"];

  it("kills: decide cuando puntos y vivos empatan; sin dato, 0", () => {
    const c = ctx([veh("a", "red", true), veh("b", "blue", true)], limited, { red: 3, blue: 2 });
    expect(resolveTimeoutTiebreak(["score", "kills"], teams, { red: 1, blue: 1 }, c)).toBe("red");
    expect(resolveTimeoutTiebreak(["kills"], teams, {}, ctx(c.vehicles, limited))).toBe("draw");
  });
  it("alive cuenta vivos no descalificados; respawns_left suma reapariciones restantes", () => {
    const a = veh("a", "red", true, 2); // vivo, sin reapariciones
    const b = veh("b", "blue", false, 0); // muerto, 2 reapariciones
    const c = ctx([a, b], limited);
    expect(resolveTimeoutTiebreak(["alive"], teams, {}, c)).toBe("red");
    expect(resolveTimeoutTiebreak(["respawns_left"], teams, {}, c)).toBe("blue");
    expect(resolveTimeoutTiebreak(["lives"], teams, {}, c)).toBe("blue"); // 1 frente a 2
    const dq = veh("c", "red", true);
    dq.disqualified = true;
    expect(resolveTimeoutTiebreak(["alive"], teams, {}, ctx([dq, veh("d", "blue", false)], none))).toBe("draw");
  });
  it("orden del respawn limitado: puntos → vivos → reapariciones → bajas → empate", () => {
    const crit = ["score", "alive", "respawns_left", "kills"] as const;
    const v = [veh("a", "red", true, 1), veh("b", "blue", true, 1)];
    expect(resolveTimeoutTiebreak([...crit], teams, { red: 2, blue: 3 }, ctx(v, limited))).toBe("blue");
    expect(resolveTimeoutTiebreak([...crit], teams, { red: 3, blue: 3 }, ctx(v, limited, { red: 1, blue: 4 }))).toBe(
      "blue",
    );
    expect(resolveTimeoutTiebreak([...crit], teams, { red: 3, blue: 3 }, ctx(v, limited, { red: 4, blue: 4 }))).toBe(
      "draw",
    );
  });
  it("la batalla pasa las bajas ENEMIGAS reales al desempate", () => {
    const b = new Battle({
      battleId: "k",
      seed: "k",
      ruleset: loadRuleset("tdm_mvp@1", {
        scoreToWin: 99,
        timeLimitTicks: 100_000,
        respawn: { enabled: true, delayTicks: 30 },
      }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "h", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "i", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new HunterBot("h"));
    b.attachBot("veh_2", new IdleBot("i"));
    for (let t = 0; t < 3000; t++) b.step();
    const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed" && e.targetId === "veh_2").length;
    expect(deaths).toBeGreaterThan(0);
    expect((b as any).teamKills.red).toBe(deaths);
    expect((b as any).teamKills.blue ?? 0).toBe(0);
    b.free();
  }, 60_000);
});

// ----------------------------------------------------------------- vidas 0..N
describe("reapariciones agotadas en 2v2: el bot NO vuelve aunque la batalla siga", () => {
  for (const n of [0, 2]) {
    it(`maxRespawns ${n}: tras ${n + 1} muertes queda fuera y su compañero mantiene la batalla`, () => {
      const r = resolveRulesRequest({
        preset: "custom",
        teamSize: 2,
        params: {
          respawn: { mode: "limited", maxRespawns: n, delaySeconds: 1 },
          victory: "elimination",
          timeLimitMinutes: 10,
        },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      const b = new Battle({
        battleId: `lives2-${n}`,
        seed: "lives2",
        ruleset: r.engineRuleset,
        map: emptyArena(),
        participants: ["red", "red", "blue", "blue"].map((team, i) => ({
          id: `veh_${i + 1}`,
          botId: `b${i}`,
          team,
          spec: gunnerLoadout(),
        })),
      });
      for (let i = 1; i <= 4; i++) b.attachBot(`veh_${i}`, new IdleBot(`b${i}`));
      const victim = b.getVehicles().find((v) => v.id === "veh_3")!;
      let kills = 0;
      for (let t = 0; t < 3000; t++) {
        if (victim.alive && kills < n + 1 && t % 10 === 0) {
          const poses = (b as any).poses();
          (b as any).damageVehicle(victim, 1e9, poses.get("veh_1").position, poses, "veh_1", "red");
          kills++;
        }
        b.step();
      }
      expect(b.isFinished()).toBe(false);
      expect(kills).toBe(n + 1);
      expect(victim.alive).toBe(false);
      expect(victim.respawnsUsed).toBe(n);
      b.free();
    }, 60_000);
  }
});

describe("maxRespawns 0, 1, 2 y N: vidas = maxRespawns + 1 en el motor", () => {
  for (const n of [0, 1, 2, 6]) {
    it(`maxRespawns ${n}: muere ${n + 1} veces, reaparece ${n} y queda eliminado (gana el rival)`, () => {
      const r = resolveRulesRequest({
        preset: "custom",
        teamSize: 1,
        params: {
          respawn: { mode: "limited", maxRespawns: n, delaySeconds: 1 },
          victory: "elimination",
          timeLimitMinutes: 10,
        },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      const b = new Battle({
        battleId: `lives-${n}`,
        seed: "lives",
        ruleset: r.engineRuleset,
        map: emptyArena(),
        participants: [
          { id: "veh_1", botId: "a", team: "red", spec: gunnerLoadout() },
          { id: "veh_2", botId: "b", team: "blue", spec: gunnerLoadout() },
        ],
      });
      b.attachBot("veh_1", new IdleBot("a"));
      b.attachBot("veh_2", new IdleBot("b"));
      const victim = b.getVehicles().find((v) => v.id === "veh_2")!;
      let kills = 0;
      for (let t = 0; t < 20_000 && !b.isFinished(); t++) {
        if (victim.alive && t % 10 === 0) {
          // Muerte provocada por el rival (camino real de daño: onKill, puntuación, eliminación).
          const poses = (b as any).poses();
          (b as any).damageVehicle(victim, 1e9, poses.get("veh_1").position, poses, "veh_1", "red");
          kills++;
        }
        if (!b.isFinished()) b.step();
      }
      const res = b.getResult()!;
      expect(res.winner).toBe("red");
      expect(kills).toBe(n + 1);
      expect(victim.respawnsUsed).toBe(n);
      expect(b.publicEvents.filter((e: any) => e.kind === "vehicle_eliminated")).toHaveLength(1);
      b.free();
    }, 60_000);
  }
});
