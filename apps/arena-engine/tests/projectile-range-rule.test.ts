/**
 * OLA 2 · MC · UNA sola regla de alcance del proyectil.
 *
 * La vida del proyectil se deriva SIEMPRE de rangeM y de la velocidad del propio spec
 * (combat.ts projectileLifetimeOf). No hay regla heredada de 90 ticks; un spec incoherente
 * falla en lugar de imponerse en silencio. Mata los mutantes X1 (quitar el cálculo desde
 * rangeM) y X2 (reintroducir una regla fija).
 */
import { describe, expect, it } from "vitest";
import { TICK_DT } from "../../../packages/game-rules/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { gunnerLoadout } from "../../../packages/module-catalog/resolve/archetypes.js";
import { fire, projectileLifetimeOf } from "../src/sim/combat.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { Rng } from "../src/rng.js";

const catalog = loadCatalog();

function cannon(patch: Record<string, unknown> = {}) {
  const spec = resolveVehicle(gunnerLoadout, catalog);
  const w = spec.modules.find((m) => m.category === "weapon")!;
  Object.assign(w, patch);
  return { spec, w };
}
function shoot(patch: Record<string, unknown> = {}) {
  const { spec, w } = cannon(patch);
  const v = new Vehicle("veh_1", "red", "b1", spec);
  const p = fire(v, w.slot, 0, { x: 0, y: 0 }, new Rng("rule"), 0);
  return { p: p!, w };
}

describe("MC · una sola regla de alcance", () => {
  it("el cañón resuelto alcanza 360 m (rangeM · TICK_HZ / velocidad)", () => {
    const { p } = shoot();
    expect(p.ttlTicks).toBe(90);
    expect(p.ttlTicks * Math.hypot(p.velocity.x, p.velocity.y) * TICK_DT).toBeCloseTo(360, 6);
  });

  it("cambiar rangeM en el spec resuelto cambia el alcance (coherente con la vida derivada)", () => {
    // 240 m a 120 m/s = 60 ticks. El campo derivado se actualiza a juego.
    const { p } = shoot({ rangeM: 240, projectileLifetimeTicks: 60 });
    expect(p.ttlTicks).toBe(60);
    expect(p.ttlTicks * Math.hypot(p.velocity.x, p.velocity.y) * TICK_DT).toBeCloseTo(240, 6);
  });

  it("un spec SIN vida derivada (sólo rangeM + velocidad) usa rangeM, no un valor fijo", () => {
    const { p } = shoot({ rangeM: 240, projectileLifetimeTicks: undefined });
    expect(p.ttlTicks).toBe(60);
    const { p: q } = shoot({ rangeM: 480, projectileLifetimeTicks: undefined });
    expect(q.ttlTicks).toBe(120);
  });

  it("spec incoherente (vida derivada ≠ rangeM/velocidad) FALLA, no se impone en silencio", () => {
    expect(() => shoot({ rangeM: 240, projectileLifetimeTicks: 90 })).toThrow(/incoherente/);
    expect(() => shoot({ projectileLifetimeTicks: 91 })).toThrow(/incoherente/);
  });

  it("sin rangeM o sin velocidad NO hay regla heredada de 90: falla", () => {
    expect(() => shoot({ rangeM: undefined, projectileLifetimeTicks: undefined })).toThrow(/sin rangeM/);
    expect(() => shoot({ projectileSpeedMs: undefined, projectileLifetimeTicks: undefined })).toThrow(/sin rangeM/);
    expect(() => projectileLifetimeOf({ moduleId: "x" } as never)).toThrow();
  });

  it("rangeM que no es múltiplo entero del avance por tick falla (fail-closed)", () => {
    expect(() => shoot({ rangeM: 361, projectileLifetimeTicks: undefined })).toThrow();
  });
});
