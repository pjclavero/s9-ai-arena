/**
 * OLA2-G3 · RESPAWN_REARM_POLICY (decisión del usuario, 2026-11-12).
 *
 * «Cuando reaparece un rival, repón también la munición de los supervivientes si la
 * alternativa es permitir que una batalla válida quede estancada por agotamiento
 * irreversible. Como regla explícita del modo/respawn, no como parche escondido.»
 *
 * Regla: `ruleset.respawn.rearmPolicy` (`packages/game-rules/index.ts`, `RespawnRearmPolicy`):
 *  - `self`: sólo el que reaparece recupera su munición (comportamiento anterior a G3);
 *  - `all_alive_participants` (por defecto en los rulesets con respawn): al final del PASO 7,
 *    tras todas las reapariciones del tick, todos los vivos no descalificados vuelven a su
 *    munición MÁXIMA; una sola pasada por tick; asignación, nunca suma.
 * Garantías y mutantes: `scripts/hardening/g3-rearm-mutants.py`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESPAWN_REARM_POLICY,
  RULESETS,
  loadRuleset,
  respawnRearmPolicyOf,
  type RespawnRearmPolicy,
  type Ruleset,
} from "../../../packages/game-rules/index.js";
import {
  RULES_PRESETS,
  engineRulesetFor,
  resolveRulesRequest,
  type RulesParams,
} from "../../../packages/game-rules/battle-rules.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, emptyArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { HunterBot, IdleBot } from "../src/stubs.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { record, verify } from "../src/replay.js";

beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Mismo reparto que rules-respawn-tiebreak: artilleros y, en la 3.ª posición, un explorador. */
function roster(perSide: number): Participant[] {
  const parts: Participant[] = [];
  for (let i = 0; i < perSide * 2; i++) {
    parts.push({
      id: `veh_${i + 1}`,
      botId: `b${i + 1}`,
      team: i % 2 === 0 ? "red" : "blue",
      spec: i % 3 === 2 ? scoutLoadout() : gunnerLoadout(),
    });
  }
  return parts;
}

function tdm(policy: RespawnRearmPolicy | undefined, over: Partial<Ruleset> = {}, delayTicks = 30): Ruleset {
  return loadRuleset("tdm_mvp@1", {
    rulesetId: "test-rearm",
    scoreToWin: Number.MAX_SAFE_INTEGER,
    timeLimitTicks: 40_000,
    respawn: { enabled: true, delayTicks, ...(policy ? { rearmPolicy: policy } : {}) },
    ...over,
  });
}

function idleBattle(ruleset: Ruleset, perSide = 2) {
  const parts = roster(perSide);
  const b = new Battle({ battleId: "g3", seed: "g3-seed", ruleset, map: emptyArena(), participants: parts });
  for (const p of parts) b.attachBot(p.id, new IdleBot(p.botId));
  return b;
}

const veh = (b: Battle, id: string) => b.getVehicles().find((v) => v.id === id)!;
/** Munición actual de un vehículo (rondas por módulo `ammo` + cargas por módulo `mine`). */
const stock = (v: Vehicle) => [...v.modulesOf("ammo").map((m) => m.ammo), ...v.modulesOf("mine").map((m) => m.charges)];
const rounds = (v: Vehicle) => v.modulesOf("ammo").map((m) => m.ammo);
const maxStock = (v: Vehicle) => [
  ...v.modulesOf("ammo").map((m) => m.spec.rounds ?? 0),
  ...v.modulesOf("mine").map((m) => m.spec.charges ?? 0),
];
/** Gasta munición «a mano» (los tests unitarios no verifican replay: ver la sección de determinismo). */
function spend(v: Vehicle, left = 3) {
  for (const m of v.modulesOf("ammo")) m.ammo = Math.min(m.ammo, left);
}
/** Muerte sin pasar por el combate: el PASO 7 la trata igual que cualquier otra. */
function kill(v: Vehicle) {
  v.hullHp = 0;
  v.alive = false;
}
function stepUntilRespawn(b: Battle, id: string, max = 200) {
  for (let t = 0; t < max; t++) {
    b.step();
    if (veh(b, id).alive) return b.tick;
  }
  throw new Error(`${id} no reapareció en ${max} ticks`);
}

describe("G3 · la regla es DATOS: explícita, validada y documentada", () => {
  it("todo ruleset del catálogo CON respawn declara all_alive_participants; sin respawn, nada", () => {
    expect(DEFAULT_RESPAWN_REARM_POLICY).toBe("all_alive_participants");
    for (const [id, r] of Object.entries(RULESETS)) {
      if (r.respawn.enabled) expect(r.respawn.rearmPolicy, id).toBe("all_alive_participants");
      else expect(r.respawn.rearmPolicy, id).toBeUndefined();
    }
  });

  it("presets y personalizado: engineRulesetFor fija la política en todo modo con respawn", () => {
    for (const p of RULES_PRESETS) {
      const params = { ...p.params, teamSize: p.teamSizes[0] } as RulesParams;
      const r = engineRulesetFor(params, "x@1");
      if (params.respawn.mode === "none") {
        expect(r.respawn.enabled).toBe(false);
        expect(r.respawn.rearmPolicy).toBeUndefined();
      } else expect(r.respawn.rearmPolicy, p.id).toBe("all_alive_participants");
    }
  });

  it("el personalizado NO deja elegir la política (munición): forbidden_field explícito", () => {
    const res = resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: {
        game: "combat",
        respawn: { mode: "unlimited", delaySeconds: 5, rearmPolicy: "self" },
        victory: "score_limit",
        scoreLimit: 5,
        timeLimitMinutes: 5,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(
      expect.objectContaining({ field: "rules.params.respawn.rearmPolicy", code: "forbidden_field" }),
    );
  });

  it("validación estricta en el motor: valor desconocido o política sin respawn ⇒ la batalla no se crea", () => {
    const bad = tdm("refill_everyone" as RespawnRearmPolicy);
    expect(() => idleBattle(bad)).toThrow(/rearmPolicy desconocida/);
    const noRespawn = loadRuleset("tdm_mvp@1", {
      respawn: { enabled: false, delayTicks: 0, rearmPolicy: "all_alive_participants" },
    });
    expect(() => idleBattle(noRespawn)).toThrow(/sólo se admite con respawn activado/);
  });

  it("política efectiva: ausente ⇒ self; sin respawn ⇒ self", () => {
    expect(respawnRearmPolicyOf(tdm(undefined))).toBe("self");
    expect(respawnRearmPolicyOf(tdm("all_alive_participants"))).toBe("all_alive_participants");
    expect(respawnRearmPolicyOf(loadRuleset("dm_practice@1"))).toBe("self");
  });
});

describe("G3 · all_alive_participants", () => {
  it("los SUPERVIVIENTES (de ambos bandos) recuperan la munición cuando reaparece un vehículo", () => {
    const b = idleBattle(tdm("all_alive_participants"));
    b.step();
    const [v1, v2, v3, v4] = ["veh_1", "veh_2", "veh_3", "veh_4"].map((id) => veh(b, id));
    for (const v of [v1, v2, v3]) spend(v);
    kill(v4);
    // Antes de la reaparición nadie se rearma (la regla no actúa por la muerte, sólo por el respawn).
    b.step();
    expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));
    const t = stepUntilRespawn(b, "veh_4");
    expect(t).toBeGreaterThan(1);
    for (const v of [v1, v2, v3]) expect(stock(v), v.id).toEqual(maxStock(v));
  });

  it("el que REAPARECE también vuelve a su munición máxima", () => {
    const b = idleBattle(tdm("all_alive_participants"));
    b.step();
    const v4 = veh(b, "veh_4");
    spend(v4, 0);
    kill(v4);
    stepUntilRespawn(b, "veh_4");
    expect(stock(v4)).toEqual(maxStock(v4));
    expect(stock(v4).some((n) => n > 0)).toBe(true);
  });

  it("dos reapariciones en el MISMO tick ⇒ un solo rearme, exactamente al máximo, nunca por encima", () => {
    const b = idleBattle(tdm("all_alive_participants"));
    b.step();
    const [v1, v2, v3, v4] = ["veh_1", "veh_2", "veh_3", "veh_4"].map((id) => veh(b, id));
    spend(v1, 3);
    kill(v2);
    kill(v4);
    // Las dos muertes caen antes del mismo tick ⇒ el mismo respawnAtTick.
    const calls = new Map<string, number>();
    let respawnTick = -1;
    const spy = vi.spyOn(Vehicle.prototype, "rearm").mockImplementation(function (this: Vehicle) {
      calls.set(this.id, (calls.get(this.id) ?? 0) + 1);
      for (const m of this.modules.values()) {
        m.ammo = m.spec.rounds ?? 0;
        m.charges = m.spec.charges ?? 0;
      }
    });
    for (let t = 0; t < 200 && respawnTick < 0; t++) {
      calls.clear();
      b.step();
      if (v2.alive || v4.alive) respawnTick = b.tick;
    }
    spy.mockRestore();
    expect(v2.alive && v4.alive).toBe(true); // reaparecen JUNTOS
    // Supervivientes: UNA llamada en el tick (no una por reaparición). Reaparecidos: la de
    // respawn() + la pasada de la regla (asignación idempotente).
    expect(calls.get("veh_1")).toBe(1);
    expect(calls.get("veh_3")).toBe(1);
    for (const v of [v1, v2, v3, v4]) {
      expect(stock(v), v.id).toEqual(maxStock(v));
      for (const m of v.modulesOf("ammo")) expect(m.ammo, v.id).toBeLessThanOrEqual(m.spec.rounds ?? 0);
    }
  });

  it("rearme idempotente con el método real: dos aplicaciones seguidas = máximo exacto", () => {
    const b = idleBattle(tdm("all_alive_participants"));
    const v1 = veh(b, "veh_1");
    spend(v1, 3);
    v1.rearm();
    v1.rearm();
    expect(stock(v1)).toEqual(maxStock(v1));
  });

  it("un descalificado no se rearma", () => {
    const b = idleBattle(tdm("all_alive_participants"));
    b.step();
    const v1 = veh(b, "veh_1");
    spend(v1, 3);
    v1.disqualified = true;
    kill(veh(b, "veh_4"));
    stepUntilRespawn(b, "veh_4");
    expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));
  });
});

describe("G3 · self (comportamiento anterior) y sin respawn", () => {
  it("self: el superviviente NO se rearma; el que reaparece sí", () => {
    const b = idleBattle(tdm("self"));
    b.step();
    const [v1, v4] = [veh(b, "veh_1"), veh(b, "veh_4")];
    spend(v1, 3);
    spend(v4, 0);
    kill(v4);
    stepUntilRespawn(b, "veh_4");
    expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));
    expect(stock(v4)).toEqual(maxStock(v4));
  });

  it("sin respawn la munición sigue siendo FINITA (nadie se rearma aunque haya bajas)", () => {
    const b = idleBattle(loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 }, scoreToWin: 99 }), 2);
    b.step();
    const [v1, v2, v4] = [veh(b, "veh_1"), veh(b, "veh_2"), veh(b, "veh_4")];
    spend(v1, 3);
    spend(v2, 0);
    kill(v4);
    for (let t = 0; t < 600 && !b.isFinished(); t++) b.step();
    expect(v4.alive).toBe(false);
    expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));
    expect(rounds(v2)).toEqual(v2.modulesOf("ammo").map(() => 0));
  });
});

describe("G3 · el 2v2 con respawn ya no se estanca por munición", () => {
  /**
   * Mecanismo diagnosticado por MB (Paso 9): el artillero rojo agota su AP y, como la munición
   * sólo se reponía al reaparecer, el azul superviviente queda vivo hasta el límite de ticks. En
   * b885888 el escenario literal de MB (dotación de serie) ya termina antes de agotar munición
   * (trayectorias distintas tras la integración), así que se CONSTRUYE el mismo mecanismo sin
   * tocar la semilla (`rules-seed`): los artilleros rojos llevan 30 AP en su spec (dato de la
   * batalla, viaja en la cabecera), el explorador rojo no tiene radar (HunterBot no ve a nadie)
   * y el azul es IdleBot. Azul tiene 2 vehículos × 2 vidas = 1200 PV; 30 AP no bastan.
   */
  function starvedBattle(policy: RespawnRearmPolicy) {
    const parts = roster(2).map((p) => {
      if (p.team !== "red") return p;
      const spec = structuredClone(p.spec);
      for (const m of spec.modules) if (m.category === "ammo") m.rounds = 30;
      return { ...p, spec };
    });
    const ruleset = tdm(policy, {}, 30);
    ruleset.respawn.maxRespawns = 1;
    const b = new Battle({ battleId: "rr", seed: "rules-seed", ruleset, map: emptyArena(), participants: parts });
    for (const p of parts) b.attachBot(p.id, p.team === "red" ? new HunterBot(p.botId) : new IdleBot(p.botId));
    return b;
  }

  it("self: el artillero rojo se queda sin munición y la batalla queda estancada (comportamiento anterior)", () => {
    const b = starvedBattle("self");
    for (let t = 0; t < 15_000 && !b.isFinished(); t++) b.step();
    expect(b.isFinished()).toBe(false);
    expect(rounds(veh(b, "veh_1"))).toEqual([0]);
    // Azul conserva vidas y nadie va a reaparecer: estancamiento irreversible.
    expect(b.getVehicles().filter((v) => v.team === "blue" && v.alive).length).toBeGreaterThan(0);
    b.free();
  });

  it("all_alive_participants: tras varias reapariciones el rojo se rearma y la batalla termina por eliminación", () => {
    const b = starvedBattle("all_alive_participants");
    let respawns = 0;
    let prev = new Set(b.getVehicles().filter((v) => v.alive).map((v) => v.id));
    for (let t = 0; t < 40_000 && !b.isFinished(); t++) {
      b.step();
      const now = new Set(b.getVehicles().filter((v) => v.alive).map((v) => v.id));
      for (const id of now) if (!prev.has(id)) respawns++;
      prev = now;
    }
    expect(b.isFinished()).toBe(true);
    const r = b.getResult()!;
    expect(r.ticks).toBeLessThan(40_000);
    expect(r.winner).toBe("red");
    expect(respawns).toBeGreaterThanOrEqual(2);
    for (const v of b.getVehicles().filter((x) => x.team === "blue")) expect(v.respawnsUsed).toBe(1);
    b.free();
  });
});

describe("G3 · self reproduce EXACTAMENTE las anclas anteriores a la regla", () => {
  // Anclas de rules-respawn-tiebreak en b885888 (antes de G3). Con `self` explícito el motor
  // da los mismos hashes: la regla nueva no toca nada más.
  const PRE_G3 = {
    tdm_1v1: { hash: "df7b19ab8c88a3e1da243c93d76c837fc0ec0b06900259f4e92ead2f405c83f8", tick: 3000 },
    tdm_2v2: { hash: "0af19ee467fcb2ff76059fcafb8e3010daa8ea9bfe80e1e0e9bca50d9d27a2a5", tick: 3000 },
    tdm_4v4: { hash: "682cd1e9276a3ca00aa465efc44dfb842fe85b00778972208f2a37284d4eefbb", tick: 2371 },
    ctf_1v1: { hash: "960c80cc76e70e3028d2bac75eaa30df4db63da3ce7215e39357dbda2d1e4578", tick: 2000 },
  };
  const cases: [keyof typeof PRE_G3, string, number, () => ReturnType<typeof emptyArena>, number][] = [
    ["tdm_1v1", "tdm_mvp@1", 1, () => emptyArena(), 3000],
    ["tdm_2v2", "tdm_mvp@1", 2, () => emptyArena(), 3000],
    ["tdm_4v4", "tdm_mvp@1", 4, () => emptyArena(), 3000],
    ["ctf_1v1", "ctf_mvp@1", 1, () => ctfArena(), 2000],
  ];
  for (const [key, rs, n, map, ticks] of cases) {
    it(`${key} con rearmPolicy self`, () => {
      const base = loadRuleset(rs);
      const ruleset = loadRuleset(rs, { respawn: { ...base.respawn, rearmPolicy: "self" } });
      const parts = roster(n);
      const b = new Battle({ battleId: "rr", seed: "rules-seed", ruleset, map: map(), participants: parts, recordReplay: true });
      for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
      for (let t = 0; t < ticks && !b.isFinished(); t++) b.step();
      expect({ hash: b.stateHash(), tick: b.tick }).toEqual(PRE_G3[key]);
      b.free();
    });
  }
});

describe("G3 · diagnóstico de tdm_4v4_norespawn (sin respawn la regla no aplica)", () => {
  it("no es munición: tras la última baja nadie se ve (radar) ni dispara; termina por TIEMPO con desempate", () => {
    const parts = roster(4);
    const ruleset = loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 }, scoreToWin: 99 });
    const b = new Battle({ battleId: "rr", seed: "rules-seed", ruleset, map: emptyArena(), participants: parts, recordReplay: true });
    for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
    let noAmmo = 0;
    const emit = (b as any).emit.bind(b);
    (b as any).emit = (ev: any, to?: string) => {
      if (ev.kind === "rejected_action" && ev.reason === "no_ammo") noAmmo++;
      return emit(ev, to);
    };
    for (let t = 0; t < ruleset.timeLimitTicks + 10 && !b.isFinished(); t++) b.step();
    const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed");
    expect(deaths.at(-1)!.tick).toBeLessThan(1000);
    expect(noAmmo).toBe(0);
    // Todos los supervivientes conservan munición: el estancamiento es de búsqueda, no de munición.
    for (const v of b.getVehicles().filter((x) => x.alive && x.modulesOf("sensor").length > 0))
      expect(rounds(v).every((n) => n > 0), v.id).toBe(true);
    expect(b.isFinished()).toBe(true);
    const r = b.getResult()!;
    expect(r.ticks).toBeGreaterThanOrEqual(ruleset.timeLimitTicks);
    expect(r.winner).toBe("blue"); // desempate tdm_mvp@1 (0.3.0): más puntos (3 bajas a 1)
    b.free();
  });
});

describe("G3 · determinismo, stateHash y replay", () => {
  /** 2v2 de cazadores con respawn ilimitado: hay bajas, reapariciones y rearmes reales. */
  function huntConfig(policy: RespawnRearmPolicy) {
    return {
      battleId: "g3-replay",
      seed: "rules-seed",
      ruleset: tdm(policy, { timeLimitTicks: 3000 }, 150),
      map: emptyArena(),
      participants: roster(2),
    };
  }
  const attachHunters = (b: Battle) => {
    for (const p of roster(2)) b.attachBot(p.id, new HunterBot(p.botId));
  };

  it("misma semilla y comandos ⇒ mismo hash; la política cambia el hash (entra en el estado)", () => {
    const run = (policy: RespawnRearmPolicy) => {
      const b = new Battle(huntConfig(policy));
      attachHunters(b);
      for (let t = 0; t < 3000 && !b.isFinished(); t++) b.step();
      const out = { hash: b.stateHash(), tick: b.tick };
      b.free();
      return out;
    };
    const a = run("all_alive_participants");
    expect(run("all_alive_participants")).toEqual(a);
    expect(run("self").hash).not.toBe(a.hash);
  });

  it("verify() reproduce el replay con rearme; sin la política en la cabecera, diverge", async () => {
    const replay = await record(huntConfig("all_alive_participants"), attachHunters);
    expect(replay.header.ruleset.respawn.rearmPolicy).toBe("all_alive_participants");
    expect(replay.events.filter((e: any) => e.kind === "vehicle_destroyed").length).toBeGreaterThan(1);
    const ok = await verify(replay);
    expect(ok.rejected).toBeNull();
    expect(ok.matches).toBe(true);
    // La cabecera es lo que lleva la regla: quitada, la re-simulación usa `self` y diverge.
    const stripped = structuredClone(replay);
    delete stripped.header.ruleset.respawn.rearmPolicy;
    const bad = await verify(stripped);
    expect(bad.matches).toBe(false);
  });
});
