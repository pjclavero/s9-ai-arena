/**
 * OLA 2 · ME · BASELINE · alcance EFECTIVO actual de las armas (C-PROJ-1, P-2).
 *
 * Hoy el alcance no lo fija `weapon.rangeM` (60 m el cañón, 55 m la ametralladora) sino
 * el TTL fijo `ttlTicks: 90` de combat.ts: alcance = projectileSpeedMs · 90 · TICK_DT.
 * MC tiene que migrar `weapon.rangeM` a fuente real del rango SIN REBALANCEAR: estos
 * números son la referencia (cañón 360 m, ametralladora 600 m). Cuando MC lo migre, el
 * test `characterizes-defect: …` se invierte (y se activa el contrato de
 * contract-pending/catalog-effects.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TICK_DT, loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import type { VehicleSpec } from "../../src/sim/vehicle.js";
import { IdleBot } from "../../src/stubs.js";
import { ScriptBot, assertBaselineGolden, loadout, rangeArena } from "./helpers.js";

beforeAll(async () => {
  await initPhysics();
});

const WEAPONS = [
  { weapon: "weapon.cannon@1", ammo: "ammo.ap@1", chassis: "chassis.medium@1" },
  { weapon: "weapon.mg@1", ammo: "ammo.standard@1", chassis: "chassis.light@1" },
  { weapon: "weapon.mg@2", ammo: "ammo.standard@1", chassis: "chassis.light@1" },
] as const;

function shooter(weapon: string, ammo: string, chassis: string): VehicleSpec {
  return loadout(chassis, [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "turret_main", moduleId: weapon, ammo },
  ]);
}

function sandbag(): VehicleSpec {
  return loadout("chassis.light@1", [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
  ]);
}

/**
 * Dispara UNA vez en el tick 0 hacia +X y sigue al proyectil hasta que desaparece.
 * Devuelve cuántos ticks se le observa vivo tras el paso y la distancia máxima a la boca.
 */
function measureFlight(spec: VehicleSpec, target?: { x: number; y: number }) {
  const map = rangeArena();
  if (target) map.spawns[1] = { team: "blue", position: target, heading: 0 };
  const b = new Battle({
    battleId: "me_range",
    seed: "me-range",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 400 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec },
      { id: "veh_2", botId: "b2", team: "blue", spec: target ? sandbag() : sandbag() },
    ],
  });
  b.attachBot("veh_1", new ScriptBot("b1", (t) => (t === 0 ? { fire: ["turret_main"] } : undefined)));
  b.attachBot("veh_2", new IdleBot("b2"));
  const muzzle = { x: 20 + spec.radiusM + 0.3, y: 20 };
  let aliveTicks = 0;
  let maxDist = 0;
  let projId: string | null = null;
  let seenAfter = false;
  for (let t = 0; t < 300; t++) {
    b.step();
    const ps: any[] = (b as any).projectiles;
    if (ps.length > 0) {
      projId ??= ps[0].id;
      aliveTicks++;
      maxDist = Math.max(maxDist, Math.hypot(ps[0].position.x - muzzle.x, ps[0].position.y - muzzle.y));
    } else if (aliveTicks > 0) {
      seenAfter = true;
      break;
    }
  }
  const targetHp = b.getVehicle("veh_2")!.hullHp;
  const targetHpMax = b.getVehicle("veh_2")!.spec.hullHp;
  b.free();
  return { aliveTicks, maxDist, projId, seenAfter, hit: targetHp < targetHpMax };
}

describe("baseline · alcance efectivo de las armas (TTL fijo 90)", () => {
  for (const w of WEAPONS) {
    it(`${w.weapon}: el proyectil vive 90 pasos de movimiento y su alcance es speed·90·TICK_DT`, () => {
      const spec = shooter(w.weapon, w.ammo, w.chassis);
      const speed = spec.modules.find((m) => m.slot === "turret_main")!.projectileSpeedMs!;
      const f = measureFlight(spec);
      // Se observa vivo tras 89 pasos (el 90º movimiento lo agota: ttl 90 → 0).
      expect(f.aliveTicks).toBe(89);
      expect(f.seenAfter).toBe(true);
      expect(f.maxDist).toBeCloseTo(speed * 89 * TICK_DT, 6);
    });
  }

  it("tabla de alcance efectivo actual (golden): rangeM declarado frente a alcance real", () => {
    const rows = WEAPONS.map((w) => {
      const spec = shooter(w.weapon, w.ammo, w.chassis);
      const m = spec.modules.find((x) => x.slot === "turret_main")!;
      return {
        weapon: w.weapon,
        declaredRangeM: m.rangeM ?? null,
        projectileSpeedMs: m.projectileSpeedMs,
        ttlTicks: 90,
        effectiveRangeM: Math.round(m.projectileSpeedMs! * 90 * TICK_DT * 1e6) / 1e6,
      };
    });
    // Valores de referencia para la migración de MC (sin rebalancear).
    expect(rows.map((r) => r.effectiveRangeM)).toEqual([360, 600, 600]);
    assertBaselineGolden("weapon-effective-range", rows);
  });

  it("un blanco a (alcance − 4) m en la línea de tiro recibe el impacto; a (alcance + 4) m no", () => {
    // test.fixture_*: el cañón real con spreadRad 0 para que la línea de tiro sea exacta.
    const base = shooter("weapon.cannon@1", "ammo.ap@1", "chassis.medium@1");
    const spec: VehicleSpec = {
      ...base,
      modules: base.modules.map((m) =>
        m.slot === "turret_main" ? { ...m, moduleId: "test.fixture_cannon_nospread@1", spreadRad: 0 } : m,
      ),
    };
    const reach = 120 * 90 * TICK_DT; // 360 m desde la boca
    const muzzleX = 20 + spec.radiusM + 0.3;
    const r = sandbag().radiusM;
    const near = measureFlight(spec, { x: muzzleX + reach - 4 + r, y: 20 });
    const far = measureFlight(spec, { x: muzzleX + reach + 4 + r, y: 20 });
    expect(near.hit).toBe(true);
    expect(far.hit).toBe(false);
  });

  it("characterizes-defect: weapon.rangeM NO influye en el alcance (el TTL 90 es un hardcode)", () => {
    const base = shooter("weapon.cannon@1", "ammo.ap@1", "chassis.medium@1");
    const withRange = (rangeM: number): VehicleSpec => ({
      ...base,
      modules: base.modules.map((m) =>
        m.slot === "turret_main" ? { ...m, moduleId: "test.fixture_cannon_range@1", rangeM } : m,
      ),
    });
    const short = measureFlight(withRange(10));
    const long = measureFlight(withRange(5000));
    // DEFECTO (P-2): con rangeM 10 o 5000 el proyectil vuela exactamente igual.
    expect(short.aliveTicks).toBe(long.aliveTicks);
    expect(short.maxDist).toBe(long.maxDist);
  });
});
