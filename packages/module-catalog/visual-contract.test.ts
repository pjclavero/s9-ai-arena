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
 *   TEST 8 · PROJECTILE_INFERENCE           la tabla de cinemática de proyectiles (§12.2) es la que sale del catálogo
 *                                          y de las constantes reales, y lo que se infiere de ella es PUBLIC.
 *   TEST 9 · VIEWER_PROJECTION              los perfiles de vista de ADR-VIS-002 aplicados a §12: ninguna vista ve
 *                                          NEVER_VISUALIZE, las públicas ven exactamente lo PUBLIC y PRIVATE ≠ PUBLIC.
 *   TEST 0 · ESTRUCTURA                    el parser no puede saltarse filas en silencio: una línea con `|` pegada
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
import {
  CHASSIS_DAMAGE_SHARE,
  DECISION_EVERY_N_TICKS,
  MODULE_STATE_PERFORMANCE,
  TICK_HZ,
} from "../game-rules/constants.js";

const REPO = resolve(DATA_DIR, "..", "..", "..");
const DOCS = join(REPO, "docs", "visual-bots");
const SCHEMA_PATH = join(DATA_DIR, "..", "schema", "module.schema.json");

const INVENTORY = readFileSync(join(DOCS, "VISUAL_COMPONENT_INVENTORY.md"), "utf8");
const MATRIX = readFileSync(join(DOCS, "VISUAL_COMPONENT_MATRIX.md"), "utf8");
const ADR2 = readFileSync(join(DOCS, "adr", "ADR-VIS-002-catalog-versioning.md"), "utf8");
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

/**
 * P3-4 · Texto que un lector VE: las líneas dentro de bloques ``` o de comentarios HTML se vacían (sin
 * cambiar la numeración). Una tabla escondida ahí no cuenta como cobertura.
 */
function visibleLines(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  let comment = false;
  for (const line of md.split("\n")) {
    if (!comment && line.trim().startsWith("```")) {
      fenced = !fenced;
      out.push("");
      continue;
    }
    if (fenced) {
      out.push("");
      continue;
    }
    let rest = line;
    let kept = "";
    while (rest.length > 0) {
      const mark = comment ? rest.indexOf("-->") : rest.indexOf("<!--");
      if (mark < 0) {
        if (!comment) kept += rest;
        break;
      }
      if (!comment) kept += rest.slice(0, mark);
      rest = rest.slice(mark + (comment ? 3 : 4));
      comment = !comment;
    }
    out.push(kept);
  }
  return out;
}

function tables(md: string, firstHeader: string): Row[] {
  const lines = visibleLines(md);
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
/**
 * P3-4 · Conjunto CANÓNICO de datos de §12 (revisados en las rondas 1 y 2). No es un recuento: quitar uno
 * y añadir otro inventado es rojo. Añadir un dato nuevo exige añadirlo aquí a propósito.
 */
const CANONICAL_DATA_IDS = [
  "data.chassis_identity",
  "data.team_identity",
  "data.bot_name",
  "data.pose",
  "data.turret_heading",
  "data.hull_hp_exact",
  "data.module_state",
  "data.module_health_exact",
  "data.armor_sector_hp",
  "data.slot_occupancy",
  "data.module_identity",
  "data.sensor_installed",
  "data.sensor_destroyed",
  "data.radar_operating",
  "data.sensor_cycle_output",
  "data.sensor_readings",
  "data.sensor_range_fov",
  "data.radio_installed",
  "data.radio_active",
  "data.radio_content",
  "data.ammo_type",
  "data.ammo_installed",
  "data.light_ammo_type",
  "data.ammo_remaining",
  "data.out_of_ammo",
  "data.weapon_cooldown",
  "data.firing",
  "data.projectile_origin",
  "data.weapon_identity",
  "data.weapon_version",
  "data.energy_state",
  "data.power_installed",
  "data.mine_installed",
  "data.mine_bay_contents",
  "data.mine_position",
  "data.mine_triggered",
  "data.light_weapon_identity",
  "data.light_drive_identity",
  "data.carrying_flag",
  "data.juggernaut",
  "data.vehicle_alive",
  "data.respawns_left",
  "data.engine_activity",
  "data.engine_throttle",
  "data.hit_details",
  "data.full_loadout",
];
/** Fugas entre vistas que §12.3 tiene que tratar (CROSS_VIEW_LEAK). */
const CANONICAL_CROSS_VIEWS = [
  "cross.raw_replay",
  "cross.composition_cache",
  "cross.thumbnail",
  "cross.team_capture",
  "cross.debug_overlay",
  "cross.client_payload",
];
const DISCLOSURE = new Set(["YES", "NO", "PARTIAL"]);
const dupes = (ids: string[]): string[] => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
const sorted = (a: Iterable<string>): string[] => [...a].sort();

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
  it("ningún DOMAIN_ID se repite en el inventario", () => {
    expect(dupes(inventoryRows().map((r) => r.DOMAIN_ID))).toEqual([]);
  });

  it("ningún DOMAIN_ID se repite en las tablas de decisión de la matriz", () => {
    expect(dupes(decisionRows().map((r) => r.DOMAIN_ID))).toEqual([]);
  });

  // P2-7 · Unicidad en TODAS las tablas con clave, sumando todas las tablas con la misma cabecera: una
  // fila repetida (aunque esté en otra tabla, o con otra clase) es rojo, nunca «gana la última».
  const KEYED: [string, string, string][] = [
    ["MATRIX", "REAL_CATEGORY", MATRIX],
    ["MATRIX", "SENSOR_ID", MATRIX],
    ["MATRIX", "WEAPON_ID", MATRIX],
    ["MATRIX", "DATA_ID", MATRIX],
    ["MATRIX", "STATE", MATRIX],
    ["MATRIX", "CHASSIS_SLOT", MATRIX],
    ["MATRIX", "WEAPON_KIN", MATRIX],
    ["MATRIX", "CROSS_VIEW_ID", MATRIX],
    ["ADR-VIS-002", "VIEW_PROFILE", ADR2],
  ];
  for (const [doc, key, md] of KEYED) {
    it(`ninguna clave ${key} se repite en ${doc} (sumando todas sus tablas)`, () => {
      const rows = tables(md, key);
      expect(rows.length, `${doc}: tabla ${key}`).toBeGreaterThan(0);
      expect(dupes(rows.map((r) => r[key]))).toEqual([]);
    });
  }

  it("cada módulo real tiene EXACTAMENTE una fila en el inventario y una decisión en la matriz (ni falta ni sobra)", () => {
    const real = sorted(catalog.map(versioned));
    const inv = sorted(
      inventoryRows()
        .filter((r) => r.CATEGORY !== "runtime")
        .map((r) => r.DOMAIN_ID),
    );
    const dec = sorted(
      decisionRows()
        .map((r) => r.DOMAIN_ID)
        .filter((id) => !id.startsWith("runtime.")),
    );
    expect(inv, "inventario frente al catálogo").toEqual(real);
    expect(dec, "decisiones de la matriz frente al catálogo").toEqual(real);
    const runtimeInv = sorted(
      inventoryRows()
        .filter((r) => r.CATEGORY === "runtime")
        .map((r) => r.DOMAIN_ID),
    );
    const runtimeDec = sorted(
      decisionRows()
        .map((r) => r.DOMAIN_ID)
        .filter((id) => id.startsWith("runtime.")),
    );
    expect(runtimeDec, "decisiones runtime frente al inventario").toEqual(runtimeInv);
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

  it("§12: los DATA_ID son EXACTAMENTE el conjunto canónico revisado (ni faltan ni sobran)", () => {
    expect(sorted(tables(MATRIX, "DATA_ID").map((r) => r.DATA_ID))).toEqual(sorted(CANONICAL_DATA_IDS));
  });

  it("§12: DIRECT/DERIVED_DISCLOSURE válidos; YES ⇒ PUBLIC; PUBLIC ⇒ algún YES/PARTIAL; PARTIAL ⇒ NOTES lo explica", () => {
    const bad: string[] = [];
    for (const r of tables(MATRIX, "DATA_ID")) {
      const d = r.DIRECT_DISCLOSURE;
      const v = r.DERIVED_DISCLOSURE;
      if (!DISCLOSURE.has(d) || !DISCLOSURE.has(v)) {
        bad.push(`${r.DATA_ID}: DIRECT «${d}» / DERIVED «${v}»`);
        continue;
      }
      if ((d === "YES" || v === "YES") && r.CLASSIFICATION !== "PUBLIC")
        bad.push(`${r.DATA_ID}: se divulga (YES) pero es ${r.CLASSIFICATION}`);
      if (r.CLASSIFICATION === "PUBLIC" && d === "NO" && v === "NO")
        bad.push(`${r.DATA_ID}: PUBLIC sin divulgación directa ni derivada`);
      if (v === "YES" && d !== "YES" && !r.NOTES.includes("PUBLIC por inferencia"))
        bad.push(`${r.DATA_ID}: sólo derivado y sin «PUBLIC por inferencia» en NOTES`);
      if ((d === "PARTIAL" || v === "PARTIAL") && r.NOTES.length < 20)
        bad.push(`${r.DATA_ID}: PARTIAL sin explicación en NOTES`);
    }
    expect(bad).toEqual([]);
    // La taxonomía obligatoria está escrita en el contrato.
    expect(MATRIX).toContain("VISUAL_INFORMATION_LEAK = DIRECT_LEAK + DERIVED_LEAK + CROSS_VIEW_LEAK");
  });

  it("§12.3: las fugas entre vistas canónicas están tratadas y todas van hacia una vista con menos privilegio", () => {
    const rows = tables(MATRIX, "CROSS_VIEW_ID");
    expect(sorted(rows.map((r) => r.CROSS_VIEW_ID))).toEqual(sorted(CANONICAL_CROSS_VIEWS));
    const VIEWS = ["PUBLIC_VIEW", "ALLY_VIEW", "OWNER_VIEW", "RAW_REPLAY", "INTERNAL_VIEW"];
    const rank: Record<string, number> = {
      PUBLIC_VIEW: 0,
      ALLY_VIEW: 1,
      OWNER_VIEW: 2,
      RAW_REPLAY: 3,
      INTERNAL_VIEW: 3,
    };
    const bad = rows
      .filter(
        (r) =>
          !VIEWS.includes(r.FROM_VIEW) || !VIEWS.includes(r.TO_VIEW) || rank[r.FROM_VIEW] <= rank[r.TO_VIEW] || !r.RULE,
      )
      .map((r) => r.CROSS_VIEW_ID);
    expect(bad).toEqual([]);
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
  MATRIX: [
    "REAL_CATEGORY",
    "DOMAIN_ID",
    "SENSOR_ID",
    "WEAPON_ID",
    "DATA_ID",
    "STATE",
    "CHASSIS_SLOT",
    "WEAPON_KIN",
    "CROSS_VIEW_ID",
  ],
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
const CHASSIS_SLOT_RE = /[a-z][a-z0-9_]*\.[a-z0-9_]+\/[a-z0-9_]+/;

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
    // Las filas WEAPON_KIN (§12.2) también empiezan por un id de catálogo: se descuentan.
    const kin = tables(MATRIX, "WEAPON_KIN");
    expect(dec.length + kin.length, "filas DOMAIN_ID + WEAPON_KIN de la matriz").toBe(
      rawRows(MATRIX, CATALOG_OR_RUNTIME_ID),
    );
    expect(kin.length, "filas WEAPON_KIN = armas del catálogo").toBe(
      catalog.filter((m) => m.category === "weapon").length,
    );
    expect(data.length, "filas DATA_ID de §12").toBe(rawRows(MATRIX, DATA_ID_RE));
    // P2-7 · §12.1 tiene EXACTAMENTE una fila por ranura calculada (sin duplicados que cuenten como cobertura).
    const slotRows = tables(MATRIX, "CHASSIS_SLOT");
    expect(slotRows.length, "filas CHASSIS_SLOT = ranuras calculadas").toBe(computedSlotTable().size);
    expect(slotRows.length, "filas CHASSIS_SLOT en el texto bruto").toBe(rawRows(MATRIX, CHASSIS_SLOT_RE));
    // Mínimos: todo el catálogo + algún elemento runtime; §12 no puede encoger por debajo de lo revisado.
    const real = new Set([...schemaCategories, ...catalog.map((m) => m.category)]);
    const ids = (cat: string): number => new Set(catalog.filter((m) => m.category === cat).map((m) => m.id)).size;
    expect(inv.filter((r) => r.CATEGORY !== "runtime").length).toBeGreaterThanOrEqual(catalog.length);
    expect(inv.filter((r) => r.CATEGORY === "runtime").length).toBeGreaterThan(0);
    expect(dec.length).toBeGreaterThanOrEqual(inv.length);
    expect(data.length).toBe(CANONICAL_DATA_IDS.length);
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
    expect(MATRIX).toContain("**no** se aplican al **fichero de replay crudo**");
  });

  it("PRE-1: el contrato dice que el renderer público consume sólo la proyección saneada, nunca el crudo", () => {
    expect(MATRIX).toContain("**PUBLIC_REPLAY = proyección saneada de competición.**");
    expect(MATRIX).toContain("**RAW_REPLAY = restringido**");
    expect(MATRIX).toContain(
      "consume **sólo** el canal de\n   espectador o la proyección saneada, **nunca** el replay crudo",
    );
  });
});

/* ─────────────── TEST 8 · PROJECTILE_INFERENCE: lo que delata la cinemática del proyectil (P2-5) ─────────────── */

/**
 * Hechos del motor que usa el cálculo (citados en §12.2): velocidad = `projectileSpeedMs`; el disparo sólo
 * se resuelve en ticks de decisión; cooldown = round(cooldownTicks / max(0.25, rendimiento)) (`combat.ts`);
 * al casco va `CHASSIS_DAMAGE_SHARE` del daño. El `ttlTicks` se lee del propio `combat.ts`, no se copia.
 */
const COMBAT_SRC = readFileSync(join(REPO, "apps", "arena-engine", "src", "sim", "combat.ts"), "utf8");
const TTL_TICKS = Number(/ttlTicks:\s*(\d+)/.exec(COMBAT_SRC)?.[1] ?? NaN);
const COOLDOWN_SRC =
  /Math\.round\(\(w\.spec\.cooldownTicks \?\? 30\) \/ Math\.max\(0\.25, v\.performanceOf\(slot\)\)\)/;

const num = (x: number): string => String(Number(x.toFixed(2)));
const fireInterval = (cooldownTicks: number, perf: number): number =>
  Math.ceil(Math.round(cooldownTicks / Math.max(0.25, perf)) / DECISION_EVERY_N_TICKS) * DECISION_EVERY_N_TICKS;

interface Kin {
  speed: number;
  reach: number;
  interval: number[];
  hullDamage: string;
}

function weaponKinematics(): Map<string, Kin> {
  const out = new Map<string, Kin>();
  const ammo = catalog.filter((m) => m.category === "ammo");
  for (const w of catalog.filter((m) => m.category === "weapon")) {
    const speed = w.projectileSpeedMs ?? NaN;
    const perfs = [
      MODULE_STATE_PERFORMANCE.operational,
      MODULE_STATE_PERFORMANCE.damaged,
      MODULE_STATE_PERFORMANCE.critical,
    ];
    const hull = (w.acceptsAmmo ?? [])
      .slice()
      .sort()
      .map((base) => {
        const a = ammo.find((x) => x.id === base);
        return `${base} ${num((w.damage ?? NaN) * (a?.damageMultiplier ?? NaN) * CHASSIS_DAMAGE_SHARE)}`;
      })
      .join("; ");
    out.set(versioned(w), {
      speed,
      reach: (speed * TTL_TICKS) / TICK_HZ,
      interval: perfs.map((p) => fireInterval(w.cooldownTicks ?? NaN, p)),
      hullDamage: hull,
    });
  }
  return out;
}

function expectedKinRows(): Map<string, Record<string, string>> {
  const kin = weaponKinematics();
  const rows = new Map<string, Record<string, string>>();
  for (const [id, k] of kin) {
    const base = id.slice(0, id.lastIndexOf("@"));
    const otherBases = [...kin].filter(([o]) => o.slice(0, o.lastIndexOf("@")) !== base);
    const siblings = [...kin].filter(([o]) => o !== id && o.slice(0, o.lastIndexOf("@")) === base);
    const signals = new Set<string>();
    for (const [, s] of siblings) {
      if (s.speed !== k.speed) signals.add("SPEED");
      if (s.interval[0] !== k.interval[0]) signals.add("INTERVAL");
      if (s.interval.slice(1).join() !== k.interval.slice(1).join()) signals.add("INTERVAL_DEGRADED");
      if (s.hullDamage !== k.hullDamage) signals.add("HULL_DAMAGE");
    }
    rows.set(id, {
      SPEED_MS: num(k.speed),
      REACH_M: num(k.reach),
      INTERVAL_TICKS: k.interval.join(" / "),
      HULL_DAMAGE: k.hullDamage,
      IDENTITY_BY_SPEED: otherBases.some(([, o]) => o.speed === k.speed) ? "AMBIGUOUS" : "IDENTITY",
      VERSION_SIGNAL: signals.size ? sorted(signals).join(", ") : "—",
    });
  }
  return rows;
}

describe("TEST 8 · PROJECTILE_INFERENCE (fog of war por cinemática y daño del proyectil)", () => {
  it("las premisas del motor que usa el cálculo siguen en el código (ttl y fórmula del cooldown)", () => {
    expect(Number.isFinite(TTL_TICKS) && TTL_TICKS > 0).toBe(true);
    expect(COMBAT_SRC).toMatch(COOLDOWN_SRC);
    expect(COMBAT_SRC).toContain("const speed = w.spec.projectileSpeedMs");
  });

  it("la tabla WEAPON_KIN de §12.2 es EXACTAMENTE la que sale del catálogo y de las constantes reales", () => {
    const expected = expectedKinRows();
    const declared = tables(MATRIX, "WEAPON_KIN");
    expect(sorted(declared.map((r) => r.WEAPON_KIN))).toEqual(sorted(expected.keys()));
    const bad: string[] = [];
    for (const r of declared) {
      const e = expected.get(r.WEAPON_KIN);
      if (!e) continue;
      for (const [col, v] of Object.entries(e))
        if (r[col] !== v) bad.push(`${r.WEAPON_KIN}.${col}: «${r[col]}» ≠ «${v}»`);
    }
    expect(bad).toEqual([]);
  });

  it("si las armas base se distinguen por velocidad, su identidad y el origen del proyectil son PUBLIC por inferencia", () => {
    const expected = expectedKinRows();
    const anyIdentity = [...expected.values()].some((r) => r.IDENTITY_BY_SPEED === "IDENTITY");
    const anyVersion = [...expected.values()].some((r) => r.VERSION_SIGNAL !== "—");
    const data = new Map(tables(MATRIX, "DATA_ID").map((r) => [r.DATA_ID, r]));
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const bad: string[] = [];
    if (anyIdentity) {
      for (const id of ["data.weapon_identity", "data.projectile_origin"]) {
        const r = data.get(id);
        if (r?.CLASSIFICATION !== "PUBLIC" || r.DERIVED_DISCLOSURE !== "YES")
          bad.push(`${id}: debe ser PUBLIC derivado`);
      }
      for (const [id, r] of expected) {
        if (r.IDENTITY_BY_SPEED !== "IDENTITY") continue;
        const d = decisions.get(id);
        if (d && d.VISIBILITY_CLASS !== "PUBLIC" && !d.WHY.includes("PUBLIC por inferencia"))
          bad.push(`${id}: identificable por velocidad y sin «PUBLIC por inferencia»`);
      }
    }
    if (anyVersion && data.get("data.weapon_version")?.CLASSIFICATION !== "PUBLIC")
      bad.push("data.weapon_version: hay señal de versión y no es PUBLIC");
    expect(bad).toEqual([]);
  });

  it("si las municiones de un arma tienen daño distinto, su decisión lo declara «Inferible con ruido»", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const bad: string[] = [];
    for (const w of catalog.filter((m) => m.category === "weapon")) {
      const ammo = catalog.filter((m) => m.category === "ammo" && (w.acceptsAmmo ?? []).includes(m.id));
      if (new Set(ammo.map((a) => `${a.damageMultiplier}/${a.explosionRadiusM}`)).size < 2) continue;
      for (const a of ammo) {
        const d = decisions.get(versioned(a));
        if (d && d.VISIBILITY_CLASS !== "PUBLIC" && !d.WHY.includes("Inferible con ruido"))
          bad.push(`${versioned(a)}: distinguible por daño y sin «Inferible con ruido»`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ─────────────── TEST 9 · VIEWER_PROJECTION: la vista depende de la audiencia (P2-6) ─────────────── */

describe("TEST 9 · VIEWER_PROJECTION (ADR-VIS-002: PRIVATE_VIEW ≠ PUBLIC_VIEW)", () => {
  const profiles = (): Row[] => tables(ADR2, "VIEW_PROFILE");
  const visibleFor = (p: Row): Set<string> => {
    const classes = new Set(p.SEES_CLASSES.split(",").map((c) => c.trim()));
    if (p.OBSERVER_DEPENDENT === "SHOWN") classes.add("OBSERVER_DEPENDENT");
    return new Set(
      tables(MATRIX, "DATA_ID")
        .filter((r) => classes.has(r.CLASSIFICATION))
        .map((r) => r.DATA_ID),
    );
  };

  it("los perfiles son válidos y ninguno ve NEVER_VISUALIZE", () => {
    const bad: string[] = [];
    expect(profiles().length).toBeGreaterThan(0);
    for (const p of profiles()) {
      const classes = p.SEES_CLASSES.split(",").map((c) => c.trim());
      if (classes.some((c) => !VISIBILITY.has(c) || c === "NEVER_VISUALIZE" || c === "OBSERVER_DEPENDENT"))
        bad.push(`${p.VIEW_PROFILE}: SEES_CLASSES «${p.SEES_CLASSES}»`);
      if (!["SHOWN", "HIDDEN"].includes(p.OBSERVER_DEPENDENT)) bad.push(`${p.VIEW_PROFILE}: OBSERVER_DEPENDENT`);
      if (!["spectator", "team", "owner", "internal"].includes(p.VIEWER_ROLE))
        bad.push(`${p.VIEW_PROFILE}: VIEWER_ROLE`);
    }
    expect(bad).toEqual([]);
  });

  it("las vistas de espectador ven EXACTAMENTE lo PUBLIC de §12 y nunca leen el replay crudo", () => {
    const pub = sorted(
      tables(MATRIX, "DATA_ID")
        .filter((r) => r.CLASSIFICATION === "PUBLIC")
        .map((r) => r.DATA_ID),
    );
    const spect = profiles().filter((p) => p.VIEWER_ROLE === "spectator");
    expect(spect.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const p of spect) {
      if (JSON.stringify(sorted(visibleFor(p))) !== JSON.stringify(pub))
        bad.push(`${p.VIEW_PROFILE}: ve algo no PUBLIC`);
      if (/crudo/i.test(p.EQUIPMENT_SOURCE)) bad.push(`${p.VIEW_PROFILE}: lee el replay crudo`);
    }
    expect(bad).toEqual([]);
  });

  it("PRIVATE_VIEW ≠ PUBLIC_VIEW: el dueño ve estrictamente más que cualquier espectador", () => {
    const owner = profiles().find((p) => p.VIEWER_ROLE === "owner");
    expect(owner, "perfil de dueño").toBeDefined();
    const ownerSees = visibleFor(owner!);
    for (const p of profiles().filter((x) => x.VIEWER_ROLE === "spectator")) {
      const pubSees = visibleFor(p);
      expect(
        [...pubSees].filter((id) => !ownerSees.has(id)),
        `${p.VIEW_PROFILE} ⊆ dueño`,
      ).toEqual([]);
      expect([...ownerSees].filter((id) => !pubSees.has(id)).length, `dueño − ${p.VIEW_PROFILE}`).toBeGreaterThan(0);
    }
  });

  it("la clave de la caché de composición incluye la proyección y el perfil, nunca sólo botVersionId", () => {
    expect(ADR2).toContain(
      "`(hash del equipamiento YA proyectado, visibilityProfile, viewerRole, spectatorPolicyVersion, visualCatalogVersion, renderTarget)`",
    );
    expect(ADR2).toContain("nunca se indexa sólo por `botVersionId`");
    expect(ADR2).not.toContain("Clave = `(botVersionId o hash del equipamiento");
  });
});
