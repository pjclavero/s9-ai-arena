/**
 * OLA 2 · MC · GATE CATALOG_CONTRACT (P-2: «todo campo declarado sin comportamiento real se
 * implementa o se elimina»).
 *
 * Recorre el ESQUEMA (lo que un módulo puede declarar) y el CATÁLOGO (lo que declara) y
 * falla si:
 *   S1  un campo declarado no está clasificado en field-status.ts;
 *   S2  una entrada ACTIVE/VALIDATION_ONLY no existe ya en el esquema (tabla rancia);
 *   S3  un campo eliminado (REMOVE) sigue admitiéndose en el esquema;
 *   S4  una entrada que cuenta no trae la mutación con la que se demuestra;
 *   S5  la tabla de la UI (effect-status.ts) dice otra cosa que esta;
 *   S6  un arma resuelta no trae la vida del proyectil (el motor caería en la regla heredada);
 *   D1  un campo ACTIVE mutado NO cambia la batalla de sonda (= no tiene consumidor);
 *   D2  un campo VALIDATION_ONLY mutado no cambia el veredicto del validador, o SÍ cambia la
 *       batalla (estaría mal clasificado);
 *   D3  un metadato (nombre, descripción) cambia la batalla.
 * D1-D3 son diferenciales sobre una batalla real (catalog-probe.ts) que pasa por
 * resolveVehicle(): un campo que la frontera no copia, o que el motor no lee, da el mismo
 * digest y pone el gate en rojo.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { DATA_DIR, loadCatalog } from "./loadCatalog.js";
import { resolveVehicle } from "./resolve/index.js";
import { validateLoadout } from "./validator/index.js";
import { effectOf } from "./effect-status.js";
import { CATEGORY_FIELDS, COMMON_FIELDS, IDENTITY_FIELDS, REMOVED_FIELDS, fieldContract } from "./field-status.js";
import { loadoutWith, probeDigest } from "./catalog-probe.js";
import type { LoadoutInput, LoadoutModuleEntry, ModuleCategory, ModuleDefinition } from "./types.js";

const schema = JSON.parse(readFileSync(join(DATA_DIR, "..", "schema", "module.schema.json"), "utf8"));
const realCatalog = loadCatalog();
/**
 * Una categoría sin ninguna pieza real (utility hoy) se prueba con una pieza SINTÉTICA de
 * este test (no es contenido: no está en data/): sus campos comunes también tienen que
 * tener consumidor.
 */
const SYNTHETIC: ModuleDefinition[] = (schema.properties.category.enum as ModuleCategory[])
  .filter((cat) => !realCatalog.some((m) => m.category === cat))
  .map((cat) => ({ id: `${cat}.probe`, version: 1, category: cat, name: "sonda", massKg: 10, costCredits: 10, size: "S", hp: 10 }));
const catalog = [...realCatalog, ...SYNTHETIC];
const CATEGORIES = schema.properties.category.enum as ModuleCategory[];

// ------------------------------------------------------------------ campos declarados por el esquema

type Json = Record<string, any>;

/** Claves de `properties` con objetos anidados (power.x) y listas de objetos (slots[].x). */
function propsOf(node: Json | undefined, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, sub] of Object.entries((node?.properties ?? {}) as Json)) {
    if (sub === false) continue; // prohibido explícitamente (ver forbiddenIn)
    if (sub.properties && (sub.type === "object" || sub.type === undefined)) out.push(...propsOf(sub, `${prefix}${k}.`));
    else if (sub.type === "array" && sub.items?.type === "object") out.push(...propsOf(sub.items, `${prefix}${k}[].`));
    else out.push(`${prefix}${k}`);
  }
  return out;
}

/** Recorre allOf/if/then anidados de una categoría (p. ej. las variantes de sensorType). */
function thenProps(node: Json | undefined): string[] {
  if (!node) return [];
  const out = propsOf(node);
  for (const sub of (node.allOf ?? []) as Json[]) out.push(...thenProps(sub.then));
  return out;
}

const COMMON_DECLARED = propsOf(schema);

/** ¿Aplica la rama `if` de categoría a `cat`? (const, not-const y not-enum). */
function branchApplies(branch: Json, cat: ModuleCategory): boolean {
  const c = branch.if?.properties?.category;
  if (!c) return false;
  if (c.const !== undefined) return c.const === cat;
  if (c.not?.const !== undefined) return c.not.const !== cat;
  if (Array.isArray(c.not?.enum)) return !c.not.enum.includes(cat);
  return false;
}

/** Rutas que una rama aplicable PROHÍBE con el esquema `false`. */
function forbiddenIn(node: Json | undefined, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, sub] of Object.entries((node?.properties ?? {}) as Json)) {
    if (sub === false) out.push(`${prefix}${k}`);
    else if (sub && typeof sub === "object" && sub.properties) out.push(...forbiddenIn(sub, `${prefix}${k}.`));
  }
  return out;
}

function declaredFor(cat: ModuleCategory): string[] {
  const own: string[] = [];
  const forbidden = new Set<string>();
  for (const branch of schema.allOf as Json[]) {
    if (!branchApplies(branch, cat)) continue;
    own.push(...thenProps(branch.then));
    for (const f of forbiddenIn(branch.then)) forbidden.add(f);
  }
  return [...new Set([...COMMON_DECLARED, ...own])].filter((f) => !forbidden.has(f));
}

/** Campos que DECLARA un módulo concreto (mismas rutas que el esquema). */
function presentIn(def: ModuleDefinition): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(def as unknown as Json)) {
    if (k === "power" && v && typeof v === "object") for (const s of Object.keys(v)) out.push(`power.${s}`);
    else if (k === "slots" && Array.isArray(v)) for (const s of v) for (const sk of Object.keys(s)) out.push(`slots[].${sk}`);
    else out.push(k);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ mutación de un campo en una copia del catálogo

function getPath(def: Json, path: string): unknown {
  if (path.startsWith("power.")) return def.power?.[path.slice(6)];
  if (path.startsWith("slots[].")) return def.slots?.[0]?.[path.slice(8)];
  return def[path];
}

/** Copia del catálogo con `path` de `target` cambiado a `value` (en slots: la ranura pertinente). */
const SECTOR_CYCLE = ["front", "right", "rear", "left"];

function withField(cat: ModuleDefinition[], target: ModuleDefinition, path: string, value: unknown): ModuleDefinition[] {
  return cat.map((m) => {
    if (m !== target) return m;
    const c = structuredClone(m) as Json;
    if (path.startsWith("power.")) c.power = { ...(c.power ?? {}), [path.slice(6)]: value };
    else if (path.startsWith("slots[].")) {
      const key = path.slice(8);
      // Se muta la ranura que la sonda USA para ese dato (blindaje para sector; la del arma si no).
      const idx = Math.max(
        0,
        (c.slots as Json[]).findIndex((s) => (key === "sector" ? s.sector !== undefined : s.accepts.includes("weapon"))),
      );
      if (key === "sector") {
        // Todas las ranuras de blindaje (la sonda monta el blindaje en la que le toca): la
        // rotación de cada una desalinea el sector del módulo montado.
        c.slots = (c.slots as Json[]).map((s) =>
          s.sector === undefined ? s : { ...s, sector: (SECTOR_CYCLE[(SECTOR_CYCLE.indexOf(s.sector) + 1) % 4] as string) },
        );
      } else c.slots[idx] = { ...c.slots[idx], [key]: value };
    } else c[path] = value;
    return c as unknown as ModuleDefinition;
  });
}

/** Módulo de la categoría que declara el campo (el primero, orden estable del catálogo). */
function carrier(cat: ModuleCategory, path: string): ModuleDefinition | undefined {
  return catalog.find((m) => m.category === cat && presentIn(m).includes(path));
}

/** Una pieza de cada categoría que la sonda sabe montar (para metadatos y campos opcionales). */
function anyOf(cat: ModuleCategory): ModuleDefinition | undefined {
  return catalog.find((m) => m.category === cat);
}

const verdict = (cat: ModuleDefinition[], loadout: LoadoutInput): string =>
  JSON.stringify(
    validateLoadout(loadout, cat, 1000)
      .map((v) => `${v.code}:${v.slot ?? ""}:${v.moduleId ?? ""}`)
      .sort(),
  );

/**
 * Para maxPerVehicle hacen falta DOS copias: se añade al chasis de la sonda una ranura extra
 * («dup») que acepta la categoría y se monta la segunda copia (la munición, en un arma que
 * la acepte). Devuelve el catálogo con esa ranura y el loadout con la copia.
 */
function withDuplicate(
  cat: ModuleDefinition[],
  target: ModuleDefinition,
): { cat: ModuleDefinition[]; loadout: LoadoutInput } {
  const loadout = structuredClone(loadoutWith(target, cat));
  const tRef = `${target.id}@${target.version}`;
  let entry: LoadoutModuleEntry = { slot: "dup", moduleId: tRef };
  let accepts: ModuleCategory = target.category;
  if (target.category === "ammo") {
    const w = cat.find((m) => m.category === "weapon" && (m.acceptsAmmo ?? []).includes(target.id))!;
    entry = { slot: "dup", moduleId: `${w.id}@${w.version}`, ammo: tRef };
    accepts = "weapon";
  }
  loadout.modules.push(entry);
  const out = cat.map((m) =>
    `${m.id}@${m.version}` === loadout.chassis
      ? ({
          ...m,
          slots: [
            ...(m.slots ?? []),
            { id: "dup", accepts: [accepts], maxSize: "XL", ...(target.sector ? { sector: target.sector } : {}) },
          ],
        } as ModuleDefinition)
      : m,
  );
  return { cat: out, loadout };
}

beforeAll(async () => {
  await initPhysics();
});

// ------------------------------------------------------------------ S · estructura

describe("CATALOG_CONTRACT · S · el esquema y la tabla de campos coinciden", () => {
  it("S1 · todo campo declarado por el esquema, en cada categoría, está clasificado", () => {
    const missing: string[] = [];
    for (const cat of CATEGORIES)
      for (const f of declaredFor(cat))
        if (!IDENTITY_FIELDS.includes(f) && !fieldContract(cat, f)) missing.push(`${cat}.${f}`);
    expect(missing).toEqual([]);
  });

  it("S1 · todo campo presente en data/*.json está declarado y clasificado", () => {
    const bad: string[] = [];
    for (const m of catalog)
      for (const f of presentIn(m)) {
        if (IDENTITY_FIELDS.includes(f)) continue;
        if (!declaredFor(m.category).includes(f) || !fieldContract(m.category, f)) bad.push(`${m.id}@${m.version}.${f}`);
      }
    expect(bad).toEqual([]);
  });

  it("S2 · ninguna entrada que cuenta es rancia (todas existen en el esquema)", () => {
    const stale: string[] = [];
    for (const cat of CATEGORIES)
      for (const [f, c] of Object.entries(CATEGORY_FIELDS[cat]))
        if ((c.status === "ACTIVE" || c.status === "VALIDATION_ONLY") && !declaredFor(cat).includes(f))
          stale.push(`${cat}.${f}`);
    for (const f of Object.keys(COMMON_FIELDS))
      if (!CATEGORIES.some((cat) => declaredFor(cat).includes(f))) stale.push(`*.${f}`);
    expect(stale).toEqual([]);
  });

  it("S2 · no queda ningún campo FUTURE ni REMOVE declarado (FUTURE no se admite en un módulo)", () => {
    const bad: string[] = [];
    for (const cat of CATEGORIES)
      for (const f of declaredFor(cat)) {
        const c = fieldContract(cat, f);
        if (c && c.status !== "ACTIVE" && c.status !== "VALIDATION_ONLY") bad.push(`${cat}.${f}=${c.status}`);
      }
    expect(bad).toEqual([]);
  });

  it("S3 · un módulo con un campo eliminado (REMOVE) no valida contra el esquema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const [key, { category }] of Object.entries(REMOVED_FIELDS)) {
      const field = key.slice(category.length + 1);
      expect(declaredFor(category), `${key} sigue declarado`).not.toContain(field);
      const base =
        anyOf(category) ??
        ({ id: "utility.probe", version: 1, category, name: "x", massKg: 1, costCredits: 1, size: "S", hp: 1 } as Json);
      expect(validate(base), `control: ${base.id} debería validar`).toBe(true);
      const mutated = structuredClone(base) as Json;
      if (field.startsWith("slots[].")) mutated.slots[0][field.slice(8)] = { x: 0, y: 0 };
      else mutated[field] = field === "effect" ? "smoke" : 1;
      expect(validate(mutated), `${key} se admite todavía`).toBe(false);
    }
  });

  it("S3 · en un sensor, fovRad/rays sólo valen en lidar y errorM sólo en radar", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const radar = catalog.find((m) => m.category === "sensor" && m.sensorType === "radar")!;
    const lidar = catalog.find((m) => m.category === "sensor" && m.sensorType === "lidar")!;
    expect(validate(radar) && validate(lidar)).toBe(true);
    expect(validate({ ...radar, fovRad: 1 })).toBe(false);
    expect(validate({ ...radar, rays: 8 })).toBe(false);
    expect(validate({ ...lidar, errorM: 1 })).toBe(false);
    const { fovRad: _f, ...lidarSinFov } = lidar;
    expect(validate(lidarSinFov), "lidar sin fovRad caería en un valor por defecto oculto").toBe(false);
  });

  it("S4 · toda entrada ACTIVE / VALIDATION_ONLY trae su mutación y su consumidor", () => {
    const bad: string[] = [];
    const all = [
      ...Object.entries(COMMON_FIELDS).map(([f, c]) => [`*.${f}`, c] as const),
      ...CATEGORIES.flatMap((cat) => Object.entries(CATEGORY_FIELDS[cat]).map(([f, c]) => [`${cat}.${f}`, c] as const)),
    ];
    for (const [k, c] of all)
      if ((c.status === "ACTIVE" || c.status === "VALIDATION_ONLY") && (!c.perturb || !c.consumer)) bad.push(k);
    expect(bad).toEqual([]);
  });

  it("S5 · effect-status.ts (lo que ve la UI) coincide con esta tabla en todo campo del catálogo", () => {
    const map = { ACTIVE: "ACTIVE", VALIDATION_ONLY: "PARTIAL" } as const;
    const bad: string[] = [];
    for (const m of catalog)
      for (const f of presentIn(m)) {
        if (IDENTITY_FIELDS.includes(f) || f.startsWith("slots[].")) continue;
        const c = fieldContract(m.category, f)!;
        const ui = effectOf(m.category, f);
        if (!ui || ui.status !== map[c.status as keyof typeof map]) bad.push(`${m.category}.${f}: ${ui?.status} ≠ ${c.status}`);
      }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("S6 · toda arma resuelta trae projectileLifetimeTicks (nunca la regla heredada de 90)", () => {
    for (const w of catalog.filter((m) => m.category === "weapon")) {
      const spec = resolveVehicle(loadoutWith(w, catalog), catalog);
      const ws = spec.modules.find((m) => m.category === "weapon")!;
      expect(Number.isInteger(ws.projectileLifetimeTicks), `${w.id}@${w.version}`).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ D · consumo real (diferencial)

interface Case {
  cat: ModuleCategory;
  field: string;
  target: ModuleDefinition;
  injected: boolean;
}

/** Casos por (categoría, campo declarado). Sin portador ni `sample` ⇒ queda SIN PRUEBA (rojo). */
function cases(status: "ACTIVE" | "VALIDATION_ONLY"): { list: Case[]; uncovered: string[] } {
  const list: Case[] = [];
  const uncovered: string[] = [];
  for (const cat of CATEGORIES)
    for (const f of declaredFor(cat)) {
      const c = fieldContract(cat, f);
      if (!c || c.status !== status) continue;
      const t = carrier(cat, f);
      if (t) list.push({ cat, field: f, target: t, injected: false });
      else if (c.sample !== undefined && anyOf(cat)) list.push({ cat, field: f, target: anyOf(cat)!, injected: true });
      else uncovered.push(`${cat}.${f}`);
    }
  return { list, uncovered };
}

const baseDigests = new Map<string, string>();
function baseDigest(t: ModuleDefinition): string {
  const k = `${t.id}@${t.version}`;
  if (!baseDigests.has(k)) baseDigests.set(k, probeDigest(catalog, k));
  return baseDigests.get(k)!;
}

describe("CATALOG_CONTRACT · D1 · todo campo ACTIVE tiene consumidor en la simulación", () => {
  const { list, uncovered } = cases("ACTIVE");
  it("todo campo ACTIVE declarado, en TODA categoría, tiene caso (portador real o sample)", () => {
    expect(uncovered).toEqual([]);
  });
  for (const c of list) {
    it(`${c.cat}.${c.field} (${c.target.id}@${c.target.version}${c.injected ? ", inyectado" : ""}) cambia la batalla`, () => {
      const contract = fieldContract(c.cat, c.field)!;
      const before = c.injected ? undefined : getPath(c.target as unknown as Json, c.field);
      const after = contract.perturb!(c.injected ? contract.sample : before, c.target);
      expect(after, "la mutación no cambia el valor").not.toEqual(before);
      const mutated = withField(catalog, c.target, c.field, after);
      expect(probeDigest(mutated, `${c.target.id}@${c.target.version}`)).not.toBe(baseDigest(c.target));
    });
  }
});

describe("CATALOG_CONTRACT · D2 · todo campo VALIDATION_ONLY cambia el veredicto y NO la batalla", () => {
  const { list, uncovered } = cases("VALIDATION_ONLY");
  it("todo campo VALIDATION_ONLY declarado, en TODA categoría, tiene caso", () => {
    expect(uncovered).toEqual([]);
  });
  for (const c of list) {
    it(`${c.cat}.${c.field} (${c.target.id}@${c.target.version}${c.injected ? ", inyectado" : ""})`, () => {
      const contract = fieldContract(c.cat, c.field)!;
      const before = c.injected ? undefined : getPath(c.target as unknown as Json, c.field);
      const after = contract.perturb!(c.injected ? contract.sample : before, c.target);
      expect(after, "la mutación no cambia el valor").not.toEqual(before);
      // Mismo loadout (construido con el catálogo SIN mutar) contra los dos catálogos.
      const dup = c.field === "maxPerVehicle" ? withDuplicate(catalog, c.target) : null;
      const baseCat = dup ? dup.cat : catalog;
      const loadout = dup ? dup.loadout : loadoutWith(c.target, catalog);
      const mutated = withField(baseCat, baseCat[catalog.indexOf(c.target)], c.field, after);
      expect(verdict(mutated, loadout), "el validador no lo usa").not.toBe(verdict(baseCat, loadout));
      // ...y la simulación no lo lee: mismo loadout, catálogo mutado ⇒ misma batalla.
      if (!dup) {
        const ref = `${c.target.id}@${c.target.version}`;
        expect(probeDigest(mutated, ref, loadout), "un campo de validación cambia la batalla").toBe(
          baseDigest(c.target),
        );
      }
    });
  }
});

describe("CATALOG_CONTRACT · D3 · los metadatos no cambian la batalla", () => {
  for (const cat of CATEGORIES) {
    const t = anyOf(cat);
    if (!t) continue;
    it(`${cat}: nombre y descripción (${t.id}@${t.version})`, () => {
      const both = catalog.map((m) => (m === t ? { ...m, name: "otro nombre", description: "otra" } : m));
      expect(probeDigest(both, `${t.id}@${t.version}`)).toBe(baseDigest(t));
    });
  }
});
