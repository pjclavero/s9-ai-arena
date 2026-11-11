/**
 * OLA 2 · MC · Validación DATA-DRIVEN de los bloques v2 del catálogo: Effect, Interference,
 * Trigger, Deployable, Guidance, Projectile y Action (contracts/engine-v2.ts; contrato en
 * docs/technical/engine-v2-contracts.md §8-§12).
 *
 * Reglas:
 *  - Fail-closed (E2): una primitiva desconocida, una clave no declarada o un canal sin
 *    consumidor es un error, nunca se ignora en silencio.
 *  - Despacho por REGISTRO de primitiva (E1), creado con emptyDict() y leído con
 *    safeLookup(): ninguna cadena `if (primitive === …)` ni, por supuesto, por moduleId.
 *  - Pura y sin E/S: recibe datos ya cargados.
 *
 * Estos bloques todavía NO los admite module.schema.json (unevaluatedProperties:false): no
 * hay consumidor en la simulación y un campo sin consumidor es un campo falso. Hasta que el
 * motor los consuma sólo se usan con fixtures `test.fixture_*` (test-fixtures/).
 */
import { emptyDict, safeLookup } from "../../game-rules/safe-lookup.js";
import type {
  ActionKind,
  EffectPrimitive,
  InterferenceChannel,
  KnownDamageType,
  TriggerKind,
} from "../contracts/engine-v2.js";

export interface V2Issue {
  readonly path: string;
  readonly message: string;
}

export class V2ContractError extends Error {
  constructor(readonly issues: readonly V2Issue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  }
}

// ------------------------------------------------------------------ vocabularios cerrados

const set = <T extends string>(xs: readonly T[]): ReadonlySet<string> => new Set<string>(xs);

/** Canales con CONSUMIDOR en el motor (sensores y radio). `optical` no lo tiene: N3. */
export const CONSUMED_CHANNELS = set<InterferenceChannel>(["lidar", "radar", "proximity", "acoustic", "radio"]);
const ALL_CHANNELS = set<InterferenceChannel>(["lidar", "radar", "proximity", "acoustic", "radio", "optical"]);
/** Registro inicial de B (DamageTypeProfile). Un id nuevo se añade aquí con su perfil. */
export const KNOWN_DAMAGE_TYPES = set<KnownDamageType>(["kinetic", "explosive", "thermal", "electronic", "environmental"]);
const RELATIONS = set(["self", "ally", "enemy", "any"]);
const KINDS = set(["vehicle", "module", "deployable", "projectile"]);
const FALLOFFS = set(["none", "linear", "step"]);
const STACKINGS = set(["none", "replace", "max", "add"]);
const CHANNEL_MODES = set(["attenuate", "block", "noise"]);
const VISIBILITY_LEVELS = set(["hidden", "detected", "revealed"]);
const TRIGGER_EVENTS = set(["owner_destroyed", "deployable_damaged", "battle_phase"]);

// ------------------------------------------------------------------ utilidades de comprobación

type Obj = Record<string, unknown>;

class Check {
  readonly issues: V2Issue[] = [];
  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }
  obj(v: unknown, path: string): v is Obj {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      this.fail(path, "debe ser un objeto");
      return false;
    }
    return true;
  }
  /** Claves cerradas: lo no declarado es error (no hay campos silenciosos). */
  keys(o: Obj, path: string, required: readonly string[], optional: readonly string[] = []): void {
    const allowed = new Set([...required, ...optional]);
    for (const k of Object.keys(o)) if (!allowed.has(k)) this.fail(`${path}.${k}`, "clave no declarada en el contrato");
    for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) this.fail(`${path}.${k}`, "obligatorio");
  }
  num(o: Obj, k: string, path: string, opt: { min?: number; max?: number; gt?: number; int?: boolean } = {}): void {
    if (!Object.prototype.hasOwnProperty.call(o, k)) return;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return this.fail(`${path}.${k}`, "debe ser un número finito");
    if (opt.int && !Number.isInteger(v)) this.fail(`${path}.${k}`, "debe ser entero");
    if (opt.min !== undefined && v < opt.min) this.fail(`${path}.${k}`, `debe ser ≥ ${opt.min}`);
    if (opt.max !== undefined && v > opt.max) this.fail(`${path}.${k}`, `debe ser ≤ ${opt.max}`);
    if (opt.gt !== undefined && !(v > opt.gt)) this.fail(`${path}.${k}`, `debe ser > ${opt.gt}`);
  }
  bool(o: Obj, k: string, path: string): void {
    if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] !== "boolean")
      this.fail(`${path}.${k}`, "debe ser booleano");
  }
  oneOf(o: Obj, k: string, path: string, allowed: ReadonlySet<string>): void {
    if (!Object.prototype.hasOwnProperty.call(o, k)) return;
    const v = o[k];
    if (typeof v !== "string" || !allowed.has(v)) this.fail(`${path}.${k}`, `valor no admitido: ${String(v)}`);
  }
  /** Lista no vacía, sin repetidos, de valores del vocabulario. */
  list(o: Obj, k: string, path: string, allowed: ReadonlySet<string>): void {
    if (!Object.prototype.hasOwnProperty.call(o, k)) return;
    const v = o[k];
    if (!Array.isArray(v) || v.length === 0) return this.fail(`${path}.${k}`, "debe ser una lista no vacía");
    if (new Set(v).size !== v.length) this.fail(`${path}.${k}`, "valores repetidos");
    v.forEach((x, i) => {
      if (typeof x !== "string" || !allowed.has(x)) this.fail(`${path}.${k}[${i}]`, `valor no admitido: ${String(x)}`);
    });
  }
}

/** Un canal existe y además tiene consumidor (N3: `optical` se rechaza hasta que lo tenga). */
function channel(c: Check, value: unknown, path: string): void {
  if (typeof value !== "string" || !ALL_CHANNELS.has(value)) return c.fail(path, `canal desconocido: ${String(value)}`);
  if (!CONSUMED_CHANNELS.has(value))
    c.fail(path, `canal sin consumidor en el motor (AVAILABLE_PRIMITIVE_WITHOUT_CONTENT): ${value}`);
}

function targetFilter(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  c.keys(v, path, ["relations", "kinds"], ["requiresLineOfSight"]);
  c.list(v, "relations", path, RELATIONS);
  c.list(v, "kinds", path, KINDS);
  c.bool(v, "requiresLineOfSight", path);
}

// ------------------------------------------------------------------ Effect (§8)

const EFFECT_COMMON = ["primitive", "strength", "targets", "stacking"] as const;
const EFFECT_OPTIONAL = ["radiusM", "durationTicks", "falloff", "stackKey", "maxStacks"] as const;

/** Validador propio de cada primitiva: claves extra obligatorias/opcionales y semántica. */
interface EffectSpecValidator {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  check(c: Check, e: Obj, path: string): void;
}

const EFFECT_VALIDATORS: Record<string, EffectSpecValidator> = emptyDict<EffectSpecValidator>();
const damageLike = (area: boolean): EffectSpecValidator => ({
  required: ["damageType"],
  check(c, e, path) {
    if (typeof e.damageType !== "string" || !KNOWN_DAMAGE_TYPES.has(e.damageType))
      c.fail(`${path}.damageType`, `tipo de daño sin perfil registrado: ${String(e.damageType)}`);
    c.num(e, "strength", path, { gt: 0 });
    const r = (e.radiusM as number | undefined) ?? 0;
    if (area && !(r > 0)) c.fail(`${path}.radiusM`, "una explosión exige radiusM > 0");
    if (!area && r > 0) c.fail(`${path}.radiusM`, "el daño directo es puntual: usa explosion para área");
  },
});
EFFECT_VALIDATORS.damage = damageLike(false);
EFFECT_VALIDATORS.explosion = damageLike(true);
EFFECT_VALIDATORS.penetration = {
  required: [],
  check(c, e, path) {
    c.num(e, "strength", path, { min: 0 });
  },
};
EFFECT_VALIDATORS.interference = {
  required: ["profile"],
  check(c, e, path) {
    c.num(e, "strength", path, { min: 0, max: 1 });
    if (!(((e.radiusM as number | undefined) ?? 0) > 0)) c.fail(`${path}.radiusM`, "una interferencia es una zona: radiusM > 0");
    if (!(((e.durationTicks as number | undefined) ?? 0) > 0))
      c.fail(`${path}.durationTicks`, "una zona de interferencia dura: durationTicks > 0");
    interferenceProfile(c, e.profile, `${path}.profile`);
  },
};
EFFECT_VALIDATORS.repair = {
  required: ["repairs"],
  check(c, e, path) {
    c.num(e, "strength", path, { gt: 0 });
    c.oneOf(e, "repairs", path, set(["hull", "modules", "armor"]));
  },
};
EFFECT_VALIDATORS.statusModifier = {
  required: ["stat"],
  check(c, e, path) {
    c.num(e, "strength", path, { gt: -1 });
    c.oneOf(e, "stat", path, set(["maxSpeed", "turnRate", "turretRate", "energyGeneration", "cooldown"]));
  },
};
EFFECT_VALIDATORS.sensorModifier = {
  required: ["channels", "stat"],
  check(c, e, path) {
    c.num(e, "strength", path, { gt: -1 });
    c.oneOf(e, "stat", path, set(["range", "error", "refresh"]));
    if (!Array.isArray(e.channels) || e.channels.length === 0)
      return c.fail(`${path}.channels`, "debe ser una lista no vacía");
    if (new Set(e.channels).size !== e.channels.length) c.fail(`${path}.channels`, "valores repetidos");
    e.channels.forEach((ch, i) => channel(c, ch, `${path}.channels[${i}]`));
  },
};
EFFECT_VALIDATORS.communicationModifier = {
  required: ["stat"],
  check(c, e, path) {
    c.num(e, "strength", path, { gt: -1 });
    c.oneOf(e, "stat", path, set(["range", "rate", "delay", "maxBytes"]));
  },
};

/** Primitivas con validador registrado (= las del contrato EffectPrimitive). */
export function registeredEffectPrimitives(): EffectPrimitive[] {
  return Object.keys(EFFECT_VALIDATORS).sort() as EffectPrimitive[];
}

function effectDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  const spec = typeof v.primitive === "string" ? safeLookup(EFFECT_VALIDATORS, v.primitive) : undefined;
  if (!spec) return c.fail(`${path}.primitive`, `primitiva desconocida: ${String(v.primitive)}`);
  c.keys(v, path, [...EFFECT_COMMON, ...spec.required], [...EFFECT_OPTIONAL, ...(spec.optional ?? [])]);
  c.num(v, "radiusM", path, { min: 0 });
  c.num(v, "durationTicks", path, { min: 0, int: true });
  c.oneOf(v, "falloff", path, FALLOFFS);
  if (((v.radiusM as number | undefined) ?? 0) > 0 && v.falloff === undefined)
    c.fail(`${path}.falloff`, "obligatorio si radiusM > 0");
  c.oneOf(v, "stacking", path, STACKINGS);
  if (v.stackKey !== undefined && (typeof v.stackKey !== "string" || v.stackKey.length === 0))
    c.fail(`${path}.stackKey`, "debe ser un texto no vacío");
  c.num(v, "maxStacks", path, { min: 1, int: true });
  if (v.maxStacks !== undefined && v.stacking !== "add") c.fail(`${path}.maxStacks`, "sólo con stacking = add");
  if (v.stacking !== "none" && !(((v.durationTicks as number | undefined) ?? 0) > 0))
    c.fail(`${path}.stacking`, "apilar sólo tiene sentido en un efecto persistente (durationTicks > 0)");
  targetFilter(c, v.targets, `${path}.targets`);
  spec.check(c, v, path);
}

/** Lista ordenada de efectos (de una acción, un impacto o un deployable). */
function effectList(c: Check, v: unknown, path: string, allowEmpty = false): void {
  if (!Array.isArray(v) || (!allowEmpty && v.length === 0)) return c.fail(path, "debe ser una lista no vacía de efectos");
  v.forEach((e, i) => effectDef(c, e, `${path}[${i}]`));
  // `penetration` no daña por sí sola: necesita un efecto de daño HERMANO (§8).
  const prims = v.map((e) => (e && typeof e === "object" ? (e as Obj).primitive : undefined));
  if (prims.includes("penetration") && !prims.some((p) => p === "damage" || p === "explosion"))
    c.fail(path, "penetration sin un efecto damage/explosion hermano no tiene efecto");
}

// ------------------------------------------------------------------ Interference (§9)

function interferenceProfile(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  c.keys(v, path, ["channels"]);
  const chans = v.channels;
  if (!c.obj(chans, `${path}.channels`)) return;
  const names = Object.keys(chans);
  if (names.length === 0) c.fail(`${path}.channels`, "al menos un canal");
  for (const name of names) {
    const p = `${path}.channels.${name}`;
    channel(c, name, p);
    const m = chans[name];
    if (!c.obj(m, p)) continue;
    c.keys(m, p, ["strength", "mode"], ["noise"]);
    c.num(m, "strength", p, { gt: 0, max: 1 });
    c.oneOf(m, "mode", p, CHANNEL_MODES);
    c.num(m, "noise", p, { gt: 0 });
    if (m.mode === "noise" && m.noise === undefined) c.fail(`${p}.noise`, "obligatorio con mode = noise");
    if (m.mode !== "noise" && m.noise !== undefined) c.fail(`${p}.noise`, "sólo con mode = noise");
  }
}

// ------------------------------------------------------------------ Trigger y Deployable (§10)

interface TriggerSpecValidator {
  readonly required: readonly string[];
  check(c: Check, t: Obj, path: string): void;
}
const TRIGGER_VALIDATORS: Record<string, TriggerSpecValidator> = emptyDict<TriggerSpecValidator>();
TRIGGER_VALIDATORS.proximity = {
  required: ["radiusM", "targets"],
  check(c, t, path) {
    c.num(t, "radiusM", path, { gt: 0 });
    targetFilter(c, t.targets, `${path}.targets`);
  },
};
TRIGGER_VALIDATORS.contact = {
  required: ["targets"],
  check(c, t, path) {
    targetFilter(c, t.targets, `${path}.targets`);
  },
};
TRIGGER_VALIDATORS.timer = {
  required: ["afterTicks"],
  check(c, t, path) {
    c.num(t, "afterTicks", path, { min: 1, int: true });
  },
};
TRIGGER_VALIDATORS.remote = {
  required: ["requiresOwnerAlive"],
  check(c, t, path) {
    c.bool(t, "requiresOwnerAlive", path);
  },
};
TRIGGER_VALIDATORS.event = {
  required: ["event"],
  check(c, t, path) {
    c.oneOf(t, "event", path, TRIGGER_EVENTS);
  },
};

export function registeredTriggerKinds(): TriggerKind[] {
  return Object.keys(TRIGGER_VALIDATORS).sort() as TriggerKind[];
}

function triggerDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  const spec = typeof v.kind === "string" ? safeLookup(TRIGGER_VALIDATORS, v.kind) : undefined;
  if (!spec) return c.fail(`${path}.kind`, `trigger desconocido: ${String(v.kind)}`);
  c.keys(v, path, ["kind", ...spec.required]);
  spec.check(c, v, path);
}

function deployableDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  c.keys(
    v,
    path,
    [
      "lifetimeTicks",
      "armDelayTicks",
      "maxActivePerOwner",
      "trigger",
      "effects",
      "consumeOnTrigger",
      "visibility",
      "placement",
      "ownership",
    ],
    ["hp"],
  );
  c.num(v, "lifetimeTicks", path, { min: 1, int: true });
  c.num(v, "armDelayTicks", path, { min: 0, int: true });
  c.num(v, "maxActivePerOwner", path, { min: 1, int: true });
  c.bool(v, "consumeOnTrigger", path);
  const life = v.lifetimeTicks as number;
  const arm = v.armDelayTicks as number;
  if (Number.isFinite(life) && Number.isFinite(arm) && arm >= life)
    c.fail(`${path}.armDelayTicks`, "se arma después de caducar: nunca podría dispararse");
  triggerDef(c, v.trigger, `${path}.trigger`);
  const t = v.trigger as Obj | undefined;
  if (t && t.kind === "timer" && typeof t.afterTicks === "number" && arm + t.afterTicks >= life)
    c.fail(`${path}.trigger.afterTicks`, "el temporizador vence después de caducar");
  effectList(c, v.effects, `${path}.effects`);
  // hp > 0 = destructible: FUTURE hasta que exista su consumidor (el validador lo rechaza).
  if (v.hp !== undefined) c.fail(`${path}.hp`, "FUTURE: deployable destructible sin consumidor en el motor");

  const vis = v.visibility;
  if (c.obj(vis, `${path}.visibility`)) {
    const p = `${path}.visibility`;
    c.keys(vis, p, ["allies", "enemies", "spectator", "signature"]);
    for (const k of ["allies", "enemies", "spectator"]) c.oneOf(vis, k, p, VISIBILITY_LEVELS);
    const sig = vis.signature;
    if (c.obj(sig, `${p}.signature`)) {
      for (const [ch, val] of Object.entries(sig)) {
        channel(c, ch, `${p}.signature.${ch}`);
        if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1)
          c.fail(`${p}.signature.${ch}`, "firma en [0, 1]");
      }
    }
  }
  const pl = v.placement;
  if (c.obj(pl, `${path}.placement`)) {
    const p = `${path}.placement`;
    c.keys(pl, p, ["mode"], ["maxOffsetM"]);
    c.oneOf(pl, "mode", p, set(["at_self", "offset"]));
    c.num(pl, "maxOffsetM", p, { gt: 0 });
    if (pl.mode === "offset" && pl.maxOffsetM === undefined) c.fail(`${p}.maxOffsetM`, "obligatorio con mode = offset");
    if (pl.mode === "at_self" && pl.maxOffsetM !== undefined) c.fail(`${p}.maxOffsetM`, "sólo con mode = offset");
  }
  const own = v.ownership;
  if (c.obj(own, `${path}.ownership`)) {
    c.keys(own, `${path}.ownership`, ["friendlyTrigger"]);
    c.oneOf(own, "friendlyTrigger", `${path}.ownership`, set(["inherit", "always", "never"]));
  }
}

// ------------------------------------------------------------------ Guidance y Projectile (§11)

interface GuidanceSpecValidator {
  readonly required: readonly string[];
  check(c: Check, g: Obj, path: string): void;
}
const GUIDANCE_VALIDATORS: Record<string, GuidanceSpecValidator> = emptyDict<GuidanceSpecValidator>();
GUIDANCE_VALIDATORS.none = { required: [], check() {} };
GUIDANCE_VALIDATORS.target = {
  required: ["turnRateRads", "acquisitionRangeM", "lockRequirements", "trackingErrorRad", "onLockLost"],
  check(c, g, path) {
    c.num(g, "turnRateRads", path, { gt: 0 });
    c.num(g, "acquisitionRangeM", path, { gt: 0 });
    c.num(g, "trackingErrorRad", path, { min: 0 });
    c.oneOf(g, "onLockLost", path, set(["ballistic", "expire"]));
    const lr = g.lockRequirements;
    const p = `${path}.lockRequirements`;
    if (c.obj(lr, p)) {
      c.keys(lr, p, ["channel", "requiresLineOfSight", "minLockTicks"]);
      channel(c, lr.channel, `${p}.channel`);
      c.bool(lr, "requiresLineOfSight", p);
      c.num(lr, "minLockTicks", p, { min: 0, int: true });
    }
  },
};
GUIDANCE_VALIDATORS.waypoint = {
  required: ["turnRateRads", "maxWaypoints", "trackingErrorRad"],
  check(c, g, path) {
    c.num(g, "turnRateRads", path, { gt: 0 });
    c.num(g, "maxWaypoints", path, { min: 1, int: true });
    c.num(g, "trackingErrorRad", path, { min: 0 });
  },
};

function guidanceDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  const spec = typeof v.mode === "string" ? safeLookup(GUIDANCE_VALIDATORS, v.mode) : undefined;
  if (!spec) return c.fail(`${path}.mode`, `modo de guiado desconocido: ${String(v.mode)}`);
  c.keys(v, path, ["mode", ...spec.required]);
  spec.check(c, v, path);
}

function projectileDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  c.keys(v, path, ["speedMs", "lifetimeTicks", "spreadRad", "guidance", "onImpact"]);
  c.num(v, "speedMs", path, { gt: 0 });
  c.num(v, "lifetimeTicks", path, { min: 1, int: true });
  c.num(v, "spreadRad", path, { min: 0 });
  guidanceDef(c, v.guidance, `${path}.guidance`);
  effectList(c, v.onImpact, `${path}.onImpact`);
}

// ------------------------------------------------------------------ Action (§12)

/** Producto que exige cada clase de acción: exactamente lo que el contrato asigna. */
interface ActionSpecValidator {
  readonly products: readonly ("projectile" | "deployable" | "effects")[];
  /** true = uno de `products` es obligatorio; false = no admite ninguno. */
  readonly needsProduct: boolean;
}
const ACTION_VALIDATORS: Record<string, ActionSpecValidator> = emptyDict<ActionSpecValidator>();
ACTION_VALIDATORS.fire = { products: ["projectile"], needsProduct: true };
ACTION_VALIDATORS.deploy = { products: ["deployable"], needsProduct: true };
ACTION_VALIDATORS.activate = { products: ["effects", "deployable"], needsProduct: true };
// `trigger` acciona lo ya desplegado (detonate remoto): no produce nada nuevo.
ACTION_VALIDATORS.trigger = { products: [], needsProduct: false };

export function registeredActionKinds(): ActionKind[] {
  return Object.keys(ACTION_VALIDATORS).sort() as ActionKind[];
}

function actionDef(c: Check, v: unknown, path: string): void {
  if (!c.obj(v, path)) return;
  const spec = typeof v.kind === "string" ? safeLookup(ACTION_VALIDATORS, v.kind) : undefined;
  if (!spec) return c.fail(`${path}.kind`, `acción desconocida: ${String(v.kind)}`);
  c.keys(v, path, ["kind", "cooldownTicks", "cost"], spec.products);
  c.num(v, "cooldownTicks", path, { min: 0, int: true });
  const cost = v.cost;
  if (c.obj(cost, `${path}.cost`)) {
    c.keys(cost, `${path}.cost`, ["energyEU"], ["charges", "ammo"]);
    c.num(cost, "energyEU", `${path}.cost`, { min: 0 });
    c.num(cost, "charges", `${path}.cost`, { min: 1, int: true });
    c.num(cost, "ammo", `${path}.cost`, { min: 1, int: true });
  }
  const present = spec.products.filter((p) => v[p] !== undefined);
  if (spec.needsProduct && present.length !== 1)
    c.fail(path, `la acción ${String(v.kind)} exige exactamente uno de: ${spec.products.join(", ")}`);
  if (v.projectile !== undefined) projectileDef(c, v.projectile, `${path}.projectile`);
  if (v.deployable !== undefined) deployableDef(c, v.deployable, `${path}.deployable`);
  if (v.effects !== undefined) effectList(c, v.effects, `${path}.effects`);
}

// ------------------------------------------------------------------ API pública

function run(fn: (c: Check, v: unknown, path: string) => void, v: unknown, path: string): V2Issue[] {
  const c = new Check();
  fn(c, v, path);
  return c.issues;
}

export const validateEffectDef = (v: unknown, path = "effect"): V2Issue[] => run(effectDef, v, path);
export const validateEffectList = (v: unknown, path = "effects"): V2Issue[] => run(effectList, v, path);
export const validateInterferenceProfile = (v: unknown, path = "profile"): V2Issue[] =>
  run(interferenceProfile, v, path);
export const validateTriggerDef = (v: unknown, path = "trigger"): V2Issue[] => run(triggerDef, v, path);
export const validateDeployableDef = (v: unknown, path = "deployable"): V2Issue[] => run(deployableDef, v, path);
export const validateGuidanceDef = (v: unknown, path = "guidance"): V2Issue[] => run(guidanceDef, v, path);
export const validateProjectileDef = (v: unknown, path = "projectile"): V2Issue[] => run(projectileDef, v, path);
export const validateActionDef = (v: unknown, path = "action"): V2Issue[] => run(actionDef, v, path);

/** Lista de acciones de un módulo: no vacía y válida una a una. */
export function validateActions(v: unknown, path = "actions"): V2Issue[] {
  const c = new Check();
  if (!Array.isArray(v) || v.length === 0) c.fail(path, "debe ser una lista no vacía de acciones");
  else v.forEach((a, i) => actionDef(c, a, `${path}[${i}]`));
  return c.issues;
}
