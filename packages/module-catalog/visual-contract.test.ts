/**
 * VISUAL BOTS · FASE 0 · Contrato visual frente al catálogo REAL.
 *
 * Los documentos de `docs/visual-bots/` (inventario y matriz) se escribieron a mano a partir del
 * código. Este test impide que se desalineen: lee el catálogo de verdad (`loadCatalog()` sobre
 * `data/*.json` y el `enum` de `category` de `schema/module.schema.json`, nunca una copia) y
 * parsea las tablas Markdown y los bloques JSON de los documentos.
 *
 *   TEST 1 · VISUAL_INVENTORY_COVERAGE      todo módulo del catálogo está en el inventario (o marcado NONE),
 *                                          sin ids inventados y con categoría/tamaño/masa del catálogo.
 *   TEST 2 · VISUAL_INVENTORY_UNIQUE_IDS    ningún DOMAIN_ID duplicado (inventario ni decisiones de la matriz).
 *   TEST 3 · VISUAL_CATEGORY_COVERAGE       toda categoría real (schema + datos) aparece en la matriz.
 *   TEST 4 · VISUAL_INFORMATION_CLASSIFIED  todo elemento tiene decisión y clase de visibilidad válidas;
 *                                          los datos mínimos de fog of war y los 13 estados están clasificados.
 *   TEST 5 · CHASSIS_MOUNT_CONTRACT         los mounts JSON de la matriz cubren exactamente las ranuras reales.
 *   TEST 6 · SENSOR/WEAPON_VISUAL_CONTRACT  todo sensor y arma del catálogo tiene su fila de contrato.
 *
 * Sin BD, sin red y sin motor: sólo ficheros. Fase documental: no toca reglas ni renderer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCatalog, DATA_DIR } from "./loadCatalog.js";
import type { ModuleDefinition } from "./types.js";

const DOCS = resolve(DATA_DIR, "..", "..", "..", "docs", "visual-bots");
const SCHEMA_PATH = join(DATA_DIR, "..", "schema", "module.schema.json");

const INVENTORY = readFileSync(join(DOCS, "VISUAL_COMPONENT_INVENTORY.md"), "utf8");
const MATRIX = readFileSync(join(DOCS, "VISUAL_COMPONENT_MATRIX.md"), "utf8");
const catalog: ModuleDefinition[] = loadCatalog();
const schemaCategories: string[] = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")).properties.category.enum;

const versioned = (m: ModuleDefinition): string => `${m.id}@${m.version}`;

type Row = Record<string, string>;

/** Celda sin backticks ni espacios. */
const clean = (s: string): string =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();

/**
 * Todas las tablas Markdown del texto cuya PRIMERA columna de cabecera es `firstHeader`. Devuelve
 * las filas como objetos cabecera→celda. Una fila con distinto número de celdas que la cabecera
 * es un error (tabla rota), no una fila que se ignora.
 */
function tables(md: string, firstHeader: string): Row[] {
  const lines = md.split("\n");
  const rows: Row[] = [];
  const split = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(clean);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = split(lines[i]);
    if (header[0] !== firstHeader) continue;
    if (!/^\|\s*-{3}/.test(lines[i + 1]?.trim() ?? "")) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = split(lines[j]);
      if (cells.length !== header.length) {
        throw new Error(
          `tabla «${firstHeader}» rota en la línea ${j + 1}: ${cells.length} celdas, ${header.length} cabeceras`,
        );
      }
      rows.push(Object.fromEntries(header.map((h, k) => [h, cells[k]])));
    }
    i = j;
  }
  return rows;
}

const inventoryRows = (): Row[] => tables(INVENTORY, "DOMAIN_ID");
const decisionRows = (): Row[] => tables(MATRIX, "DOMAIN_ID");

const VISIBILITY = new Set(["PUBLIC", "SELF_ONLY", "ALLY_ONLY", "OBSERVER_DEPENDENT", "NEVER_VISUALIZE"]);
const DECISIONS = new Set(["MUST_RENDER", "SHOULD_RENDER", "MAY_RENDER", "DO_NOT_RENDER"]);

describe("TEST 1 · VISUAL_INVENTORY_COVERAGE", () => {
  it("el catálogo real no está vacío (si lo estuviera, la cobertura sería trivialmente verde)", () => {
    expect(catalog.length).toBeGreaterThan(0);
    expect(inventoryRows().length).toBeGreaterThan(0);
  });

  it("todo módulo del catálogo (id@version) aparece en el inventario, visual o marcado NONE", () => {
    const ids = new Set(inventoryRows().map((r) => r.DOMAIN_ID));
    const missing = catalog.map(versioned).filter((id) => !ids.has(id));
    expect(missing, "módulos del catálogo sin fila en VISUAL_COMPONENT_INVENTORY.md").toEqual([]);
  });

  it("ninguna fila de catálogo del inventario inventa un módulo inexistente", () => {
    const real = new Set(catalog.map(versioned));
    const invented = inventoryRows()
      .filter((r) => r.CATEGORY !== "runtime")
      .map((r) => r.DOMAIN_ID)
      .filter((id) => !real.has(id));
    expect(invented).toEqual([]);
  });

  it("CATEGORY, SIZE y MASS coinciden con el catálogo (nada copiado de memoria)", () => {
    const byId = new Map(catalog.map((m) => [versioned(m), m]));
    const wrong: string[] = [];
    for (const r of inventoryRows()) {
      const m = byId.get(r.DOMAIN_ID);
      if (!m) continue;
      if (r.CATEGORY !== m.category) wrong.push(`${r.DOMAIN_ID}: CATEGORY ${r.CATEGORY} ≠ ${m.category}`);
      if (m.size ? r.SIZE !== m.size : !r.SIZE.startsWith("N/A"))
        wrong.push(`${r.DOMAIN_ID}: SIZE ${r.SIZE} ≠ ${m.size ?? "N/A"}`);
      if (Number(r.MASS) !== m.massKg) wrong.push(`${r.DOMAIN_ID}: MASS ${r.MASS} ≠ ${m.massKg}`);
    }
    expect(wrong).toEqual([]);
  });

  it("los campos enumerados del inventario sólo usan valores válidos", () => {
    const bad: string[] = [];
    for (const r of inventoryRows()) {
      if (!["HIGH", "MEDIUM", "LOW", "NONE"].includes(r.VISUAL_RELEVANCE)) bad.push(`${r.DOMAIN_ID}: VISUAL_RELEVANCE`);
      if (!["YES", "NO", "MAYBE"].includes(r.VISIBLE_EXTERNALLY)) bad.push(`${r.DOMAIN_ID}: VISIBLE_EXTERNALLY`);
      if (!["YES", "NO"].includes(r.DYNAMIC_STATE)) bad.push(`${r.DOMAIN_ID}: DYNAMIC_STATE`);
      if (!["YES", "NO"].includes(r.HISTORICAL_SNAPSHOT_REQUIRED))
        bad.push(`${r.DOMAIN_ID}: HISTORICAL_SNAPSHOT_REQUIRED`);
      if (r.CATEGORY === "runtime" && !r.DOMAIN_ID.startsWith("runtime.")) bad.push(`${r.DOMAIN_ID}: prefijo runtime.`);
    }
    expect(bad).toEqual([]);
  });
});

describe("TEST 2 · VISUAL_INVENTORY_UNIQUE_IDS", () => {
  const dupes = (ids: string[]): string[] => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

  it("ningún DOMAIN_ID se repite en el inventario", () => {
    expect(dupes(inventoryRows().map((r) => r.DOMAIN_ID))).toEqual([]);
  });

  it("ningún DOMAIN_ID se repite en las tablas de decisión de la matriz", () => {
    expect(dupes(decisionRows().map((r) => r.DOMAIN_ID))).toEqual([]);
  });
});

describe("TEST 3 · VISUAL_CATEGORY_COVERAGE", () => {
  const categoryRows = (): Row[] => tables(MATRIX, "REAL_CATEGORY");

  it("toda categoría real (enum del schema ∪ categorías presentes en data/) tiene fila en la matriz", () => {
    const real = new Set([...schemaCategories, ...catalog.map((m) => m.category)]);
    expect(real.size).toBeGreaterThan(0);
    const inMatrix = new Set(categoryRows().map((r) => r.REAL_CATEGORY));
    expect([...real].filter((c) => !inMatrix.has(c))).toEqual([]);
  });

  it("la matriz no declara categorías reales que no existen", () => {
    const real = new Set([...schemaCategories, ...catalog.map((m) => m.category)]);
    expect(
      categoryRows()
        .map((r) => r.REAL_CATEGORY)
        .filter((c) => !real.has(c)),
    ).toEqual([]);
  });

  it("el número de módulos por categoría de la matriz coincide con el catálogo", () => {
    const wrong: string[] = [];
    for (const r of categoryRows()) {
      const declared = Number(/^\d+/.exec(r.MODULES_IN_CATALOG)?.[0] ?? NaN);
      const actual = catalog.filter((m) => m.category === r.REAL_CATEGORY).length;
      if (declared !== actual) wrong.push(`${r.REAL_CATEGORY}: ${declared} ≠ ${actual}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("TEST 4 · VISUAL_INFORMATION_CLASSIFIED", () => {
  it("todo elemento del inventario tiene decisión y clase de visibilidad válidas en la matriz", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const bad: string[] = [];
    for (const r of inventoryRows()) {
      const d = decisions.get(r.DOMAIN_ID);
      if (!d) bad.push(`${r.DOMAIN_ID}: sin fila de decisión`);
      else {
        if (!DECISIONS.has(d.DECISION)) bad.push(`${r.DOMAIN_ID}: DECISION «${d.DECISION}»`);
        if (!VISIBILITY.has(d.VISIBILITY_CLASS)) bad.push(`${r.DOMAIN_ID}: VISIBILITY_CLASS «${d.VISIBILITY_CLASS}»`);
        if (!d.WHY) bad.push(`${r.DOMAIN_ID}: sin porqué`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("un elemento marcado NONE en el inventario no se pinta (DO_NOT_RENDER)", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r.DECISION]));
    const bad = inventoryRows()
      .filter((r) => r.VISUAL_RELEVANCE === "NONE" && decisions.get(r.DOMAIN_ID) !== "DO_NOT_RENDER")
      .map((r) => r.DOMAIN_ID);
    expect(bad).toEqual([]);
  });

  it("§12: todo dato tiene una clasificación válida y están los datos mínimos del encargo", () => {
    const rows = tables(MATRIX, "DATA_ID");
    const invalid = rows
      .filter((r) => !VISIBILITY.has(r.CLASSIFICATION))
      .map((r) => `${r.DATA_ID}: ${r.CLASSIFICATION}`);
    expect(invalid).toEqual([]);
    const required = [
      "data.sensor_installed",
      "data.sensor_destroyed",
      "data.ammo_remaining",
      "data.radio_active",
      "data.radar_operating",
      "data.hull_hp_exact",
      "data.weapon_cooldown",
      "data.mine_position",
      "data.mine_bay_contents",
      "data.energy_state",
    ];
    const present = new Set(rows.map((r) => r.DATA_ID));
    expect(required.filter((id) => !present.has(id))).toEqual([]);
  });

  it("§13: los 13 estados visuales están marcados CURRENT (con referencia de código) o FUTURE", () => {
    const rows = tables(MATRIX, "STATE");
    const states = [
      "healthy",
      "damaged",
      "critical",
      "destroyed",
      "offline",
      "firing",
      "reloading",
      "out_of_ammo",
      "engine_active",
      "radio_active",
      "sensor_active",
      "carrying_flag",
      "destroyed_vehicle",
    ];
    const byState = new Map(rows.map((r) => [r.STATE, r]));
    const bad: string[] = [];
    for (const s of states) {
      const r = byState.get(s);
      if (!r) bad.push(`${s}: ausente`);
      else if (!["CURRENT", "FUTURE"].includes(r.STATUS)) bad.push(`${s}: STATUS «${r.STATUS}»`);
      else if (r.STATUS === "CURRENT" && !r.CODE_REFERENCE) bad.push(`${s}: CURRENT sin referencia`);
    }
    expect(bad).toEqual([]);
  });
});

describe("TEST 5 · CHASSIS_MOUNT_CONTRACT", () => {
  interface Mount {
    SOURCE_SLOT: string | null;
    MOUNT_TYPE: string[];
    REQUIRED: boolean;
    OPTIONAL: boolean;
    MAX_COUNT: number;
    ORIENTATION: string;
    LAYER_GROUP: string;
    MAX_SIZE: string | null;
  }
  interface ChassisMounts {
    chassis: string;
    appliesToVersions: number[];
    mounts: Record<string, Mount>;
  }
  const blocks = (): ChassisMounts[] =>
    [...MATRIX.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1]) as ChassisMounts)
      .filter((b) => typeof b.chassis === "string");

  it("cada versión de cada chasis del catálogo tiene un bloque de mounts", () => {
    const covered = new Set(blocks().flatMap((b) => b.appliesToVersions.map((v) => `${b.chassis}@${v}`)));
    const chassis = catalog.filter((m) => m.category === "chassis").map(versioned);
    expect(chassis.length).toBeGreaterThan(0);
    expect(chassis.filter((c) => !covered.has(c))).toEqual([]);
  });

  it("los mounts de cada chasis cubren EXACTAMENTE sus ranuras reales, con su maxSize", () => {
    const bad: string[] = [];
    for (const b of blocks()) {
      for (const v of b.appliesToVersions) {
        const def = catalog.find((m) => m.id === b.chassis && m.version === v);
        if (!def) {
          bad.push(`${b.chassis}@${v}: no existe en el catálogo`);
          continue;
        }
        const slots = new Map((def.slots ?? []).map((s) => [s.id, s]));
        const used = new Set<string>();
        for (const [name, mt] of Object.entries(b.mounts)) {
          if (mt.SOURCE_SLOT === null) {
            if (mt.MAX_COUNT !== 0 || mt.REQUIRED)
              bad.push(`${b.chassis}@${v}.${name}: sin ranura pero MAX_COUNT/REQUIRED`);
            continue;
          }
          const slot = slots.get(mt.SOURCE_SLOT);
          if (!slot) bad.push(`${b.chassis}@${v}.${name}: ranura ${mt.SOURCE_SLOT} inexistente`);
          else {
            used.add(slot.id);
            if (mt.MAX_SIZE !== slot.maxSize)
              bad.push(`${b.chassis}@${v}.${name}: MAX_SIZE ${mt.MAX_SIZE} ≠ ${slot.maxSize}`);
            if (!mt.REQUIRED || mt.MAX_COUNT < 1) bad.push(`${b.chassis}@${v}.${name}: ranura real no REQUIRED`);
          }
          if (!Array.isArray(mt.MOUNT_TYPE) || mt.MOUNT_TYPE.length === 0)
            bad.push(`${b.chassis}@${v}.${name}: MOUNT_TYPE`);
        }
        for (const id of slots.keys()) if (!used.has(id)) bad.push(`${b.chassis}@${v}: ranura ${id} sin mount`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("TEST 6 · SENSOR_VISUAL_CONTRACT / WEAPON_VISUAL_CONTRACT", () => {
  const covers = (rows: Row[], key: string, category: string): string[] => {
    const byId = new Map(rows.map((r) => [r[key], r.VERSIONS]));
    return catalog
      .filter((m) => m.category === category)
      .filter((m) => !(byId.get(m.id) ?? "").split(/[,\s]+/).includes(`@${m.version}`))
      .map(versioned);
  };

  it("todo sensor del catálogo (id y versión) tiene fila en el contrato de sensores", () => {
    expect(catalog.some((m) => m.category === "sensor")).toBe(true);
    expect(covers(tables(MATRIX, "SENSOR_ID"), "SENSOR_ID", "sensor")).toEqual([]);
  });

  it("toda arma del catálogo (id y versión) tiene fila en el contrato de armas", () => {
    expect(catalog.some((m) => m.category === "weapon")).toBe(true);
    expect(covers(tables(MATRIX, "WEAPON_ID"), "WEAPON_ID", "weapon")).toEqual([]);
  });
});
