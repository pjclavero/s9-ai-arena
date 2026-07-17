/**
 * R1.3 · Los sensores que el motor ya implementaba (sensor.acoustic, sensor.proximity)
 * ahora existen como DATO de catálogo y, por tanto, son montables desde un loadout real.
 *
 * Antes de R1.3 el motor sabía leer `sensorType: "acoustic"` y `"proximity"`
 * (apps/arena-engine/src/sim/sensors.ts) y el esquema los declaraba, pero ningún vehículo
 * podía llevarlos porque no había fichero en data/. Este test cubre las tres puertas que
 * los hacen utilizables de verdad: (1) validan contra el esquema de E1, (2) un loadout que
 * los monta es legal (validateLoadout), y (3) —integrando con R1.2— un vehículo con
 * sensor.acoustic RESUELTO DESDE CATÁLOGO oye un disparo en una batalla real.
 */
import { beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, DATA_DIR, CATALOG_VERSION } from "./loadCatalog.js";
import { validateLoadout } from "./validator/index.js";
import { resolveVehicle } from "./resolve/index.js";
import { findModule, type LoadoutInput } from "./types.js";
import { BUDGET_CREDITS_MVP, loadRuleset } from "../game-rules/index.js";
import { Battle } from "../../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { emptyArena, gunnerLoadout } from "../../apps/arena-engine/src/fixtures.js";

const SCHEMA_PATH = join(DATA_DIR, "..", "schema", "module.schema.json");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateModule = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

const catalog = loadCatalog();

describe("R1.3 · sensor.acoustic@1 y sensor.proximity@1 existen y validan", () => {
  for (const id of ["sensor.acoustic@1", "sensor.proximity@1"]) {
    it(`${id} está en el catálogo y valida contra module.schema.json`, () => {
      const def = findModule(catalog, id);
      expect(def, `${id} no existe en el catálogo`).toBeDefined();
      const ok: boolean = validateModule(def);
      if (!ok) throw new Error(`${id}: ${JSON.stringify(validateModule.errors, null, 2)}`);
      expect(ok).toBe(true);
    });
  }

  it("sensor.acoustic declara sensorType acoustic y el rangeM que consume el motor", () => {
    const def = findModule(catalog, "sensor.acoustic@1")!;
    expect(def.sensorType).toBe("acoustic");
    // sensors.ts lee rangeM para filtrar sonidos; sin él el sensor no oiría nada.
    expect(def.rangeM).toBeGreaterThan(0);
  });

  it("sensor.proximity declara sensorType proximity y su rangeM", () => {
    const def = findModule(catalog, "sensor.proximity@1")!;
    expect(def.sensorType).toBe("proximity");
    expect(def.rangeM).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- loadouts legales
/** Explorador ligero cuyo único sensor es el acústico (sensor_a del chasis ligero). */
const acousticListenerLoadout: LoadoutInput = {
  loadoutId: "ldt_acoustic01",
  revision: 1,
  name: "Escucha ligero",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.acoustic@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

/** Medio con detector de proximidad como sensor. */
const proximityLoadout: LoadoutInput = {
  loadoutId: "ldt_proximity01",
  revision: 1,
  name: "Guardián medio",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.proximity@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

describe("R1.3 · ambos sensores son montables en un loadout legal (budget/masa/energía)", () => {
  it("sensor.acoustic monta legalmente en un chasis ligero", () => {
    const violations = validateLoadout(acousticListenerLoadout, catalog, BUDGET_CREDITS_MVP);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });

  it("sensor.proximity monta legalmente en un chasis medio", () => {
    const violations = validateLoadout(proximityLoadout, catalog, BUDGET_CREDITS_MVP);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });

  it("ambos loadouts resuelven a un VehicleSpec con su sensor aplanado", () => {
    const listener = resolveVehicle(acousticListenerLoadout, catalog);
    const acoustic = listener.modules.find((m) => m.moduleId === "sensor.acoustic@1");
    expect(acoustic?.sensorType).toBe("acoustic");
    expect(acoustic?.rangeM).toBeGreaterThan(0);

    const guard = resolveVehicle(proximityLoadout, catalog);
    const prox = guard.modules.find((m) => m.moduleId === "sensor.proximity@1");
    expect(prox?.sensorType).toBe("proximity");
    expect(prox?.rangeM).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- integración con R1.2
describe("R1.3 + R1.2 · un vehículo con sensor.acoustic DEL CATÁLOGO oye un disparo real", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("el acústico montado desde catálogo percibe un disparo y da dirección, nunca posición", () => {
    // Oyente = loadout legal de arriba, resuelto por el mismo camino que usa el motor
    // real (loadCatalog → validateLoadout → resolveVehicle). No usamos el fixture
    // MODULES.acoustic del motor: probamos que el DATO de catálogo basta.
    const listener = resolveVehicle(acousticListenerLoadout, catalog);
    const shooter = gunnerLoadout(); // artillero con cañón: su fogonazo hace ruido

    const b = new Battle({
      battleId: "r13-acoustic",
      seed: "r13-seed",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000 }),
      map: emptyArena(),
      participants: [
        { id: "veh_listener", botId: "bot_listener", team: "red", spec: listener },
        { id: "veh_shooter", botId: "bot_shooter", team: "blue", spec: shooter },
      ],
    });

    const phys = b.getPhysics();
    b.step();
    phys.get("veh_listener")!.rb.setTranslation({ x: 60, y: 40 }, true); // oyente
    phys.get("veh_shooter")!.rb.setTranslation({ x: 45, y: 40 }, true); // tirador, 15 m al oeste

    // Lo que el OYENTE recibe en su decisión: la ruta real que R1.2 dejó operativa.
    const heard: any[] = [];
    b.attachBot("veh_listener", {
      botId: "bot_listener",
      decide: (obs: any) => {
        for (const s of obs.sensors?.acoustic?.[0]?.sources ?? []) heard.push(s);
        return { forTick: obs.tick, move: { throttle: 0, steer: 0 } };
      },
    });
    // El tirador dispara hacia el oeste, lejos del oyente: solo el fogonazo entra en alcance.
    b.attachBot("veh_shooter", {
      botId: "bot_shooter",
      decide: (obs: any) => ({
        forTick: obs.tick,
        move: { throttle: 0, steer: 0 },
        turret: { targetPoint: { x: 0, y: 40 } },
        fire: ["turret_main"],
      }),
    });

    for (let i = 0; i < 30; i++) {
      b.step();
      phys.get("veh_listener")!.rb.setTranslation({ x: 60, y: 40 }, true);
      phys.get("veh_shooter")!.rb.setTranslation({ x: 45, y: 40 }, true);
    }

    const shots = heard.filter((s) => s.kind === "gunshot");
    expect(shots.length, "el sensor.acoustic del catálogo nunca percibió el disparo").toBeGreaterThan(0);
    for (const s of shots) {
      expect(s).toHaveProperty("bearing");
      expect(s).not.toHaveProperty("position"); // solo dirección (cap. 11)
      expect(s).not.toHaveProperty("distanceM");
      expect(s).not.toHaveProperty("entityId");
      // El disparo viene del oeste: bearing ≈ ±π.
      expect(Math.abs(Math.abs(s.bearing) - Math.PI)).toBeLessThan(0.5);
    }
    b.free();
  });
});
