/**
 * Tests del importador de Tiled (E4/T4.1). Cubren la DoD de la tarea:
 *  - El mapa MVP fuente (maps/mvp-arena-01.tiled.json) importa sin errores y su
 *    resultado coincide BYTE A BYTE con el golden maps/mvp-arena-01.json.
 *  - El checksum es estable en 20 ejecuciones.
 *  - Una propiedad personalizada desconocida produce un WARNING (no una excepción).
 *  - Un mapa sin la capa 'ground' o sin 'spawns' lanza un Error que NOMBRA la capa.
 *  - El golden valida contra packages/map-schema/map.schema.json (Ajv 2020).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { importTiled, type TiledMap } from "../src/import-tiled.js";

const SOURCE_PATH = fileURLToPath(new URL("../../../maps/mvp-arena-01.tiled.json", import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL("../../../maps/mvp-arena-01.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../../../packages/map-schema/map.schema.json", import.meta.url));

function readSource(): TiledMap {
  return JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as TiledMap;
}

/**
 * Mapa de Tiled MÍNIMO pero importable: una tilelayer 'ground' y un object group
 * 'spawns' con un spawn. Base para construir casos de error/aviso mutándolo.
 */
function minimalTiled(): TiledMap {
  return {
    width: 4,
    height: 4,
    tilewidth: 10,
    tileheight: 10,
    properties: [
      { name: "pixelsPerMeter", type: "float", value: 10 },
      { name: "mapId", type: "string", value: "mini" },
      { name: "author", type: "string", value: "E4" },
      { name: "license", type: "string", value: "CC-BY-4.0" },
      { name: "supportedModes", type: "string", value: "deathmatch" },
    ],
    tilesets: [{ firstgid: 1, name: "materials" }],
    layers: [
      { type: "tilelayer", name: "ground", data: new Array(16).fill(1) },
      {
        type: "objectgroup",
        name: "spawns",
        objects: [
          {
            id: 1,
            name: "sp_1",
            x: 5,
            y: 5,
            point: true,
            properties: [
              { name: "team", value: "red" },
              { name: "heading", value: 0 },
            ],
          },
        ],
      },
    ],
  };
}

describe("importTiled · mapa MVP (golden)", () => {
  it("importa el fuente sin errores y produce EXACTAMENTE el golden del repo", () => {
    const { map, warnings } = importTiled(readSource());
    expect(warnings).toEqual([]);
    // Golden byte a byte: mismo serializado que el archivo versionado.
    const serialized = JSON.stringify(map, null, 2) + "\n";
    expect(serialized).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });

  it("tiene las dimensiones y capas esperadas (120x80, dos pasillos, dos bases/banderas)", () => {
    const { map } = importTiled(readSource());
    expect(map.widthM).toBe(120);
    expect(map.heightM).toBe(80);
    expect(map.layers.walls).toHaveLength(3);
    expect(map.layers.spawns).toHaveLength(4);
    expect(map.layers.bases).toHaveLength(2);
    expect(map.layers.flags).toHaveLength(2);
    expect(map.layers.destructibles).toHaveLength(4);
    expect(map.layers.zones).toHaveLength(2);
    // Volteo de Y correcto: la zona 'norte' quedó en y alto y la 'sur' en y bajo.
    const zn = map.layers.zones!.find((z) => z.objectId === "acid_pool_n")!;
    const zs = map.layers.zones!.find((z) => z.objectId === "acid_pool_s")!;
    expect(zn.position!.y).toBe(65);
    expect(zs.position!.y).toBe(15);
  });

  it("el checksum es estable en 20 ejecuciones (re-importando desde cero)", () => {
    const first = importTiled(readSource()).map.checksum;
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let i = 0; i < 20; i++) {
      expect(importTiled(readSource()).map.checksum).toBe(first);
    }
  });
});

describe("importTiled · propiedades desconocidas", () => {
  it("una propiedad personalizada desconocida produce un warning, no una excepción", () => {
    const t = minimalTiled();
    // Propiedad inventada sobre el spawn.
    (t.layers[1].objects![0].properties as { name: string; value: unknown }[]).push({ name: "wobble", value: 3 });
    const { warnings } = importTiled(t);
    expect(warnings.some((w) => w.includes("wobble"))).toBe(true);
  });

  it("una propiedad de mapa desconocida también produce un warning", () => {
    const t = minimalTiled();
    (t.properties as { name: string; value: unknown }[]).push({ name: "spookyMapProp", value: true });
    const { warnings } = importTiled(t);
    expect(warnings.some((w) => w.includes("spookyMapProp"))).toBe(true);
  });

  it("un object group con nombre no reconocido se ignora con warning", () => {
    const t = minimalTiled();
    t.layers.push({ type: "objectgroup", name: "decoracion", objects: [{ id: 9, x: 0, y: 0 }] });
    const { warnings } = importTiled(t);
    expect(warnings.some((w) => w.includes("decoracion"))).toBe(true);
  });
});

describe("importTiled · capas obligatorias ausentes", () => {
  it("sin capa 'ground' lanza un Error que nombra 'ground'", () => {
    const t = minimalTiled();
    t.layers = t.layers.filter((l) => l.type !== "tilelayer");
    expect(() => importTiled(t)).toThrow(/ground/);
  });

  it("sin capa 'spawns' lanza un Error que nombra 'spawns'", () => {
    const t = minimalTiled();
    t.layers = t.layers.filter((l) => l.name !== "spawns");
    expect(() => importTiled(t)).toThrow(/spawns/);
  });

  it("con object group 'spawns' pero vacío también lanza un Error que nombra 'spawns'", () => {
    const t = minimalTiled();
    t.layers[1].objects = [];
    expect(() => importTiled(t)).toThrow(/spawns/);
  });

  it("sin la escala 'pixelsPerMeter' lanza un Error explicativo", () => {
    const t = minimalTiled();
    t.properties = (t.properties ?? []).filter((p) => p.name !== "pixelsPerMeter");
    expect(() => importTiled(t)).toThrow(/pixelsPerMeter/);
  });
});

describe("golden · validación de esquema E1", () => {
  it("maps/mvp-arena-01.json valida contra map.schema.json (Ajv 2020)", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const ajv = new (
      Ajv2020 as unknown as new (o: object) => {
        compile: (s: object) => (d: unknown) => boolean;
        errorsText: () => string;
      }
    )({
      strict: false,
      allErrors: true,
    });
    (addFormats as unknown as (a: unknown) => void)(ajv);
    const validate = ajv.compile(schema);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
    const ok = validate(golden);
    expect(ok, ajv.errorsText()).toBe(true);
  });
});
