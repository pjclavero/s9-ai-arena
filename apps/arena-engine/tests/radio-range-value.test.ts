/**
 * OLA 2 · MC · el VALOR del alcance de radio (radio.rangeM) y el efecto del rendimiento del módulo.
 *
 * Mata los mutantes X3 (alcance ×2) y X4 (ignorar el rendimiento) de la revisión de #276:
 * antes sólo se probaba «hay límite», no cuál. Dos distancias a ambos lados de rangeM y un
 * módulo dañado.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { MODULES, emptyArena, scoutLoadout } from "../src/fixtures.js";
import { radioDeliverableTo, radioRangeOf, type RadioMessage } from "../src/sim/sensors.js";
import { Vehicle } from "../src/sim/vehicle.js";
import type { BotAgent } from "../src/sim/battle.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";

beforeAll(async () => {
  await initPhysics();
});

const RANGE = MODULES.radio.rangeM!; // 80 m en el fixture

function radioSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [...s.modules, { ...MODULES.radio }];
  return s;
}

function msg(rangeM: number): RadioMessage {
  return { from: "veh_1", team: "red", data: "AA==", sentTick: 0, deliverAtTick: 0, origin: { x: 0, y: 0 }, rangeM };
}

describe("MC · radio.rangeM: valor exacto del alcance (unitario)", () => {
  const rx = new Vehicle("veh_2", "red", "b2", radioSpec());
  it("radioDeliverableTo: recibe a rangeM-0,5 y NO a rangeM+0,5", () => {
    expect(radioDeliverableTo(msg(RANGE), rx, { x: RANGE - 0.5, y: 0 })).toBe(true);
    expect(radioDeliverableTo(msg(RANGE), rx, { x: RANGE + 0.5, y: 0 })).toBe(false);
    expect(radioDeliverableTo(msg(RANGE), rx, { x: 0, y: RANGE + 0.5 })).toBe(false);
  });
  it("radioRangeOf: módulo sano = rangeM del spec", () => {
    const tx = new Vehicle("veh_1", "red", "b1", radioSpec());
    expect(radioRangeOf(tx, "radio_a")).toBe(RANGE);
  });
  it("radioRangeOf: un módulo dañado alcanza MENOS (rendimiento aplicado)", () => {
    const tx = new Vehicle("veh_1", "red", "b1", radioSpec());
    const m = tx.modules.get("radio_a")!;
    m.hp = m.spec.hp * 0.2; // estado crítico
    const perf = tx.performanceOf("radio_a");
    expect(perf).toBeGreaterThan(0);
    expect(perf).toBeLessThan(1);
    expect(radioRangeOf(tx, "radio_a")).toBeCloseTo(RANGE * perf, 9);
    expect(radioRangeOf(tx, "radio_a")).toBeLessThan(RANGE);
  });
  it("radioRangeOf: módulo destruido = 0 y sin radio = 0", () => {
    const tx = new Vehicle("veh_1", "red", "b1", radioSpec());
    tx.modules.get("radio_a")!.hp = 0;
    expect(radioRangeOf(tx, "radio_a")).toBe(0);
    expect(radioRangeOf(tx, "turret_main")).toBe(0);
  });
});

class Talker implements BotAgent {
  constructor(readonly botId: string, private say: boolean) {}
  got = 0;
  decide(obs: any) {
    this.got += Array.isArray(obs.radio) ? obs.radio.length : 0;
    const out: any = { forTick: obs.tick };
    if (this.say && obs.tick < 3) out.radio = [{ slot: "radio_a", data: Buffer.from("hi").toString("base64") }];
    return out;
  }
}

/** ¿Recibe el compañero a `gapM` metros del emisor un mensaje de equipo? */
function received(gapM: number): number {
  const map = emptyArena(300, 100);
  map.spawns = [
    { team: "red", position: { x: 20, y: 50 }, heading: 0 },
    { team: "red", position: { x: 20 + gapM, y: 50 }, heading: 0 },
    { team: "blue", position: { x: 280, y: 90 }, heading: 0 },
  ];
  const b = new Battle({
    battleId: "radio-range",
    seed: "radio-range",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: radioSpec() },
      { id: "veh_2", botId: "b2", team: "red", spec: radioSpec() },
      { id: "veh_3", botId: "b3", team: "blue", spec: radioSpec() },
    ],
  });
  const rx = new Talker("b2", false);
  b.attachBot("veh_1", new Talker("b1", true));
  b.attachBot("veh_2", rx);
  b.attachBot("veh_3", new Talker("b3", false));
  try {
    for (let i = 0; i < 120; i++) b.step();
  } finally {
    b.free();
  }
  return rx.got;
}

describe("MC · radio.rangeM: valor exacto del alcance (batalla)", () => {
  it("compañero a rangeM-5 recibe; a rangeM+5 no", () => {
    expect(received(RANGE - 5)).toBeGreaterThan(0);
    expect(received(RANGE + 5)).toBe(0);
  });
});
