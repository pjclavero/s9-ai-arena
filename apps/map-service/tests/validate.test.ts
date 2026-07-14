/**
 * T4.2 · Validador de mapas: las SEIS comprobaciones del cap. 14.3.
 *
 * Estrategia del corpus roto: se parte de un mapa BUENO (dos gaps amplios alrededor de un
 * muro central, simétrico) y se MUTA mínimamente para introducir UN defecto por mapa. Cada
 * mapa mutado se escribe a tests/maps-broken/*.json y —salvo que pruebe un defecto
 * estructural— se valida primero contra map.schema.json, de modo que el fallo detectado sea
 * de LÓGICA del validador y no de forma. NINGUNO de estos mapas viola el esquema: el de
 * "ground.data de longitud incorrecta" pasa el esquema porque el propio esquema delega esa
 * comprobación en E4 (ver su descripción de `ground.data`).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateMap, isPublishable, hasRoute } from "../src/validate/index.js";
import { withChecksum } from "../src/canonical.js";
import type { InternalMap, Shape } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const BROKEN_DIR = join(ROOT, "tests", "maps-broken");
const SCHEMA_PATH = join(ROOT, "packages", "map-schema", "map.schema.json");
const MVP_PATH = join(ROOT, "packages", "module-catalog", "examples", "map-mvp-arena-01.json");

// --------------------------------------------------------------------------- schema
function buildSchemaValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
}
const validateSchema = buildSchemaValidator();

// --------------------------------------------------------------- mapa base BUENO
const W = 120;
const H = 80;

/** Muro central (60,40) de 4x30: deja gaps de 25 m arriba y abajo. */
function centralWall(): Shape {
  return { shape: "rect", position: { x: 60, y: 40 }, widthM: 4, heightM: 30, rotation: 0 };
}

/**
 * Muro vertical en x=60 partido en dos, dejando un GAP de altura `gapH` centrado en y=40.
 * Los dos trozos tocan los bordes (y=0 e y=H): cruzar de un lado a otro OBLIGA a usar el gap.
 */
function splitWall(gapH: number): Shape[] {
  const gapTop = 40 + gapH / 2;
  const gapBot = 40 - gapH / 2;
  return [
    { shape: "rect", position: { x: 60, y: (gapTop + H) / 2 }, widthM: 4, heightM: H - gapTop, rotation: 0 },
    { shape: "rect", position: { x: 60, y: gapBot / 2 }, widthM: 4, heightM: gapBot, rotation: 0 },
  ];
}

/** Mapa MVP bien diseñado: simétrico, dos gaps amplios, CTF + TDM, tres chasis. */
function baseGoodMap(): InternalMap {
  return withChecksum({
    schemaVersion: 1,
    mapId: "good-base",
    version: 1,
    widthM: W,
    heightM: H,
    navCellSizeM: 0.5,
    materials: [
      { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
      { id: "concrete", name: "Hormigón", blocksMovement: true, blocksVision: true },
      { id: "crate", name: "Caja", blocksMovement: true, blocksVision: true, hp: 120 },
    ],
    layers: {
      ground: { tileSizeM: 2, cols: 60, rows: 40, data: new Array(60 * 40).fill(0) },
      walls: [centralWall()],
      destructibles: [],
      spawns: [
        { objectId: "sp_red_1", team: "red", position: { x: 10, y: 36 }, heading: 0 },
        { objectId: "sp_red_2", team: "red", position: { x: 10, y: 44 }, heading: 0 },
        { objectId: "sp_blue_1", team: "blue", position: { x: 110, y: 36 }, heading: Math.PI },
        { objectId: "sp_blue_2", team: "blue", position: { x: 110, y: 44 }, heading: Math.PI },
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
      name: "Good base",
      author: "E4",
      license: "CC-BY-4.0",
      supportedModes: ["capture_the_flag", "team_deathmatch"],
      supportedChassisSizes: ["light", "medium", "heavy"],
      maxDestructibles: 64,
      destructiblesMayBlockOnlyRoute: false,
    },
  });
}

/** Clona el mapa base, aplica una mutación y recalcula el checksum (para que sea válido). */
function mutate(fn: (m: InternalMap) => void): InternalMap {
  const m = structuredClone(baseGoodMap());
  fn(m);
  return withChecksum(m);
}

// --------------------------------------------------------------- corpus de mapas rotos
interface Broken {
  name: string;
  expected: "geometry" | "navigation" | "playability" | "balance" | "mode" | "destruction";
  map: InternalMap;
  /** true si el mapa prueba un defecto estructural que NO debe validar contra el esquema. */
  structural?: boolean;
}

const broken: Broken[] = [
  // --- NAVEGACIÓN (dos, como exige el DoD) ---
  {
    name: "nav-no-route",
    expected: "navigation",
    // Muro macizo de lado a lado: NINGÚN chasis puede cruzar (mapa partido en dos).
    map: mutate((m) => {
      m.layers.walls = [{ shape: "rect", position: { x: 60, y: 40 }, widthM: 4, heightM: H, rotation: 0 }];
    }),
  },
  {
    name: "nav-light-only",
    expected: "navigation",
    // Gap de 3.6 m: pasa el chasis ligero, no el medio ni el pesado (soportados los tres).
    map: mutate((m) => {
      m.layers.walls = splitWall(3.6);
    }),
  },
  // --- GEOMETRÍA ---
  {
    name: "geometry-spawn-in-wall",
    expected: "geometry",
    // Un muro pequeño 2x2 sobre el spawn sp_red_2: queda EMPOTRADO en un sólido.
    map: mutate((m) => {
      m.layers.walls.push({ shape: "rect", position: { x: 10, y: 44 }, widthM: 2, heightM: 2, rotation: 0 });
    }),
  },
  {
    name: "geometry-ground-length",
    expected: "geometry",
    // ground.data con una celda de menos: cols*rows deja de cuadrar. (Pasa el esquema.)
    map: mutate((m) => {
      m.layers.ground.data.pop();
    }),
  },
  {
    name: "geometry-out-of-bounds",
    expected: "geometry",
    // Destructible que se sale del borde derecho del mapa (maxX = 121 > 120).
    map: mutate((m) => {
      m.layers.destructibles!.push({ objectId: "oob", material: "crate", shape: "rect", position: { x: 119, y: 40 }, widthM: 4, heightM: 2 });
    }),
  },
  {
    name: "geometry-too-many-destructibles",
    expected: "geometry",
    // 3 destructibles con maxDestructibles = 2: supera la cota del presupuesto de tick.
    map: mutate((m) => {
      m.meta.maxDestructibles = 2;
      m.layers.destructibles = [
        { objectId: "c1", material: "crate", shape: "rect", position: { x: 40, y: 20 }, widthM: 2, heightM: 2 },
        { objectId: "c2", material: "crate", shape: "rect", position: { x: 80, y: 60 }, widthM: 2, heightM: 2 },
        { objectId: "c3", material: "crate", shape: "rect", position: { x: 40, y: 60 }, widthM: 2, heightM: 2 },
      ];
    }),
  },
  // --- JUGABILIDAD ---
  {
    name: "playability-narrow",
    expected: "playability",
    // Mismo gap de 3.6 m, pero SOLO se soporta el chasis ligero: navegación pasa (el ligero
    // llega) pero el pasillo es más estrecho que el mínimo cómodo (4 m) -> jugabilidad.
    map: mutate((m) => {
      m.layers.walls = splitWall(3.6);
      m.meta.supportedChassisSizes = ["light"];
    }),
  },
  // --- EQUILIBRIO ---
  {
    name: "balance-asymmetric",
    expected: "balance",
    // Los spawns rojos se acercan mucho al centro: rojo tiene su objetivo mucho más cerca.
    map: mutate((m) => {
      m.layers.spawns[0].position = { x: 50, y: 36 };
      m.layers.spawns[1].position = { x: 50, y: 44 };
    }),
  },
  // --- MODO ---
  {
    name: "mode-ctf-no-flags",
    expected: "mode",
    // Declara capture_the_flag pero se quedó sin banderas.
    map: mutate((m) => {
      m.layers.flags = [];
    }),
  },
  // --- DESTRUCCIÓN ---
  {
    name: "destruction-destructible-blocks",
    expected: "destruction",
    // Muro con un hueco de 6 m TAPADO por un destructible; con mayBlock=false, la única
    // ruta entre lados dependería de destruir la caja -> prohibido.
    map: mutate((m) => {
      m.layers.walls = splitWall(6);
      m.layers.destructibles = [
        { objectId: "door_plug", material: "crate", shape: "rect", position: { x: 60, y: 40 }, widthM: 4, heightM: 6 },
      ];
    }),
  },
];

beforeAll(() => {
  mkdirSync(BROKEN_DIR, { recursive: true });
  for (const b of broken) {
    writeFileSync(join(BROKEN_DIR, `${b.name}.json`), JSON.stringify(b.map, null, 2));
  }
});

// --------------------------------------------------------------------------- tests
function errorChecks(map: InternalMap): string[] {
  return validateMap(map).checks.filter((c) => c.severity === "error").map((c) => c.check);
}

describe("T4.2 · corpus de mapas rotos", () => {
  it("hay al menos 10 mapas rotos, dos de ellos de navegación", () => {
    expect(broken.length).toBeGreaterThanOrEqual(10);
    expect(broken.filter((b) => b.expected === "navigation").length).toBeGreaterThanOrEqual(2);
  });

  for (const b of broken) {
    it(`${b.name}: estructura válida contra el esquema${b.structural ? " (OMITIDO: defecto estructural)" : ""}`, () => {
      if (b.structural) return; // documentado: no debe validar contra el esquema
      const ok = validateSchema(b.map);
      expect(ok, JSON.stringify(validateSchema.errors)).toBe(true);
    });

    it(`${b.name}: falla EXACTAMENTE en la comprobación "${b.expected}"`, () => {
      const errs = errorChecks(b.map);
      // Contiene un error de la comprobación esperada...
      expect(errs, `esperaba un error de "${b.expected}", hubo: ${errs.join(", ") || "ninguno"}`).toContain(b.expected);
      // ...y NINGÚN error de otra comprobación no relacionada.
      const otros = [...new Set(errs.filter((c) => c !== b.expected))];
      expect(otros, `errores inesperados en otras comprobaciones: ${otros.join(", ")}`).toEqual([]);
      // No es publicable (tiene al menos un error).
      expect(isPublishable(validateMap(b.map))).toBe(false);
    });
  }
});

describe("T4.2 · mapa bueno pasa las SEIS comprobaciones", () => {
  it("el mapa base bueno no produce ningún error", () => {
    const result = validateMap(baseGoodMap());
    const errs = result.checks.filter((c) => c.severity === "error");
    expect(errs, JSON.stringify(errs)).toEqual([]);
    expect(isPublishable(result)).toBe(true);
  });

  it("el ejemplo real map-mvp-arena-01.json es publicable (0 errores)", () => {
    const mvp = JSON.parse(readFileSync(MVP_PATH, "utf8")) as InternalMap;
    // El propio ejemplo valida contra el esquema.
    expect(validateSchema(mvp), JSON.stringify(validateSchema.errors)).toBe(true);
    const result = validateMap(mvp);
    const errs = result.checks.filter((c) => c.severity === "error");
    expect(errs, JSON.stringify(errs)).toEqual([]);
    expect(isPublishable(result)).toBe(true);
  });

  it("hay ruta entre lados para los TRES tamaños de chasis en el mapa bueno", () => {
    const m = baseGoodMap();
    const red = { x: 10, y: 36 };
    const blue = { x: 110, y: 36 };
    for (const size of ["light", "medium", "heavy"] as const) {
      expect(hasRoute(m, size, red, blue, { ignoreDestructibles: true }), `chasis ${size}`).toBe(true);
    }
  });
});

describe("T4.2 · comprobación de destrucción", () => {
  it("detecta que la única ruta a la bandera pasa por un destructible con mayBlock=false", () => {
    const map = broken.find((b) => b.name === "destruction-destructible-blocks")!.map;
    const errs = validateMap(map).checks.filter((c) => c.severity === "error");
    expect(errs.map((c) => c.check)).toContain("destruction");
    expect(errs.every((c) => c.check === "destruction")).toBe(true);
  });

  it("si mayBlock=true, el mismo mapa SÍ es aceptable por destrucción", () => {
    const map = structuredClone(broken.find((b) => b.name === "destruction-destructible-blocks")!.map);
    map.meta.destructiblesMayBlockOnlyRoute = true;
    const errs = validateMap(withChecksum(map)).checks.filter((c) => c.severity === "error");
    expect(errs.map((c) => c.check)).not.toContain("destruction");
  });
});

describe("T4.2 · pureza (mismo input -> mismo output)", () => {
  it("validateMap devuelve el mismo resultado en llamadas repetidas", () => {
    const m = baseGoodMap();
    const a = validateMap(m);
    const b = validateMap(m);
    expect(b).toEqual(a);
    // También sobre un mapa roto, para cubrir las ramas de error.
    const bad = broken[0].map;
    expect(validateMap(bad)).toEqual(validateMap(bad));
  });
});
