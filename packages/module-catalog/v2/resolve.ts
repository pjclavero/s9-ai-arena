/**
 * OLA 2 · MC · RESOLUCIÓN de los bloques v2 (Effect, Interference, Deployable, Guidance,
 * Projectile, Action): de dato de catálogo validado a forma canónica INMUTABLE que el motor
 * consumirá a través de resolveVehicle() (la frontera catálogo → simulación).
 *
 *  - Primero valida (validate.ts); si hay un solo problema, lanza V2ContractError con todos.
 *  - Aplica los valores por defecto que fija el contrato y nada más:
 *      · targets.requiresLineOfSight = true (§8: un efecto de área no atraviesa muros);
 *      · stackKey = `${primitive}:${canal|damageType}` (§8).
 *  - Devuelve una copia profunda congelada: el catálogo de origen no se toca y el motor no
 *    puede mutar lo resuelto.
 *
 * Sin consumidor en la simulación todavía (ver validate.ts): sólo fixtures `test.fixture_*`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionDef, DeployableDef, EffectDef, ProjectileDef } from "../contracts/engine-v2.js";
import {
  V2ContractError,
  validateActions,
  validateDeployableDef,
  validateEffectDef,
  validateProjectileDef,
  type V2Issue,
} from "./validate.js";

type Obj = Record<string, unknown>;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as Obj)) deepFreeze((v as Obj)[k]);
    Object.freeze(v);
  }
  return v;
}

function ensure(issues: V2Issue[]): void {
  if (issues.length > 0) throw new V2ContractError(issues);
}

/** Clave de apilado por defecto: primitiva + canal (o tipo de daño) que la distingue. */
function defaultStackKey(e: Obj): string {
  if (typeof e.damageType === "string") return `${e.primitive}:${e.damageType}`;
  if (Array.isArray(e.channels)) return `${e.primitive}:${[...e.channels].sort().join("+")}`;
  const prof = e.profile as { channels?: Obj } | undefined;
  if (prof?.channels) return `${e.primitive}:${Object.keys(prof.channels).sort().join("+")}`;
  if (typeof e.stat === "string") return `${e.primitive}:${e.stat}`;
  if (typeof e.repairs === "string") return `${e.primitive}:${e.repairs}`;
  return String(e.primitive);
}

function normalizeEffect(e: Obj): Obj {
  const targets = e.targets as Obj;
  return {
    ...e,
    targets: { ...targets, requiresLineOfSight: targets.requiresLineOfSight ?? true },
    stackKey: e.stackKey ?? defaultStackKey(e),
  };
}

function normalizeEffects(list: unknown): Obj[] {
  return (list as Obj[]).map(normalizeEffect);
}

function normalizeTrigger(t: Obj): Obj {
  return t.targets
    ? { ...t, targets: { ...(t.targets as Obj), requiresLineOfSight: (t.targets as Obj).requiresLineOfSight ?? true } }
    : { ...t };
}

function normalizeDeployable(d: Obj): Obj {
  return { ...d, trigger: normalizeTrigger(d.trigger as Obj), effects: normalizeEffects(d.effects) };
}

function normalizeProjectile(p: Obj): Obj {
  return { ...p, guidance: { ...(p.guidance as Obj) }, onImpact: normalizeEffects(p.onImpact) };
}

function normalizeAction(a: Obj): Obj {
  const out: Obj = { ...a, cost: { ...(a.cost as Obj) } };
  if (a.projectile) out.projectile = normalizeProjectile(a.projectile as Obj);
  if (a.deployable) out.deployable = normalizeDeployable(a.deployable as Obj);
  if (a.effects) out.effects = normalizeEffects(a.effects);
  return out;
}

const clone = <T>(v: unknown): T => structuredClone(v) as T;

export function resolveEffectDef(v: unknown): EffectDef {
  ensure(validateEffectDef(v));
  return deepFreeze(normalizeEffect(clone<Obj>(v))) as unknown as EffectDef;
}

export function resolveDeployableDef(v: unknown): DeployableDef {
  ensure(validateDeployableDef(v));
  return deepFreeze(normalizeDeployable(clone<Obj>(v))) as unknown as DeployableDef;
}

export function resolveProjectileDef(v: unknown): ProjectileDef {
  ensure(validateProjectileDef(v));
  return deepFreeze(normalizeProjectile(clone<Obj>(v))) as unknown as ProjectileDef;
}

export function resolveActions(v: unknown): readonly ActionDef[] {
  ensure(validateActions(v));
  return deepFreeze(clone<Obj[]>(v).map(normalizeAction)) as unknown as readonly ActionDef[];
}

// ------------------------------------------------------------------ fixtures de prueba

/** Patrón de id de fixture (contrato §12): cabe en el patrón de id del catálogo. */
export const FIXTURE_ID_PATTERN = /^test\.fixture_[a-z0-9_]+$/;

/** Módulo de prueba con bloques v2. NUNCA está en data/ ni lo carga loadCatalog(). */
export interface FixtureModuleV2 {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  readonly actions: readonly ActionDef[];
}

const FIXTURE_KEYS = new Set(["id", "version", "name", "description", "actions"]);

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

/** Valida y resuelve un fixture v2. Fail-closed como todo lo demás. */
export function resolveFixtureModule(raw: unknown): FixtureModuleV2 {
  const issues: V2Issue[] = [];
  const o = raw as Obj;
  if (!o || typeof o !== "object" || Array.isArray(o))
    throw new V2ContractError([{ path: "fixture", message: "debe ser un objeto" }]);
  for (const k of Object.keys(o))
    if (!FIXTURE_KEYS.has(k)) issues.push({ path: `fixture.${k}`, message: "clave no declarada" });
  if (typeof o.id !== "string" || !FIXTURE_ID_PATTERN.test(o.id))
    issues.push({ path: "fixture.id", message: `id de fixture debe casar ${FIXTURE_ID_PATTERN}` });
  if (!Number.isInteger(o.version) || (o.version as number) < 1)
    issues.push({ path: "fixture.version", message: "entero ≥ 1" });
  if (typeof o.name !== "string" || o.name.length === 0) issues.push({ path: "fixture.name", message: "obligatorio" });
  issues.push(...validateActions(o.actions, `${String(o.id)}.actions`));
  ensure(issues);
  const out = clone<Obj>(o);
  out.actions = (out.actions as Obj[]).map(normalizeAction);
  return deepFreeze(out) as unknown as FixtureModuleV2;
}

/** Carga test-fixtures/*.json (sólo tests). Orden estable por id@version. */
export function loadFixtureCatalog(dir: string = FIXTURES_DIR): FixtureModuleV2[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => resolveFixtureModule(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
}
