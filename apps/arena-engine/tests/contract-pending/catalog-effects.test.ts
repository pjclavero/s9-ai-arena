/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MC (catálogo veraz, P-2).
 *
 *  - `movement.terrain` se ELIMINA (catálogo, esquema y tabla de estado de campos).
 *  - `radio.rangeM` se IMPLEMENTA: un compañero fuera de alcance no recibe el mensaje.
 *  - `weapon.rangeM` es la FUENTE del alcance (sin rebalancear: la baseline
 *    weapon-range.test.ts fija 360 m / 600 m como referencia de la migración).
 *  - Ningún campo declarado en un módulo es FUTURE (sin efecto).
 *
 * En ROJO sobre el BASE_SHA f07ff6f (`contractIt("MC", …)` = it.fails). Interfaces:
 * `FieldStatus` (contracts/engine-v2.ts) sustituye a `EffectStatus`; mientras MC no
 * renombre, estos tests leen `effectOf()` de effect-status.ts y tratan PARTIAL como
 * VALIDATION_ONLY. Si MC renombra el módulo, adapta SÓLO `statusOf()`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { TICK_DT, loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import type { VehicleSpec } from "../../src/sim/vehicle.js";
import { IdleBot } from "../../src/stubs.js";
import * as fieldStatus from "../../../../packages/module-catalog/effect-status.js";
import { NON_GAMEPLAY_KEYS } from "../../../../packages/module-catalog/effect-status.js";
import { ScriptBot, catalog, contractIt, fixtureGuard, loadout, rangeArena } from "../baseline/helpers.js";

beforeAll(async () => {
  await initPhysics();
});

const SCHEMA_DIR = join(import.meta.dirname, "../../../../packages/module-catalog/schema");

function statusOf(category: string, prop: string): string | undefined {
  return (fieldStatus as any).effectOf(category, prop)?.status;
}

describe("MC · movement.terrain eliminado (REMOVE)", () => {
  contractIt("MC", "ningún módulo del catálogo declara terrain", () => {
    expect(
      catalog()
        .filter((d: any) => d.terrain !== undefined)
        .map((d) => d.id),
    ).toEqual([]);
  });

  contractIt("MC", "el esquema de módulo ya no admite terrain", () => {
    const schemas = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"));
    const withTerrain = schemas.filter((f) => /"terrain"\s*:/.test(readFileSync(join(SCHEMA_DIR, f), "utf8")));
    expect(withTerrain).toEqual([]);
  });

  contractIt("MC", "la tabla de estado de campos no clasifica terrain", () => {
    expect(statusOf("movement", "terrain")).toBeUndefined();
  });
});

describe("MC · ningún campo declarado sin efecto (NO_SILENT_FAKE_FIELDS)", () => {
  contractIt("MC", "ningún campo de un módulo del catálogo real está en estado FUTURE", () => {
    const fake: string[] = [];
    for (const d of catalog()) {
      for (const k of Object.keys(d)) {
        if (NON_GAMEPLAY_KEYS.has(k)) continue;
        if (statusOf(d.category, k) === "FUTURE") fake.push(`${d.id}@${d.version}.${k}`);
      }
    }
    expect(fake).toEqual([]);
  });
});

// ------------------------------------------------------------------ radio.rangeM

function radioRun(distanceM: number): boolean {
  const scout = () =>
    loadout("chassis.light@1", [
      { slot: "drive", moduleId: "movement.wheels@1" },
      { slot: "power", moduleId: "power.battery@1" },
      { slot: "radio_a", moduleId: "radio.short@1" },
    ]);
  const map = rangeArena(400, 300);
  map.spawns = [
    { team: "red", position: { x: 20, y: 20 }, heading: 0 },
    { team: "red", position: { x: 20, y: 20 + distanceM }, heading: 0 },
    { team: "blue", position: { x: 380, y: 280 }, heading: 0 },
  ];
  const b = new Battle({
    battleId: "me_radio",
    seed: "me-radio",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 120, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: scout() },
      { id: "veh_2", botId: "b2", team: "red", spec: scout() },
      { id: "veh_3", botId: "b3", team: "blue", spec: scout() },
    ],
  });
  let heard = false;
  b.attachBot(
    "veh_1",
    new ScriptBot("b1", (t) => (t === 0 ? { radio: [{ slot: "radio_a", data: "aGk=" }] } : undefined)),
  );
  b.attachBot("veh_2", new ScriptBot("b2", (_t, o) => ((heard ||= (o.radio ?? []).length > 0), undefined)));
  b.attachBot("veh_3", new IdleBot("b3"));
  for (let t = 0; t < 30; t++) b.step();
  b.free();
  return heard;
}

describe("MC · radio.rangeM aplicado", () => {
  contractIt("MC", "un compañero a 150 m (radio.short rangeM 80) NO recibe el mensaje; a 50 m sí", () => {
    expect(radioRun(50)).toBe(true); // control positivo
    expect(radioRun(150)).toBe(false);
  });
});

// ------------------------------------------------------------------ weapon.rangeM

function flight(spec: VehicleSpec) {
  const b = new Battle({
    battleId: "me_wrange",
    seed: "me-wrange",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 400 }),
    map: rangeArena(),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec },
      {
        id: "veh_2",
        botId: "b2",
        team: "blue",
        spec: loadout("chassis.light@1", [
          { slot: "drive", moduleId: "movement.wheels@1" },
          { slot: "power", moduleId: "power.battery@1" },
        ]),
      },
    ],
  });
  b.attachBot("veh_1", new ScriptBot("b1", (t) => (t === 0 ? { fire: ["turret_main"] } : undefined)));
  b.attachBot("veh_2", new IdleBot("b2"));
  const muzzle = { x: 20 + spec.radiusM + 0.3, y: 20 };
  let maxDist = 0;
  let seen = false;
  for (let t = 0; t < 400; t++) {
    b.step();
    const ps: any[] = (b as any).projectiles;
    if (ps.length) {
      seen = true;
      maxDist = Math.max(maxDist, Math.hypot(ps[0].position.x - muzzle.x, ps[0].position.y - muzzle.y));
    } else if (seen) break;
  }
  b.free();
  fixtureGuard(seen, "flight: el arma no disparó ningún proyectil (el escenario no mide nada)");
  return maxDist;
}

const SHOOTERS = [
  { weapon: "weapon.cannon@1", ammo: "ammo.ap@1", chassis: "chassis.medium@1" },
  { weapon: "weapon.mg@1", ammo: "ammo.standard@1", chassis: "chassis.light@1" },
] as const;

/**
 * Fixture de alcance. `spreadRad = 0` en la ranura del arma: la dispersión del mg@1 sacaba
 * la bala de la `rangeArena` (100 m de alto) a los ~140 m y el test medía el perímetro, no
 * el alcance. Sin dispersión la trayectoria es recta a lo largo de +X (1000 m de arena).
 */
function shooterSpec(w: (typeof SHOOTERS)[number], rangeOverride?: number): VehicleSpec {
  const s = loadout(w.chassis, [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "turret_main", moduleId: w.weapon, ammo: w.ammo },
  ]);
  return {
    ...s,
    modules: s.modules.map((m) => {
      if (m.slot !== "turret_main") return m;
      const straight = { ...m, spreadRad: 0 };
      return rangeOverride === undefined
        ? straight
        : { ...straight, moduleId: "test.fixture_weapon_range@1", rangeM: rangeOverride };
    }),
  };
}

describe("MC · weapon.rangeM es la fuente del alcance (sin rebalancear)", () => {
  for (const w of SHOOTERS) {
    contractIt("MC", `${w.weapon}: el proyectil recorre rangeM (± un paso de tick) y desaparece`, () => {
      const spec = shooterSpec(w);
      const m = spec.modules.find((x) => x.slot === "turret_main")!;
      const step = m.projectileSpeedMs! * TICK_DT;
      expect(Math.abs(flight(spec) + step - m.rangeM!)).toBeLessThanOrEqual(step + 1e-6);
    });
  }

  contractIt("MC", "cambiar rangeM en un fixture cambia el alcance en proporción", () => {
    const w = SHOOTERS[0];
    const short = flight(shooterSpec(w, 100));
    const long = flight(shooterSpec(w, 300));
    expect(long).toBeGreaterThan(short + 150);
  });
});
