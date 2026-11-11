/**
 * OLA 2 · ME · BASELINE · daño, HE, blindaje y torreta (C-DMG-1/2, C-TUR-1/2).
 *
 * Fija el modelo D6 tal y como se ejecuta en el BASE_SHA: tabla numérica de applyDamage,
 * daño de casco sin variación aleatoria, HE con doble daño (directo + explosión) y la
 * deducción de blindaje y de velocidad de torreta desde el snapshot público. Los dos
 * últimos son DEFECTOS conocidos (#262/#263) que MB invierte.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHASSIS_DAMAGE_SHARE, TICK_DT, loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { applyDamage } from "../../src/sim/combat.js";
import { initPhysics } from "../../src/sim/physics.js";
import { Vehicle } from "../../src/sim/vehicle.js";
import { Rng } from "../../src/rng.js";
import { emptyArena, gunnerLoadout, sandbagLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { ScriptBot, assertBaselineGolden, gunnerHe } from "./helpers.js";

beforeAll(async () => {
  await initPhysics();
});

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const FROM = {
  front: { x: 10, y: 0 },
  rear: { x: -10, y: 0 },
  left: { x: 0, y: 10 },
  right: { x: 0, y: -10 },
} as const;

describe("baseline · applyDamage (D6) tabla numérica", () => {
  it("tabla por sector × daño base × loadout con semilla fija (golden)", () => {
    const rows: any[] = [];
    for (const [name, mk] of [
      ["gunner", gunnerLoadout],
      ["sandbag", sandbagLoadout],
    ] as const) {
      for (const sector of Object.keys(FROM) as (keyof typeof FROM)[]) {
        for (const base of [10, 45, 100]) {
          const v = new Vehicle("veh_t", "red", "bot_t", mk());
          const res = applyDamage(
            v,
            base,
            FROM[sector],
            { x: 0, y: 0 },
            0,
            new Rng(`me-dmg-${name}-${sector}-${base}`),
          );
          rows.push({
            loadout: name,
            sector,
            base,
            res: {
              sector: res.sector,
              effective: r6(res.effectiveDamage),
              hull: r6(res.hullDamage),
              moduleSlot: res.moduleSlot,
              moduleDamage: r6(res.moduleDamage),
              moduleDestroyed: res.moduleDestroyed,
              killed: res.killed,
            },
            hullHpAfter: r6(v.hullHp),
            armorAfter: Object.fromEntries(Object.entries(v.armor).map(([s, a]) => [s, r6(a!.hp)])),
          });
        }
      }
    }
    assertBaselineGolden("damage-table", rows);
  });

  it("desgaste del blindaje frontal impacto a impacto hasta romperse (golden)", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const seq: any[] = [];
    for (let i = 0; i < 12; i++) {
      const res = applyDamage(v, 54, FROM.front, { x: 0, y: 0 }, 0, new Rng(`me-wear-${i}`));
      seq.push({ i, effective: r6(res.effectiveDamage), armorFront: r6(v.armor.front!.hp), hull: r6(v.hullHp) });
    }
    assertBaselineGolden("damage-armor-wear", seq);
  });

  it("D-B3 · el daño de CASCO no tiene variación aleatoria: misma base y sector ⇒ mismo daño con 20 semillas", () => {
    const hulls = new Set<number>();
    for (let s = 0; s < 20; s++) {
      const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
      hulls.add(r6(applyDamage(v, 45, FROM.left, { x: 0, y: 0 }, 0, new Rng(`seed-${s}`)).hullDamage));
    }
    expect([...hulls]).toEqual([r6(45 * CHASSIS_DAMAGE_SHARE)]);
  });
});

/** Batalla mínima: tirador HE frente a un saco de arena a `dist` m, en línea. */
function heDuel(dist: number) {
  const map = emptyArena(200, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 20 + dist, y: 40 }, heading: Math.PI },
  ];
  const b = new Battle({
    battleId: "me_he",
    seed: "me-he",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerHe() },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  const events: any[] = [];
  const attackerEvents: any[] = [];
  const shooter = new ScriptBot("b1", (t) => (t === 0 ? { fire: ["turret_main"] } : undefined)) as any;
  shooter.onEvent = (e: any) => attackerEvents.push(e);
  const target = new IdleBot("b2") as any;
  target.onEvent = (e: any) => events.push(e);
  b.attachBot("veh_1", shooter);
  b.attachBot("veh_2", target);
  for (let t = 0; t < 30; t++) b.step();
  const hp = b.getVehicle("veh_2")!.hullHp;
  const hpMax = b.getVehicle("veh_2")!.spec.hullHp;
  b.free();
  return { events, attackerEvents, hpLoss: hpMax - hp };
}

describe("baseline · munición HE", () => {
  it("characterizes-defect: un impacto directo HE daña DOS veces (directo + explosión) en el mismo tick", () => {
    const { events, attackerEvents, hpLoss } = heDuel(15);
    const taken = events.filter((e) => e.kind === "hit_taken");
    const dealt = attackerEvents.filter((e) => e.kind === "hit_dealt");
    // DEFECTO D-B6: dos hit_taken del mismo proyectil, en el mismo tick.
    expect(taken).toHaveLength(2);
    expect(taken[0].tick).toBe(taken[1].tick);
    expect(dealt).toHaveLength(2);
    const direct = 45 * 0.9; // cañón × ammo.he.damageMultiplier, saco sin blindaje
    expect(taken[0].damage).toBeCloseTo(direct, 5);
    expect(taken[1].damage).toBeGreaterThan(0);
    expect(taken[1].damage).toBeLessThan(direct);
    expect(hpLoss).toBeCloseTo((taken[0].damage + taken[1].damage) * CHASSIS_DAMAGE_SHARE, 5);
    assertBaselineGolden("he-double-damage", {
      taken: taken.map((e) => ({ sector: e.sector, damage: e.damage })),
      hpLoss: r6(hpLoss),
    });
  });
});

describe("baseline · blindaje y torreta deducibles desde el snapshot público", () => {
  it("characterizes-defect: Δ hullHp público tras un impacto frontal revela la reducción exacta del blindaje", () => {
    const map = emptyArena(200, 80);
    map.spawns = [
      { team: "red", position: { x: 20, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 40, y: 40 }, heading: Math.PI }, // morro hacia el tirador
    ];
    const b = new Battle({
      battleId: "me_armor",
      seed: "me-armor",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
      map,
      snapshotEveryNTicks: 1,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new ScriptBot("b1", (t) => (t === 0 ? { fire: ["turret_main"] } : undefined)));
    b.attachBot("veh_2", new IdleBot("b2"));
    for (let t = 0; t < 30; t++) b.step();
    const snaps = b.snapshots;
    b.free();
    const pub = (s: any) => s.vehicles.find((v: any) => v.id === "veh_2");
    const before = pub(snaps[0]).hullHp;
    const after = pub(snaps[snaps.length - 1]).hullHp;
    const hullHpMax = pub(snaps[0]).hullHpMax;
    // Lo que un espectador puede calcular sólo con datos públicos + catálogo público:
    const base = 45 * 1.2; // cañón × ammo.ap
    const effective = (before - after) / CHASSIS_DAMAGE_SHARE;
    const inferredReduction = 1 - effective / base;
    expect(hullHpMax).toBe(gunnerLoadout().hullHp);
    expect(inferredReduction).toBeCloseTo(0.35, 4); // armor.steel_front@1.reduction exacta
  });

  it("C-TUR-1 · la torreta gira a turretRateRads · performance por tick (cañón 1 rad/s)", () => {
    const map = emptyArena(200, 80);
    const b = new Battle({
      battleId: "me_turret",
      seed: "me-turret",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 200 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new ScriptBot("b1", () => ({ turret: { targetHeading: Math.PI / 2 } })));
    b.attachBot("veh_2", new IdleBot("b2"));
    const h0 = b.getVehicle("veh_1")!.turretHeading;
    for (let t = 0; t < 10; t++) b.step();
    const h10 = b.getVehicle("veh_1")!.turretHeading;
    b.free();
    expect(h10 - h0).toBeCloseTo(10 * 1.0 * TICK_DT, 9);
  });

  it("characterizes-defect: turretHeading público (round6) permite estimar turretRateRads con error < 0,1 %", () => {
    const map = emptyArena(200, 80);
    const b = new Battle({
      battleId: "me_turret_leak",
      seed: "me-turret-leak",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 200 }),
      map,
      snapshotEveryNTicks: 1,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new ScriptBot("b1", () => ({ turret: { targetHeading: Math.PI / 2 } })));
    b.attachBot("veh_2", new IdleBot("b2"));
    for (let t = 0; t < 20; t++) b.step();
    const hs = b.snapshots.map((s: any) => s.vehicles.find((v: any) => v.id === "veh_1").turretHeading);
    b.free();
    let maxStep = 0;
    for (let i = 1; i < hs.length; i++) maxStep = Math.max(maxStep, Math.abs(hs[i] - hs[i - 1]));
    const estimatedRate = maxStep / TICK_DT;
    // DEFECTO #262: la velocidad de torreta (dato de equipamiento) sale exacta del público.
    expect(Math.abs(estimatedRate - 1.0) / 1.0).toBeLessThan(1e-3);
  });
});
