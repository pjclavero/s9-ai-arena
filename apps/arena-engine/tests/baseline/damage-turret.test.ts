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
import { ScriptBot, assertBaselineGolden, gunnerHe, publicStream } from "./helpers.js";

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
  // INVERTIDO en la integración OLA 2 (M0) por el arreglo de MB (D-B6: el impactado directo queda
  // excluido de su propia onda; puerta única resolveDamage): antes «un impacto directo HE daña DOS veces».
  it("corregido (MB): un impacto directo HE daña UNA vez (sin doble daño de la onda)", () => {
    const { events, attackerEvents, hpLoss } = heDuel(15);
    const taken = events.filter((e) => e.kind === "hit_taken");
    const dealt = attackerEvents.filter((e) => e.kind === "hit_dealt");
    expect(taken).toHaveLength(1);
    expect(dealt).toHaveLength(1);
    const direct = 45 * 0.9; // cañón × ammo.he.damageMultiplier, saco sin blindaje
    expect(taken[0].damage).toBeCloseTo(direct, 5);
    expect(hpLoss).toBeCloseTo(taken[0].damage * CHASSIS_DAMAGE_SHARE, 5);
    assertBaselineGolden("he-double-damage", {
      taken: taken.map((e) => ({ sector: e.sector, damage: e.damage })),
      hpLoss: r6(hpLoss),
    });
  });
});

describe("baseline · blindaje y torreta deducibles desde el snapshot público", () => {
  // INVERTIDO en la integración OLA 2 (M0) por MA (D-B1 = R2, frame proyectado) y MB/MA (D-B5 hullLevel N=20,
  // D-B4 blindaje cuantizado en lo público): antes «Δ hullHp público revela la reducción exacta del blindaje».
  // Con hullLevel (20 pasos) la reducción sólo se acota, no se lee con 4 decimales.
  it("corregido (MA/MB): el frame público no lleva hullHp ni hullHpMax; sólo hullLevel cuantizado", () => {
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
    // Integración OLA 2 (M0): desde MA b.snapshots son frames INTERNOS; lo público es su proyección.
    const snaps = publicStream(b).snapshots;
    b.free();
    const pub = (s: any) => s.vehicles.find((v: any) => v.team === "blue");
    const first = pub(snaps[0]);
    const last = pub(snaps[snaps.length - 1]);
    for (const v of [first, last]) {
      expect(v).not.toHaveProperty("hullHp");
      expect(v).not.toHaveProperty("hullHpMax");
      expect(Number.isInteger(v.hullLevel) && v.hullLevel >= 0 && v.hullLevel <= 20).toBe(true);
    }
    // Control: el impacto llegó (el nivel público bajó o, como poco, no subió) y el interno sí perdió hp.
    expect(last.hullLevel).toBeLessThanOrEqual(first.hullLevel);
    expect(CHASSIS_DAMAGE_SHARE).toBeGreaterThan(0);
    expect(gunnerLoadout().hullHp).toBeGreaterThan(0);
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
    // Integración OLA 2 (M0): lectura del frame PÚBLICO proyectado (antes, el snapshot del motor).
    const hs = publicStream(b).snapshots.map((s: any) => s.vehicles.find((v: any) => v.team === "red").turretHeading);
    b.free();
    let maxStep = 0;
    for (let i = 1; i < hs.length; i++) maxStep = Math.max(maxStep, Math.abs(hs[i] - hs[i - 1]));
    const estimatedRate = maxStep / TICK_DT;
    // DEFECTO #262: la velocidad de torreta (dato de equipamiento) sale exacta del público.
    expect(Math.abs(estimatedRate - 1.0) / 1.0).toBeLessThan(1e-3);
  });
});
