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
 *   D1  un campo ACTIVE mutado NO cambia la magnitud de efecto observable que declara
 *       (`observes`: daño aplicado, cinemática, proyectiles, minas, eventos, radio…) en la
 *       batalla de sonda (= no tiene consumidor real), o (ronda 4, P2-1c) no cambia NINGUNO
 *       de los canales de comportamiento que GOBIERNA (`governs`): si sólo cambia su propio
 *       estado (energía, estado de módulo, eventos), su consumidor no limita nada;
 *   D2  un campo VALIDATION_ONLY mutado no cambia el veredicto del validador, o SÍ cambia la
 *       batalla (estaría mal clasificado);
 *   D3  un metadato (nombre, descripción) cambia la batalla.
 *   D0  (ronda 3, P2-1b) la propia SONDA registra una copia de la configuración: D0a, dos
 *       sondas con specs distintos de dinámica idéntica (reservas iniciales trasladadas donde
 *       nunca limitan) dan canales distintos; D0b, falsear el registro de daño y el `damage`
 *       de los eventos DESPUÉS de aplicarse cambia algún canal.
 *   D4  (ronda 4) con el CONSUMIDOR de un campo anulado en el test (se interpone la función
 *       del motor que lo lee: devuelve el valor por defecto o deja de limitar; el código de
 *       producción no se toca), la sonda NO cambia ningún canal que el campo gobierna: la
 *       declaración `governs` estaría vacía o la sonda no vería el efecto.
 * D1-D3 son diferenciales sobre una batalla real (catalog-probe.ts) que pasa por
 * resolveVehicle(). G1: D1 compara CANALES DE EFECTO (listas blancas de magnitudes), no el
 * hash de estado: un campo que la frontera no copia, que el motor no lee, o que el motor
 * sólo COPIA en su estado sin que ninguna magnitud observable cambie, pone el gate en rojo.
 * D2/D3 (negativas) siguen comparando la traza COMPLETA (canales + observaciones + hash).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { PhysicsWorld, initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { Battle } from "../../apps/arena-engine/src/sim/battle.js";
import { Vehicle, type VehicleSpec } from "../../apps/arena-engine/src/sim/vehicle.js";
import { DATA_DIR, loadCatalog } from "./loadCatalog.js";
import { resolveVehicle } from "./resolve/index.js";
import { validateLoadout } from "./validator/index.js";
import { effectOf } from "./effect-status.js";
import {
  BEHAVIOR_CHANNELS,
  CATEGORY_FIELDS,
  COMMON_FIELDS,
  IDENTITY_FIELDS,
  PROBE_CHANNELS,
  REMOVED_FIELDS,
  fieldContract,
  ownStateChannels,
  type ProbeChannel,
} from "./field-status.js";
import { PROBE_BASE, loadoutWith, probeTrace, type ProbeFacts, type ProbeTrace } from "./catalog-probe.js";
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
  .map((cat) => ({
    id: `${cat}.probe`,
    version: 1,
    category: cat,
    name: "sonda",
    // Ronda 4 · masa comparable a la del arma: una pieza sin acción propia sólo cuenta por el
    // daño de módulo que absorbe mientras vive (sorteo ponderado por masa, damage.ts); con
    // 10 kg casi nunca lo recibía.
    massKg: 150,
    costCredits: 10,
    size: "S",
    // G1.2 · hp por encima de un impacto de módulo (cañón: ~16 de daño de módulo por
    // impacto): con hp 10 cualquier impacto lo destruía con o sin la mutación (×0,25) y el
    // hp no podía tener efecto observable (antes «pasaba» por el hp vivo copiado al estado).
    hp: 100,
  }));
const catalog = [...realCatalog, ...SYNTHETIC];
const CATEGORIES = schema.properties.category.enum as ModuleCategory[];

// ------------------------------------------------------------------ campos declarados por el esquema

type Json = Record<string, any>;

/** Claves de `properties` con objetos anidados (power.x) y listas de objetos (slots[].x). */
function propsOf(node: Json | undefined, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, sub] of Object.entries((node?.properties ?? {}) as Json)) {
    if (sub === false) continue; // prohibido explícitamente (ver forbiddenIn)
    if (sub.properties && (sub.type === "object" || sub.type === undefined))
      out.push(...propsOf(sub, `${prefix}${k}.`));
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
    else if (k === "slots" && Array.isArray(v))
      for (const s of v)
        for (const [sk, sv] of Object.entries(s as Json)) {
          // Objetos anidados de la ranura (p. ej. `mount`, D-B2): rutas `slots[].mount.x`, como el esquema.
          if (sv && typeof sv === "object" && !Array.isArray(sv))
            for (const k2 of Object.keys(sv)) out.push(`slots[].${sk}.${k2}`);
          else out.push(`slots[].${sk}`);
        }
    else out.push(k);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ mutación de un campo en una copia del catálogo

function getPath(def: Json, path: string): unknown {
  if (path.startsWith("power.")) return def.power?.[path.slice(6)];
  if (path.startsWith("slots[].")) {
    const [key, sub] = path.slice(8).split(".");
    // La ranura del arma para los datos de montura (las demás no la llevan).
    const s = sub ? (def.slots as Json[] | undefined)?.find((x) => x[key] !== undefined) : def.slots?.[0];
    return sub ? s?.[key]?.[sub] : s?.[key];
  }
  return def[path];
}

/** Copia del catálogo con `path` de `target` cambiado a `value` (en slots: la ranura pertinente). */
const SECTOR_CYCLE = ["front", "right", "rear", "left"];

function withField(
  cat: ModuleDefinition[],
  target: ModuleDefinition,
  path: string,
  value: unknown,
): ModuleDefinition[] {
  return cat.map((m) => {
    if (m !== target) return m;
    const c = structuredClone(m) as Json;
    if (path.startsWith("power.")) c.power = { ...(c.power ?? {}), [path.slice(6)]: value };
    else if (path.startsWith("slots[].")) {
      const key = path.slice(8);
      // Se muta la ranura que la sonda USA para ese dato (blindaje para sector; la del arma si no).
      const idx = Math.max(
        0,
        (c.slots as Json[]).findIndex((s) =>
          key === "sector" ? s.sector !== undefined : s.accepts.includes("weapon"),
        ),
      );
      if (key === "sector") {
        // Todas las ranuras de blindaje (la sonda monta el blindaje en la que le toca): la
        // rotación de cada una desalinea el sector del módulo montado.
        c.slots = (c.slots as Json[]).map((s) =>
          s.sector === undefined
            ? s
            : { ...s, sector: SECTOR_CYCLE[(SECTOR_CYCLE.indexOf(s.sector) + 1) % 4] as string },
        );
      } else if (key.includes(".")) {
        const [k1, k2] = key.split(".");
        c.slots[idx] = { ...c.slots[idx], [k1]: { ...(c.slots[idx][k1] ?? {}), [k2]: value } };
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
        if (!declaredFor(m.category).includes(f) || !fieldContract(m.category, f))
          bad.push(`${m.id}@${m.version}.${f}`);
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

  it("S4 · toda entrada ACTIVE declara al menos un canal de efecto observable, y sólo canales que la sonda mide", () => {
    const bad: string[] = [];
    const all = [
      ...Object.entries(COMMON_FIELDS).map(([f, c]) => [`*.${f}`, c] as const),
      ...CATEGORIES.flatMap((cat) => Object.entries(CATEGORY_FIELDS[cat]).map(([f, c]) => [`${cat}.${f}`, c] as const)),
    ];
    for (const [k, c] of all) {
      if (c.status !== "ACTIVE") {
        if (c.observes !== undefined) bad.push(`${k}: ${c.status} con observes`);
        continue;
      }
      if (!c.observes || c.observes.length === 0) bad.push(`${k}: sin observes`);
      for (const ch of c.observes ?? [])
        if (!(PROBE_CHANNELS as readonly string[]).includes(ch)) bad.push(`${k}: canal ${ch} desconocido`);
    }
    expect(bad).toEqual([]);
  });

  it("S4 · toda entrada ACTIVE GOBIERNA algún canal de comportamiento, nunca contabilidad ni su estado propio (ronda 4)", () => {
    const bad: string[] = [];
    const all = [
      ...Object.entries(COMMON_FIELDS).map(([f, c]) => ["*", f, c] as const),
      ...CATEGORIES.flatMap((cat) => Object.entries(CATEGORY_FIELDS[cat]).map(([f, c]) => [cat, f, c] as const)),
    ];
    for (const [cat, f, c] of all) {
      const k = `${cat}.${f}`;
      if (c.status !== "ACTIVE") {
        if (c.governs !== undefined) bad.push(`${k}: ${c.status} con governs`);
        continue;
      }
      if (!c.governs || c.governs.length === 0) bad.push(`${k}: sin governs`);
      const own = cat === "*" ? [] : ownStateChannels(cat, f);
      for (const ch of c.governs ?? []) {
        if (!BEHAVIOR_CHANNELS.includes(ch)) bad.push(`${k}: gobierna ${ch}, que es contabilidad o declaración`);
        if (own.includes(ch)) bad.push(`${k}: gobierna ${ch}, donde se registra su propio estado`);
      }
    }
    // Las categorías con entrada común: el estado propio se comprueba por categoría.
    for (const cat of CATEGORIES)
      for (const f of declaredFor(cat)) {
        const c = fieldContract(cat, f);
        if (c?.status !== "ACTIVE") continue;
        for (const ch of c.governs ?? [])
          if (ownStateChannels(cat, f).includes(ch)) bad.push(`${cat}.${f}: gobierna ${ch} (estado propio)`);
      }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("S5 · effect-status.ts (lo que ve la UI) coincide con esta tabla en todo campo del catálogo", () => {
    const map = { ACTIVE: "ACTIVE", VALIDATION_ONLY: "PARTIAL" } as const;
    const bad: string[] = [];
    for (const m of catalog)
      for (const f of presentIn(m)) {
        if (IDENTITY_FIELDS.includes(f) || f.startsWith("slots[].")) continue;
        const c = fieldContract(m.category, f)!;
        const ui = effectOf(m.category, f);
        if (!ui || ui.status !== map[c.status as keyof typeof map])
          bad.push(`${m.category}.${f}: ${ui?.status} ≠ ${c.status}`);
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
      const pinned = c.carrier ? catalog.find((m) => `${m.id}@${m.version}` === c.carrier) : undefined;
      if (c.carrier && (!pinned || pinned.category !== cat || !presentIn(pinned).includes(f))) {
        uncovered.push(`${cat}.${f} (portador ${c.carrier} inexistente o sin el campo)`);
        continue;
      }
      const t = pinned ?? carrier(cat, f);
      if (t) list.push({ cat, field: f, target: t, injected: false });
      else if (c.sample !== undefined && anyOf(cat)) list.push({ cat, field: f, target: anyOf(cat)!, injected: true });
      else uncovered.push(`${cat}.${f}`);
    }
  return { list, uncovered };
}

const baseTraces = new Map<string, ProbeTrace>();
function baseTrace(t: ModuleDefinition): ProbeTrace {
  const k = `${t.id}@${t.version}`;
  if (!baseTraces.has(k)) baseTraces.set(k, probeTrace(catalog, k));
  return baseTraces.get(k)!;
}

/** Canales de efecto cuya traza difiere entre dos batallas de sonda. */
const changedChannels = (a: ProbeTrace, b: ProbeTrace): ProbeChannel[] =>
  PROBE_CHANNELS.filter((ch) => a.channels[ch] !== b.channels[ch]);

/** Un caso ACTIVE con su campo mutado: catálogo, loadout de E y traza (una vez por caso). */
interface Mutated {
  catalog: ModuleDefinition[];
  loadout: LoadoutInput | undefined;
  trace: ProbeTrace;
}
const mutatedTraces = new Map<string, Mutated>();
const refOf = (m: ModuleDefinition) => `${m.id}@${m.version}`;
function mutatedCase(c: Case): Mutated {
  const k = `${c.cat}.${c.field}@${refOf(c.target)}`;
  const hit = mutatedTraces.get(k);
  if (hit) return hit;
  const contract = fieldContract(c.cat, c.field)!;
  const before = c.injected ? undefined : getPath(c.target as unknown as Json, c.field);
  const after = contract.perturb!(c.injected ? contract.sample : before, c.target);
  expect(after, "la mutación no cambia el valor").not.toEqual(before);
  const mutated = withField(catalog, c.target, c.field, after);
  // `baseLoadout`: el loadout construido con el catálogo SIN mutar (es el de baseTrace).
  const loadout = contract.baseLoadout ? loadoutWith(c.target, catalog) : undefined;
  const out = { catalog: mutated, loadout, trace: probeTrace(mutated, refOf(c.target), loadout) };
  mutatedTraces.set(k, out);
  return out;
}
const caseName = (c: Case) => `${c.cat}.${c.field} (${refOf(c.target)}${c.injected ? ", inyectado" : ""})`;

describe("CATALOG_CONTRACT · D1 · todo campo ACTIVE tiene consumidor en la simulación", () => {
  const { list, uncovered } = cases("ACTIVE");
  it("todo campo ACTIVE declarado, en TODA categoría, tiene caso (portador real o sample)", () => {
    expect(uncovered).toEqual([]);
  });
  for (const c of list) {
    const contract = fieldContract(c.cat, c.field)!;
    const declared = contract.observes ?? [];
    const governs = contract.governs ?? [];
    it(`${caseName(c)} cambia [${declared.join(", ")}]`, () => {
      expect(declared.length, "entrada ACTIVE sin canal de efecto declarado").toBeGreaterThan(0);
      const changed = changedChannels(mutatedCase(c).trace, baseTrace(c.target));
      // Todos los canales declarados deben cambiar. El mensaje lista los que SÍ cambiaron.
      expect(
        declared.filter((ch) => !changed.includes(ch)),
        `sin efecto observable en lo declarado; canales que cambian: [${changed.join(", ")}]`,
      ).toEqual([]);
    });
    // Ronda 4 (P2-1c) · al menos UN canal de comportamiento gobernado cambia. Si sólo cambian
    // la contabilidad, las declaraciones o el estado propio del campo, su consumidor no limita.
    it(`${caseName(c)} gobierna [${governs.join(", ")}]`, () => {
      expect(governs.length, "entrada ACTIVE sin canal gobernado").toBeGreaterThan(0);
      const changed = changedChannels(mutatedCase(c).trace, baseTrace(c.target));
      expect(
        governs.filter((ch) => changed.includes(ch)),
        `ningún canal gobernado cambia: sólo cambia estado propio o declaraciones [${changed.join(", ")}]`,
      ).not.toEqual([]);
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
        expect(probeTrace(mutated, ref, loadout).full, "un campo de validación cambia la batalla").toBe(
          baseTrace(c.target).full,
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
      expect(probeTrace(both, `${t.id}@${t.version}`).full).toBe(baseTrace(t).full);
    });
  }
});

// ------------------------------------------------------------------ D0 · la sonda no registra copias

/**
 * Ronda 3 (P2-1b, cerrado como CLASE) · ningún canal de la sonda puede registrar un valor cuyo
 * origen sea una COPIA de la configuración (un valor inicial copiado del spec, o el de un
 * registro interno que refleje lo calculado sin haberlo aplicado). Dos defensas diferenciales,
 * calibradas con los mutantes P1-P6 de scripts/hardening/g1-mutants.py (cada uno reintroduce
 * en la sonda un canal que copia, y muere aquí):
 *
 * D0a · TRASLACIÓN de reservas iniciales donde nunca limitan. Si una reserva no llega nunca
 *   a su límite en la batalla base, desplazar su valor inicial deja la dinámica IDÉNTICA:
 *     - casco +1000 en un vehículo que no muere (la muerte es hp ≤ 0; nada más lo lee en la
 *       sonda: el desempate por casco sólo actúa al agotar el tiempo, que es 100 000);
 *     - capacidad de energía +500 si la energía nunca baja de 2×coste de acción + 5: arranca
 *       llena y el tope y el suelo se trasladan igual (e+K), así que cada gasto y cada recarga
 *       ocurren igual;
 *     - munición +1000 / cargas +1000 si nunca se agotan;
 *     - hp ×10 de un módulo que nadie toca (su estado es hp/hpMáx = 1 en los dos casos).
 *   Un canal que registre un NIVEL (copia del valor inicial) cambia; uno que registre flujos,
 *   eventos o posiciones, no. El test exige además que se haya trasladado algo de cada clase
 *   (casco, energía, hp de módulo): no puede pasar en vacío.
 * D0b · REGISTRO FALSEADO después de aplicarse: el registro de daño (damageRecordsOfLastTick)
 *   y el `damage` de hit_taken/hit_dealt (el `effective` del registro) se multiplican tras
 *   aplicar el daño al estado. El estado no cambia y los bots de la sonda no leen esos
 *   importes, así que la dinámica es idéntica: ningún canal puede cambiar. Uno que lea el
 *   registro, cambia.
 * Sujetos: el chasis de la sonda (D sin módulos: muere en la durabilidad) y su arma.
 */
const D0_SUBJECTS = [PROBE_BASE.chassis, PROBE_BASE.modules.find((m) => m.slot === "turret_main")!.moduleId];

function shiftReserves(facts: ProbeFacts, applied: string[]) {
  return (key: string, spec: VehicleSpec): VehicleSpec => {
    const f = facts[key];
    if (!f) throw new Error(`D0a: sin hechos de ${key}`);
    const s = spec as any;
    if (!f.died) {
      s.hullHp += 1000;
      applied.push(`${key}:hull`);
    }
    const power = s.modules.find((m: any) => m.category === "power");
    if (power && !f.energyShort) {
      power.capacityEU = (power.capacityEU ?? 0) + 500;
      applied.push(`${key}:energy`);
    }
    for (const m of s.modules) {
      if (m.category === "ammo" && !f.ammoOut && typeof m.rounds === "number") {
        m.rounds += 1000;
        applied.push(`${key}:${m.slot}:rounds`);
      }
      if (m.category === "mine" && !f.chargesOut && typeof m.charges === "number") {
        m.charges += 1000;
        applied.push(`${key}:${m.slot}:charges`);
      }
      if (!f.hitSlots.includes(m.slot)) {
        m.hp *= 10;
        applied.push(`${key}:${m.slot}:hp`);
      }
    }
    return spec;
  };
}

describe("CATALOG_CONTRACT · D0 · ningún canal de la sonda registra una COPIA de la configuración", () => {
  for (const subject of D0_SUBJECTS) {
    it(`D0a · ${subject}: reservas iniciales trasladadas donde nunca limitan ⇒ ningún canal cambia`, () => {
      const base = probeTrace(catalog, subject);
      const applied: string[] = [];
      const shifted = probeTrace(catalog, subject, undefined, { tweakSpec: shiftReserves(base.facts, applied) });
      for (const kind of [":hull", ":energy", ":hp"])
        expect(
          applied.some((a) => a.endsWith(kind)),
          `D0a en vacío: no se trasladó ninguna reserva «${kind}»`,
        ).toBe(true);
      expect(
        changedChannels(shifted, base),
        `canales que copian la configuración (trasladado: ${applied.join(" ")})`,
      ).toEqual([]);
    });

    it(`D0b · ${subject}: registro de daño falseado DESPUÉS de aplicarse ⇒ ningún canal cambia`, () => {
      const proto = Battle.prototype as any;
      const emit0 = proto.emit;
      const records0 = proto.damageRecordsOfLastTick;
      const forge = (x: unknown) => (typeof x === "number" ? x * 7 + 1 : x);
      let forgedEvents = 0;
      let forgedRecords = 0;
      proto.emit = function (ev: any, to?: string) {
        if (ev && typeof ev.damage === "number") {
          forgedEvents++;
          ev = { ...ev, damage: forge(ev.damage) };
        }
        return emit0.call(this, ev, to);
      };
      proto.damageRecordsOfLastTick = function () {
        return records0.call(this).map((r: any) => {
          forgedRecords++;
          return {
            ...r,
            base: forge(r.base),
            reduction: forge(r.reduction),
            absorbed: forge(r.absorbed),
            effective: forge(r.effective),
            hull: forge(r.hull),
            moduleDamage: forge(r.moduleDamage),
          };
        });
      };
      let forged: ProbeTrace;
      try {
        forged = probeTrace(catalog, subject);
      } finally {
        proto.emit = emit0;
        proto.damageRecordsOfLastTick = records0;
      }
      expect(forgedEvents, "D0b en vacío: ningún evento con importe de daño").toBeGreaterThan(0);
      // `forgedRecords` sólo cuenta si la sonda LEE el registro (la sonda correcta no lo lee).
      expect(
        changedChannels(forged!, probeTrace(catalog, subject)),
        `registro leído (${forgedRecords} registros)`,
      ).toEqual([]);
    });
  }
});

// ------------------------------------------------------------------ D4 · ablación de consumidores

/**
 * Ronda 4 (P2-1c, cerrado como CLASE «estado sin consumidor») · Defensa estructural contra una
 * declaración `governs` vacía. Para cada campo ACTIVE se ANULA en el test el consumidor que lo
 * lee en el motor, sin tocar el código de producción: se interpone la función que lo lee
 * (método de Vehicle, Battle o PhysicsWorld) para que devuelva el valor por defecto o deje de
 * limitar. Con el campo MUTADO (el escenario de su D1), la sonda con el consumidor anulado
 * tiene que diferir de la normal en al menos un canal que el campo GOBIERNA. Si no difiere,
 * la sonda no ve el efecto de ese consumidor en lo declarado: la declaración no vale.
 *
 * Cada ablación es una interposición que se deshace al terminar (try/finally). Las que
 * modifican entidades vivas (proyectiles, minas, mensajes, cooldowns) lo hacen ANTES de que
 * el motor las consuma en el tick, igual que lo haría el consumidor con otro valor.
 */
type Restore = () => void;
const VP = Vehicle.prototype as any;
const BP = Battle.prototype as any;
const PP = PhysicsWorld.prototype as any;
function patch(obj: any, name: string, make: (orig: (...a: any[]) => any) => (...a: any[]) => any): Restore {
  const orig = obj[name];
  if (typeof orig !== "function") throw new Error(`ablación: ${name} no es un método`);
  obj[name] = make(orig);
  return () => {
    obj[name] = orig;
  };
}
/** Ejecuta `pre(this, args)` y luego el método original. */
const before = (obj: any, name: string, pre: (self: any, args: any[]) => void): Restore =>
  patch(
    obj,
    name,
    (orig) =>
      function (this: any, ...args: any[]) {
        pre(this, args);
        return orig.apply(this, args);
      },
  );
const modulesOfCat = (v: any, cat: string): any[] =>
  [...v.modules.values()].filter((m: any) => m.spec.category === cat);
/** Proyectiles que el motor ve por PRIMERA vez (recién disparados) en resolveProjectiles. */
function onNewProjectiles(fn: (self: any, p: any) => void): Restore {
  const seen = new Set<string>();
  return before(BP, "resolveProjectiles", (self) => {
    for (const p of self.projectiles) {
      const k = `${self.config.battleId}:${p.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      fn(self, p);
    }
  });
}
/** Sustituye datos del spec de cada sensor TAL Y COMO lo lee buildObservation (activeModulesOf). */
const sensorSees = (override: Record<string, unknown>): Restore =>
  patch(
    VP,
    "activeModulesOf",
    (orig) =>
      function (this: any, cat: string) {
        const r = orig.call(this, cat);
        return cat !== "sensor" ? r : r.map((m: any) => ({ ...m, spec: { ...m.spec, ...override } }));
      },
  );
/** Envuelve damageVehicle con un antes y un después sobre el vehículo dañado. */
function aroundDamage(pre: (target: any, args: any[]) => unknown, post: (target: any, saved: any) => void): Restore {
  return patch(
    BP,
    "damageVehicle",
    (orig) =>
      function (this: any, ...args: any[]) {
        const saved = pre(args[0], args);
        try {
          return orig.apply(this, args);
        } finally {
          post(args[0], saved);
        }
      },
  );
}

interface Ablation {
  /** Consumidor anulado y cómo. */
  readonly consumer: string;
  /** Campos cuyo consumidor es éste: «categoría.campo» o «*.campo» (común). */
  readonly fields: readonly string[];
  /** Instala la interposición para el caso `c` (algunas se limitan a su categoría). */
  readonly install: (c: Case) => Restore;
}

const ABLATIONS: Readonly<Record<string, Ablation>> = {
  ENERGY_LIMIT: {
    consumer: "combat.ts canFire / canDeployMine (no_energy): la energía se repone a 1e9 tras tickEnergy y nunca falta",
    fields: ["power.capacityEU", "power.generationEUs", "*.power.passiveEUs", "*.power.perActionEU"],
    install: () =>
      patch(
        VP,
        "tickEnergy",
        (orig) =>
          function (this: any, dt: number) {
            orig.call(this, dt);
            this.energyEU = 1e9;
          },
      ),
  },
  MOVEMENT_CAPS: {
    consumer: "vehicle.ts movementCaps: prestaciones fijas (6 m/s, 4 m/s², 1 rad/s), sin módulo, estado ni masa",
    fields: [
      "*.massKg",
      "movement.maxSpeedMs",
      "movement.accelerationMs2",
      "movement.turnRateRads",
      "movement.ratedLoadKg",
    ],
    install: () => patch(VP, "movementCaps", () => () => ({ maxSpeedMs: 6, accelerationMs2: 4, turnRateRads: 1 })),
  },
  MODULE_STATE: {
    consumer:
      "vehicle.ts stateOf, SÓLO para los módulos de la categoría del caso: ignora el hp (operativo salvo apagado); lo leen performanceOf / activeModulesOf / canFire / canDeployMine / validateRadio",
    fields: ["movement.hp", "power.hp", "sensor.hp", "weapon.hp", "mine.hp", "radio.hp"],
    install: (c) =>
      patch(
        VP,
        "stateOf",
        (orig) =>
          function (this: any, slot: string) {
            const m = this.modules.get(slot);
            if (!m || m.spec.category !== c.cat) return orig.call(this, slot);
            return m.offline ? "offline" : "operational";
          },
      ),
  },
  MODULE_SOAK: {
    consumer: "damage.ts resolveDamage (candidatos con hp > 0): un módulo destruido sigue absorbiendo daño de módulo",
    fields: ["ammo.hp", "utility.hp"],
    install: () =>
      aroundDamage(
        (t) => {
          const revived = [...t.modules.values()].filter((m: any) => m.hp <= 0 && m.spec.category !== "armor");
          for (const m of revived) m.hp = 1e-9;
          return revived;
        },
        (_t, revived: any[]) => {
          for (const m of revived) if (m.hp <= 1e-9) m.hp = 0;
        },
      ),
  },
  ARMOR_OFF: {
    consumer: "damage.ts resolveDamage (armor[sector], armorActive, resist): el vehículo dañado no tiene blindaje",
    fields: ["armor.hp", "armor.sector", "armor.reduction"],
    install: () =>
      aroundDamage(
        (t) => {
          const saved = t.armor;
          t.armor = Object.create(null);
          return saved;
        },
        (t, saved) => {
          t.armor = saved;
        },
      ),
  },
  HULL_DEATH: {
    consumer: "damage.ts resolveDamage (killed = hullHp ≤ 0) → onKill: el casco nunca llega a 0 (nadie muere)",
    fields: ["chassis.hullHp"],
    install: () =>
      aroundDamage(
        (t) => {
          t.hullHp += 1e9;
        },
        (t) => {
          t.hullHp -= 1e9;
        },
      ),
  },
  VEHICLE_RADIUS: {
    consumer: "physics.ts addVehicle: colisionador de radio fijo 1,6 m (boca del arma y perímetro siguen con el spec)",
    fields: ["chassis.radiusM"],
    install: () =>
      patch(
        PP,
        "addVehicle",
        (orig) =>
          function (this: any, id: string, pos: unknown, heading: number, _r: number, mass: number) {
            return orig.call(this, id, pos, heading, 1.6, mass);
          },
      ),
  },
  MOUNT_LOOKUP: {
    consumer:
      "vehicle.ts mountOf(slot): si la ranura no tiene montura, devuelve la primera del chasis (no busca por id)",
    fields: ["chassis.slots[].id"],
    install: () =>
      patch(
        VP,
        "mountOf",
        (orig) =>
          function (this: any, slot: string) {
            return orig.call(this, slot) ?? Object.values(this.spec.turretMounts ?? {})[0];
          },
      ),
  },
  TURRET_RATE: {
    consumer: "vehicle.ts turretRate: tasa fija de 3 rad/s",
    fields: ["chassis.slots[].mount.turretRateRads"],
    install: () => patch(VP, "turretRate", () => () => 3),
  },
  TURRET_ARC: {
    consumer: "vehicle.ts mountArcOf (lo leen turretArc → stepTurret y canFire): arco completo, no limita",
    fields: ["chassis.slots[].mount.turretArcRad"],
    install: () => patch(VP, "mountArcOf", () => () => Math.PI * 2),
  },
  COOLDOWN: {
    consumer: "combat.ts canFire / canDeployMine (cooldown): cooldownUntilTick a 0 antes de resolver los disparos",
    fields: ["weapon.cooldownTicks", "mine.cooldownTicks"],
    install: () =>
      before(BP, "resolveFiring", (self) => {
        for (const v of self.vehicles) for (const m of v.modules.values()) m.cooldownUntilTick = 0;
      }),
  },
  AMMO_STOCK: {
    consumer: "combat.ts canFire / ammoFor (no_ammo): la munición se repone antes de resolver los disparos",
    fields: ["ammo.rounds"],
    install: () =>
      before(BP, "resolveFiring", (self) => {
        for (const v of self.vehicles) for (const m of modulesOfCat(v, "ammo")) m.ammo = 1e6;
      }),
  },
  AMMO_COMPAT: {
    consumer: "combat.ts ammoFor (acceptsAmmo): el arma acepta cualquier munición montada",
    fields: ["weapon.acceptsAmmo"],
    install: () =>
      before(BP, "resolveFiring", (self) => {
        for (const v of self.vehicles) {
          const all = modulesOfCat(v, "ammo").map((a: any) => a.spec.moduleId.split("@")[0]);
          for (const w of modulesOfCat(v, "weapon")) w.spec.acceptsAmmo = all;
        }
      }),
  },
  MINE_CHARGES: {
    consumer: "combat.ts canDeployMine (no_charges): las cargas se reponen antes de resolver las siembras",
    fields: ["mine.charges"],
    install: () =>
      before(BP, "resolveFiring", (self) => {
        for (const v of self.vehicles) for (const m of modulesOfCat(v, "mine")) m.charges = 1e6;
      }),
  },
  PROJECTILE_RANGE: {
    consumer: "battle.ts resolveProjectiles (ttlTicks = alcance): ningún proyectil caduca",
    fields: ["weapon.rangeM"],
    install: () =>
      before(BP, "resolveProjectiles", (self) => {
        for (const p of self.projectiles) p.ttlTicks = 1e6;
      }),
  },
  PROJECTILE_SPEED: {
    consumer: "combat.ts fire (velocidad): todo proyectil nuevo vuela a 100 m/s (el valor por defecto)",
    fields: ["weapon.projectileSpeedMs"],
    install: () =>
      onNewProjectiles((_s, p) => {
        const k = 100 / Math.hypot(p.velocity.x, p.velocity.y);
        p.velocity = { x: p.velocity.x * k, y: p.velocity.y * k };
      }),
  },
  PROJECTILE_SPREAD: {
    consumer: "combat.ts fire (dispersión): todo proyectil nuevo sale según la torreta, sin dispersión",
    fields: ["weapon.spreadRad"],
    install: () =>
      onNewProjectiles((self, p) => {
        const owner = self.vehicles.find((v: any) => v.id === p.ownerId);
        const speed = Math.hypot(p.velocity.x, p.velocity.y);
        p.velocity = { x: Math.cos(owner.turretHeading) * speed, y: Math.sin(owner.turretHeading) * speed };
      }),
  },
  DIRECT_DAMAGE: {
    consumer: "battle.ts damageVehicle (impacto directo de proyectil): importe fijo de 20",
    fields: ["weapon.damage", "ammo.damageMultiplier"],
    install: () =>
      before(BP, "damageVehicle", (_s, args) => {
        if (args[7] === "projectile") args[1] = 20;
      }),
  },
  BLAST_DAMAGE: {
    consumer: "battle.ts explode: daño fijo de 40",
    fields: ["mine.damage"],
    install: () =>
      before(BP, "explode", (_s, args) => {
        args[1] = 40;
      }),
  },
  BLAST_RADIUS: {
    consumer: "battle.ts explode: radio fijo de 2 m",
    fields: ["mine.explosionRadiusM", "ammo.explosionRadiusM"],
    install: () =>
      before(BP, "explode", (_s, args) => {
        args[2] = 2;
      }),
  },
  MINE_TRIGGER: {
    consumer: "battle.ts resolveMines (detonación): radio de activación de 2 m (el valor por defecto)",
    fields: ["mine.triggerRadiusM"],
    install: () =>
      before(BP, "resolveMines", (self) => {
        for (const m of self.mines) m.triggerRadiusM = 2;
      }),
  },
  MINE_ARM: {
    consumer: "battle.ts resolveMines (armedAtTick): toda mina está armada",
    fields: ["mine.armDelayTicks"],
    install: () =>
      before(BP, "resolveMines", (self) => {
        for (const m of self.mines) m.armedAtTick = 0;
      }),
  },
  MINE_LIFETIME: {
    consumer: "battle.ts resolveMines (expiresAtTick): ninguna mina caduca",
    fields: ["mine.lifetimeTicks"],
    install: () =>
      before(BP, "resolveMines", (self) => {
        for (const m of self.mines) m.expiresAtTick = Number.POSITIVE_INFINITY;
      }),
  },
  SENSOR_TYPE: {
    consumer: "sensors.ts buildObservation (primitiva por tipo): todo sensor se lee como de proximidad",
    fields: ["sensor.sensorType"],
    install: () => sensorSees({ sensorType: "proximity" }),
  },
  SENSOR_RANGE: {
    consumer: "sensors.ts buildObservation (rangeM): alcance fijo de 40 m",
    fields: ["sensor.rangeM"],
    install: () => sensorSees({ rangeM: 40 }),
  },
  SENSOR_FOV: {
    consumer: "sensors.ts buildObservation, lidar (fovRad): π/2 (el valor por defecto)",
    fields: ["sensor.fovRad"],
    install: () => sensorSees({ fovRad: Math.PI / 2 }),
  },
  SENSOR_RAYS: {
    consumer: "sensors.ts buildObservation, lidar (rays): 16 (el valor por defecto)",
    fields: ["sensor.rays"],
    install: () => sensorSees({ rays: 16 }),
  },
  SENSOR_ERROR: {
    consumer: "sensors.ts buildObservation, radar (errorM): 2 m (el valor por defecto)",
    fields: ["sensor.errorM"],
    install: () => sensorSees({ errorM: 2 }),
  },
  RADIO_RANGE: {
    consumer: "sensors.ts radioDeliverableTo (rangeM del mensaje): alcance ilimitado",
    fields: ["radio.rangeM"],
    install: () =>
      before(BP, "step", (self) => {
        for (const m of self.radioQueue) m.rangeM = 1e9;
      }),
  },
  RADIO_BYTES: {
    consumer: "sensors.ts validateRadio (too_large): tamaño máximo por defecto (el techo de D8)",
    fields: ["radio.maxMessageBytes"],
    install: () =>
      before(BP, "step", (self) => {
        for (const v of self.vehicles) for (const r of modulesOfCat(v, "radio")) delete r.spec.maxMessageBytes;
      }),
  },
  RADIO_RATE: {
    consumer: "sensors.ts validateRadio (rate_limited): el contador del segundo vuelve a 0 en cada tick",
    fields: ["radio.maxMessagesPerSecond"],
    install: () =>
      before(BP, "step", (self) => {
        for (const v of self.vehicles) v.radioSentThisSecond = 0;
      }),
  },
};

/**
 * Campos ACTIVE SIN ablación, con el motivo. Vacío: todo campo ACTIVE tiene un consumidor que
 * se puede anular en el test. Si alguno entra aquí, el motivo queda en el gate.
 */
const NO_ABLATION: Readonly<Record<string, string>> = {};

function ablationsOf(c: Case): string[] {
  return Object.entries(ABLATIONS)
    .filter(([, a]) => a.fields.includes(`${c.cat}.${c.field}`) || a.fields.includes(`*.${c.field}`))
    .map(([id]) => id);
}

describe("CATALOG_CONTRACT · D4 · ablación: con el consumidor anulado cambia algún canal gobernado", () => {
  const { list } = cases("ACTIVE");
  it("todo caso ACTIVE tiene EXACTAMENTE una ablación de su consumidor (o un motivo en NO_ABLATION)", () => {
    const bad: string[] = [];
    for (const c of list) {
      const k = `${c.cat}.${c.field}`;
      const n = ablationsOf(c).length;
      if (n === 0 && !NO_ABLATION[k]) bad.push(`${k}: sin ablación`);
      if (n > 1) bad.push(`${k}: ${n} ablaciones (${ablationsOf(c).join(", ")})`);
      if (n === 1 && NO_ABLATION[k]) bad.push(`${k}: ablación y motivo a la vez`);
    }
    // Ninguna ablación rancia: cada campo que nombra existe como caso ACTIVE.
    const keys = new Set(list.flatMap((c) => [`${c.cat}.${c.field}`, `*.${c.field}`]));
    for (const [id, a] of Object.entries(ABLATIONS))
      for (const f of a.fields) if (!keys.has(f)) bad.push(`${id}: ${f} no es un caso ACTIVE`);
    expect(bad).toEqual([]);
  });
  for (const c of list) {
    const [id] = ablationsOf(c);
    if (!id) continue;
    const governs = fieldContract(c.cat, c.field)!.governs ?? [];
    it(`ablación ${id} · ${caseName(c)}: consumidor anulado ⇒ cambia [${governs.join(", ")}]`, () => {
      const m = mutatedCase(c);
      const restore = ABLATIONS[id]!.install(c);
      let ablated: ProbeTrace;
      try {
        ablated = probeTrace(m.catalog, refOf(c.target), m.loadout);
      } finally {
        restore();
      }
      const changed = changedChannels(ablated!, m.trace);
      expect(
        governs.filter((ch) => changed.includes(ch)),
        `${ABLATIONS[id]!.consumer}: la sonda no ve su efecto en lo gobernado; canales que cambian: [${changed.join(", ")}]`,
      ).not.toEqual([]);
    });
  }
});
