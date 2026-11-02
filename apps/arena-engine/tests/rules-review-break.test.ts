/**
 * RULES-REVIEW (FASE 20) · intentos de ROMPER respawn limitado, eliminación, empate
 * y desempate del motor (rama `rules/rulesets`, ADR-021). Escritos por el revisor
 * independiente; complementan `rules-respawn-tiebreak.test.ts` sin reutilizar sus
 * aserciones:
 *
 *  1. vidas = respawns + 1 EXACTO (no «≤»): con el valor del preset (2) el perdedor
 *     muere exactamente 3 veces, reaparece exactamente 2 y se emite UN
 *     `vehicle_eliminated`; el control con respawn ilimitado en la misma ventana
 *     muere más veces (el límite es el que corta, no la duración).
 *  2. Eliminación MUTUA en el mismo tick ⇒ `draw` (nadie gana por orden de equipos).
 *  3. Borde del límite de tiempo (P3 corregido en rules/rulesets): la eliminación mutua
 *     en el tick del límite es `draw`, igual que un tick antes (antes la decidía el
 *     desempate declarado).
 *  4. score limit = vidas totales del rival (límite alcanzable exacto): termina con
 *     ganador al llegar a él, el mismo que daría la eliminación.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { resolveRulesRequest } from "../../../packages/game-rules/battle-rules.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { createMode, type ModeContext } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, gunnerLoadout } from "../src/fixtures.js";
import { HunterBot, IdleBot } from "../src/stubs.js";
import { Vehicle } from "../src/sim/vehicle.js";

beforeAll(async () => {
  await initPhysics();
});

const duelParts = (): Participant[] => [
  { id: "veh_1", botId: "hunter", team: "red", spec: gunnerLoadout() },
  { id: "veh_2", botId: "idle", team: "blue", spec: gunnerLoadout() },
];

function run(ruleset: Ruleset, maxTicks: number) {
  const parts = duelParts();
  const b = new Battle({ battleId: "rv", seed: "review-seed", ruleset, map: emptyArena(), participants: parts });
  b.attachBot("veh_1", new HunterBot("hunter"));
  b.attachBot("veh_2", new IdleBot("idle"));
  for (let t = 0; t < maxTicks && !b.isFinished(); t++) b.step();
  const deaths = (id: string) =>
    b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed" && e.targetId === id).length;
  return { b, deaths };
}

describe("vidas = respawns + 1 (exacto)", () => {
  it("preset Respawn limitado (2 reapariciones) en 1v1 personalizado: 3 muertes, 2 reapariciones, 1 eliminación", () => {
    const r = resolveRulesRequest({
      preset: "custom",
      teamSize: 1,
      params: {
        respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 1 },
        victory: "elimination",
        timeLimitMinutes: 10,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.engineRuleset.respawn).toEqual({ enabled: true, delayTicks: 30, maxRespawns: 2 });
    const { b, deaths } = run(r.engineRuleset, r.engineRuleset.timeLimitTicks);
    const res = b.getResult()!;
    expect(res.winner).toBe("red");
    expect(res.ticks).toBeLessThan(r.engineRuleset.timeLimitTicks);
    const idle = b.getVehicles().find((v) => v.id === "veh_2")!;
    expect(deaths("veh_2")).toBe(3);
    expect(idle.respawnsUsed).toBe(2);
    const elim = b.publicEvents.filter((e: any) => e.kind === "vehicle_eliminated");
    expect(elim).toHaveLength(1);
    expect(elim[0]).toMatchObject({ targetId: "veh_2", team: "blue", tick: res.ticks });
    b.free();

    // Control: mismas reglas con respawn ILIMITADO. La 3.ª muerte ocurre en el mismo
    // tick (misma simulación) pero NO termina la batalla y el vehículo REAPARECE una
    // 3.ª vez: es el límite el que corta. (No se cuentan muertes extra: el gunner del
    // HunterBot agota la munición tras 3 bajas, así que «más muertes» no discrimina.)
    const ctrl = run(
      loadRuleset("tdm_mvp@1", {
        ...r.engineRuleset,
        respawn: { enabled: true, delayTicks: 30 },
        scoreToWin: Number.MAX_SAFE_INTEGER,
        timeLimitTicks: res.ticks + 600,
      }),
      res.ticks + 600,
    );
    expect(ctrl.deaths("veh_2")).toBe(3);
    expect(ctrl.b.tick).toBeGreaterThanOrEqual(res.ticks + 599); // no terminó en la 3.ª muerte
    expect(ctrl.b.getVehicles().find((v) => v.id === "veh_2")!.respawnsUsed).toBe(3);
    expect(ctrl.b.publicEvents.some((e: any) => e.kind === "vehicle_eliminated")).toBe(false);
    ctrl.b.free();
  });
});

// ---------------------------------------------------------- winner() puro
function veh(id: string, team: string, alive: boolean, used: number) {
  const v = new Vehicle(id, team, id, gunnerLoadout());
  v.alive = alive;
  v.respawnsUsed = used;
  return v;
}
const limited1: Ruleset = loadRuleset("tdm_mvp@1", {
  rulesetId: "review-limited",
  scoreToWin: Number.MAX_SAFE_INTEGER,
  timeLimitTicks: 1000,
  respawn: { enabled: true, delayTicks: 30, maxRespawns: 1 },
  timeoutTiebreak: ["lives", "score", "hull"],
});
function ctx(tick: number, vehicles: Vehicle[]): ModeContext {
  return { tick, ruleset: limited1, vehicles, poses: new Map(), map: emptyArena(), emit: () => {} };
}

describe("eliminación mutua", () => {
  it("los dos bandos agotan sus vidas en el mismo tick ⇒ draw (sin sesgo por orden de equipos)", () => {
    for (const teams of [
      ["red", "blue"],
      ["blue", "red"],
    ]) {
      const mode = createMode(limited1, teams, emptyArena());
      (mode as any).score.red = 1;
      (mode as any).score.blue = 0;
      const c = ctx(500, [veh("a", "red", false, 1), veh("b", "blue", false, 1)]);
      expect(mode.winner(c)).toBe("draw");
    }
  });

  it("un bando sin vidas pero con un muerto pendiente de reaparecer en el otro ⇒ gana el otro", () => {
    const mode = createMode(limited1, ["red", "blue"], emptyArena());
    const c = ctx(500, [veh("a", "red", false, 0), veh("b", "blue", false, 1)]);
    expect(mode.winner(c)).toBe("red");
  });

  it("P3 corregido: la misma eliminación mutua EN el tick del límite también es draw (no la decide el desempate)", () => {
    const mode = createMode(limited1, ["red", "blue"], emptyArena());
    (mode as any).score.red = 1;
    (mode as any).score.blue = 0;
    const before = ctx(999, [veh("a", "red", false, 1), veh("b", "blue", false, 1)]);
    const atLimit = ctx(1000, [veh("a", "red", false, 1), veh("b", "blue", false, 1)]);
    expect(mode.winner(before)).toBe("draw");
    expect(mode.winner(atLimit)).toBe("draw");
  });
});

describe("score limit alcanzable exacto", () => {
  it("1v1, 1 reaparición (2 vidas) y límite 2 bajas: gana al llegar a 2, igual que por eliminación", () => {
    const r = resolveRulesRequest({
      preset: "custom",
      teamSize: 1,
      params: {
        respawn: { mode: "limited", maxRespawns: 1, delaySeconds: 1 },
        victory: "score_limit",
        scoreLimit: 2,
        timeLimitMinutes: 10,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { b, deaths } = run(r.engineRuleset, r.engineRuleset.timeLimitTicks);
    const res = b.getResult()!;
    expect(res.winner).toBe("red");
    expect(res.score).toMatchObject({ red: 2, blue: 0 });
    expect(deaths("veh_2")).toBe(2);
    b.free();
    // 3 bajas sería inalcanzable: el servidor lo rechaza.
    const bad = resolveRulesRequest({
      preset: "custom",
      teamSize: 1,
      params: {
        respawn: { mode: "limited", maxRespawns: 1, delaySeconds: 1 },
        victory: "score_limit",
        scoreLimit: 3,
        timeLimitMinutes: 10,
      },
    });
    expect(bad.ok).toBe(false);
  });
});
