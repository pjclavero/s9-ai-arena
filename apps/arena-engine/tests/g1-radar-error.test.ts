/**
 * OLA 2 · G1 ronda 5 (P2-1d) · Comportamiento del ERROR DEL RADAR (D8), fuera del gate del
 * catálogo y sin anclas de hash.
 *
 * Mide el error REAL de la detección: la posición que el radar informa de un contacto frente a
 * la posición real del vehículo detectado (la de la física), en muchas observaciones de una
 * batalla real del motor. Y su dependencia de `errorM` (el campo del catálogo):
 *   - errorM = 0 ⇒ la posición informada es la real;
 *   - errorM = E > 0 ⇒ el error por eje nunca pasa de E, llega a acercarse a E y su media es
 *     del orden de E/2 (ruido uniforme en [−E, E]);
 *   - el error medio ESCALA con errorM (×4 de errorM ⇒ ≈×4 de error).
 * Las cotas son estadísticas (no la secuencia exacta del RNG): el test no depende de cuántas
 * tiradas se consuman, sólo del efecto observable.
 *
 * Calibrado con mutantes de scripts/hardening/g1-mutants.py: F2 de la revisión (error fijo de
 * 2 m; errorM sólo decide cuántas tiradas se consumen) y F5 (el ruido se anula pero se siguen
 * consumiendo las mismas tiradas y se sigue informando errorM) lo ponen en ROJO.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const SAMPLES = 80;

/** Error por eje (|informada − real|) de cada contacto de radar de veh_1 sobre veh_2. */
function radarErrors(errorM: number): number[] {
  const radarSpec = gunnerLoadout();
  const radar = radarSpec.modules.find((m) => m.category === "sensor" && m.sensorType === "radar");
  if (!radar) throw new Error("el artillero ya no lleva radar");
  const spec: VehicleSpec = {
    ...radarSpec,
    modules: radarSpec.modules.map((m) => (m === radar ? { ...m, errorM } : m)),
  };
  const b = new Battle({
    battleId: "radar-error",
    seed: "radar-error-seed",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000 }),
    map: emptyArena(),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec },
      { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
    ],
  });
  b.attachBot("veh_1", new IdleBot("b1"));
  b.attachBot("veh_2", new IdleBot("b2"));
  const errs: number[] = [];
  try {
    b.step();
    const phys = b.getPhysics();
    phys.get("veh_1")!.rb.setTranslation({ x: 40, y: 40 }, true);
    phys.get("veh_2")!.rb.setTranslation({ x: 60, y: 40 }, true);
    for (let i = 0; i < SAMPLES; i++) {
      // Un ciclo de decisión entero entre muestras: el flujo de sensores avanza.
      for (let k = 0; k < 3; k++) b.step();
      const contacts = b.observationFor("veh_1").sensors?.radar?.[0]?.contacts ?? [];
      expect(contacts.length, "el radar no detecta al contacto (20 m, sin muros)").toBe(1);
      const real = phys.pose("veh_2")!.position;
      errs.push(Math.abs(contacts[0].position.x - real.x), Math.abs(contacts[0].position.y - real.y));
    }
  } finally {
    b.free();
  }
  return errs;
}

const max = (xs: number[]) => Math.max(...xs);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Redondeo de la observación (r6) y de la pose. */
const EPS = 2e-6;

describe("G1 · error real del radar (posición informada frente a real) y su dependencia de errorM", () => {
  it("errorM = 0 ⇒ la posición informada es la real", () => {
    expect(max(radarErrors(0))).toBeLessThanOrEqual(EPS);
  });

  for (const E of [1, 4]) {
    it(`errorM = ${E} ⇒ error por eje ≤ ${E}, llega cerca de ${E} y su media es ≈ ${E}/2`, () => {
      const errs = radarErrors(E);
      expect(max(errs)).toBeLessThanOrEqual(E + EPS);
      expect(max(errs)).toBeGreaterThanOrEqual(0.8 * E);
      expect(mean(errs)).toBeGreaterThan(0.35 * E);
      expect(mean(errs)).toBeLessThan(0.65 * E);
    });
  }

  it("el error medio escala con errorM (×4 de errorM ⇒ entre ×3 y ×5 de error)", () => {
    const ratio = mean(radarErrors(4)) / mean(radarErrors(1));
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
  });
});
