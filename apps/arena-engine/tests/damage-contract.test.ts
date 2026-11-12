/**
 * OLA 2 · MB · Gate DAMAGE_CONTRACT.
 *
 * Fija el contrato de daño explícito (packages/game-rules/damage-contract.ts) y la puerta
 * única (src/sim/damage.ts). Cada bloque nombra el MUTANTE que lo pone en rojo (se
 * ejecutan en serie en VM112 y se anotan en el informe MB):
 *
 *  - CHAR   caracterización: con los perfiles por defecto, la puerta nueva reproduce la
 *           fórmula D6 histórica número a número (oráculo independiente, abajo).
 *  - NORAND D-B3: ningún importe depende del RNG              (mutante: variación aleatoria)
 *  - HE     D-B6: un paquete por vehículo y detonación          (mutante: doble daño de HE)
 *  - GATE   las zonas pasan por la puerta única, sin RNG         (mutante: zona resta hullHp)
 *  - MOUNT  D-B2: tasa y arco de la MONTURA, nunca del arma      (mutante: arco del arma)
 *  - N20    D-B5: hullLevel con N = 20                           (mutante: N ≠ 20)
 *  - STATIC el motor no despacha por id de contenido ni usa Math.random
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import * as acorn from "acorn";
import {
  CHASSIS_DAMAGE_SHARE,
  DMG_MIN_FRACTION,
  MODULE_DAMAGE_SHARE,
  loadRuleset,
} from "../../../packages/game-rules/index.js";
import {
  ARMOR_LEVEL_STEPS,
  DAMAGE_TYPE_PROFILES,
  HULL_LEVEL_STEPS,
  TURRET_HEADING_QUANTUM,
  UnknownDamageTypeError,
  armorBroken,
  armorLevel,
  hullLevel,
  impactClassOf,
  normalizeAngle,
  quantizeTurretHeading,
} from "../../../packages/game-rules/damage-contract.js";
import { projectDamageForViewer, projectTurret, DAMAGE_POLICY_ROWS } from "../../../packages/projection/damage.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { canFire } from "../src/sim/combat.js";
import { resolveDamage, type EnginePacket } from "../src/sim/damage.js";
import { initPhysics } from "../src/sim/physics.js";
import { Vehicle, type VehicleSpec } from "../src/sim/vehicle.js";
import { Rng } from "../src/rng.js";
import { emptyArena, gunnerLoadout, minerLoadout, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const ROOT = join(import.meta.dirname, "../../..");
const CATALOG = loadCatalog();

const pkt = (amount: number, from: { x: number; y: number }, over: Partial<EnginePacket> = {}): EnginePacket => ({
  amount,
  type: "kinetic",
  penetration: 0,
  from,
  owner: "veh_att",
  ownerTeam: "blue",
  sourceKind: "projectile",
  seq: 0,
  ...over,
});
const POSE = { position: { x: 0, y: 0 }, heading: 0 };
const FROM = {
  front: { x: 10, y: 0 },
  left: { x: 0, y: 10 },
  right: { x: 0, y: -10 },
  rear: { x: -10, y: 0 },
} as const;

// ------------------------------------------------------------------ oráculo D6 histórico
/**
 * Copia independiente de la fórmula de `applyDamage` en f07ff6f (combat.ts:75-120), sin
 * importar código del motor: importes exactos y desgaste del blindaje. La elección de
 * módulo se compara aparte (orden por slot, decisión del contrato).
 */
function legacyAmounts(base: number, reduction: number, armorHp: number) {
  const r = armorHp > 0 ? reduction : 0;
  const effective = Math.max(DMG_MIN_FRACTION * base, base * (1 - r));
  const armorAfter = armorHp > 0 ? Math.max(0, armorHp - (base - effective)) : armorHp;
  return { effective, hull: effective * CHASSIS_DAMAGE_SHARE, module: effective * MODULE_DAMAGE_SHARE, armorAfter };
}

describe("CHAR · la puerta única reproduce la fórmula D6 histórica", () => {
  const amounts = [0.4, 5, 12, 45, 54, 100, 300];
  for (const sector of ["front", "left", "right", "rear"] as const) {
    for (const amount of amounts) {
      it(`gunner · ${sector} · ${amount}`, () => {
        const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
        const armor = v.armor[sector];
        const hp0 = v.hullHp;
        const armorHp0 = armor?.hp ?? 0;
        const exp = legacyAmounts(amount, armor?.reduction ?? 0, armorHp0);
        const rec = resolveDamage(pkt(amount, FROM[sector]), v, POSE, new Rng("c"), 7);
        expect(rec.sector).toBe(sector);
        expect(rec.effective).toBe(exp.effective);
        expect(rec.hull).toBe(exp.hull);
        expect(v.hullHp).toBe(Math.max(0, hp0 - exp.hull));
        if (armor) expect(armor.hp).toBe(exp.armorAfter);
        if (rec.moduleSlot) {
          const m = v.modules.get(rec.moduleSlot)!;
          expect(rec.moduleDamage).toBe(Math.min(m.spec.hp, exp.module));
          expect(m.hp).toBe(Math.max(0, m.spec.hp - exp.module));
        }
        expect(rec.tick).toBe(7);
      });
    }
  }

  it("desgaste hasta la rotura: el impacto que rompe lo marca y el siguiente entra íntegro", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const a = v.armor.front!;
    let legacyHp = a.hp;
    let broke = 0;
    for (let i = 0; i < 40; i++) {
      const exp = legacyAmounts(45, a.reduction, legacyHp);
      const rec = resolveDamage(pkt(45, FROM.front), v, POSE, new Rng("w" + i), i);
      expect(rec.effective).toBe(exp.effective);
      legacyHp = exp.armorAfter;
      expect(a.hp).toBe(legacyHp);
      if (rec.armorBroken) broke++;
      if (!v.alive) break;
    }
    expect(broke).toBe(1);
  });

  it("blindaje con FUENTE ÚNICA: el sector y su módulo son el mismo hp", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const a = v.armor.front!;
    resolveDamage(pkt(100, FROM.front), v, POSE, new Rng("s"), 0);
    expect(v.modules.get(a.slot)!.hp).toBe(a.hp);
    while (a.hp > 0) resolveDamage(pkt(100, FROM.front), v, POSE, new Rng("s"), 0);
    expect(v.stateOf(a.slot)).toBe("destroyed"); // la rotura es estado del módulo
  });

  it("módulo impactado: un `weighted` sobre candidatos ordenados por slot (no por loadout)", () => {
    const spec = sandbagLoadout();
    const reversed: VehicleSpec = { ...spec, modules: [...spec.modules].reverse() };
    for (let i = 0; i < 25; i++) {
      const a = resolveDamage(pkt(30, FROM.rear), new Vehicle("a", "red", "b", spec), POSE, new Rng("m" + i), 0);
      const b = resolveDamage(pkt(30, FROM.rear), new Vehicle("a", "red", "b", reversed), POSE, new Rng("m" + i), 0);
      expect(b.moduleSlot).toBe(a.moduleSlot);
    }
  });

  it("los perfiles por defecto reproducen D6 (kinetic = explosive) y el ambiental va íntegro al casco", () => {
    for (const id of ["kinetic", "explosive", "thermal", "electronic"]) {
      const p = DAMAGE_TYPE_PROFILES[id]!;
      expect([p.hullShare, p.moduleShare, p.minFraction, p.armorWearFactor, p.armorApplies, p.usesSector]).toEqual([
        CHASSIS_DAMAGE_SHARE,
        MODULE_DAMAGE_SHARE,
        DMG_MIN_FRACTION,
        1,
        true,
        true,
      ]);
    }
    const env = DAMAGE_TYPE_PROFILES.environmental!;
    expect([env.hullShare, env.moduleShare, env.armorApplies, env.usesSector]).toEqual([1, 0, false, false]);
  });

  it("tipo sin perfil = error (fail-closed), también `__proto__`", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    expect(() => resolveDamage(pkt(10, FROM.front, { type: "test.fixture.nope" }), v, POSE, new Rng("x"), 0)).toThrow(
      UnknownDamageTypeError,
    );
    expect(() => resolveDamage(pkt(10, FROM.front, { type: "__proto__" }), v, POSE, new Rng("x"), 0)).toThrow(
      UnknownDamageTypeError,
    );
  });

  it("un tipo nuevo es una FILA de datos (test.fixture.*), sin tocar código", () => {
    const profiles = {
      ...DAMAGE_TYPE_PROFILES,
      "test.fixture.halfhull": { ...DAMAGE_TYPE_PROFILES.kinetic!, id: "test.fixture.halfhull", hullShare: 0.5 },
    };
    const v = new Vehicle("veh_t", "red", "bot_t", sandbagLoadout());
    const rec = resolveDamage(
      pkt(10, FROM.rear, { type: "test.fixture.halfhull" }),
      v,
      POSE,
      new Rng("x"),
      0,
      profiles,
    );
    expect(rec.hull).toBe(5);
  });

  it("penetración en unidades de resistencia: reduction = clamp(r − p, 0, 1)", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const r = v.armor.front!.reduction;
    const rec = resolveDamage(pkt(100, FROM.front, { penetration: 0.1 }), v, POSE, new Rng("p"), 0);
    expect(rec.reduction).toBeCloseTo(r - 0.1, 12);
    const rec2 = resolveDamage(pkt(100, FROM.front, { penetration: 5 }), v, POSE, new Rng("p"), 0);
    expect(rec2.reduction).toBe(0);
  });
});

// ------------------------------------------------------------------ D-B3
describe("NORAND · D-B3: sin variación aleatoria de daño", () => {
  const amountsOf = (seed: string | null, sector: keyof typeof FROM, amount: number) => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const rng =
      seed === null
        ? // Trampa: sólo se permite UNA elección ponderada de módulo; cualquier otra tirada revienta.
          ({
            weighted: () => 0,
            next: () => {
              throw new Error("el importe del daño ha consumido RNG");
            },
          } as unknown as Rng)
        : new Rng(seed);
    const rec = resolveDamage(pkt(amount, FROM[sector]), v, POSE, rng, 0);
    return [rec.effective, rec.hull, rec.absorbed, rec.reduction, rec.moduleDamage, v.hullHp, v.armor.front!.hp];
  };

  for (const sector of ["front", "left", "rear"] as const) {
    for (const amount of [12, 45, 100]) {
      it(`${sector} · ${amount}: 40 semillas, mismos importes; sólo cambia QUÉ módulo`, () => {
        const ref = amountsOf("seed-0", sector, amount);
        for (let i = 1; i < 40; i++) expect(amountsOf(`seed-${i}`, sector, amount)).toEqual(ref);
        expect(amountsOf(null, sector, amount)).toEqual(ref);
      });
    }
  }

  it("el daño ambiental no consume RNG en absoluto", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const trap = {
      weighted: () => {
        throw new Error("rng");
      },
      next: () => {
        throw new Error("rng");
      },
    } as unknown as Rng;
    const rec = resolveDamage(
      pkt(0.4, FROM.front, { type: "environmental", owner: null, ownerTeam: null, sourceKind: "zone" }),
      v,
      POSE,
      trap,
      0,
    );
    expect(rec.hull).toBe(0.4);
    expect(rec.sector).toBeNull();
    expect(rec.moduleSlot).toBeNull();
  });
});

// ------------------------------------------------------------------ batallas cortas
/** Apunta la torreta a un punto fijo y dispara la ranura en cada decisión. */
class AimFireBot implements BotAgent {
  constructor(
    readonly botId: string,
    private target: { x: number; y: number },
  ) {}
  decide(obs: any) {
    return { forTick: obs.tick, turret: { targetPoint: this.target }, fire: ["turret_main"] };
  }
}

/** IdleBot que registra sus eventos privados. */
class RecordingBot extends IdleBot {
  events: any[] = [];
  onEvent(e: any) {
    this.events.push(e);
  }
}

const heGunner = (): VehicleSpec =>
  resolveVehicle(
    {
      ...ARCHETYPES.gunner,
      modules: ARCHETYPES.gunner.modules.map((m) => (m.slot === "turret_main" ? { ...m, ammo: "ammo.he@1" } : m)),
    },
    CATALOG,
  );

describe("HE · D-B6: un paquete por vehículo y detonación", () => {
  it("el impactado directo recibe SÓLO el impacto directo; el vecino, sólo la onda", () => {
    const map = emptyArena();
    map.spawns = [
      { team: "red", position: { x: 20, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 40, y: 40 }, heading: Math.PI },
      { team: "blue", position: { x: 41, y: 43.5 }, heading: Math.PI },
    ];
    const b = new Battle({
      battleId: "mb_he",
      seed: "he",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, respawn: { enabled: false, delayTicks: 0 } }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: heGunner() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
        { id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new AimFireBot("b1", { x: 40, y: 40 }));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.attachBot("veh_3", new IdleBot("b3"));

    let directHits = 0;
    let splash = 0;
    for (let t = 0; t < 300 && !b.isFinished(); t++) {
      b.step();
      const recs = b.damageRecordsOfLastTick();
      const perTarget = new Map<string, number>();
      for (const r of recs) perTarget.set(r.target, (perTarget.get(r.target) ?? 0) + 1);
      // Un único disparo puede estar en vuelo a la vez (cadencia 30 ticks, vuelo < 6).
      for (const [target, n] of perTarget) expect(n, `${target} recibió ${n} paquetes en el tick ${b.tick}`).toBe(1);
      for (const r of recs) {
        if (r.target === "veh_2") {
          expect(r.sourceKind).toBe("projectile");
          expect(r.type).toBe("kinetic");
          directHits++;
        }
        if (r.target === "veh_3") {
          expect(r.sourceKind).toBe("explosion");
          expect(r.type).toBe("explosive");
          splash++;
        }
      }
    }
    expect(directHits).toBeGreaterThan(0);
    expect(splash).toBeGreaterThan(0);
    b.free();
  }, 30_000);
});

describe("GATE · las zonas pasan por la puerta única", () => {
  it("cada punto de casco perdido en el ácido tiene su registro `environmental`, sin hit_taken", () => {
    const map = emptyArena();
    map.zones = [{ id: "acid", position: { x: 20, y: 40 }, radiusM: 5, kind: "damage", damagePerSecond: 30 }];
    const b = new Battle({
      battleId: "mb_zone",
      seed: "zone",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 900, respawn: { enabled: false, delayTicks: 0 } }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    const bot = new RecordingBot("b1");
    b.attachBot("veh_1", bot);
    b.attachBot("veh_2", new IdleBot("b2"));
    const v = (b as unknown as { vehicles: Vehicle[] }).vehicles.find((x) => x.id === "veh_1")!;
    let records = 0;
    for (let t = 0; t < 900 && v.alive; t++) {
      const before = v.hullHp;
      b.step();
      const mine = b.damageRecordsOfLastTick().filter((r) => r.target === "veh_1");
      const lost = before - v.hullHp;
      const accounted = mine.reduce((s, r) => s + r.hull, 0);
      expect(Math.min(accounted, before)).toBeCloseTo(lost, 9);
      for (const r of mine) {
        expect(r.type).toBe("environmental");
        expect(r.owner).toBeNull();
        expect(r.sourceKind).toBe("zone");
      }
      records += mine.length;
    }
    expect(records).toBeGreaterThan(0);
    expect(v.alive).toBe(false);
    expect(bot.events.some((e) => e.kind === "hit_taken" || e.kind === "hit_dealt")).toBe(false);
    b.free();
  }, 30_000);
});

// ------------------------------------------------------------------ D-B2
/** Gunner real con la montura sustituida y CAMPOS TRAMPA en el arma (legado). */
function mountedGunner(mount: { turretRateRads: number; turretArcRad: number }): VehicleSpec {
  const spec = gunnerLoadout();
  return {
    ...spec,
    turretMounts: { turret_main: mount },
    modules: spec.modules.map((m) =>
      m.category === "weapon" ? ({ ...m, turretRateRads: 50, turretArcRad: Math.PI * 2 } as typeof m) : m,
    ),
  };
}

describe("MOUNT · D-B2: tasa y arco son de la montura", () => {
  it("la tasa de giro es la de la montura (el campo del arma se ignora)", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", mountedGunner({ turretRateRads: 0.6, turretArcRad: Math.PI * 2 }));
    expect(v.turretRate()).toBeCloseTo(0.6, 12);
    v.lastTurretTarget = 2;
    v.stepTurret(1 / 30);
    expect(v.turretHeading).toBeCloseTo(0.6 / 30, 12);
  });

  it("el arco LIMITA EL GIRO (no sólo el disparo) y no se cruza la zona prohibida", () => {
    const arc = Math.PI / 2;
    const v = new Vehicle("veh_t", "red", "bot_t", mountedGunner({ turretRateRads: 3, turretArcRad: arc }));
    v.heading = 0.3;
    v.lastTurretTarget = 0.3 + Math.PI; // justo detrás
    for (let i = 0; i < 120; i++) {
      v.stepTurret(1 / 30);
      const rel = normalizeAngle(v.turretHeading - v.heading);
      expect(Math.abs(rel)).toBeLessThanOrEqual(arc / 2 + 1e-9);
    }
    // En el borde del arco puede disparar; el borde es alcanzable.
    expect(Math.abs(normalizeAngle(v.turretHeading - v.heading))).toBeCloseTo(arc / 2, 9);
    expect(canFire(v, "turret_main", 0, new Rng("f"))).not.toBe("out_of_arc");
    // Con la torreta a la izquierda y el objetivo a la derecha, va por DENTRO del arco.
    v.lastTurretTarget = v.heading - arc / 2;
    let prev = normalizeAngle(v.turretHeading - v.heading);
    for (let i = 0; i < 60; i++) {
      v.stepTurret(1 / 30);
      const rel = normalizeAngle(v.turretHeading - v.heading);
      expect(rel).toBeLessThanOrEqual(prev + 1e-12);
      prev = rel;
    }
    expect(prev).toBeCloseTo(-arc / 2, 9);
  });

  it("el chasis que gira arrastra la torreta dentro del arco", () => {
    const arc = Math.PI / 3;
    const v = new Vehicle("veh_t", "red", "bot_t", mountedGunner({ turretRateRads: 0.1, turretArcRad: arc }));
    v.lastTurretTarget = 0;
    for (let i = 0; i < 90; i++) {
      v.heading = normalizeAngle(v.heading + 0.05);
      v.stepTurret(1 / 30);
      expect(Math.abs(normalizeAngle(v.turretHeading - v.heading))).toBeLessThanOrEqual(arc / 2 + 1e-9);
    }
  });

  it("canFire consulta el arco de la MONTURA de la ranura", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", mountedGunner({ turretRateRads: 1, turretArcRad: Math.PI / 4 }));
    v.turretHeading = 1.0; // fuera de ±π/8 (sin pasar por stepTurret)
    expect(canFire(v, "turret_main", 0, new Rng("f"))).toBe("out_of_arc");
  });

  it("una ranura de arma sin montura no gira (fail-closed)", () => {
    const spec = { ...gunnerLoadout(), turretMounts: {} };
    const v = new Vehicle("veh_t", "red", "bot_t", spec);
    expect(v.turretRate()).toBe(0);
  });

  it("el ángulo interno queda normalizado a (−π, π] aunque la torreta dé vueltas", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", mountedGunner({ turretRateRads: 3, turretArcRad: Math.PI * 2 }));
    for (let i = 0; i < 600; i++) {
      v.lastTurretTarget = v.turretHeading + 1; // siempre por delante: gira sin parar
      v.stepTurret(1 / 30);
      expect(v.turretHeading).toBeGreaterThan(-Math.PI);
      expect(v.turretHeading).toBeLessThanOrEqual(Math.PI);
    }
  });

  it("catálogo: ninguna arma declara tasa ni arco; toda ranura de arma tiene montura", () => {
    for (const m of CATALOG) {
      const raw = m as unknown as Record<string, unknown>;
      expect(raw.turretRateRads, `${m.id}@${m.version}`).toBeUndefined();
      expect(raw.turretArcRad, `${m.id}@${m.version}`).toBeUndefined();
      for (const s of m.slots ?? []) {
        if (s.accepts.includes("weapon")) expect(s.mount, `${m.id}@${m.version}.${s.id}`).toBeDefined();
        else expect(s.mount, `${m.id}@${m.version}.${s.id}`).toBeUndefined();
      }
    }
    expect(gunnerLoadout().turretMounts?.turret_main).toEqual({ turretRateRads: 1, turretArcRad: 6.2832 });
  });
});

// Tasa de giro por chasis/montura (OLA2-MB, P2-1): fija el cambio de comportamiento de D-B2. Antes la fijaba el arma
// (mg 2,2 / cañón 1,0); ahora la fija la montura del chasis. Un vehículo que monte el MISMO arma gira distinto
// según el chasis; un cambio de la tabla debe ser deliberado.
describe("MOUNT · tasa efectiva de giro por chasis y ranura (comportamiento resuelto)", () => {
  // Mismo loadout del explorador (weapon.mg@1) sobre otro chasis.
  const rateOf = (chassis: string) =>
    new Vehicle("veh_r", "red", "bot_r", resolveVehicle({ ...ARCHETYPES.scout, chassis }, CATALOG)).turretRate();
  it("resuelto de los arquetipos: scout 2,2 · gunner 1,0 · miner 1,0 (antes 2,2) · heavy 1,0", () => {
    expect(new Vehicle("a", "red", "b", scoutLoadout()).turretRate()).toBeCloseTo(2.2, 12);
    expect(new Vehicle("a", "red", "b", gunnerLoadout()).turretRate()).toBeCloseTo(1.0, 12);
    expect(new Vehicle("a", "red", "b", minerLoadout()).turretRate()).toBeCloseTo(1.0, 12);
    expect(new Vehicle("a", "red", "b", resolveVehicle(ARCHETYPES.heavy, CATALOG)).turretRate()).toBeCloseTo(1.0, 12);
  });
  it("el mismo arma gira según el chasis: weapon.mg en light 2,2 y en medium 1,0", () => {
    expect(rateOf("chassis.light@1")).toBeCloseTo(2.2, 12);
    expect(rateOf("chassis.medium@1")).toBeCloseTo(1.0, 12);
    expect(rateOf("chassis.medium@2")).toBeCloseTo(1.0, 12);
  });
});

// ------------------------------------------------------------------ D-B4 / D-B5
describe("N20 · contrato público: hullLevel N = 20 y blindaje cuantizado", () => {
  it("N es 20", () => {
    expect(HULL_LEVEL_STEPS).toBe(20);
  });

  it("hullLevel = ceil(20·hp/hpMax), vivo ≥ 1, muerto 0", () => {
    const cases: [number, number, number][] = [
      [300, 300, 20],
      [285.0001, 300, 20],
      [285, 300, 19],
      [151, 300, 11],
      [150, 300, 10],
      [15, 300, 1],
      [0.0001, 300, 1],
      [0, 300, 0],
      [180, 180, 20],
      [9, 180, 1],
      [9.0001, 180, 2],
    ];
    for (const [hp, max, lvl] of cases) expect(hullLevel(hp, max), `${hp}/${max}`).toBe(lvl);
  });

  it("blindaje público: K niveles y rotura", () => {
    expect(ARMOR_LEVEL_STEPS).toBe(4);
    expect([
      armorLevel(200, 200),
      armorLevel(150, 200),
      armorLevel(149, 200),
      armorLevel(1, 200),
      armorLevel(0, 200),
    ]).toEqual([4, 3, 3, 1, 0]);
    expect(armorBroken(0, 200)).toBe(true);
    expect(armorBroken(0.1, 200)).toBe(false);
  });

  it("impactClassOf se decide por hechos discretos, nunca por importes", () => {
    expect(impactClassOf({ killed: true, armorBroken: false, moduleDestroyed: false })).toBe("kill");
    expect(impactClassOf({ killed: false, armorBroken: true, moduleDestroyed: false })).toBe("critical");
    expect(impactClassOf({ killed: false, armorBroken: false, moduleDestroyed: true })).toBe("critical");
    expect(impactClassOf({ killed: false, armorBroken: false, moduleDestroyed: false })).toBe("hit");
  });

  const ctx = (audienceClass: string) =>
    ({ audienceClass, policy: { id: "t", version: 1, regime: "R2", fields: DAMAGE_POLICY_ROWS } }) as never;

  it("el proyector público no deja salir hp exacto, hpMax ni reducción", () => {
    const view = {
      hullHp: 151,
      hullHpMax: 300,
      alive: true,
      armor: { front: { hp: 0, hpMax: 200 }, rear: { hp: 37.25, hpMax: 120 } },
      modules: [],
    };
    for (const aud of ["public_live", "broadcast", "public_replay"]) {
      const out = projectDamageForViewer(view, ctx(aud));
      expect(Object.keys(out).sort()).toEqual(["alive", "armorBroken", "hullLevel"]);
      expect(out.hullLevel).toBe(11);
      expect(out.armorBroken).toEqual({ front: true, rear: false });
      expect(JSON.stringify(out)).not.toMatch(/151|300|200|37\.25|120/);
    }
  });

  it("dos hp distintos del mismo nivel proyectan idéntico (oráculo de un impacto cerrado)", () => {
    const base = { hullHpMax: 300, alive: true, armor: { front: { hp: 120, hpMax: 200 } }, modules: [] };
    const a = projectDamageForViewer({ ...base, hullHp: 151.7 }, ctx("public_live"));
    const b = projectDamageForViewer({ ...base, hullHp: 165 }, ctx("public_live"));
    expect(a).toEqual(b);
  });

  it("torreta pública: normalizada y múltiplo del cuanto", () => {
    for (const a of [0, 0.123456, -3.1, 3.14159, 7.5, -12.2, Math.PI, -Math.PI]) {
      const h = projectTurret({ heading: a }, ctx("public_live")).heading;
      expect(h).toBeGreaterThan(-Math.PI);
      expect(h).toBeLessThanOrEqual(Math.PI);
      const k = h / TURRET_HEADING_QUANTUM;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      expect(h).toBe(quantizeTurretHeading(a));
    }
  });
});

// ------------------------------------------------------------------ estático (AST)
/**
 * Semántica, no texto: se quitan los tipos con el transformador de Node (posiciones
 * intactas) y se recorre el ESTree de acorn, como apps/api/src/server-wiring.test.ts.
 */
type EsNode = { type: string; start: number; end: number; [k: string]: unknown };
function astOf(file: string): { src: string; ast: EsNode } {
  const src = readFileSync(join(ROOT, file), "utf8");
  const js = stripTypeScriptTypes(src, { mode: "strip" });
  return { src, ast: acorn.parse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as EsNode };
}
function walk(n: unknown, f: (n: EsNode) => void): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const c of n) walk(c, f);
    return;
  }
  const node = n as EsNode;
  if (typeof node.type === "string") f(node);
  for (const k of Object.keys(node)) if (k !== "type") walk(node[k], f);
}
const isMember = (n: unknown, prop?: string): n is EsNode =>
  !!n &&
  (n as EsNode).type === "MemberExpression" &&
  (prop === undefined || ((n as any).property?.type === "Identifier" && (n as any).property.name === prop));
const isStringLit = (n: unknown) => !!n && (n as EsNode).type === "Literal" && typeof (n as any).value === "string";

describe("STATIC · la capa de daño no despacha por contenido ni usa azar", () => {
  const files = [
    "apps/arena-engine/src/sim/damage.ts",
    "apps/arena-engine/src/sim/combat.ts",
    "apps/arena-engine/src/sim/vehicle.ts",
    "packages/game-rules/damage-contract.ts",
    "packages/projection/damage.ts",
  ];
  const CONTENT_KEYS = new Set(["type", "moduleId", "id", "damageType", "ammo", "weapon"]);

  for (const f of files) {
    it(`${f}: sin Math.random y sin comparar tipo/moduleId con literales`, () => {
      const { src, ast } = astOf(f);
      const bad: string[] = [];
      walk(ast, (n) => {
        if (isMember(n, "random") && (n as any).object?.type === "Identifier" && (n as any).object.name === "Math") {
          bad.push(`Math.random: ${src.slice(n.start, n.end)}`);
        }
        if (n.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes((n as any).operator)) {
          const { left, right } = n as any;
          const other = isStringLit(left) ? right : isStringLit(right) ? left : null;
          const prop = other && isMember(other) ? (other as any).property : null;
          if (prop?.type === "Identifier" && CONTENT_KEYS.has(prop.name)) {
            bad.push(src.slice(n.start, n.end));
          }
        }
      });
      expect(bad).toEqual([]);
    });
  }

  it("el motor nunca lee tasa ni arco de torreta de un módulo (sólo de la montura)", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of [
      "apps/arena-engine/src/sim/vehicle.ts",
      "apps/arena-engine/src/sim/combat.ts",
      "apps/arena-engine/src/sim/battle.ts",
    ]) {
      const { src, ast } = astOf(f);
      walk(ast, (n) => {
        if (isMember(n, "turretRateRads") || isMember(n, "turretArcRad")) {
          seen++;
          const recv = (n as any).object as EsNode;
          if (!/mount/i.test(src.slice(recv.start, recv.end))) bad.push(`${f}: ${src.slice(n.start, n.end)}`);
        }
      });
    }
    expect(seen).toBeGreaterThan(0); // el detector ve las lecturas legítimas de la montura
    expect(bad).toEqual([]);
  });

  it("el proyector público no importa tipos de simulación (F7)", () => {
    const { ast } = astOf("packages/projection/damage.ts");
    const imports: string[] = [];
    walk(ast, (n) => {
      if (n.type === "ImportDeclaration") imports.push(String((n as any).source.value));
    });
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).not.toMatch(/arena-engine|sim\//);
  });
});
