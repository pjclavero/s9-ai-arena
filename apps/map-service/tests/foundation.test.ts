/**
 * Verifica la BASE compartida de E4 (canonical + to-engine-map) de forma aislada,
 * antes de que el importador (T4.1), el validador (T4.2), el servicio (T4.3) y el
 * generador (T4.4) construyan encima. Es el contrato que todos comparten.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, computeChecksum, verifyChecksum, withChecksum } from "../src/canonical.js";
import { toEngineMap } from "../src/to-engine-map.js";
import type { InternalMap } from "../src/types.js";
import { Battle } from "../../arena-engine/src/sim/battle.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { IdleBot, ForwardBot } from "../../arena-engine/src/stubs.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";

/** Mapa interno mínimo pero completo y bien formado (2 corredores en el muro central). */
function sampleMap(): InternalMap {
  const cols = 60, rows = 40;
  return withChecksum({
    schemaVersion: 1,
    mapId: "foundation-sample",
    version: 1,
    widthM: 120,
    heightM: 80,
    navCellSizeM: 0.5,
    materials: [
      { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
      { id: "concrete", name: "Hormigón", blocksMovement: true, blocksVision: true },
      { id: "crate", name: "Caja", blocksMovement: true, blocksVision: true, hp: 120 },
      { id: "acid", name: "Ácido", blocksMovement: false, blocksVision: false, damagePerSecond: 8 },
    ],
    layers: {
      ground: { tileSizeM: 2, cols, rows, data: new Array(cols * rows).fill(0) },
      walls: [
        // Muro central partido en dos, dejando un corredor central (y 30..50).
        { shape: "rect", position: { x: 60, y: 62 }, widthM: 4, heightM: 24, rotation: 0 },
        { shape: "rect", position: { x: 60, y: 18 }, widthM: 4, heightM: 24, rotation: 0 },
      ],
      destructibles: [
        { objectId: "crate_01", material: "crate", shape: "rect", position: { x: 45, y: 55 }, widthM: 2, heightM: 2 },
      ],
      zones: [
        { objectId: "acid_pool", zoneType: "damage", damagePerSecond: 8, shape: "circle", position: { x: 60, y: 40 }, radiusM: 5 },
      ],
      spawns: [
        { objectId: "sp_red_1", team: "red", position: { x: 10, y: 40 }, heading: 0 },
        { objectId: "sp_blue_1", team: "blue", position: { x: 110, y: 40 }, heading: Math.PI },
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
      name: "Foundation sample",
      author: "E4",
      license: "CC-BY-4.0",
      supportedModes: ["capture_the_flag", "team_deathmatch"],
      supportedChassisSizes: ["light", "medium", "heavy"],
      maxDestructibles: 64,
      destructiblesMayBlockOnlyRoute: false,
    },
  });
}

describe("E4 base · checksum canónico", () => {
  it("es estable en 20 ejecuciones (no depende de orden ni de locale)", () => {
    const map = sampleMap();
    const first = computeChecksum(map);
    for (let i = 0; i < 20; i++) expect(computeChecksum(map)).toBe(first);
  });

  it("no depende del orden de las claves del objeto de entrada", () => {
    const map = sampleMap();
    // Reconstruye el mismo mapa con las claves de meta en orden inverso.
    const reordered = { ...map, meta: Object.fromEntries(Object.entries(map.meta).reverse()) } as InternalMap;
    expect(computeChecksum(reordered)).toBe(computeChecksum(map));
  });

  it("ignora el propio campo checksum al calcularlo", () => {
    const map = sampleMap();
    const withBogus = { ...map, checksum: "sha256:" + "0".repeat(64) };
    expect(computeChecksum(withBogus)).toBe(computeChecksum(map));
  });

  it("withChecksum produce un mapa cuyo checksum se verifica", () => {
    expect(verifyChecksum(sampleMap())).toBe(true);
  });

  it("tiene el formato sha256:<64 hex>", () => {
    expect(computeChecksum(sampleMap())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("canonicalize ordena claves recursivamente y no mete espacios", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("E4 base · toEngineMap", () => {
  it("aplana el formato interno a ArenaMap con las formas correctas", () => {
    const eng = toEngineMap(sampleMap());
    expect(eng.walls).toHaveLength(2);
    expect(eng.walls[0]).toMatchObject({ id: "wall_0", halfW: 2, halfH: 12 });
    expect(eng.destructibles[0]).toMatchObject({ id: "crate_01", halfW: 1, halfH: 1, hp: 120 });
    expect(eng.bases.map((b) => b.team).sort()).toEqual(["blue", "red"]);
    expect(eng.bases[0].radiusM).toBe(4); // min(8,12)/2
    expect(eng.zones[0]).toMatchObject({ id: "acid_pool", kind: "damage", radiusM: 5, damagePerSecond: 8 });
    expect(eng.flags).toHaveLength(2);
  });

  it("una batalla REAL corre sobre el mapa convertido sin lanzar", async () => {
    await initPhysics();
    const catalog = loadCatalog();
    const battle = await Battle.create({
      battleId: "foundation-battle",
      seed: "foundation",
      ruleset: loadRuleset("ctf_mvp@1", { timeLimitTicks: 120 }),
      map: toEngineMap(sampleMap()),
      participants: [
        { id: "veh_1", botId: "bot_a", team: "red", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
        { id: "veh_2", botId: "bot_b", team: "blue", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      ],
    });
    battle.attachBot("veh_1", new ForwardBot("bot_a"));
    battle.attachBot("veh_2", new IdleBot("bot_b"));
    expect(() => {
      for (let i = 0; i < 120; i++) battle.step();
    }).not.toThrow();
    battle.free();
  });
});
