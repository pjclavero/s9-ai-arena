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
 *   TEST 9 · VIEWER_PROJECTION              los perfiles de vista de ADR-VIS-002 aplicados a §12: lista canónica de
 *                                          perfiles con su rol, ninguna vista ve NEVER_VISUALIZE, las públicas ven
 *                                          exactamente lo PUBLIC y PRIVATE ≠ PUBLIC.
 *   TEST 10 · VIEWER_ENTITY_PAIR (P2-9)     la proyección se resuelve por pareja (visor, vehículo observado): el
 *                                          contexto, la matriz mínima de parejas contra una función de referencia y el
 *                                          aislamiento de la caché (Intrinsic frente a Projected).
 *   TEST 11 · ENGINE_DERIVED                las fugas del motor de §12.4 están clasificadas, atadas a su issue
 *                                          (#261/#262/#263) y coinciden en los dos sentidos con §12, §5 y §6.
 *   TEST 12 · CROSS_VIEW_VISIBILITY_TRANSITION  la clave de la ProjectedComposition lleva el estado de
 *                                          visibilidad: una caché simulada con la clave declarada nunca sirve,
 *                                          tras una transición (revelación, visor, relación, canal o política),
 *                                          la composición de antes (T1-T6).
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
const MOUNTS_DOC = readFileSync(join(DOCS, "MOUNT_TYPE_DRAFT.md"), "utf8");
const MASTER = readFileSync(join(DOCS, "MASTER-PLAN.md"), "utf8");
const ENGINE_SRC = (rel: string): string => readFileSync(join(REPO, "apps", "arena-engine", "src", "sim", rel), "utf8");
/** Texto sin comentarios HTML ni negritas y con los espacios colapsados (para buscar frases, no líneas). */
const prose = (md: string): string =>
  md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ");
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
  "data.armor_material",
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
  "cross.owner_to_rival",
];
/** Elementos de batalla (runtime) revisados: un id runtime inventado en inventario y matriz a la vez es rojo. */
const CANONICAL_RUNTIME_IDS = [
  "runtime.turret",
  "runtime.projectile",
  "runtime.muzzle_flash",
  "runtime.mine_deployed",
  "runtime.explosion",
  "runtime.smoke",
  "runtime.wreck",
  "runtime.flag",
  "runtime.juggernaut_marker",
  "runtime.team_color",
  "runtime.bot_label",
];
/** Los 13 estados visuales del encargo: conjunto EXACTO (ni falta ni sobra). */
const CANONICAL_STATES = [
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
/** Taxonomía de MOUNT_TYPE_DRAFT §2: conjunto EXACTO. */
const CANONICAL_MOUNT_TYPES = [
  "hull.base",
  "weapon.primary",
  "weapon.secondary",
  "sensor.front",
  "sensor.top",
  "sensor.omni",
  "sensor.flank",
  "radio.top",
  "armor.front",
  "armor.side",
  "armor.rear",
  "mobility.left",
  "mobility.right",
  "bay.rear",
  "internal",
  "fx.muzzle",
  "ui.overhead",
];
/** Mount types que no salen de una ranura (ancla del casco, efectos, UI): no aparecen en los bloques JSON de §9. */
const NON_SLOT_MOUNT_TYPES = ["hull.base", "fx.muzzle", "ui.overhead"];
const DISCLOSURE = new Set(["YES", "NO", "PARTIAL"]);
/** Referencias válidas de la columna ENGINE_DERIVED de §12 (issue de motor, decisión de producto o BY_DESIGN). */
const ENGINE_ISSUES = ["#261", "#262", "#263"];
const ENGINE_REF = /^(?:#26[123]|D-0[1-8]|BY_DESIGN)$/;
const refsOf = (cell: string | undefined): string[] =>
  (cell ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
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
    ["MATRIX", "LEAK_CLASS", MATRIX],
    ["MATRIX", "ENGINE_LEAK_ID", MATRIX],
    ["ADR-VIS-002", "VIEW_PROFILE", ADR2],
    ["ADR-VIS-002", "PAIR_CASE", ADR2],
    ["ADR-VIS-002", "CACHE_ID", ADR2],
    ["ADR-VIS-002", "VIS_TRANSITION", ADR2],
    ["ADR-VIS-002", "REVEAL_ID", ADR2],
    ["MOUNT_TYPE_DRAFT", "MOUNT_TYPE", MOUNTS_DOC],
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
    expect(runtimeInv, "elementos runtime frente al conjunto canónico").toEqual(sorted(CANONICAL_RUNTIME_IDS));
  });

  it("P2-10 · ninguna fila de clave queda con la clasificación vacía o nula", () => {
    const bad: string[] = [];
    const empty = (v: string | undefined): boolean => v === undefined || v === "" || /^(null|undefined|-)$/i.test(v);
    for (const r of decisionRows()) {
      if (empty(r.DECISION) || empty(r.VISIBILITY_CLASS)) bad.push(`${r.DOMAIN_ID}: decisión o clase vacía`);
    }
    for (const r of inventoryRows()) if (empty(r.VISUAL_RELEVANCE)) bad.push(`${r.DOMAIN_ID}: relevancia vacía`);
    for (const r of tables(MATRIX, "DATA_ID")) if (empty(r.CLASSIFICATION)) bad.push(`${r.DATA_ID}: clase vacía`);
    for (const r of tables(MATRIX, "STATE")) if (empty(r.STATUS)) bad.push(`${r.STATE}: estado vacío`);
    for (const r of tables(MATRIX, "CROSS_VIEW_ID")) if (empty(r.RULE)) bad.push(`${r.CROSS_VIEW_ID}: regla vacía`);
    expect(bad).toEqual([]);
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
      // ENGINE_DERIVED: lo derivado lo permite el motor y va atado a una issue, una decisión o BY_DESIGN.
      const refs = refsOf(r.ENGINE_DERIVED);
      if (v === "NO" && r.ENGINE_DERIVED !== "—")
        bad.push(`${r.DATA_ID}: sin derivación pero ENGINE_DERIVED «${r.ENGINE_DERIVED}»`);
      if (v !== "NO") {
        if (refs.length === 0 || refs.some((x) => !ENGINE_REF.test(x)))
          bad.push(`${r.DATA_ID}: ENGINE_DERIVED «${r.ENGINE_DERIVED}» no válido`);
        if (dupes(refs).length) bad.push(`${r.DATA_ID}: ENGINE_DERIVED repetido`);
      }
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
    const states = CANONICAL_STATES;
    expect(sorted(rows.map((r) => r.STATE)), "STATE: conjunto exacto").toEqual(sorted(states));
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
  // P2-10 · Sólo cuentan los bloques que un lector ve (fuera de comentarios HTML), y TODO bloque ```json debe ser
  // un bloque de mounts: un JSON que no lo sea, o que no parsee, es rojo, no algo que se ignora.
  const blocks = (): ChassisMounts[] =>
    [...MATRIX.replace(/<!--[\s\S]*?-->/g, "").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => {
      const b = JSON.parse(m[1]) as ChassisMounts;
      if (typeof b.chassis !== "string" || !Array.isArray(b.appliesToVersions) || typeof b.mounts !== "object")
        throw new Error(`bloque JSON de la matriz que no es un bloque de mounts: ${m[1].slice(0, 60)}`);
      return b;
    });

  it("cada versión de cada chasis del catálogo tiene EXACTAMENTE un bloque de mounts (chasis@versión único)", () => {
    const coveredList = blocks().flatMap((b) => b.appliesToVersions.map((v) => `${b.chassis}@${v}`));
    const chassis = catalog.filter((m) => m.category === "chassis").map(versioned);
    expect(chassis.length).toBeGreaterThan(0);
    expect(dupes(coveredList), "chasis@versión representado en más de un bloque").toEqual([]);
    expect(dupes(blocks().map((b) => b.chassis)), "chasis con más de un bloque").toEqual([]);
    expect(sorted(coveredList), "bloques frente a los chasis del catálogo").toEqual(sorted(chassis));
  });

  it("los MOUNT_TYPE son EXACTAMENTE la taxonomía canónica, y los bloques de §9 usan exactamente los de ranura", () => {
    const declared = tables(MOUNTS_DOC, "MOUNT_TYPE").map((r) => r.MOUNT_TYPE);
    expect(dupes(declared)).toEqual([]);
    expect(sorted(declared), "MOUNT_TYPE_DRAFT §2").toEqual(sorted(CANONICAL_MOUNT_TYPES));
    const used = new Set(blocks().flatMap((b) => Object.values(b.mounts).flatMap((mt) => mt.MOUNT_TYPE)));
    expect(sorted(used), "MOUNT_TYPE usados en §9").toEqual(
      sorted(CANONICAL_MOUNT_TYPES.filter((t) => !NON_SLOT_MOUNT_TYPES.includes(t))),
    );
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

  const bases = (category: string): string[] =>
    sorted(new Set(catalog.filter((m) => m.category === category).map((m) => m.id)));

  it("todo sensor del catálogo (id y versión) tiene fila en el contrato de sensores, y ninguna sobra", () => {
    expect(catalog.some((m) => m.category === "sensor")).toBe(true);
    expect(covers(tables(MATRIX, "SENSOR_ID"), "SENSOR_ID", "sensor")).toEqual([]);
    expect(sorted(tables(MATRIX, "SENSOR_ID").map((r) => r.SENSOR_ID))).toEqual(bases("sensor"));
  });

  it("toda arma del catálogo (id y versión) tiene fila en el contrato de armas, y ninguna sobra", () => {
    expect(catalog.some((m) => m.category === "weapon")).toBe(true);
    expect(covers(tables(MATRIX, "WEAPON_ID"), "WEAPON_ID", "weapon")).toEqual([]);
    expect(sorted(tables(MATRIX, "WEAPON_ID").map((r) => r.WEAPON_ID))).toEqual(bases("weapon"));
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
    "LEAK_CLASS",
    "ENGINE_LEAK_ID",
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
    // Tablas nuevas de la ronda 3: tantas filas parseadas como líneas brutas con su id.
    expect(tables(MATRIX, "ENGINE_LEAK_ID").length, "filas ENGINE_LEAK_ID").toBe(rawRows(MATRIX, /engine\.[a-z0-9_]+/));
    expect(tables(ADR2, "PAIR_CASE").length, "filas PAIR_CASE").toBe(rawRows(ADR2, /pair\.[a-z0-9_.]+/));
    expect(tables(ADR2, "CACHE_ID").length, "filas CACHE_ID").toBe(rawRows(ADR2, /cache\.[a-z0-9_]+/));
    expect(tables(ADR2, "VIEW_PROFILE").length, "filas VIEW_PROFILE").toBe(rawRows(ADR2, /view\.[a-z0-9_]+/));
    expect(tables(MOUNTS_DOC, "MOUNT_TYPE").length, "filas MOUNT_TYPE").toBe(
      rawRows(MOUNTS_DOC, /[a-z]+(?:\.[a-z]+)?/),
    );
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

  // P3-9 · No basta con que la frase literal exista: la regla de §12.3 y la prosa tienen que seguir prohibiendo.
  it("PRE-1 · las reglas de §12.3 prohíben, y ningún texto permite al renderer público leer el crudo", () => {
    const rule = new Map(tables(MATRIX, "CROSS_VIEW_ID").map((r) => [r.CROSS_VIEW_ID, r.RULE]));
    const bad: string[] = [];
    for (const id of ["cross.raw_replay", "cross.owner_to_rival"]) {
      if (!(rule.get(id) ?? "").startsWith("Prohibido")) bad.push(`${id}: la regla no empieza por «Prohibido»`);
      if (!(rule.get(id) ?? "").includes("proyección saneada"))
        bad.push(`${id}: la regla no cita la proyección saneada`);
    }
    for (const [id, r] of rule) if (/permitid/i.test(r)) bad.push(`${id}: regla permisiva «${r.slice(0, 60)}»`);
    for (const [name, md] of [
      ["MATRIX", MATRIX],
      ["ADR-VIS-002", ADR2],
    ] as const) {
      const text = prose(md);
      const permissive =
        /(renderer|vista|perfil)[^.]{0,20}p[úu]blic[oa][^.]{0,40}\b(puede|pueden|podr[áa]n?)\b[^.]{0,40}\b(leer|consumir|usar|recibir)\b[^.]{0,40}crudo/i.exec(
          text,
        );
      if (permissive) bad.push(`${name}: «${permissive[0]}»`);
    }
    const m = prose(MATRIX);
    if (!m.includes("El contrato tiene que ser seguro aunque se activen los replays públicos"))
      bad.push("MATRIX: falta «seguro aunque se activen los replays públicos»");
    if (!m.includes("que hoy estén apagados por configuración no cuenta como protección"))
      bad.push("MATRIX: falta «apagados por configuración no cuenta como protección»");
    if (!m.includes("«RAW_REPLAY ⇒ dueño» se resuelve por pareja"))
      bad.push("MATRIX: «RAW_REPLAY ⇒ dueño» no es por pareja");
    expect(bad).toEqual([]);
  });

  it("P3-10 · el flag `debugOpen` del formato de replay está inventariado como CROSS_VIEW latente", () => {
    const fmt = readFileSync(join(REPO, "apps", "replay-service", "src", "format.ts"), "utf8");
    expect(fmt, "premisa: el formato sigue teniendo debugOpen").toMatch(/\bdebugOpen\s*:\s*boolean/);
    const dbg = tables(MATRIX, "CROSS_VIEW_ID").find((r) => r.CROSS_VIEW_ID === "cross.debug_overlay");
    expect(dbg?.VECTOR ?? "").toContain("`debugOpen`");
    expect(dbg?.RULE ?? "").toContain("`debugOpen`");
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
  /** Ritmo máximo de giro de la torreta por estado (operational/damaged/critical): turretRateRads × rendimiento. */
  turret: number[];
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
      turret: perfs.map((p) => (w.turretRateRads ?? NaN) * p),
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
    // #262 · Con el `state` público conocido, se compara el ritmo de giro estado a estado con las otras armas base.
    const turretShared = k.turret.some((r, i) =>
      otherBases.some(([, o]) => Number(num(o.turret[i])) === Number(num(r))),
    );
    const turretFastest = k.turret.every((r, i) => otherBases.every(([, o]) => r > o.turret[i]));
    rows.set(id, {
      SPEED_MS: num(k.speed),
      REACH_M: num(k.reach),
      INTERVAL_TICKS: k.interval.join(" / "),
      HULL_DAMAGE: k.hullDamage,
      IDENTITY_BY_SPEED: otherBases.some(([, o]) => o.speed === k.speed) ? "AMBIGUOUS" : "IDENTITY",
      TURRET_RATE_RADS: k.turret.map(num).join(" / "),
      IDENTITY_BY_TURRET: turretShared ? "AMBIGUOUS" : turretFastest ? "IDENTITY" : "EXCLUSION",
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

  // P3-8 · «El disparo sólo se resuelve en ticks de decisión» es una premisa de la tabla: se vigila en battle.ts.
  it("premisa del motor: los comandos (y con ellos el disparo) sólo se rellenan en ticks de decisión", () => {
    const src = ENGINE_SRC("battle.ts");
    expect(src).toMatch(/isDecisionTick\(\): boolean \{\s*return this\.tick % DECISION_EVERY_N_TICKS === 0;\s*\}/);
    const open = /const commands = new Map<string, any>\(\);\s*if \(this\.isDecisionTick\(\)\) \{/.exec(src);
    expect(open, "el mapa de comandos se rellena bajo isDecisionTick()").not.toBeNull();
    // Fin del bloque `if (this.isDecisionTick()) { … }` por conteo de llaves.
    const start = open!.index + open![0].length;
    let depth = 1;
    let end = start;
    for (; end < src.length && depth > 0; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") depth--;
    }
    const sets = [...src.matchAll(/\bcommands\.set\(/g)].map((x) => x.index ?? -1);
    expect(sets.length).toBeGreaterThan(0);
    expect(
      sets.filter((i) => i < start || i > end),
      "commands.set fuera del bloque de decisión",
    ).toEqual([]);
    expect(src.indexOf("this.resolveFiring(commands,")).toBeGreaterThan(end);
  });

  it("premisa del motor (#262): la torreta gira a turretRateRads × rendimiento y su rumbo va en cada snapshot", () => {
    expect(ENGINE_SRC("vehicle.ts")).toContain("(w.spec.turretRateRads ?? 0) * this.performanceOf(w.spec.slot)");
    const battle = ENGINE_SRC("battle.ts");
    expect(battle).toContain("const maxStep = rate * TICK_DT;");
    expect(battle).toContain("turretHeading: round6(v.turretHeading)");
  });

  it("#262 · si el giro de la torreta separa las armas base, sus decisiones lo atan a la issue", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const bad: string[] = [];
    for (const [id, r] of expectedKinRows()) {
      if (r.IDENTITY_BY_TURRET === "AMBIGUOUS") continue;
      const why = decisions.get(id)?.WHY ?? "";
      if (!why.includes("ENGINE_DERIVED") || !why.includes("#262"))
        bad.push(`${id}: giro distinguible sin ENGINE_DERIVED #262`);
    }
    expect(bad).toEqual([]);
  });

  it("#263 · si dos placas del mismo sector reducen distinto, su decisión dice que el material es ENGINE_DERIVED", () => {
    const decisions = new Map(decisionRows().map((r) => [r.DOMAIN_ID, r]));
    const armor = catalog.filter((m) => m.category === "armor");
    expect(armor.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const a of armor) {
      const distinct = armor.some((o) => o !== a && o.sector === a.sector && o.reduction !== a.reduction);
      if (!distinct) continue;
      const why = decisions.get(versioned(a))?.WHY ?? "";
      if (!why.includes("ENGINE_DERIVED") || !why.includes("#263"))
        bad.push(`${versioned(a)}: sin ENGINE_DERIVED #263`);
    }
    expect(bad).toEqual([]);
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

/* ─────────────── TEST 9 · VIEWER_PROJECTION: la vista depende de la audiencia (P2-6, P2-10) ─────────────── */

/** P2-10 · Lista canónica de perfiles: [VIEWER_ROLE, SEES_CLASSES, OBSERVER_DEPENDENT]. Comparación exacta. */
const CANONICAL_VIEW_PROFILES: Record<string, string[]> = {
  "view.public_live": ["spectator", "PUBLIC", "HIDDEN"],
  "view.public_replay": ["spectator", "PUBLIC", "HIDDEN"],
  "view.broadcast": ["spectator", "PUBLIC", "HIDDEN"],
  "view.ally": ["team", "PUBLIC, ALLY_ONLY", "HIDDEN"],
  "view.owner": ["owner", "PUBLIC, ALLY_ONLY, SELF_ONLY", "SHOWN"],
  "view.internal": ["internal", "PUBLIC, ALLY_ONLY, SELF_ONLY", "SHOWN"],
};
/** Perfiles públicos y la ÚNICA fuente de equipamiento que pueden tener (nunca el replay crudo, PRE-1). */
const PUBLIC_EQUIPMENT_SOURCE: Record<string, string> = {
  "view.public_live": "canal de espectador",
  "view.public_replay": "proyección saneada del replay",
  "view.broadcast": "canal de espectador",
};
/** P2-9 · Campos de VisualProjectionContext (ADR-VIS-002) y si son opcionales. */
const CANONICAL_PROJECTION_CONTEXT: Record<string, string> = {
  viewerId: "optional",
  viewerRole: "required",
  viewerTeamIds: "optional",
  observedBotId: "required",
  observedBotVersionId: "required",
  observedBotOwnerId: "optional",
  observedTeamId: "optional",
  spectatorMode: "required",
  spectatorPolicyVersion: "required",
  visibilityPolicyVersion: "required",
  visibilityStateVersion: "required",
};
/** P2-9 · Matriz mínima de parejas: [VIEWER, CHANNEL, OBSERVED]. */
const CANONICAL_PAIR_CASES: Record<string, string[]> = {
  "pair.owner_a.sees_a": ["owner(A)", "private", "A"],
  "pair.owner_a.sees_b": ["owner(A)", "private", "B"],
  "pair.owner_b.sees_a": ["owner(B)", "private", "A"],
  "pair.team_a.sees_a": ["team(A)", "private", "A"],
  "pair.team_a.sees_b": ["team(A)", "private", "B"],
  "pair.admin.sees_a": ["admin", "internal", "A"],
  "pair.admin.public_live_a": ["admin", "live_public", "A"],
  "pair.anonymous.sees_a": ["anonymous", "live_public", "A"],
  "pair.spectator.sees_a": ["spectator", "live_public", "A"],
  "pair.broadcast.sees_a": ["broadcast", "broadcast", "A"],
  "pair.public_replay.sees_a": ["anonymous", "public_replay", "A"],
  "pair.owner_a.public_live_a": ["owner(A)", "live_public", "A"],
  "pair.owner_a.public_replay_a": ["owner(A)", "public_replay", "A"],
};
/** P2-9 · Niveles de caché y si se sirven al cliente. */
const CANONICAL_CACHES: Record<string, string> = {
  "cache.asset": "YES",
  "cache.intrinsic_composition": "NO",
  "cache.projected_composition": "YES",
};
const PROJECTED_KEY_REQUIRED = [
  "observedBotId",
  "viewerRelation",
  "resolvedProfile",
  "spectatorMode",
  "spectatorPolicyVersion",
  "visibilityPolicyVersion",
  "visibilityStateVersion",
  "visualCatalogVersion",
  "renderTarget",
];
/** §12.4 · Fugas del motor y su issue. */
const CANONICAL_ENGINE_LEAKS: Record<string, string> = {
  "engine.entity_identity_order": "#261",
  "engine.turret_kinematics": "#262",
  "engine.damage_response": "#263",
};
/** §12 · Datos atados a cada issue de motor (columna ENGINE_DERIVED). */
const CANONICAL_ENGINE_DATA: Record<string, string[]> = {
  "#261": ["data.mine_bay_contents", "data.mine_position"],
  "#262": ["data.full_loadout", "data.module_identity", "data.weapon_identity"],
  "#263": [
    "data.armor_material",
    "data.armor_sector_hp",
    "data.full_loadout",
    "data.hit_details",
    "data.module_identity",
  ],
};

/** Datos de §12 que ve un perfil de ADR-VIS-002. */
const visibleFor = (p: Row): Set<string> => {
  const classes = new Set(p.SEES_CLASSES.split(",").map((c) => c.trim()));
  if (p.OBSERVER_DEPENDENT === "SHOWN") classes.add("OBSERVER_DEPENDENT");
  return new Set(
    tables(MATRIX, "DATA_ID")
      .filter((r) => classes.has(r.CLASSIFICATION))
      .map((r) => r.DATA_ID),
  );
};

describe("TEST 9 · VIEWER_PROJECTION (ADR-VIS-002: PRIVATE_VIEW ≠ PUBLIC_VIEW)", () => {
  const profiles = (): Row[] => tables(ADR2, "VIEW_PROFILE");

  it("P2-10 · los perfiles son EXACTAMENTE la lista canónica, con su rol, sus clases y su OBSERVER_DEPENDENT", () => {
    const got = Object.fromEntries(
      profiles().map((p) => [p.VIEW_PROFILE, [p.VIEWER_ROLE, p.SEES_CLASSES, p.OBSERVER_DEPENDENT]]),
    );
    expect(dupes(profiles().map((p) => p.VIEW_PROFILE))).toEqual([]);
    expect(got).toEqual(CANONICAL_VIEW_PROFILES);
  });

  it("las vistas públicas toman el equipamiento sólo del canal de espectador o de la proyección saneada", () => {
    const src = new Map(profiles().map((p) => [p.VIEW_PROFILE, p.EQUIPMENT_SOURCE]));
    const bad = Object.entries(PUBLIC_EQUIPMENT_SOURCE)
      .filter(([id, s]) => src.get(id) !== s)
      .map(([id]) => `${id}: «${src.get(id)}»`);
    for (const [id, s] of src)
      if (!(id in PUBLIC_EQUIPMENT_SOURCE) && !/autorizad/i.test(s ?? "")) bad.push(`${id}: privado sin autorización`);
    expect(bad).toEqual([]);
  });

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

  it("las vistas de espectador ven EXACTAMENTE lo PUBLIC de §12; la de equipo, sólo PUBLIC ∪ ALLY_ONLY", () => {
    const data = tables(MATRIX, "DATA_ID");
    const pub = sorted(data.filter((r) => r.CLASSIFICATION === "PUBLIC").map((r) => r.DATA_ID));
    const allyMax = new Set(
      data.filter((r) => r.CLASSIFICATION === "PUBLIC" || r.CLASSIFICATION === "ALLY_ONLY").map((r) => r.DATA_ID),
    );
    const bad: string[] = [];
    for (const id of Object.keys(PUBLIC_EQUIPMENT_SOURCE)) {
      const p = profiles().find((x) => x.VIEW_PROFILE === id);
      if (!p) bad.push(`${id}: falta`);
      else if (JSON.stringify(sorted(visibleFor(p))) !== JSON.stringify(pub)) bad.push(`${id}: ve algo no PUBLIC`);
    }
    const ally = profiles().find((x) => x.VIEW_PROFILE === "view.ally");
    if (!ally) bad.push("view.ally: falta");
    else {
      const extra = [...visibleFor(ally)].filter((id) => !allyMax.has(id));
      if (extra.length) bad.push(`view.ally ve fuera de PUBLIC ∪ ALLY_ONLY: ${extra.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });

  it("PRIVATE_VIEW ≠ PUBLIC_VIEW: el dueño ve estrictamente más que cualquier espectador", () => {
    const owner = profiles().find((p) => p.VIEW_PROFILE === "view.owner");
    expect(owner, "perfil de dueño").toBeDefined();
    const ownerSees = visibleFor(owner!);
    for (const p of profiles().filter((x) => x.VIEW_PROFILE in PUBLIC_EQUIPMENT_SOURCE)) {
      const pubSees = visibleFor(p);
      expect(
        [...pubSees].filter((id) => !ownerSees.has(id)),
        `${p.VIEW_PROFILE} ⊆ dueño`,
      ).toEqual([]);
      expect([...ownerSees].filter((id) => !pubSees.has(id)).length, `dueño − ${p.VIEW_PROFILE}`).toBeGreaterThan(0);
    }
  });
});

/* ─────────────── TEST 10 · VIEWER_ENTITY_PAIR: la proyección se decide por pareja (P2-9) ─────────────── */

/**
 * Función de referencia de ADR-VIS-002 («Proyección por pareja»), escrita aquí de forma independiente de la tabla:
 * la relación sale del visor y del vehículo OBSERVADO; el perfil, del canal y de esa relación.
 */
const relationOf = (viewer: string, observed: string): string => {
  const m = /^(owner|team)\(([A-Z])\)$/.exec(viewer);
  if (m) return m[2] !== observed ? "NONE" : m[1] === "owner" ? "OWNER" : "TEAMMATE";
  if (viewer === "admin") return "INTERNAL";
  return ["anonymous", "spectator", "broadcast"].includes(viewer) ? "NONE" : `?${viewer}`;
};
const profileOf = (channel: string, relation: string): string => {
  if (channel === "live_public") return "view.public_live";
  if (channel === "public_replay") return "view.public_replay";
  if (channel === "broadcast") return "view.broadcast";
  if (channel === "private")
    return relation === "OWNER" ? "view.owner" : relation === "TEAMMATE" ? "view.ally" : "view.public_live";
  if (channel === "internal") return relation === "INTERNAL" ? "view.internal" : "view.public_live";
  return `?${channel}`;
};

describe("TEST 10 · VIEWER_ENTITY_PAIR (P2-9: visor + vehículo observado + relación + política)", () => {
  const pairs = (): Row[] => tables(ADR2, "PAIR_CASE");
  const byCase = (): Map<string, Row> => new Map(pairs().map((r) => [r.PAIR_CASE, r]));
  const profile = (id: string): Row | undefined => tables(ADR2, "VIEW_PROFILE").find((p) => p.VIEW_PROFILE === id);

  it("VisualProjectionContext declara EXACTAMENTE los campos exigidos (visor, vehículo observado, relación, políticas)", () => {
    const blocks = [...ADR2.matchAll(/```ts\n(interface VisualProjectionContext \{[\s\S]*?\n\})\n```/g)];
    expect(blocks.length, "un único bloque VisualProjectionContext").toBe(1);
    const fields = Object.fromEntries(
      [...blocks[0][1].matchAll(/^\s+([A-Za-z]+)(\??):/gm)].map((f) => [f[1], f[2] === "?" ? "optional" : "required"]),
    );
    expect(fields).toEqual(CANONICAL_PROJECTION_CONTEXT);
    // Los canales de la matriz de parejas son exactamente los de `spectatorMode`.
    const modes = /spectatorMode:\s*([^;]+);/.exec(blocks[0][1])?.[1] ?? "";
    const declared = sorted([...modes.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
    expect(sorted(new Set(pairs().map((r) => r.CHANNEL)))).toEqual(declared);
  });

  it("la matriz mínima de parejas es EXACTAMENTE la canónica (visor, canal y vehículo observado)", () => {
    const got = Object.fromEntries(pairs().map((r) => [r.PAIR_CASE, [r.VIEWER, r.CHANNEL, r.OBSERVED]]));
    expect(dupes(pairs().map((r) => r.PAIR_CASE))).toEqual([]);
    expect(got).toEqual(CANONICAL_PAIR_CASES);
  });

  it("RELATION y RESOLVED_PROFILE son los que da la función de referencia (por pareja, no por rol)", () => {
    const bad: string[] = [];
    for (const r of pairs()) {
      const rel = relationOf(r.VIEWER, r.OBSERVED);
      if (r.RELATION !== rel) bad.push(`${r.PAIR_CASE}: RELATION «${r.RELATION}» ≠ «${rel}»`);
      const prof = profileOf(r.CHANNEL, rel);
      if (r.RESOLVED_PROFILE !== prof) bad.push(`${r.PAIR_CASE}: RESOLVED_PROFILE «${r.RESOLVED_PROFILE}» ≠ «${prof}»`);
      if (!profile(r.RESOLVED_PROFILE)) bad.push(`${r.PAIR_CASE}: perfil «${r.RESOLVED_PROFILE}» inexistente`);
    }
    expect(bad).toEqual([]);
  });

  it("owner(A)/A ≠ owner(A)/B y team(A)/A ≠ team(A)/B: las composiciones difieren donde difieren los permisos", () => {
    const c = byCase();
    const seen = (id: string): Set<string> => {
      const p = profile(c.get(id)?.RESOLVED_PROFILE ?? "");
      return p ? visibleFor(p) : new Set();
    };
    for (const [self, rival] of [
      ["pair.owner_a.sees_a", "pair.owner_a.sees_b"],
      ["pair.team_a.sees_a", "pair.team_a.sees_b"],
    ]) {
      const a = seen(self);
      const b = seen(rival);
      expect(
        [...b].filter((x) => !a.has(x)),
        `${rival} ⊆ ${self}`,
      ).toEqual([]);
      expect([...a].filter((x) => !b.has(x)).length, `${self} ve más que ${rival}`).toBeGreaterThan(0);
    }
    // El dueño de A ve al rival B exactamente como un espectador ve A.
    expect(sorted(seen("pair.owner_a.sees_b"))).toEqual(sorted(seen("pair.spectator.sees_a")));
  });

  it("P2_9_CACHE_ISOLATION · Intrinsic no se sirve; la clave Projected separa parejas con distinto vehículo o perfil", () => {
    const caches = tables(ADR2, "CACHE_ID");
    expect(sorted(caches.map((r) => r.CACHE_ID))).toEqual(sorted(Object.keys(CANONICAL_CACHES)));
    const keyOf = (id: string): string[] =>
      (caches.find((r) => r.CACHE_ID === id)?.KEY_FIELDS ?? "")
        .split(",")
        .map((x) => clean(x))
        .filter(Boolean);
    const bad: string[] = [];
    for (const r of caches) {
      if (r.SERVED_TO_CLIENT !== CANONICAL_CACHES[r.CACHE_ID])
        bad.push(`${r.CACHE_ID}: SERVED_TO_CLIENT «${r.SERVED_TO_CLIENT}»`);
      const k = keyOf(r.CACHE_ID);
      // Al cliente nunca se le sirve una entrada indexada por el bot sin el vehículo observado y el perfil resuelto.
      if (
        r.SERVED_TO_CLIENT === "YES" &&
        k.includes("botVersionId") &&
        !(k.includes("observedBotId") && k.includes("resolvedProfile"))
      )
        bad.push(`${r.CACHE_ID}: servida al cliente e indexada por botVersionId sin pareja`);
    }
    const asset = keyOf("cache.asset");
    for (const f of ["botVersionId", "observedBotId", "viewerRelation"])
      if (asset.includes(f)) bad.push(`cache.asset: su clave lleva ${f}`);
    const projected = keyOf("cache.projected_composition");
    for (const f of PROJECTED_KEY_REQUIRED)
      if (!projected.includes(f)) bad.push(`cache.projected_composition: falta ${f}`);
    if (projected.includes("viewerId"))
      bad.push("cache.projected_composition: la relación, no el viewerId, va en la clave");
    expect(bad).toEqual([]);
    // Simulación: valor de la clave proyectada para cada pareja de la matriz mínima.
    const value = (r: Row): string =>
      projected
        .map((f) =>
          f === "observedBotId"
            ? r.OBSERVED
            : f === "botVersionId"
              ? `${r.OBSERVED}@v`
              : f === "viewerRelation"
                ? r.RELATION
                : f === "resolvedProfile"
                  ? r.RESOLVED_PROFILE
                  : f === "spectatorMode"
                    ? r.CHANNEL
                    : "const",
        )
        .join("|");
    const collisions: string[] = [];
    const rows = pairs();
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        const mustDiffer = a.OBSERVED !== b.OBSERVED || a.RESOLVED_PROFILE !== b.RESOLVED_PROFILE;
        if (mustDiffer && value(a) === value(b)) collisions.push(`${a.PAIR_CASE} = ${b.PAIR_CASE}`);
      }
    expect(collisions).toEqual([]);
    const c = byCase();
    expect(value(c.get("pair.owner_a.sees_a")!)).not.toBe(value(c.get("pair.owner_a.sees_b")!));
  });

  it("§12.3 y PRE-1: el dueño de un participante no recibe lo privado de los demás (cross.owner_to_rival)", () => {
    expect(prose(ADR2)).toContain("«RAW_REPLAY ⇒ dueño» quiere decir «el dueño de A recibe la parte cruda de A»");
    const r = tables(MATRIX, "CROSS_VIEW_ID").find((x) => x.CROSS_VIEW_ID === "cross.owner_to_rival");
    expect(r?.FROM_VIEW).toBe("OWNER_VIEW");
    expect(r?.RULE ?? "").toContain("por pareja");
  });
});

/* ─────────────── TEST 11 · ENGINE_DERIVED: fugas del motor clasificadas y atadas a su issue ─────────────── */

describe("TEST 11 · ENGINE_DERIVED (INFORMATION_LEAK_CLASSIFICATION)", () => {
  const engineRows = (): Row[] => tables(MATRIX, "ENGINE_LEAK_ID");
  const listOf = (cell: string | undefined): string[] =>
    (cell ?? "")
      .split(",")
      .map((x) => clean(x))
      .filter(Boolean);

  it("la taxonomía tiene EXACTAMENTE cuatro clases y separa fuga visual de fuga de motor", () => {
    const got = Object.fromEntries(
      tables(MATRIX, "LEAK_CLASS").map((r) => [r.LEAK_CLASS, r.RESPONSABLE.split(" ")[0]]),
    );
    expect(got).toEqual({ DIRECT: "FASE", DERIVED: "FASE", CROSS_VIEW: "FASE", ENGINE_DERIVED: "Motor:" });
    expect(MATRIX).toContain("`ENGINE_INFORMATION_LEAK != VISUAL_CONTRACT_LEAK`");
    expect(MASTER).toContain("`ENGINE_INFORMATION_LEAK != VISUAL_CONTRACT_LEAK`");
  });

  it("§12.4 lista EXACTAMENTE las fugas de motor canónicas, cada una con su issue", () => {
    expect(dupes(engineRows().map((r) => r.ENGINE_LEAK_ID))).toEqual([]);
    expect(Object.fromEntries(engineRows().map((r) => [r.ENGINE_LEAK_ID, r.ISSUE]))).toEqual(CANONICAL_ENGINE_LEAKS);
    for (const r of engineRows()) expect(r.VISUAL_RULE.length, `${r.ENGINE_LEAK_ID}: VISUAL_RULE`).toBeGreaterThan(20);
  });

  it("DATA_IDS de cada issue = filas de §12 que la citan en ENGINE_DERIVED = conjunto canónico", () => {
    const data = tables(MATRIX, "DATA_ID");
    const bad: string[] = [];
    for (const issue of ENGINE_ISSUES) {
      const row = engineRows().find((r) => r.ISSUE === issue);
      const declared = sorted(listOf(row?.DATA_IDS));
      const real = sorted(data.filter((r) => refsOf(r.ENGINE_DERIVED).includes(issue)).map((r) => r.DATA_ID));
      const canon = sorted(CANONICAL_ENGINE_DATA[issue]);
      if (JSON.stringify(declared) !== JSON.stringify(real)) bad.push(`${issue}: §12.4 «${declared}» ≠ §12 «${real}»`);
      if (JSON.stringify(real) !== JSON.stringify(canon)) bad.push(`${issue}: §12 «${real}» ≠ canónico «${canon}»`);
    }
    expect(bad).toEqual([]);
  });

  it("DOMAIN_IDS de cada issue = decisiones de §5/§6 cuyo WHY la cita = lo que sale del catálogo", () => {
    const dec = decisionRows();
    const kin = expectedKinRows();
    const armor = catalog.filter((m) => m.category === "armor");
    const computed: Record<string, string[]> = {
      "#261": [...catalog.filter((m) => m.category === "mine").map(versioned), "runtime.mine_deployed"],
      "#262": [...[...kin].filter(([, r]) => r.IDENTITY_BY_TURRET !== "AMBIGUOUS").map(([id]) => id), "runtime.turret"],
      "#263": armor
        .filter((a) => armor.some((o) => o !== a && o.sector === a.sector && o.reduction !== a.reduction))
        .map(versioned),
    };
    const bad: string[] = [];
    for (const issue of ENGINE_ISSUES) {
      const row = engineRows().find((r) => r.ISSUE === issue);
      const declared = sorted(listOf(row?.DOMAIN_IDS));
      const citing = sorted(dec.filter((r) => r.WHY.includes(issue)).map((r) => r.DOMAIN_ID));
      const real = sorted(computed[issue]);
      if (JSON.stringify(declared) !== JSON.stringify(citing))
        bad.push(`${issue}: §12.4 «${declared}» ≠ WHY «${citing}»`);
      if (JSON.stringify(citing) !== JSON.stringify(real)) bad.push(`${issue}: WHY «${citing}» ≠ catálogo «${real}»`);
    }
    expect(bad).toEqual([]);
  });

  it("las filas de P2-8 son ENGINE_DERIVED: privadas para el renderer pero con su derivación declarada", () => {
    const data = new Map(tables(MATRIX, "DATA_ID").map((r) => [r.DATA_ID, r]));
    const bad: string[] = [];
    for (const id of ["data.mine_position", "data.mine_bay_contents", "data.armor_material", "data.armor_sector_hp"]) {
      const r = data.get(id);
      if (!r) bad.push(`${id}: falta`);
      else {
        if (r.DERIVED_DISCLOSURE === "NO") bad.push(`${id}: DERIVED_DISCLOSURE NO`);
        if (r.CLASSIFICATION === "PUBLIC") bad.push(`${id}: no debe pintarse como PUBLIC`);
        if (!r.NOTES.includes("ENGINE_DERIVED")) bad.push(`${id}: NOTES sin ENGINE_DERIVED`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("el roadmap del MASTER-PLAN referencia las tres issues de motor", () => {
    const line = MASTER.split("\n").find((l) => l.startsWith("ENGINE_ISSUES:")) ?? "";
    expect(ENGINE_ISSUES.filter((i) => !line.includes(i))).toEqual([]);
  });
});

/* ─────────── TEST 12 · CROSS_VIEW_VISIBILITY_TRANSITION: la caché proyectada no sobrevive a una transición ─────────── */

/** Casos canónicos de transición de ADR-VIS-002 y su caso del encargo (T1-T6, relación y políticas). */
const CANONICAL_VIS_TRANSITIONS: Record<string, string> = {
  "vt.reveal": "T1",
  "vt.replay_seek_back": "T2",
  "vt.next_battle": "T2",
  "vt.two_viewers": "T3",
  "vt.two_viewers_same_state": "T3",
  "vt.owner_to_anonymous": "T4",
  "vt.owner_revealed_to_anonymous": "T4",
  "vt.spectator_to_broadcast": "T5",
  "vt.owner_to_public_replay": "T6",
  "vt.team_change": "RELATION",
  "vt.spectator_policy": "POLICY",
  "vt.visibility_policy": "POLICY",
};
/** Revelaciones canónicas (D-08 interino) y los datos de §12 que destapan. */
const CANONICAL_REVEALS: Record<string, string[]> = {
  "reveal.weapon": ["data.projectile_origin", "data.weapon_identity"],
};
const VISIBILITY_TRANSITION_RULE =
  "ProjectedComposition cache MUST NOT survive a visibility transition that changes what the viewer may observe.";

/** Contexto de una celda `visor / canal / vehículo observado / revelaciones / spectatorPolicy / visibilityPolicy`. */
type VisCtx = { viewer: string; channel: string; observed: string; revealed: string[]; sp: string; vp: string };
const parseCtx = (cell: string): VisCtx => {
  const f = cell.split("/").map((x) => x.trim());
  if (f.length !== 6 || f.some((x) => !x)) throw new Error(`contexto mal formado: «${cell}»`);
  const revealed = f[3] === "∅" ? [] : f[3].split("+").map((x) => x.trim());
  return { viewer: f[0], channel: f[1], observed: f[2], revealed, sp: f[4], vp: f[5] };
};
/** Forma canónica del estado de visibilidad: conjunto ordenado de revelaciones, `∅` si ninguna (no un contador). */
const stateVersionOf = (revealed: string[]): string => sorted(new Set(revealed)).join("+") || "∅";
/** Clave canónica completa (referencia): la exigida en TEST 10 más el vehículo observado. */
const CANONICAL_PROJECTED_KEY = [...new Set(["observedBotId", ...PROJECTED_KEY_REQUIRED])];

/** Valor de la clave para un contexto: todo se recalcula a partir del contexto de ESTA petición. */
const keyFor = (ctx: VisCtx, fields: string[]): string => {
  const rel = relationOf(ctx.viewer, ctx.observed);
  const value: Record<string, string> = {
    observedBotId: ctx.observed,
    botVersionId: `${ctx.observed}@v`,
    viewerRelation: rel,
    resolvedProfile: profileOf(ctx.channel, rel),
    spectatorMode: ctx.channel,
    spectatorPolicyVersion: ctx.sp,
    visibilityPolicyVersion: ctx.vp,
    visibilityStateVersion: stateVersionOf(ctx.revealed),
  };
  return fields.map((f) => `${f}=${value[f] ?? "const"}`).join("|");
};

describe("TEST 12 · CROSS_VIEW_VISIBILITY_TRANSITION (la proyección depende del estado de visibilidad)", () => {
  const transitions = (): Row[] => tables(ADR2, "VIS_TRANSITION");
  const projectedKey = (): string[] =>
    (tables(ADR2, "CACHE_ID").find((r) => r.CACHE_ID === "cache.projected_composition")?.KEY_FIELDS ?? "")
      .split(",")
      .map((x) => clean(x))
      .filter(Boolean);
  const revealedData = (): Map<string, string[]> =>
    new Map(
      tables(ADR2, "REVEAL_ID").map((r) => [
        r.REVEAL_ID,
        r.DATA_IDS.split(",")
          .map((x) => clean(x))
          .filter(Boolean),
      ]),
    );

  /** Composición de referencia: lo que el visor PUEDE ver de ese vehículo en ese instante, calculada desde cero. */
  const composeFor = (ctx: VisCtx): string => {
    const prof = profileOf(ctx.channel, relationOf(ctx.viewer, ctx.observed));
    const p = tables(ADR2, "VIEW_PROFILE").find((x) => x.VIEW_PROFILE === prof);
    if (!p) return `?${prof}`;
    const seen = visibleFor(p);
    if (p.OBSERVER_DEPENDENT !== "SHOWN")
      for (const [id, data] of revealedData()) if (!ctx.revealed.includes(id)) for (const d of data) seen.delete(d);
    return `${ctx.observed}:${sorted(seen).join(",")}`;
  };

  /** Caché simulada: indexa por la clave DECLARADA en ADR-VIS-002 y compone sólo si falta la entrada. */
  const serve = (steps: VisCtx[], fields: string[]): string[] => {
    const cache = new Map<string, string>();
    return steps.map((ctx) => {
      const k = keyFor(ctx, fields);
      if (!cache.has(k)) cache.set(k, composeFor(ctx));
      return cache.get(k) ?? "";
    });
  };

  const ctxOf = (id: string, side: "FROM" | "TO"): VisCtx => {
    const r = transitions().find((x) => x.VIS_TRANSITION === id);
    if (!r) throw new Error(`falta ${id}`);
    return parseCtx(r[side]);
  };

  it("la regla obligatoria está escrita en ADR-VIS-002 y en la regla de §12.3 `cross.composition_cache`", () => {
    expect(prose(ADR2)).toContain(VISIBILITY_TRANSITION_RULE);
    const rule = tables(MATRIX, "CROSS_VIEW_ID").find((r) => r.CROSS_VIEW_ID === "cross.composition_cache")?.RULE;
    expect(rule ?? "").toContain(VISIBILITY_TRANSITION_RULE);
    expect(prose(MATRIX)).toContain("Ese primer disparo es una transición de visibilidad dentro de la batalla");
  });

  it("la clave proyectada lleva `visibilityStateVersion`, recalculado en cada petición: el estado, no un contador", () => {
    expect(projectedKey()).toContain("visibilityStateVersion");
    // VIEWER_PROJECTION (lo que depende de la audiencia) incluye el estado de revelación de ese instante.
    const vp = /- VIEWER_PROJECTION — [^]*?(?=\n\n)/.exec(ADR2.replace(/\*\*/g, ""))?.[0] ?? "";
    expect(vp.replace(/\s+/g, " ")).toContain("qué identidades ya se han revelado en ese instante");
    expect(vp).toContain("`visibilityStateVersion`");
    const text = prose(ADR2);
    expect(text).toContain("Lo calcula el backend en cada petición o frame a partir de ese instante");
    expect(text).toContain("nunca lo envía el cliente ni se toma de la primera composición");
    expect(text).toContain("Es el estado, no un contador ni un epoch por batalla");
  });

  it("REVEAL_ID es EXACTAMENTE el canónico y destapa justo las filas PUBLIC «tras el primer disparo» de §12", () => {
    const rows = tables(ADR2, "REVEAL_ID");
    expect(dupes(rows.map((r) => r.REVEAL_ID))).toEqual([]);
    expect(Object.fromEntries([...revealedData()].map(([id, d]) => [id, sorted(d)]))).toEqual(CANONICAL_REVEALS);
    const fromMatrix = tables(MATRIX, "DATA_ID")
      .filter((r) => r.NOTES.includes("PUBLIC por inferencia tras el primer disparo"))
      .map((r) => r.DATA_ID);
    expect(sorted(fromMatrix)).toEqual(sorted(CANONICAL_REVEALS["reveal.weapon"]));
    for (const r of tables(MATRIX, "DATA_ID").filter((x) => fromMatrix.includes(x.DATA_ID)))
      expect(r.CLASSIFICATION, r.DATA_ID).toBe("PUBLIC");
    // T2 · revelado → oculto no existe en directo (la revelación es monótona), y se declara así.
    for (const r of rows) expect(r.LIVE_REVERSIBLE.startsWith("NO"), `${r.REVEAL_ID}: LIVE_REVERSIBLE`).toBe(true);
  });

  it("los casos de transición son EXACTAMENTE los canónicos y cubren T1-T6, la relación y las políticas", () => {
    expect(dupes(transitions().map((r) => r.VIS_TRANSITION))).toEqual([]);
    expect(Object.fromEntries(transitions().map((r) => [r.VIS_TRANSITION, r.CASE]))).toEqual(CANONICAL_VIS_TRANSITIONS);
    expect(sorted(new Set(transitions().map((r) => r.CASE)))).toEqual(
      sorted(["T1", "T2", "T3", "T4", "T5", "T6", "RELATION", "POLICY"]),
    );
  });

  it("CHANGES y KEY de cada caso son los de la función de referencia (clave canónica completa)", () => {
    const bad: string[] = [];
    for (const r of transitions()) {
      const a = parseCtx(r.FROM);
      const b = parseCtx(r.TO);
      const changed = CANONICAL_PROJECTED_KEY.filter((f) => keyFor(a, [f]) !== keyFor(b, [f]));
      const declared = r.CHANGES === "—" ? [] : r.CHANGES.split(",").map((x) => clean(x));
      if (JSON.stringify(sorted(declared)) !== JSON.stringify(sorted(changed)))
        bad.push(`${r.VIS_TRANSITION}: CHANGES «${r.CHANGES}» ≠ «${changed.join(", ") || "—"}»`);
      const key = changed.length ? "DIFFERENT" : "SAME";
      if (r.KEY !== key) bad.push(`${r.VIS_TRANSITION}: KEY «${r.KEY}» ≠ «${key}»`);
    }
    expect(bad).toEqual([]);
  });

  it("T1/T2 · misma pareja antes y después de revelar el arma: composición y clave distintas, en los dos sentidos", () => {
    for (const id of ["vt.reveal", "vt.replay_seek_back", "vt.next_battle"]) {
      const from = ctxOf(id, "FROM");
      const to = ctxOf(id, "TO");
      expect(composeFor(from), `${id}: la proyección TIENE que cambiar`).not.toBe(composeFor(to));
      expect(keyFor(from, projectedKey()), `${id}: clave`).not.toBe(keyFor(to, projectedKey()));
      expect(serve([from, to], projectedKey()), `${id}: la entrada de antes no sobrevive`).toEqual([
        composeFor(from),
        composeFor(to),
      ]);
    }
  });

  it("T1-T6 · la caché con la clave declarada nunca sirve la composición de otro estado, visor, relación o política", () => {
    const bad: string[] = [];
    for (const r of transitions()) {
      const from = parseCtx(r.FROM);
      const to = parseCtx(r.TO);
      // En los dos órdenes y alternando (dos visores a la vez, T3).
      for (const steps of [
        [from, to],
        [to, from],
        [from, to, from, to],
      ]) {
        const served = serve(steps, projectedKey());
        steps.forEach((ctx, i) => {
          if (served[i] !== composeFor(ctx)) bad.push(`${r.VIS_TRANSITION}: paso ${i} servido de otro contexto`);
        });
      }
      const same = keyFor(from, projectedKey()) === keyFor(to, projectedKey());
      if (r.KEY === "DIFFERENT" && same) bad.push(`${r.VIS_TRANSITION}: misma clave`);
      if (r.KEY === "SAME" && !same) bad.push(`${r.VIS_TRANSITION}: el control SAME no comparte entrada`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("T4 · la composición privilegiada (antes o después de revelar) no se reutiliza para otro visor", () => {
    for (const id of ["vt.owner_to_anonymous", "vt.owner_revealed_to_anonymous"]) {
      const owner = ctxOf(id, "FROM");
      const anon = ctxOf(id, "TO");
      expect(composeFor(owner), `${id}: el dueño ve más`).not.toBe(composeFor(anon));
      expect(serve([owner, anon], projectedKey())[1], id).toBe(composeFor(anon));
    }
  });

  it("T6 · el replay público es, en cada estado, la proyección de un espectador: sólo lo PUBLIC y lo ya revelado", () => {
    const pub = new Set(tables(MATRIX, "DATA_ID").filter((r) => r.CLASSIFICATION === "PUBLIC").map((r) => r.DATA_ID));
    const hiddenUntilReveal = [...revealedData().values()].flat();
    const owner = ctxOf("vt.owner_to_public_replay", "FROM");
    for (const revealed of [[], ["reveal.weapon"]]) {
      const replay: VisCtx = { ...ctxOf("vt.owner_to_public_replay", "TO"), revealed };
      const live: VisCtx = { ...replay, viewer: "spectator", channel: "live_public" };
      const seen = composeFor(replay).split(":")[1].split(",").filter(Boolean);
      expect(seen.filter((d) => !pub.has(d)), "sólo PUBLIC").toEqual([]);
      if (!revealed.length) expect(seen.filter((d) => hiddenUntilReveal.includes(d)), "nada sin revelar").toEqual([]);
      expect(composeFor(replay)).toBe(composeFor(live));
      expect(serve([{ ...owner, revealed }, replay], projectedKey())[1]).toBe(composeFor(replay));
    }
    const src = tables(ADR2, "VIEW_PROFILE").find((p) => p.VIEW_PROFILE === "view.public_replay")?.EQUIPMENT_SOURCE;
    expect(src).toBe("proyección saneada del replay");
  });

  it("simulación global: dos contextos que ven cosas distintas nunca comparten clave (parejas × estados × casos)", () => {
    const ctxs: VisCtx[] = [];
    for (const r of tables(ADR2, "PAIR_CASE"))
      for (const revealed of [[], ["reveal.weapon"]])
        ctxs.push({ viewer: r.VIEWER, channel: r.CHANNEL, observed: r.OBSERVED, revealed, sp: "sp1", vp: "vp1" });
    for (const r of transitions()) ctxs.push(parseCtx(r.FROM), parseCtx(r.TO));
    const key = projectedKey();
    const comp = ctxs.map(composeFor);
    const keys = ctxs.map((c) => keyFor(c, key));
    const collisions: string[] = [];
    for (let i = 0; i < ctxs.length; i++)
      for (let j = i + 1; j < ctxs.length; j++)
        if (comp[i] !== comp[j] && keys[i] === keys[j])
          collisions.push(`${JSON.stringify(ctxs[i])} = ${JSON.stringify(ctxs[j])}`);
    expect(collisions.slice(0, 3)).toEqual([]);
    const served = serve(ctxs, key);
    expect(ctxs.filter((_, i) => served[i] !== comp[i]).length, "entradas servidas de otro contexto").toBe(0);
  });
});
