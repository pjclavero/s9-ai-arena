/**
 * OLA 2 · MC · CARACTERIZACIÓN DEL ALCANCE EFECTIVO DE LAS ARMAS (P-2).
 *
 * Fija el alcance REAL que tiene hoy cada arma del catálogo, medido sobre el motor y no
 * sobre el dato declarado. Se escribió ANTES de migrar `weapon.rangeM` a fuente real del
 * alcance (cuando el TTL del proyectil era un 90 fijo en combat.ts) y debe seguir verde,
 * con la MISMA tabla, después de la migración: la migración no rebalancea.
 *
 *   alcance efectivo = vida del proyectil (ticks) · velocidad · TICK_DT
 *
 * Dos medidas independientes:
 *  1. Unitaria: el proyectil que crea `fire()` para una ficha resuelta por resolveVehicle
 *     (la frontera catálogo → motor) vive EXPECTED_TICKS y vuela EXPECTED_RANGE_M.
 *  2. De batalla: en una arena vacía y larga, un blanco cuya superficie cercana queda
 *     0,5 m DENTRO del alcance recibe impactos y uno a 0,5 m FUERA no recibe ninguno.
 *     Aquí la dispersión se anula en una copia del catálogo (spreadRad = 0): la medida es
 *     del alcance, no de la puntería, y no depende del orden de tiradas del RNG.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TICK_DT, loadRuleset } from "../game-rules/index.js";
import { Battle, type BotAgent } from "../../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { Vehicle } from "../../apps/arena-engine/src/sim/vehicle.js";
import { fire } from "../../apps/arena-engine/src/sim/combat.js";
import { Rng } from "../../apps/arena-engine/src/rng.js";
import { emptyArena } from "../../apps/arena-engine/src/fixtures.js";
import { loadCatalog } from "./loadCatalog.js";
import { resolveVehicle } from "./resolve/index.js";
import { gunnerLoadout, scoutLoadout } from "./resolve/archetypes.js";
import type { LoadoutInput, ModuleDefinition } from "./types.js";

/** La tabla CARACTERIZADA. Es la misma antes y después de la migración de rangeM. */
const EXPECTED: Record<string, { ticks: number; rangeM: number }> = {
  "weapon.cannon@1": { ticks: 90, rangeM: 360 },
  "weapon.mg@1": { ticks: 90, rangeM: 600 },
  "weapon.mg@2": { ticks: 90, rangeM: 600 },
};

const catalog = loadCatalog();
const weapons = catalog.filter((m) => m.category === "weapon");

/** Loadout legal con el arma `weaponId` (cañón en el medio, ametralladoras en el ligero). */
function loadoutWith(weaponId: string): LoadoutInput {
  const base = weaponId.startsWith("weapon.cannon@") ? gunnerLoadout : scoutLoadout;
  return {
    ...base,
    modules: base.modules.map((m) => (m.slot === "turret_main" ? { ...m, moduleId: weaponId } : m)),
  };
}

beforeAll(async () => {
  await initPhysics();
});

describe("MC · caracterización del alcance efectivo de las armas", () => {
  it("toda arma del catálogo está caracterizada (un arma nueva obliga a fijar su alcance)", () => {
    expect(weapons.map((w) => `${w.id}@${w.version}`).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [weaponId, exp] of Object.entries(EXPECTED)) {
    it(`${weaponId}: fire() crea un proyectil que vive ${exp.ticks} ticks y alcanza ${exp.rangeM} m`, () => {
      const spec = resolveVehicle(loadoutWith(weaponId), catalog);
      const v = new Vehicle("veh_1", "red", "bot_1", spec);
      const p = fire(v, "turret_main", 0, { x: 0, y: 0 }, new Rng("range-char"), 0);
      expect(p).not.toBeNull();
      expect(p!.ttlTicks).toBe(exp.ticks);
      const speed = Math.hypot(p!.velocity.x, p!.velocity.y);
      expect(p!.ttlTicks * speed * TICK_DT).toBeCloseTo(exp.rangeM, 6);
    });
  }
});

class Shooter implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick, fire: ["turret_main"] };
  }
}
class Idle implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick };
  }
}

/** Catálogo con la dispersión anulada (copia: el catálogo real no se toca). */
function noSpread(cat: ModuleDefinition[]): ModuleDefinition[] {
  return cat.map((m) => (m.category === "weapon" ? { ...m, spreadRad: 0 } : m));
}

/** ¿Recibe daño un blanco cuya superficie cercana está a `gapM` metros de la boca del cañón? */
function targetIsHit(weaponId: string, gapM: number): boolean {
  const cat = noSpread(catalog);
  const shooterSpec = resolveVehicle(loadoutWith(weaponId), cat);
  const targetSpec = resolveVehicle(scoutLoadout, cat);
  const y = 30;
  const shooterX = 10;
  const muzzleX = shooterX + shooterSpec.radiusM + 0.3;
  const targetX = muzzleX + gapM + targetSpec.radiusM;
  const map = emptyArena(Math.ceil(targetX + 40), 60);
  map.spawns = [
    { team: "red", position: { x: shooterX, y }, heading: 0 },
    { team: "blue", position: { x: targetX, y }, heading: Math.PI },
  ];
  const battle = new Battle({
    battleId: "range-char",
    seed: "range-char",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: shooterSpec },
      { id: "veh_2", botId: "b2", team: "blue", spec: targetSpec },
    ],
  });
  battle.attachBot("veh_1", new Shooter("b1"));
  battle.attachBot("veh_2", new Idle("b2"));
  try {
    // Vuelo máximo 90 ticks + varios disparos: 240 ticks sobran.
    for (let i = 0; i < 240; i++) battle.step();
    const target = battle.getVehicles().find((v) => v.id === "veh_2")!;
    return target.hullHp < targetSpec.hullHp;
  } finally {
    battle.free();
  }
}

describe("MC · caracterización del alcance en batalla (sin dispersión)", () => {
  for (const [weaponId, exp] of Object.entries(EXPECTED)) {
    it(`${weaponId}: impacta a ${exp.rangeM - 0.5} m de la boca y no a ${exp.rangeM + 0.5} m`, () => {
      expect(targetIsHit(weaponId, exp.rangeM - 0.5)).toBe(true);
      expect(targetIsHit(weaponId, exp.rangeM + 0.5)).toBe(false);
    });
  }
});
