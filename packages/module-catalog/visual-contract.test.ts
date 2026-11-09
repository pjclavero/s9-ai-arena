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
 *   TEST 7 · SLOT_INFERENCE (fog of war)    la tabla de encaje por ranura de la matriz (§12.1) es EXACTAMENTE la
 *                                          que sale del catálogo y del validador reales, y lo que se infiere de
 *                                          ella está clasificado como PUBLIC (por inferencia).
 *   TEST 0 · ESTRUCTURA                     el parser no puede saltarse filas en silencio: una línea con `|` pegada
 *                                          a una tabla, o ids fuera de una tabla reconocida, son error; el número
 *                                          de filas parseadas coincide con el texto bruto; las decisiones sólo
 *                                          hablan de elementos del inventario; un estado CURRENT cita un fichero
 *                                          que existe.
 *
 * Sin BD, sin red y sin motor: sólo ficheros. Fase documental: no toca reglas ni renderer.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadCatalog, DATA_DIR } from "./loadCatalog.js";
import { validateLoadout } from "./validator/index.js";
import type { ModuleDefinition } from "./types.js";

const REPO = resolve(DATA_DIR, "..", "..", "..");
const DOCS = join(REPO, "docs", "visual-bots");
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
const splitRow = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(clean);

function tables(md: string, firstHeader: string): Row[] {
  const lines = md.split("\n");
  const rows: Row[] = [];
  const split = splitRow;
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
    // P2-4 (a) · Una línea con `|` interno pegada a la tabla (p. ej. una fila a la que se le ha caído el `|`
    // inicial, que GFM sigue pintando como fila) cortaría la tabla en silencio: es un error, no el final.
    const after = lines[j]?.trim() ?? "";
    if (after !== "" && after.includes("|")) {
      throw new Error(`tabla «${firstHeader}» cortada en la línea ${j + 1}: línea con «|» pegada a la tabla`);
    }
    i = j;
  }
  return rows;
}

const inventoryRows = (): Row[] => tables(INVENTORY, "DOMAIN_ID");
const decisionRows = (): Row[] => tables(MATRIX, "DOMAIN_ID");

const VISIBILITY = new Set(["PUBLIC", "SELF_ONLY", "ALLY_ONLY", "OBSERVER_DEPENDENT", "NEVER_VISUALIZE"]);
const DECISIONS = new Set(["MUST_RENDER", "SHOULD_RENDER", "MAY_RENDER", "DO_NOT_RENDER"]);
/** Filas de §12 tras la ronda 1 de revisión: §12 no puede encoger sin que el test lo note. */
const MIN_DATA_ROWS = 43;

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

/* ─────────────── TEST 0 · ESTRUCTURA: el parser no se salta filas en silencio (P2-4) ─────────────── */

/** Cabeceras (primera columna) de las tablas que el test parsea, por documento. */
const RECOGNIZED: Record<string, string[]> = {
  INVENTORY: ["DOMAIN_ID"],
  MATRIX: ["REAL_CATEGORY", "DOMAIN_ID", "SENSOR_ID", "WEAPON_ID", "DATA_ID", "STATE", "CHASSIS_SLOT"],
};
/** Un id de los que el test usa como clave: `data.x`, `runtime.x` o `familia.modulo@N`, entre backticks. */
const ID_IN_TEXT = /`(?:data\.[a-z0-9_]+|runtime\.[a-z0-9_]+|[a-z][a-z0-9_]*\.[a-z0-9_]+@\d+)`/;

/**
 * Recorre el documento (fuera de los bloques ``` ) y devuelve las líneas con `|` que contienen un id
 * y NO pertenecen a una tabla con cabecera reconocida: una fila suelta tras una línea en blanco, una
 * fila sin `|` inicial o una tabla con otra cabecera. Cualquiera de ellas sería invisible para el test.
 */
function strayIdLines(md: string, recognized: string[]): string[] {
  const lines = md.split("\n");
  const consumed = new Set<number>();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("```")) {
      fenced = !fenced;
      consumed.add(i);
      continue;
    }
    if (fenced) {
      consumed.add(i);
      continue;
    }
    if (!t.startsWith("|") || !/^\|\s*-{3}/.test(lines[i + 1]?.trim() ?? "")) continue;
    if (!recognized.includes(splitRow(t)[0])) continue;
    consumed.add(i);
    consumed.add(i + 1);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) consumed.add(j);
    i = j - 1;
  }
  return lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !consumed.has(i) && l.includes("|") && ID_IN_TEXT.test(l))
    .map(({ l, i }) => `línea ${i + 1}: ${l.trim().slice(0, 80)}`);
}

/** Líneas del texto bruto cuya primera celda (con o sin `|` inicial) es un id de la familia dada. */
const rawRows = (md: string, id: RegExp): number =>
  md.split("\n").filter((l) => new RegExp(`^\\s*\\|?\\s*\`${id.source}\`\\s*\\|`).test(l)).length;

const CATALOG_OR_RUNTIME_ID = /(?:runtime\.[a-z0-9_]+|[a-z][a-z0-9_]*\.[a-z0-9_]+@\d+)/;
const DATA_ID_RE = /data\.[a-z0-9_]+/;

/** Índice de ficheros de apps/ y packages/ (sin node_modules ni dist) para validar referencias de código. */
function sourceFiles(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else names.add(e.name);
    }
  };
  walk(join(REPO, "apps"));
  walk(join(REPO, "packages"));
  return names;
}

describe("TEST 0 · ESTRUCTURA de los documentos (sin falsos verdes del parser)", () => {
  it("(a) ninguna línea con un id queda fuera de una tabla reconocida (suelta, sin `|` inicial o sin cabecera)", () => {
    expect(strayIdLines(INVENTORY, RECOGNIZED.INVENTORY), "VISUAL_COMPONENT_INVENTORY.md").toEqual([]);
    expect(strayIdLines(MATRIX, RECOGNIZED.MATRIX), "VISUAL_COMPONENT_MATRIX.md").toEqual([]);
  });

  it("(b) el número de filas parseadas coincide con el texto bruto, y cada tabla tiene su mínimo", () => {
    const inv = inventoryRows();
    const dec = decisionRows();
    const data = tables(MATRIX, "DATA_ID");
    expect(inv.length, "filas DOMAIN_ID del inventario").toBe(rawRows(INVENTORY, CATALOG_OR_RUNTIME_ID));
    expect(dec.length, "filas DOMAIN_ID de la matriz").toBe(rawRows(MATRIX, CATALOG_OR_RUNTIME_ID));
    expect(data.length, "filas DATA_ID de §12").toBe(rawRows(MATRIX, DATA_ID_RE));
    // Mínimos: todo el catálogo + algún elemento runtime; §12 no puede encoger por debajo de lo revisado.
    const real = new Set([...schemaCategories, ...catalog.map((m) => m.category)]);
    const ids = (cat: string): number => new Set(catalog.filter((m) => m.category === cat).map((m) => m.id)).size;
    expect(inv.filter((r) => r.CATEGORY !== "runtime").length).toBeGreaterThanOrEqual(catalog.length);
    expect(inv.filter((r) => r.CATEGORY === "runtime").length).toBeGreaterThan(0);
    expect(dec.length).toBeGreaterThanOrEqual(inv.length);
    expect(data.length).toBeGreaterThanOrEqual(MIN_DATA_ROWS);
    expect(tables(MATRIX, "STATE").length).toBe(13);
    expect(tables(MATRIX, "REAL_CATEGORY").length).toBe(real.size);
    expect(tables(MATRIX, "SENSOR_ID").length).toBe(ids("sensor"));
    expect(tables(MATRIX, "WEAPON_ID").length).toBe(ids("weapon"));
  });

  it("(c) toda fila de decisión de la matriz habla de un elemento del inventario o del catálogo", () => {
    const known = new Set([...inventoryRows().map((r) => r.DOMAIN_ID), ...catalog.map(versioned)]);
    expect(
      decisionRows()
        .map((r) => r.DOMAIN_ID)
        .filter((id) => !known.has(id)),
    ).toEqual([]);
  });

  it("(d) la CODE_REFERENCE de todo estado CURRENT nombra al menos un fichero, y todos los que nombra existen", () => {
    const names = sourceFiles();
    const bad: string[] = [];
    for (const r of tables(MATRIX, "STATE").filter((x) => x.STATUS === "CURRENT")) {
      const refs = [...r.CODE_REFERENCE.matchAll(/[\w./-]+\.(?:tsx?|json)\b/g)].map((m) => m[0]);
      if (refs.length === 0) bad.push(`${r.STATE}: CURRENT sin fichero en CODE_REFERENCE`);
      for (const ref of refs) {
        const ok = ref.includes("/") ? existsSync(join(REPO, ref)) : names.has(basename(ref));
        if (!ok) bad.push(`${r.STATE}: «${ref}» no existe`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ─────────────── TEST 7 · SLOT_INFERENCE: lo que el snapshot revela por ranura ocupada (P2-1) ─────────────── */

/**
 * El snapshot público lista las ranuras OCUPADAS (`modules: [{slot, state}]`) y la nómina el chasis.
 * Candidatos de una ranura = módulos del catálogo que el VALIDADOR REAL acepta en ella (categoría,
 * tamaño, sector, chasis requerido); para munición y arma, además, la regla arma↔munición del mismo
 * validador contra las armas/municiones que caben en ese chasis. Un único id base ⇒ identidad pública.
 */
const SLOT_CODES = new Set([
  "slot_type_mismatch",
  "slot_size_exceeded",
  "unknown_slot",
  "incompatible_chassis",
  "category_forbidden_by_ruleset",
]);

const violationsOf = (chassis: ModuleDefinition, modules: { slot: string; moduleId: string }[]) =>
  validateLoadout(
    {
      loadoutId: "slot-inference",
      revision: 1,
      catalogVersion: "slot-inference",
      chassis: versioned(chassis),
      modules,
    },
    catalog,
    Number.MAX_SAFE_INTEGER,
  );

function slotCandidates(chassis: ModuleDefinition): Map<string, string[]> {
  const slots = chassis.slots ?? [];
  const fit = new Map<string, ModuleDefinition[]>();
  for (const s of slots) {
    const ok = catalog.filter(
      (m) =>
        m.category !== "chassis" &&
        !violationsOf(chassis, [{ slot: s.id, moduleId: versioned(m) }]).some((v) => SLOT_CODES.has(v.code)),
    );
    fit.set(s.id, ok);
  }
  const weaponSlots = slots.filter((s) => s.accepts.includes("weapon")).map((s) => s.id);
  const ammoSlots = slots.filter((s) => s.accepts.includes("ammo")).map((s) => s.id);
  /** ¿Acepta el validador esta pareja arma/munición sin `incompatible_ammo`? */
  const pairOk = (w: ModuleDefinition, ws: string, a: ModuleDefinition, as: string): boolean =>
    !violationsOf(chassis, [
      { slot: ws, moduleId: versioned(w) },
      { slot: as, moduleId: versioned(a) },
    ]).some((v) => v.code === "incompatible_ammo");
  const out = new Map<string, string[]>();
  for (const s of slots) {
    let cands = fit.get(s.id) ?? [];
    if (ammoSlots.includes(s.id)) {
      cands = cands.filter(
        (a) =>
          a.category !== "ammo" ||
          weaponSlots.some((ws) => (fit.get(ws) ?? []).some((w) => w.category === "weapon" && pairOk(w, ws, a, s.id))),
      );
    }
    if (weaponSlots.includes(s.id)) {
      cands = cands.filter(
        (w) =>
          w.category !== "weapon" ||
          ammoSlots.some((as) => (fit.get(as) ?? []).some((a) => a.category === "ammo" && pairOk(w, s.id, a, as))),
      );
    }
    out.set(s.id, cands.map(versioned).sort());
  }
  return out;
}

const inferenceOf = (cands: string[]): string => {
  const bases = new Set(cands.map((c) => c.slice(0, c.lastIndexOf("@"))));
  return bases.size === 0 ? "NEVER" : bases.size === 1 ? "IDENTITY" : "PRESENCE";
};

/** Tabla calculada `chassis.id/slot` → candidatos; exige que todas las versiones de un chasis coincidan. */
function computedSlotTable(): Map<string, string[]> {
  const table = new Map<string, string[]>();
  const byId = new Map<string, ModuleDefinition[]>();
  for (const c of catalog.filter((m) => m.category === "chassis")) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  for (const [id, versions] of byId) {
    const per = versions.map((v) => slotCandidates(v));
    for (const other of per.slice(1)) {
      if (JSON.stringify([...other]) !== JSON.stringify([...per[0]])) {
        throw new Error(`${id}: sus versiones no admiten lo mismo; la tabla §12.1 tendría que ir por versión`);
      }
    }
    for (const [slot, cands] of per[0]) table.set(`${id}/${slot}`, cands);
  }
  return table;
}

/** Datos de §12 que la inferencia hace PUBLIC hoy (los exige la ronda 1 de revisión de FASE 0). */
const INFERRED_PUBLIC = [
  "data.slot_occupancy",
  "data.mine_installed",
  "data.radio_installed",
  "data.light_weapon_identity",
  "data.light_drive_identity",
  "data.light_ammo_type",
  "data.ammo_installed",
  "data.power_installed",
];

describe("TEST 7 · SLOT_INFERENCE (fog of war por ranuras ocupadas)", () => {
  it("la tabla de encaje de §12.1 es EXACTAMENTE la que sale del catálogo y del validador reales", () => {
    const computed = computedSlotTable();
    expect(computed.size).toBeGreaterThan(0);
    const declared = new Map(tables(MATRIX, "CHASSIS_SLOT").map((r) => [r.CHASSIS_SLOT, r]));
    const bad: string[] = [];
    for (const [key, cands] of computed) {
      const r = declared.get(key);
      if (!r) {
        bad.push(`${key}: sin fila (candidatos reales: ${cands.join(", ") || "ninguno"})`);
        continue;
      }
      const doc =
        r.CANDIDATES === "—"
          ? []
          : r.CANDIDATES.split(/[,\s]+/)
              .map(clean)
              .filter(Boolean)
              .sort();
      if (JSON.stringify(doc) !== JSON.stringify(cands))
        bad.push(`${key}: CANDIDATES «${doc.join(", ")}» ≠ real «${cands.join(", ")}»`);
      if (r.INFERENCE !== inferenceOf(cands)) bad.push(`${key}: INFERENCE ${r.INFERENCE} ≠ ${inferenceOf(cands)}`);
    }
    for (const key of declared.keys()) if (!computed.has(key)) bad.push(`${key}: ranura inexistente`);
    expect(bad).toEqual([]);
  });

  it("todo módulo cuya identidad se infiere de una ranura es PUBLIC o lo declara «PUBLIC por inferencia»", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const bad: string[] = [];
    for (const [key, cands] of computedSlotTable()) {
      if (inferenceOf(cands) !== "IDENTITY") continue;
      for (const id of cands) {
        const d = decisions.get(id);
        if (!d) bad.push(`${id} (${key}): sin fila de decisión`);
        else if (d.VISIBILITY_CLASS !== "PUBLIC" && !d.WHY.includes("PUBLIC por inferencia"))
          bad.push(`${id} (${key}): ${d.VISIBILITY_CLASS} sin «PUBLIC por inferencia»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("§12 declara PUBLIC la ocupación de ranuras y lo que hoy se infiere de ella", () => {
    const data = new Map(tables(MATRIX, "DATA_ID").map((r) => [r.DATA_ID, r.CLASSIFICATION]));
    expect(INFERRED_PUBLIC.filter((id) => data.get(id) !== "PUBLIC")).toEqual([]);
  });

  it("§12 avisa de que las clases privadas no cubren el fichero de replay crudo (H-05)", () => {
    const notes = new Map(tables(MATRIX, "DATA_ID").map((r) => [r.DATA_ID, r.NOTES]));
    const missing = ["data.radio_content", "data.mine_position", "data.ammo_type", "data.energy_state"].filter(
      (id) => !(notes.get(id) ?? "").includes("H-05"),
    );
    expect(missing).toEqual([]);
    expect(MATRIX).toContain("**No** se aplican al **fichero de replay crudo**");
  });
});
