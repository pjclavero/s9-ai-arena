/**
 * OLA 2 · MC · Contratos data-driven Effect / Interference / Deployable / Guidance / Action.
 *
 * Los bloques v2 se validan (fail-closed) y se resuelven a una forma canónica inmutable.
 * Sólo con fixtures `test.fixture_*` (packages/module-catalog/test-fixtures/): ningún
 * contenido real nuevo. Cada caso negativo es una mutación de un fixture válido: el
 * validador tiene que ponerse rojo por la razón esperada (se comprueba la ruta del error).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ActionKind, EffectPrimitive, TriggerKind } from "../contracts/engine-v2.js";
import { DATA_DIR, loadCatalog } from "../loadCatalog.js";
import {
  FIXTURES_DIR,
  FIXTURE_ID_PATTERN,
  loadFixtureCatalog,
  resolveActions,
  resolveEffectDef,
  resolveFixtureModule,
} from "./resolve.js";
import {
  V2ContractError,
  registeredActionKinds,
  registeredEffectPrimitives,
  registeredTriggerKinds,
  validateActions,
  validateDeployableDef,
  validateEffectDef,
  validateGuidanceDef,
  validateInterferenceProfile,
  validateProjectileDef,
} from "./validate.js";

const raw = (name: string): any => JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}@1.json`), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

// Exhaustividad en COMPILACIÓN: si el contrato añade una primitiva, esto no compila.
const ALL_PRIMITIVES: Record<EffectPrimitive, true> = {
  damage: true,
  explosion: true,
  penetration: true,
  interference: true,
  repair: true,
  statusModifier: true,
  sensorModifier: true,
  communicationModifier: true,
};
const ALL_TRIGGERS: Record<TriggerKind, true> = { proximity: true, contact: true, timer: true, remote: true, event: true };
const ALL_ACTIONS: Record<ActionKind, true> = { fire: true, deploy: true, activate: true, trigger: true };

describe("MC · registros de primitivas = contrato", () => {
  it("cada EffectPrimitive / TriggerKind / ActionKind del contrato tiene validador registrado (y ninguno más)", () => {
    expect(registeredEffectPrimitives()).toEqual(Object.keys(ALL_PRIMITIVES).sort());
    expect(registeredTriggerKinds()).toEqual(Object.keys(ALL_TRIGGERS).sort());
    expect(registeredActionKinds()).toEqual(Object.keys(ALL_ACTIONS).sort());
  });
});

describe("MC · fixtures v2 (test.fixture_*)", () => {
  const fixtures = loadFixtureCatalog();

  it("hay fixtures, todos con id test.fixture_* y fuera de data/ (loadCatalog no los ve)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    for (const f of fixtures) expect(f.id).toMatch(FIXTURE_ID_PATTERN);
    const real = loadCatalog().map((m) => m.id);
    for (const f of fixtures) expect(real).not.toContain(f.id);
    expect(readdirSync(DATA_DIR).some((f) => f.startsWith("test."))).toBe(false);
  });

  it("los fixtures cubren todas las primitivas, triggers, acciones y modos de guiado del contrato", () => {
    const prims = new Set<string>();
    const triggers = new Set<string>();
    const actions = new Set<string>();
    const guidance = new Set<string>();
    const walkEffects = (list: readonly any[] | undefined) => list?.forEach((e) => prims.add(e.primitive));
    for (const f of fixtures) {
      for (const a of f.actions as any[]) {
        actions.add(a.kind);
        walkEffects(a.effects);
        if (a.deployable) {
          triggers.add(a.deployable.trigger.kind);
          walkEffects(a.deployable.effects);
        }
        if (a.projectile) {
          guidance.add(a.projectile.guidance.mode);
          walkEffects(a.projectile.onImpact);
        }
      }
    }
    // contact y damage puro se cubren en los casos inline de abajo; aquí, lo de los fixtures.
    for (const p of Object.keys(ALL_PRIMITIVES)) expect(prims, `primitiva ${p} sin fixture`).toContain(p);
    for (const t of ["proximity", "timer", "remote", "event"]) expect(triggers).toContain(t);
    for (const a of Object.keys(ALL_ACTIONS)) expect(actions).toContain(a);
    for (const g of ["target", "waypoint"]) expect(guidance).toContain(g);
  });

  it("la resolución es inmutable, no toca el origen y aplica los valores por defecto del contrato", () => {
    const src = raw("test.fixture_proximity_mine");
    const before = JSON.stringify(src);
    const r = resolveFixtureModule(src);
    expect(JSON.stringify(src)).toBe(before);
    expect(Object.isFrozen(r)).toBe(true);
    const eff = (r.actions[0] as any).deployable.effects[0];
    expect(Object.isFrozen(eff)).toBe(true);
    expect(eff.targets.requiresLineOfSight).toBe(true);
    expect(eff.stackKey).toBe("explosion:explosive");
    expect(() => {
      (eff as any).strength = 1;
    }).toThrow();
  });

  it("resolveEffectDef respeta un stackKey y una línea de visión explícitos", () => {
    const e = resolveEffectDef({
      primitive: "sensorModifier",
      strength: 0.1,
      channels: ["radar", "lidar"],
      stat: "error",
      durationTicks: 30,
      targets: { relations: ["enemy"], kinds: ["vehicle"], requiresLineOfSight: false },
      stacking: "max",
    });
    expect(e.stackKey).toBe("sensorModifier:lidar+radar");
    expect(e.targets.requiresLineOfSight).toBe(false);
  });
});

/** Un fixture válido mutado debe dar un error en `path` (y no ser aceptado). */
function expectIssue(issues: { path: string; message: string }[], pathFragment: string): void {
  expect(issues.length, "el validador aceptó un dato inválido").toBeGreaterThan(0);
  expect(
    issues.some((i) => i.path.includes(pathFragment)),
    `ningún error en ${pathFragment}: ${JSON.stringify(issues)}`,
  ).toBe(true);
}

describe("MC · validación fail-closed (mutaciones de fixtures válidos)", () => {
  const mine = () => clone(raw("test.fixture_proximity_mine").actions[0].deployable);
  const zone = () => clone(raw("test.fixture_interference_zone").actions[0].effects[0]);
  const guided = () => clone(raw("test.fixture_guided_target").actions[0].projectile);

  it("los fixtures sin mutar son válidos (control)", () => {
    expect(validateDeployableDef(mine())).toEqual([]);
    expect(validateEffectDef(zone())).toEqual([]);
    expect(validateProjectileDef(guided())).toEqual([]);
  });

  it("primitiva desconocida o de prototipo → error (no se ignora)", () => {
    for (const p of ["smoke", "__proto__", "constructor", "toString"]) {
      const e = zone();
      e.primitive = p;
      expectIssue(validateEffectDef(e), "primitive");
    }
  });

  it("clave no declarada en un efecto, un perfil, un trigger o una acción → error", () => {
    const e = zone();
    e.magnitude = 3;
    expectIssue(validateEffectDef(e), "magnitude");
    const d = mine();
    d.trigger.extra = 1;
    expectIssue(validateDeployableDef(d), "trigger.extra");
    const a = clone(raw("test.fixture_repair").actions);
    a[0].effect = "repair";
    expectIssue(validateActions(a), "effect");
  });

  it("canal óptico (sin consumidor) y canal inventado → error (N3)", () => {
    const e = zone();
    e.profile.channels.optical = { strength: 0.5, mode: "block" };
    expectIssue(validateEffectDef(e), "optical");
    expectIssue(validateInterferenceProfile({ channels: { thermal: { strength: 1, mode: "block" } } }), "thermal");
    const g = guided();
    g.guidance.lockRequirements.channel = "optical";
    expectIssue(validateProjectileDef(g), "lockRequirements.channel");
  });

  it("geometría del efecto: explosión sin radio, daño directo con radio, falloff ausente", () => {
    const d = mine();
    delete d.effects[0].radiusM;
    expectIssue(validateDeployableDef(d), "radiusM");
    const g = guided();
    g.onImpact[0].radiusM = 3;
    g.onImpact[0].falloff = "linear";
    expectIssue(validateProjectileDef(g), "radiusM");
    const z = zone();
    delete z.falloff;
    expectIssue(validateEffectDef(z), "falloff");
  });

  it("tipo de daño sin perfil, penetración sin daño hermano", () => {
    const d = mine();
    d.effects[0].damageType = "plasma";
    expectIssue(validateDeployableDef(d), "damageType");
    const g = guided();
    g.onImpact = [g.onImpact[1]];
    expectIssue(validateProjectileDef(g), "onImpact");
  });

  it("interferencia instantánea o sin radio, modo noise sin ruido, fuerza fuera de [0,1]", () => {
    const z = zone();
    delete z.durationTicks;
    expectIssue(validateEffectDef(z), "durationTicks");
    const z2 = zone();
    z2.profile.channels.lidar = { strength: 0.9, mode: "noise" };
    expectIssue(validateEffectDef(z2), "lidar.noise");
    const z3 = zone();
    z3.profile.channels.lidar.strength = 1.5;
    expectIssue(validateEffectDef(z3), "lidar");
  });

  it("apilado: add sin duración, maxStacks sin add", () => {
    const d = mine();
    d.effects[0].stacking = "add";
    expectIssue(validateDeployableDef(d), "stacking");
    const z = zone();
    z.maxStacks = 2;
    expectIssue(validateEffectDef(z), "maxStacks");
  });

  it("deployable: armado tras caducar, temporizador tras caducar, hp (FUTURE), offset sin distancia", () => {
    const d = mine();
    d.armDelayTicks = d.lifetimeTicks;
    expectIssue(validateDeployableDef(d), "armDelayTicks");
    const j = clone(raw("test.fixture_jammer_deployable").actions[0].deployable);
    j.trigger.afterTicks = j.lifetimeTicks;
    expectIssue(validateDeployableDef(j), "afterTicks");
    const h = mine();
    h.hp = 10;
    expectIssue(validateDeployableDef(h), "hp");
    const o = clone(raw("test.fixture_remote_charge").actions[0].deployable);
    delete o.placement.maxOffsetM;
    expectIssue(validateDeployableDef(o), "maxOffsetM");
  });

  it("trigger: contact exige targets, evento fuera de la lista cerrada", () => {
    const d = mine();
    d.trigger = { kind: "contact" };
    expectIssue(validateDeployableDef(d), "trigger.targets");
    const b = clone(raw("test.fixture_beacon_event").actions[0].deployable);
    b.trigger.event = "battle_started";
    expectIssue(validateDeployableDef(b), "trigger.event");
    const ok = mine();
    ok.trigger = { kind: "contact", targets: { relations: ["enemy"], kinds: ["vehicle"] } };
    expect(validateDeployableDef(ok)).toEqual([]);
  });

  it("guidance: modo desconocido, target sin lock, waypoint sin máximo", () => {
    expectIssue(validateGuidanceDef({ mode: "homing" }), "mode");
    const g = guided();
    delete g.guidance.lockRequirements;
    expectIssue(validateProjectileDef(g), "lockRequirements");
    expectIssue(validateGuidanceDef({ mode: "waypoint", turnRateRads: 1, trackingErrorRad: 0 }), "maxWaypoints");
    const p = guided();
    p.lifetimeTicks = 1.5;
    expectIssue(validateProjectileDef(p), "lifetimeTicks");
  });

  it("acción: producto ausente, dos productos, trigger con producto, clase desconocida", () => {
    const fire = clone(raw("test.fixture_guided_target").actions);
    delete fire[0].projectile;
    expectIssue(validateActions(fire), "actions[0]");
    const act = clone(raw("test.fixture_interference_zone").actions);
    act[0].deployable = clone(raw("test.fixture_proximity_mine").actions[0].deployable);
    expectIssue(validateActions(act), "actions[0]");
    const trg = clone(raw("test.fixture_remote_charge").actions);
    trg[1].effects = clone(raw("test.fixture_repair").actions[0].effects);
    expectIssue(validateActions(trg), "actions[1].effects");
    const unk = clone(raw("test.fixture_repair").actions);
    unk[0].kind = "drone";
    expectIssue(validateActions(unk), "kind");
    expectIssue(validateActions([]), "actions");
  });

  it("resolveActions / resolveFixtureModule lanzan V2ContractError con TODOS los problemas", () => {
    const a = clone(raw("test.fixture_repair").actions);
    a[0].effects[0].repairs = "everything";
    a[0].cost.energyEU = -1;
    try {
      resolveActions(a);
      throw new Error("no lanzó");
    } catch (e) {
      expect(e).toBeInstanceOf(V2ContractError);
      expect((e as V2ContractError).issues.length).toBeGreaterThanOrEqual(2);
    }
    expect(() => resolveFixtureModule({ ...raw("test.fixture_repair"), id: "utility.repair_kit" })).toThrow(V2ContractError);
    expect(() => resolveFixtureModule({ ...raw("test.fixture_repair"), category: "utility" })).toThrow(V2ContractError);
  });
});

describe("MC · los bloques v2 NO entran todavía en un módulo del catálogo (sin consumidor = campo falso)", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(DATA_DIR, "..", "schema", "module.schema.json"), "utf8"));
  const validateModule = ajv.compile(schema);
  const mine = loadCatalog().find((m) => m.category === "mine")!;

  for (const block of ["actions", "deployable", "effects", "projectile", "guidance", "signature", "visibility", "sensor"]) {
    it(`module.schema.json rechaza un módulo con \`${block}\``, () => {
      expect(validateModule(mine)).toBe(true);
      expect(validateModule({ ...mine, [block]: raw("test.fixture_proximity_mine").actions })).toBe(false);
    });
  }
});
