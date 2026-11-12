/**
 * R-ENGINE (ADR-021) · respawn LIMITADO, eliminación con vidas y desempate declarado.
 *
 * 1. Regresión de hashes: las configuraciones grabables en producción (rulesets del
 *    catálogo, sin los campos nuevos) dan EXACTAMENTE el hash del motor de `9aaad79`
 *    (medido con `git archive origin/main` y el mismo escenario).
 * 2. Comportamiento nuevo: `respawn.maxRespawns` y `timeoutTiebreak`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { engineRulesetFor, resolveRulesRequest } from "../../../packages/game-rules/battle-rules.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { resolveTimeoutTiebreak, type ModeContext } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, emptyArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { HunterBot, IdleBot } from "../src/stubs.js";
import { Vehicle } from "../src/sim/vehicle.js";

beforeAll(async () => {
  await initPhysics();
});

function roster(perSide: number, dm = false): Participant[] {
  const parts: Participant[] = [];
  for (let i = 0; i < perSide * 2; i++) {
    parts.push({
      id: `veh_${i + 1}`,
      botId: `b${i + 1}`,
      team: dm ? `t${i}` : i % 2 === 0 ? "red" : "blue",
      spec: i % 3 === 2 ? scoutLoadout() : gunnerLoadout(),
    });
  }
  return parts;
}

function battle(
  ruleset: Ruleset,
  parts: Participant[],
  map = emptyArena(),
  bot: "hunter" | "idle" = "hunter",
  seed = "rules-seed",
) {
  const b = new Battle({ battleId: "rr", seed, ruleset, map, participants: parts, recordReplay: true });
  for (const p of parts) b.attachBot(p.id, bot === "hunter" ? new HunterBot(p.botId) : new IdleBot(p.botId));
  return b;
}

function runFor(b: Battle, ticks: number) {
  for (let t = 0; t < ticks && !b.isFinished(); t++) b.step();
}

// Anclas de 9aaad79 (`.local/scratch/hashes.ts` sobre `git archive origin/main`), RE-ANCLADAS en OLA2-MB
// con los valores medidos en 741a2a7: las cambian (a) el orden por slot de los candidatos de módulo,
// (b) el hp del blindaje (= hp del módulo) y (c) la normalización de turretHeading. Con las tres
// revertidas vuelven EXACTAMENTE los hashes de 9aaad79 (experimento mb-atribucion.py).
// RE-ANCLADAS otra vez en la integración OLA2 (M0-I, MD+MB): hash v2 por componentes + flujos RNG con
// nombre (MD) + las causas a/b/c de MB + armor.profile en el estado. Con a/b/c revertidas, los ticks
// vuelven a ser los de MD (778/2801/1084…) y sólo difiere el componente `vehicles` (armor.profile).
// tdm_4v4_norespawn llega ahora al límite de tiempo (6000) en vez de acabar por eliminación.
const HASHES_9AAAD79 = {
  dm_1v1: { hash: "7b1b74e3c8b05e4e87aef8b56b10c44f4dc4139a6b4f94218448c802b226161f", tick: 469 },
  tdm_1v1: { hash: "df7b19ab8c88a3e1da243c93d76c837fc0ec0b06900259f4e92ead2f405c83f8", tick: 3000 },
  tdm_2v2: { hash: "0af19ee467fcb2ff76059fcafb8e3010daa8ea9bfe80e1e0e9bca50d9d27a2a5", tick: 3000 },
  tdm_4v4: { hash: "682cd1e9276a3ca00aa465efc44dfb842fe85b00778972208f2a37284d4eefbb", tick: 2371 },
  tdm_4v4_norespawn: { hash: "86544a85f9a0ae80752970b3fcaafb18a9e8a6b2295059db6734b14574092b98", tick: 6000 },
  ctf_1v1: { hash: "960c80cc76e70e3028d2bac75eaa30df4db63da3ce7215e39357dbda2d1e4578", tick: 2000 },
};

describe("regresión · configuraciones existentes = hash de 9aaad79", () => {
  const cases: [keyof typeof HASHES_9AAAD79, string, number, any, number, Partial<Ruleset>][] = [
    ["dm_1v1", "dm_practice@1", 1, emptyArena(), 3000, {}],
    ["tdm_1v1", "tdm_mvp@1", 1, emptyArena(), 3000, {}],
    ["tdm_2v2", "tdm_mvp@1", 2, emptyArena(), 3000, {}],
    ["tdm_4v4", "tdm_mvp@1", 4, emptyArena(), 3000, {}],
    [
      "tdm_4v4_norespawn",
      "tdm_mvp@1",
      4,
      emptyArena(),
      6000,
      { respawn: { enabled: false, delayTicks: 0 }, scoreToWin: 99 },
    ],
    ["ctf_1v1", "ctf_mvp@1", 1, ctfArena(), 2000, {}],
  ];
  for (const [key, rs, n, map, ticks, over] of cases) {
    it(`${key} (${rs}, ${n}v${n})`, () => {
      const b = battle(loadRuleset(rs, over), roster(n, rs.startsWith("dm")), map);
      runFor(b, ticks);
      expect({ hash: b.stateHash(), tick: b.tick }).toEqual(HASHES_9AAAD79[key]);
      b.free();
    });
  }
});

/** Ruleset TDM con respawn limitado y sin límite de bajas: sólo termina por eliminación. */
function limited(maxRespawns: number, delayTicks = 30): Ruleset {
  return loadRuleset("tdm_mvp@1", {
    rulesetId: "test-limited",
    scoreToWin: Number.MAX_SAFE_INTEGER,
    timeLimitTicks: 40_000,
    respawn: { enabled: true, delayTicks, maxRespawns },
  });
}

/** OLA2-MD · semilla en la que los 2v2 de respawn limitado acaban por eliminación (buscada). */
const SEED_2V2_ELIM = "rules-seed-3";

function eliminations(b: Battle) {
  return b.publicEvents.filter((e: any) => e.kind === "vehicle_eliminated");
}

describe("respawn limitado", () => {
  it("1v1 con 1 respawn: el perdedor muere 2 veces, reaparece 1 y queda eliminado; gana el otro", () => {
    const b = battle(limited(1), roster(1));
    runFor(b, 40_000);
    expect(b.isFinished()).toBe(true);
    const r = b.getResult()!;
    expect(r.ticks).toBeLessThan(40_000); // eliminación, no tiempo
    const loser = b.getVehicles().find((v) => v.team !== r.winner)!;
    expect(r.winner).not.toBe("draw");
    expect(loser.alive).toBe(false);
    expect(loser.respawnsUsed).toBe(1);
    const elim = eliminations(b);
    expect(elim).toEqual([{ tick: r.ticks, kind: "vehicle_eliminated", targetId: loser.id, team: loser.team }]);
    const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed" && e.targetId === loser.id);
    expect(deaths).toHaveLength(2);
    b.free();
  });

  it("varios respawns (3): nunca reaparece más de 3 veces y termina por eliminación", () => {
    const b = battle(limited(3), roster(1));
    runFor(b, 40_000);
    const r = b.getResult()!;
    expect(r.ticks).toBeLessThan(40_000);
    for (const v of b.getVehicles()) expect(v.respawnsUsed).toBeLessThanOrEqual(3);
    const loser = b.getVehicles().find((v) => v.team !== r.winner)!;
    expect(loser.respawnsUsed).toBe(3);
    expect(b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed" && e.targetId === loser.id)).toHaveLength(
      4,
    );
    b.free();
  });

  it("maxRespawns 0 con respawn activo equivale a una sola vida: termina en la primera baja", () => {
    const b = battle(limited(0), roster(1));
    runFor(b, 40_000);
    const r = b.getResult()!;
    const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed");
    expect(deaths).toHaveLength(1);
    expect(r.ticks).toBe(deaths[0].tick);
    b.free();
  });

  it("2v2 con 1 respawn: la batalla no acaba mientras un bando conserve vidas, y acaba al agotarlas", () => {
    // Termina POR CONSTRUCCIÓN: rojo caza, azul está inmóvil (IdleBot) y rojo parte con munición
    // sobrada. Diagnóstico (MB, VM112): con la dotación de serie, el artillero rojo gasta sus 40 AP
    // hacia el tick 1392 y la munición SÓLO se repone al reaparecer (regla de juego, no hay
    // reabastecimiento de supervivientes), y el explorador rojo no lleva radar (HunterBot nunca ve
    // contactos): el combate se estanca con azul vivo. Eso es idéntico en f07ff6f (previo a MB).
    // Aquí la munición no es el factor: el resultado no depende de la trayectoria ni del RNG.
    const parts = roster(2);
    const b = new Battle({
      battleId: "rr",
      seed: "rules-seed",
      ruleset: limited(1),
      map: emptyArena(),
      participants: parts,
      recordReplay: true,
    });
    for (const p of parts) b.attachBot(p.id, p.team === "red" ? new HunterBot(p.botId) : new IdleBot(p.botId));
    for (const v of b.getVehicles().filter((x) => x.team === "red"))
      for (const a of v.modulesOf("ammo")) a.ammo = 100_000;
    const blue = () => b.getVehicles().filter((v) => v.team === "blue");
    for (let t = 0; t < 40_000 && !b.isFinished(); t++) {
      b.step();
      // Invariante de vidas: mientras la batalla siga, algún azul vive o aún tiene un respawn por gastar.
      if (!b.isFinished()) expect(blue().some((v) => v.alive || v.respawnsUsed < 1)).toBe(true);
    }
    expect(b.isFinished()).toBe(true);
    const r = b.getResult()!;
    expect(r.ticks).toBeLessThan(40_000); // eliminación, no tiempo
    expect(r.winner).toBe("red");
    for (const v of blue()) {
      expect(v.alive).toBe(false);
      expect(v.respawnsUsed).toBe(1);
    }
    expect(
      eliminations(b)
        .map((e: any) => e.targetId)
        .sort(),
    ).toEqual(
      expect.arrayContaining(
        blue()
          .map((v) => v.id)
          .sort(),
      ),
    );
    b.free();
  });

  it("el retardo de respawn se respeta: reaparece exactamente delayTicks después de morir", () => {
    const b = battle(limited(5, 90), roster(1));
    const deathTick = new Map<string, number>();
    let checked = 0;
    for (let t = 0; t < 40_000 && !b.isFinished(); t++) {
      const before = b.getVehicles().map((v) => ({ id: v.id, alive: v.alive }));
      b.step();
      for (const v of b.getVehicles()) {
        const prev = before.find((x) => x.id === v.id)!;
        if (prev.alive && !v.alive) deathTick.set(v.id, b.tick);
        if (!prev.alive && v.alive) {
          expect(b.tick - deathTick.get(v.id)!).toBe(90);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    b.free();
  });

  it("es determinista: misma semilla y reglas ⇒ mismos hashes por segundo y mismo resultado", () => {
    const a = battle(limited(2), roster(2));
    runFor(a, 40_000);
    const b2 = battle(limited(2), roster(2));
    runFor(b2, 40_000);
    expect(b2.getResult()).toEqual(a.getResult());
    expect(b2.stateHashes).toEqual(a.stateHashes);
    a.free();
    b2.free();
  });

  it("el contador de respawns entra en el hash (v2: siempre)", () => {
    const b = battle(limited(2), roster(1));
    runFor(b, 5);
    const h1 = b.stateHash();
    b.getVehicles()[0].respawnsUsed = 1;
    expect(b.stateHash()).not.toBe(h1);
    b.free();
    const old = battle(loadRuleset("tdm_mvp@1"), roster(1));
    runFor(old, 5);
    const h2 = old.stateHash();
    old.getVehicles()[0].respawnsUsed = 1;
    // OLA2-MD · hash v2: TODO el estado de Vehicle entra, también sin respawn limitado.
    expect(old.stateHash()).not.toBe(h2);
    old.free();
  });

  it("los bots NO reciben vehicle_eliminated (no está en el esquema EVENT de arena/1)", () => {
    // 2v2 con una sola vida: tras la PRIMERA eliminación la batalla sigue y todos los
    // bots vuelven a decidir, así que un evento repartido les llegaría por onEvent.
    const b = battle(limited(0), roster(2), emptyArena(), "hunter", SEED_2V2_ELIM);
    const seen: string[] = [];
    for (const v of b.getVehicles()) {
      const inner = new HunterBot(v.botId);
      b.attachBot(v.id, {
        botId: v.botId,
        decide: (obs: any) => inner.decide(obs),
        onEvent: (e: any) => seen.push(e.kind),
      });
    }
    runFor(b, 40_000);
    const elim = eliminations(b);
    expect(elim.length).toBeGreaterThanOrEqual(2);
    expect(elim[0].tick).toBeLessThan(b.getResult()!.ticks); // hubo decisiones después
    expect(seen).toContain("vehicle_destroyed"); // el canal funciona
    expect(seen).not.toContain("vehicle_eliminated");
    b.free();
  });
});

describe("límite de puntuación y de tiempo con presets", () => {
  it("1v1 sin respawn (Duelo): la primera baja termina la batalla", () => {
    const r = resolveRulesRequest({ preset: "duel", teamSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const b = battle(r.engineRuleset, roster(1, true));
    runFor(b, 10_000);
    const res = b.getResult()!;
    const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed");
    expect(deaths).toHaveLength(1);
    expect(res.ticks).toBe(deaths[0].tick);
    b.free();
  });

  it("score limit: Combate 1v1 termina al llegar a 5 bajas, no antes", () => {
    const r = resolveRulesRequest({ preset: "combat", teamSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const rs = { ...r.engineRuleset, respawn: { ...r.engineRuleset.respawn, delayTicks: 30 } };
    const b = battle(rs, roster(1, true));
    runFor(b, rs.timeLimitTicks);
    const res = b.getResult()!;
    expect(Math.max(...Object.values(res.score))).toBe(5);
    expect(res.ticks).toBeLessThan(rs.timeLimitTicks);
    b.free();
  });

  it("time limit: con IdleBots la batalla dura exactamente timeLimitTicks", () => {
    const p = resolveRulesRequest({ preset: "team_endurance", teamSize: 2 });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const rs = { ...p.engineRuleset, timeLimitTicks: 300 };
    const b = battle(rs, roster(2), emptyArena(), "idle");
    runFor(b, 1000);
    expect(b.getResult()!.ticks).toBe(300);
    expect(b.getResult()!.winner).toBe("draw"); // 0-0
    b.free();
  });

  it("Duelo al agotar el tiempo: el casco YA NO desempata (ADR-022: vivos → vidas → bajas → empate)", () => {
    const r = resolveRulesRequest({ preset: "duel", teamSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const rs = { ...r.engineRuleset, timeLimitTicks: 60 };
    const b = battle(rs, roster(1, true), emptyArena(), "idle");
    runFor(b, 10);
    const [v1, v2] = b.getVehicles();
    v2.hullHp = v2.spec.hullHp * 0.5; // dañado, pero vivo: mismos vivos, vidas y bajas
    runFor(b, 1000);
    expect(v1.alive && v2.alive).toBe(true);
    expect(b.getResult()!.winner).toBe("draw");
    b.free();
  });

  it("Duelo al agotar el tiempo con el mismo casco: tablas", () => {
    const r = resolveRulesRequest({ preset: "duel", teamSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const rs = { ...r.engineRuleset, timeLimitTicks: 60 };
    const parts = roster(1, true).map((p) => ({ ...p, spec: gunnerLoadout() }));
    const b = battle(rs, parts, emptyArena(), "idle");
    runFor(b, 1000);
    expect(b.getResult()!.winner).toBe("draw");
    b.free();
  });
});

describe("resolveTimeoutTiebreak (pura)", () => {
  function ctx(rs: Ruleset, vs: Vehicle[]): ModeContext {
    return { tick: 0, ruleset: rs, vehicles: vs, poses: new Map(), map: emptyArena(), emit: () => {} };
  }
  function veh(id: string, team: string, alive = true, used = 0, hullFrac = 1) {
    const v = new Vehicle(id, team, id, gunnerLoadout());
    v.alive = alive;
    v.respawnsUsed = used;
    v.hullHp = v.spec.hullHp * hullFrac;
    return v;
  }
  const rs = limited(2);

  it("lives: vivos + reapariciones restantes", () => {
    // red: 1 vivo (2 restantes) = 3 · blue: 1 muerto con 1 restante = 1
    const c = ctx(rs, [veh("a", "red", true, 0), veh("b", "blue", false, 1)]);
    expect(resolveTimeoutTiebreak(["lives"], ["blue", "red"], { red: 0, blue: 5 }, c)).toBe("red");
  });

  it("orden de criterios: score antes que lives", () => {
    const c = ctx(rs, [veh("a", "red", true, 0), veh("b", "blue", false, 1)]);
    expect(resolveTimeoutTiebreak(["score", "lives"], ["blue", "red"], { red: 0, blue: 5 }, c)).toBe("blue");
  });

  it("empate en todos los criterios ⇒ draw; criterio desconocido se ignora", () => {
    const c = ctx(rs, [veh("a", "red"), veh("b", "blue")]);
    expect(
      resolveTimeoutTiebreak(["score", "lives", "hull", "bogus" as any], ["red", "blue"], { red: 1, blue: 1 }, c),
    ).toBe("draw");
  });

  it("hull: redondeo a 1e-4 (diferencias por debajo son empate)", () => {
    const c = ctx(rs, [veh("a", "red", true, 0, 0.50001), veh("b", "blue", true, 0, 0.5)]);
    expect(resolveTimeoutTiebreak(["hull"], ["red", "blue"], { red: 0, blue: 0 }, c)).toBe("draw");
    const c2 = ctx(rs, [veh("a", "red", true, 0, 0.6), veh("b", "blue", true, 0, 0.5)]);
    expect(resolveTimeoutTiebreak(["hull"], ["red", "blue"], { red: 0, blue: 0 }, c2)).toBe("red");
  });

  it("un descalificado no cuenta vidas ni casco", () => {
    const dq = veh("a", "red");
    dq.disqualified = true;
    const c = ctx(rs, [dq, veh("b", "blue", false, 2)]);
    expect(resolveTimeoutTiebreak(["lives", "hull"], ["red", "blue"], { red: 0, blue: 0 }, c)).toBe("draw");
  });
});

describe("engineRulesetFor", () => {
  it("respawn limitado ⇒ maxRespawns; ilimitado ⇒ sin campo; ninguno ⇒ desactivado", () => {
    const base = {
      teamSize: 2,
      victory: "elimination" as const,
      scoreLimit: null,
      timeLimitMinutes: 10,
      botCredits: null,
      teamCredits: null,
      botMassKg: null,
      teamMassKg: null,
      friendlyFire: false,
      game: "combat" as const,
      ctf: null,
    };
    expect(
      engineRulesetFor({ ...base, respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 } }, "x").respawn,
    ).toEqual({
      enabled: true,
      delayTicks: 150,
      maxRespawns: 2,
      rearmPolicy: "all_alive_participants", // OLA2-G3
    });
    expect(
      engineRulesetFor(
        {
          ...base,
          victory: "score_limit",
          scoreLimit: 3,
          respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 7 },
        },
        "x",
      ).respawn,
    ).toEqual({ enabled: true, delayTicks: 210, rearmPolicy: "all_alive_participants" });
    expect(
      engineRulesetFor({ ...base, respawn: { mode: "none", maxRespawns: null, delaySeconds: null } }, "x").respawn,
    ).toEqual({ enabled: false, delayTicks: 0 });
  });
});
