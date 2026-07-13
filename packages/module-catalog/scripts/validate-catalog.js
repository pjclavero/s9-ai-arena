#!/usr/bin/env node
/* Valida definiciones de módulo, loadouts y mapas contra los esquemas de E1.
 * Sin argumentos ejecuta la suite de ejemplos (válidos deben pasar, inválidos fallar).
 * Uso: validate-catalog.js [module|loadout|map] <archivo>
 */
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..", "..", "..");
const SCHEMAS = {
  module: path.join(ROOT, "packages/module-catalog/schema/module.schema.json"),
  loadout: path.join(ROOT, "packages/module-catalog/schema/loadout.schema.json"),
  map: path.join(ROOT, "packages/map-schema/map.schema.json"),
};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = Object.fromEntries(
  Object.entries(SCHEMAS).map(([k, p]) => [k, ajv.compile(JSON.parse(fs.readFileSync(p, "utf8")))]),
);

function check(kind, doc) {
  const v = validators[kind];
  const { _why, ...clean } = doc;
  const ok = v(clean);
  return { ok, errors: v.errors ? [...v.errors] : [] };
}

// ---------------------------------------------------------------- Ejemplos
const examples = {
  valid: {
    "module-chassis-medium": ["module", {
      id: "chassis.medium", version: 1, category: "chassis", name: "Chasis medio",
      massKg: 1400, costCredits: 220, hullHp: 300, radiusM: 1.6, maxLoadKg: 1600,
      slots: [
        { id: "drive", accepts: ["movement"], maxSize: "L" },
        { id: "power", accepts: ["power"], maxSize: "M" },
        { id: "sensor_a", accepts: ["sensor"], maxSize: "M" },
        { id: "turret_main", accepts: ["weapon"], maxSize: "L" },
        { id: "ammo_main", accepts: ["ammo"], maxSize: "M" },
        { id: "mine_bay", accepts: ["mine", "utility"], maxSize: "M" },
        { id: "radio_a", accepts: ["radio"], maxSize: "S" },
        { id: "armor_front", accepts: ["armor"], maxSize: "L", sector: "front" },
        { id: "armor_left", accepts: ["armor"], maxSize: "M", sector: "left" },
        { id: "armor_right", accepts: ["armor"], maxSize: "M", sector: "right" },
        { id: "armor_rear", accepts: ["armor"], maxSize: "M", sector: "rear" },
      ],
    }],
    "module-cannon": ["module", {
      id: "weapon.cannon", version: 1, category: "weapon", name: "Cañón de 60 mm",
      massKg: 380, costCredits: 190, size: "L", hp: 90,
      power: { passiveEUs: 1.5, perActionEU: 12 },
      damage: 45, cooldownTicks: 30, projectileSpeedMs: 120, spreadRad: 0.01, rangeM: 60,
      acceptsAmmo: ["ammo.ap", "ammo.he"], turretArcRad: 6.2832, turretRateRads: 1.0,
      maxPerVehicle: 1,
    }],
    "module-lidar360": ["module", {
      id: "sensor.lidar360", version: 1, category: "sensor", name: "Lidar 360",
      massKg: 60, costCredits: 140, size: "M", hp: 40,
      power: { passiveEUs: 4 },
      sensorType: "lidar", rangeM: 40, fovRad: 6.2832, rays: 64,
    }],
    "module-armor-steel-front": ["module", {
      id: "armor.steel_front", version: 1, category: "armor", name: "Blindaje de acero frontal",
      massKg: 420, costCredits: 120, size: "L", hp: 200,
      sector: "front", reduction: 0.35,
    }],
    "loadout-medium-gunner": ["loadout", {
      loadoutId: "ldt_gunner01", revision: 3, name: "Artillero medio",
      catalogVersion: "mvp@1", chassis: "chassis.medium@1",
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.battery@1" },
        { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
        { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
        { slot: "armor_front", moduleId: "armor.steel_front@1" },
      ],
    }],
    "map-mvp-arena-01": ["map", {
      schemaVersion: 1, mapId: "mvp-arena-01", version: 1,
      checksum: "sha256:3b1c9f0a7d2e4658a19b0c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      widthM: 120, heightM: 80, navCellSizeM: 0.5,
      materials: [
        { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
        { id: "concrete", name: "Muro de hormigón", blocksMovement: true, blocksVision: true },
        { id: "crate", name: "Caja destructible", blocksMovement: true, blocksVision: true, hp: 120 },
        { id: "acid", name: "Zona corrosiva", blocksMovement: false, blocksVision: false, damagePerSecond: 8 },
      ],
      layers: {
        ground: { tileSizeM: 2, cols: 60, rows: 40, data: new Array(2400).fill(0) },
        walls: [
          { shape: "rect", position: { x: 60, y: 40 }, widthM: 4, heightM: 24, rotation: 0 },
        ],
        destructibles: [
          { objectId: "crate_01", material: "crate", shape: "rect", position: { x: 40, y: 20 }, widthM: 2, heightM: 2 },
        ],
        zones: [
          { objectId: "acid_pool", zoneType: "damage", damagePerSecond: 8, shape: "circle", position: { x: 60, y: 15 }, radiusM: 6 },
        ],
        spawns: [
          { objectId: "sp_red_1", team: "red", position: { x: 10, y: 36 }, heading: 0 },
          { objectId: "sp_red_2", team: "red", position: { x: 10, y: 44 }, heading: 0 },
          { objectId: "sp_blue_1", team: "blue", position: { x: 110, y: 36 }, heading: 3.14159 },
          { objectId: "sp_blue_2", team: "blue", position: { x: 110, y: 44 }, heading: 3.14159 },
        ],
        bases: [
          { objectId: "base_red", team: "red", shape: "rect", position: { x: 8, y: 40 }, widthM: 8, heightM: 12 },
          { objectId: "base_blue", team: "blue", shape: "rect", position: { x: 112, y: 40 }, widthM: 8, heightM: 12 },
        ],
        flags: [
          { objectId: "flag_red", team: "red", position: { x: 8, y: 40 } },
          { objectId: "flag_blue", team: "blue", position: { x: 112, y: 40 } },
        ],
      },
      meta: {
        name: "Arena MVP 01", author: "E4", license: "CC-BY-4.0",
        supportedModes: ["capture_the_flag", "team_deathmatch"],
        supportedChassisSizes: ["light", "medium", "heavy"],
        maxDestructibles: 64,
        destructiblesMayBlockOnlyRoute: false,
      },
    }],
  },

  invalid: {
    "module-armor-reduction-too-high": ["module", {
      _why: "reduction 0.95 > 0.9: el blindaje nunca puede anular el daño (D6)",
      id: "armor.godmode", version: 1, category: "armor", name: "Blindaje imposible",
      massKg: 10, costCredits: 10, size: "S", hp: 10, sector: "front", reduction: 0.95,
    }],
    "module-weapon-without-ammo-compat": ["module", {
      _why: "arma sin acceptsAmmo: la compatibilidad arma-munición es obligatoria (cap. 10.2)",
      id: "weapon.mystery", version: 1, category: "weapon", name: "Arma sin munición",
      massKg: 100, costCredits: 100, size: "M", hp: 50,
      damage: 10, cooldownTicks: 10, projectileSpeedMs: 50, turretArcRad: 1, turretRateRads: 1,
    }],
    "module-non-chassis-without-hp": ["module", {
      _why: "todo módulo no-chasis debe declarar size y hp: es dañable (cap. 12.2)",
      id: "sensor.ghost", version: 1, category: "sensor", name: "Sensor invulnerable",
      massKg: 10, costCredits: 10, sensorType: "radar", rangeM: 50,
    }],
    "module-version-zero": ["module", {
      _why: "version debe ser >= 1: no existe la versión 0",
      id: "power.battery", version: 0, category: "power", name: "Batería",
      massKg: 100, costCredits: 60, size: "M", hp: 50, capacityEU: 400, generationEUs: 15,
    }],
    "module-lidar-too-many-rays": ["module", {
      _why: "512 rayos > 256: cota que protege el presupuesto de tick del motor",
      id: "sensor.lidar_insane", version: 1, category: "sensor", name: "Lidar imposible",
      massKg: 60, costCredits: 140, size: "M", hp: 40,
      sensorType: "lidar", rangeM: 40, fovRad: 6.2832, rays: 512,
    }],
    "loadout-unversioned-module": ["loadout", {
      _why: "moduleId sin versión: un loadout debe fijar versiones exactas (cap. 10.4)",
      loadoutId: "ldt_bad", revision: 1, catalogVersion: "mvp@1", chassis: "chassis.medium@1",
      modules: [{ slot: "drive", moduleId: "movement.tracks" }],
    }],
    "loadout-missing-catalog-version": ["loadout", {
      _why: "sin catalogVersion no es reproducible qué números aplicaron",
      loadoutId: "ldt_bad2", revision: 1, chassis: "chassis.medium@1", modules: [],
    }],
    "map-bad-checksum": ["map", {
      _why: "checksum sin formato sha256:<64 hex>",
      schemaVersion: 1, mapId: "m1", version: 1, checksum: "deadbeef",
      widthM: 10, heightM: 10,
      materials: [{ id: "floor", blocksMovement: false, blocksVision: false }],
      layers: { ground: { tileSizeM: 1, cols: 10, rows: 10, data: [] }, walls: [], spawns: [{ objectId: "s1", team: "red", position: { x: 1, y: 1 }, heading: 0 }] },
      meta: { author: "a", license: "l", supportedModes: ["deathmatch"] },
    }],
    "map-no-spawns": ["map", {
      _why: "sin spawns el mapa no es jugable (cap. 14.3, comprobación de geometría)",
      schemaVersion: 1, mapId: "m2", version: 1,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      widthM: 10, heightM: 10,
      materials: [{ id: "floor", blocksMovement: false, blocksVision: false }],
      layers: { ground: { tileSizeM: 1, cols: 10, rows: 10, data: [] }, walls: [], spawns: [] },
      meta: { author: "a", license: "l", supportedModes: ["deathmatch"] },
    }],
    "map-unknown-mode": ["map", {
      _why: "modo no soportado en supportedModes",
      schemaVersion: 1, mapId: "m3", version: 1,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      widthM: 10, heightM: 10,
      materials: [{ id: "floor", blocksMovement: false, blocksVision: false }],
      layers: { ground: { tileSizeM: 1, cols: 10, rows: 10, data: [] }, walls: [], spawns: [{ objectId: "s1", team: "red", position: { x: 1, y: 1 }, heading: 0 }] },
      meta: { author: "a", license: "l", supportedModes: ["battle_royale"] },
    }],
    "map-schema-version-regression": ["map", {
      _why: "schemaVersion distinto de 1: las migraciones se hacen con un esquema nuevo, no relajando este",
      schemaVersion: 0, mapId: "m4", version: 1,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      widthM: 10, heightM: 10,
      materials: [{ id: "floor", blocksMovement: false, blocksVision: false }],
      layers: { ground: { tileSizeM: 1, cols: 10, rows: 10, data: [] }, walls: [], spawns: [{ objectId: "s1", team: "red", position: { x: 1, y: 1 }, heading: 0 }] },
      meta: { author: "a", license: "l", supportedModes: ["deathmatch"] },
    }],
  },
};

if (process.argv[2] && process.argv[3]) {
  const kind = process.argv[2];
  const doc = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const { ok, errors } = check(kind, doc);
  console.log(ok ? "OK" : "FAIL");
  if (!ok) for (const e of errors) console.log(`  ${e.instancePath || "/"} ${e.message}`);
  process.exit(ok ? 0 : 1);
}

let failures = 0;
console.log("== módulos, loadouts y mapas válidos (deben PASAR) ==");
for (const [name, [kind, doc]] of Object.entries(examples.valid)) {
  const { ok, errors } = check(kind, doc);
  if (ok) console.log(`  OK    [${kind}] ${name}`);
  else {
    failures++;
    console.log(`  FALLO [${kind}] ${name}`);
    for (const e of errors.slice(0, 3)) console.log(`          ${e.instancePath || "/"} ${e.message}`);
  }
}

console.log("\n== inválidos (deben SER RECHAZADOS) ==");
for (const [name, [kind, doc]] of Object.entries(examples.invalid)) {
  const { ok } = check(kind, doc);
  if (!ok) console.log(`  OK    [${kind}] ${name}  (${doc._why})`);
  else {
    failures++;
    console.log(`  FALLO [${kind}] ${name}: fue ACEPTADO (${doc._why})`);
  }
}

// Los ejemplos válidos se escriben a disco como golden files reutilizables por E3 y E4.
const outDir = path.join(ROOT, "packages/module-catalog/examples");
fs.mkdirSync(outDir, { recursive: true });
for (const [name, [, doc]] of Object.entries(examples.valid)) {
  fs.writeFileSync(path.join(outDir, name + ".json"), JSON.stringify(doc, null, 2) + "\n");
}

console.log(`\n${failures === 0 ? "TODO CORRECTO" : failures + " FALLO(S)"}`);
process.exit(failures ? 1 : 0);
