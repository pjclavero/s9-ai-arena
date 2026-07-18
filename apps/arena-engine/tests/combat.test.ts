/**
 * T2.3 · Armas, daño por sectores y estados de módulo.
 *
 * La matriz de daño se comprueba contra la tabla de game-rules, no contra números
 * mágicos: si alguien cambia DMG_MIN_FRACTION en el ADR, estos tests deben seguir
 * pasando porque calculan el esperado a partir de la misma fuente.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHASSIS_DAMAGE_SHARE,
  DMG_MIN_FRACTION,
  MODULE_DAMAGE_SHARE,
  loadRuleset,
} from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { applyDamage, canDeployMine, canFire, sectorOfImpact } from "../src/sim/combat.js";
import { initPhysics, PhysicsWorld } from "../src/sim/physics.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { Rng } from "../src/rng.js";
import { MODULES, emptyArena, gunnerLoadout, sandbagLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const mkVehicle = () => new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());

describe("sector de impacto", () => {
  const pos = { x: 0, y: 0 };
  const heading = 0; // mirando a +X

  it("un impacto de frente es sector frontal", () => {
    expect(sectorOfImpact(heading, { x: 10, y: 0 }, pos)).toBe("front");
  });

  it("un impacto por detrás es sector trasero", () => {
    expect(sectorOfImpact(heading, { x: -10, y: 0 }, pos)).toBe("rear");
  });

  it("los laterales se distinguen (izquierda = +Y con antihorario positivo, D1)", () => {
    expect(sectorOfImpact(heading, { x: 0, y: 10 }, pos)).toBe("left");
    expect(sectorOfImpact(heading, { x: 0, y: -10 }, pos)).toBe("right");
  });

  it("el sector se calcula relativo al morro, no en absoluto", () => {
    // Mismo atacante, vehículo girado 180°: ahora le da por detrás.
    expect(sectorOfImpact(Math.PI, { x: 10, y: 0 }, pos)).toBe("rear");
  });
});

describe("matriz de daño (D6)", () => {
  it("impacto SIN blindaje: el daño llega íntegro, repartido 70/30", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", sandbagLoadout()); // sin blindaje
    const hp0 = v.hullHp;
    const res = applyDamage(v, 100, { x: -10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("d"));

    expect(res.sector).toBe("rear");
    expect(res.effectiveDamage).toBeCloseTo(100, 5);
    expect(res.hullDamage).toBeCloseTo(100 * CHASSIS_DAMAGE_SHARE, 5);
    expect(hp0 - v.hullHp).toBeCloseTo(100 * CHASSIS_DAMAGE_SHARE, 5);
    // El 30 % restante fue a un módulo.
    expect(res.moduleDamage).toBeCloseTo(100 * MODULE_DAMAGE_SHARE, 5);
    expect(res.moduleSlot).toBeTruthy();
  });

  it("impacto CON blindaje frontal: el daño se reduce según la tabla", () => {
    const v = mkVehicle(); // lleva armorFront con reduction 0.35
    const reduction = MODULES.armorFront.reduction!;
    const res = applyDamage(v, 100, { x: 10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("d"));

    expect(res.sector).toBe("front");
    expect(res.effectiveDamage).toBeCloseTo(100 * (1 - reduction), 5); // 65
  });

  it("el mismo daño duele MÁS por el sector sin blindaje: la posición importa", () => {
    const front = applyDamage(mkVehicle(), 100, { x: 10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("d"));
    const side = applyDamage(mkVehicle(), 100, { x: 0, y: 10 }, { x: 0, y: 0 }, 0, new Rng("d"));
    expect(side.effectiveDamage).toBeGreaterThan(front.effectiveDamage);
  });

  it("el blindaje NUNCA anula el daño: suelo de DMG_MIN_FRACTION", () => {
    // Un blindaje absurdo (reduction 0.99) sigue dejando pasar el 10 %.
    const v = mkVehicle();
    v.armor.front!.reduction = 0.99;
    const res = applyDamage(v, 100, { x: 10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("d"));
    expect(res.effectiveDamage).toBeCloseTo(100 * DMG_MIN_FRACTION, 5);
    expect(res.effectiveDamage).toBeGreaterThan(0);
  });

  it("el blindaje se desgasta con lo que absorbe y acaba cediendo", () => {
    const v = mkVehicle();
    const hp0 = v.armor.front!.hp;
    for (let i = 0; i < 20; i++) {
      applyDamage(v, 100, { x: 10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("d" + i));
    }
    expect(v.armor.front!.hp).toBeLessThan(hp0);
    expect(v.armor.front!.hp).toBe(0);

    // Con el blindaje a cero, el daño frontal ya entra entero.
    const res = applyDamage(v, 100, { x: 10, y: 0 }, { x: 0, y: 0 }, 0, new Rng("z"));
    expect(res.effectiveDamage).toBeCloseTo(100, 5);
  });

  it("el chasis a 0 destruye el vehículo", () => {
    const v = mkVehicle();
    let killed = false;
    for (let i = 0; i < 50 && !killed; i++) {
      killed = applyDamage(v, 100, { x: 0, y: 10 }, { x: 0, y: 0 }, 0, new Rng("k" + i)).killed;
    }
    expect(killed).toBe(true);
    expect(v.alive).toBe(false);
    expect(v.hullHp).toBe(0);
  });
});

describe("estados de módulo y degradación (cap. 12.2)", () => {
  it("los estados siguen los umbrales del ADR conforme baja la salud", () => {
    const v = mkVehicle();
    const drive = v.modules.get("drive")!;
    const max = drive.spec.hp;

    drive.hp = max;
    expect(v.stateOf("drive")).toBe("operational");
    drive.hp = max * 0.5; // < 0.66
    expect(v.stateOf("drive")).toBe("damaged");
    drive.hp = max * 0.2; // < 0.33
    expect(v.stateOf("drive")).toBe("critical");
    drive.hp = 0;
    expect(v.stateOf("drive")).toBe("destroyed");
  });

  it("un motor de movimiento CRÍTICO reduce la velocidad según la tabla", () => {
    const v = mkVehicle();
    const full = v.movementCaps()!;
    v.modules.get("drive")!.hp = v.modules.get("drive")!.spec.hp * 0.2; // crítico
    const degraded = v.movementCaps()!;

    expect(v.stateOf("drive")).toBe("critical");
    expect(degraded.maxSpeedMs).toBeLessThan(full.maxSpeedMs);
    expect(degraded.maxSpeedMs).toBeGreaterThan(0);
  });

  it("CLAVE: con el movimiento destruido el vehículo NO se desplaza, pero SIGUE girando torreta y percibiendo", () => {
    // Es el criterio explícito de la DoD de T2.3, y la razón de ser del sistema modular.
    const v = mkVehicle();
    v.modules.get("drive")!.hp = 0;

    expect(v.movementCaps()).toBeNull(); // inmóvil
    expect(v.turretRate()).toBeGreaterThan(0); // pero la torreta vive
    expect(v.activeModulesOf("sensor").length).toBeGreaterThan(0); // y los sensores también
  });

  it("un vehículo puede quedar DESARMADO pero móvil", () => {
    const v = mkVehicle();
    v.modules.get("turret_main")!.hp = 0;
    expect(v.turretRate()).toBe(0);
    expect(v.movementCaps()).not.toBeNull();
    expect(canFire(v, "turret_main", 0, new Rng("x"))).toBe("module_destroyed");
  });

  it("un vehículo puede quedar CIEGO pero armado y móvil", () => {
    const v = mkVehicle();
    for (const s of v.modulesOf("sensor")) s.hp = 0;
    expect(v.activeModulesOf("sensor").length).toBe(0);
    expect(v.movementCaps()).not.toBeNull();
    expect(v.turretRate()).toBeGreaterThan(0);
  });

  it("apagar un módulo elimina su consumo pasivo, y reactivarlo cuesta ticks", () => {
    // "sensor_a" (no "sensor_b"): el catálogo real de E3 monta el radar del artillero
    // en la única ranura de sensor de chassis.medium, que se llama "sensor_a" (T3.1).
    const v = mkVehicle();
    const before = v.passiveDrain();
    v.setModuleEnabled("sensor_a", false, 100);
    expect(v.passiveDrain()).toBeLessThan(before);
    expect(v.stateOf("sensor_a")).toBe("offline");

    // No puede reactivarlo de inmediato.
    expect(v.setModuleEnabled("sensor_a", true, 101)).toBe("reactivating");
    expect(v.stateOf("sensor_a")).toBe("offline");
    // Pasados los ticks de reactivación, sí.
    expect(v.setModuleEnabled("sensor_a", true, 100 + 15)).toBe("ok");
    expect(v.stateOf("sensor_a")).toBe("operational");
  });
});

describe("validación de disparo: el motor es autoritativo", () => {
  it("rechaza disparar sin munición", () => {
    const v = mkVehicle();
    v.modules.get("ammo_main")!.ammo = 0;
    expect(canFire(v, "turret_main", 0, new Rng("x"))).toBe("no_ammo");
  });

  it("rechaza disparar sin energía", () => {
    const v = mkVehicle();
    v.energyEU = 0;
    expect(canFire(v, "turret_main", 0, new Rng("x"))).toBe("no_energy");
  });

  it("rechaza disparar en cooldown", () => {
    const v = mkVehicle();
    v.modules.get("turret_main")!.cooldownUntilTick = 50;
    expect(canFire(v, "turret_main", 10, new Rng("x"))).toBe("cooldown");
    expect(canFire(v, "turret_main", 60, new Rng("x"))).toBeNull();
  });

  it("rechaza disparar con el arma destruida o apagada", () => {
    const v = mkVehicle();
    v.setModuleEnabled("turret_main", false, 0);
    expect(canFire(v, "turret_main", 0, new Rng("x"))).toBe("module_destroyed");
  });
});

describe("minas: el servidor valida y crea, el bot solo solicita (cap. 12.3)", () => {
  it("rechaza sin cargas, en cooldown, sin energía y al superar el límite", async () => {
    const phys = new PhysicsWorld();
    const v = new Vehicle("veh_m", "red", "bot_m", (await import("../src/fixtures.js")).minerLoadout());
    const pos = { x: 50, y: 40 };

    expect(canDeployMine(v, "mine_bay", 0, pos, phys, 0, 3)).toBeNull(); // válido

    v.modules.get("mine_bay")!.charges = 0;
    expect(canDeployMine(v, "mine_bay", 0, pos, phys, 0, 3)).toBe("no_charges");

    v.modules.get("mine_bay")!.charges = 3;
    v.modules.get("mine_bay")!.cooldownUntilTick = 100;
    expect(canDeployMine(v, "mine_bay", 50, pos, phys, 0, 3)).toBe("cooldown");

    v.modules.get("mine_bay")!.cooldownUntilTick = 0;
    v.energyEU = 0;
    expect(canDeployMine(v, "mine_bay", 0, pos, phys, 0, 3)).toBe("no_energy");

    v.energyEU = 400;
    expect(canDeployMine(v, "mine_bay", 0, pos, phys, 3, 3)).toBe("limit_exceeded");

    phys.free();
  });

  it("rechaza colocar una mina DENTRO de un muro", async () => {
    const phys = new PhysicsWorld();
    phys.addWall("w", { x: 50, y: 40 }, 3, 3);
    const v = new Vehicle("veh_m", "red", "bot_m", (await import("../src/fixtures.js")).minerLoadout());

    expect(canDeployMine(v, "mine_bay", 0, { x: 50, y: 40 }, phys, 0, 3)).toBe("invalid_position");
    expect(canDeployMine(v, "mine_bay", 0, { x: 20, y: 40 }, phys, 0, 3)).toBeNull();
    phys.free();
  });

  it("una solicitud inválida NO crea la entidad y genera un evento de rechazo", () => {
    const b = new Battle({
      battleId: "mine_reject",
      seed: "m1",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() }, // ¡sin lanzaminas!
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });

    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({ forTick: obs.tick, deployMine: { slot: "mine_bay" } }),
    });
    b.attachBot("veh_2", new IdleBot("b2"));
    b.run(30);

    expect(b.getMines()).toHaveLength(0); // no se creó ninguna entidad
    b.free();
  });
});
