/**
 * OLA 2 · ME · D-B4 (blindaje EXACTO interno, CUANTIZADO público, rotura visible).
 *
 *  - `it` (guarda de baseline, verde en el BASE_SHA): el estado interno conserva el hp
 *    de blindaje EXACTO, sin redondeo ni cuantización. MB no puede cuantizar lo interno
 *    para cumplir D-B4: la cuantización es sólo de PROYECCIÓN.
 *  - [CUMPLIDO en G2] el contrato MB (antes `contractIt("MB")`, rojo en el BASE_SHA): el estado de rotura es visible en el frame
 *    público (`armorBroken`) cuando el blindaje de un sector llega a 0, y mientras no está
 *    roto el frame público no distingue blindajes distintos más allá del casco.
 *
 * Nombres del BASE_SHA: `Vehicle.armor[sector].hp`, `applyDamage`, `Battle.snapshots`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { applyDamage } from "../../src/sim/combat.js";
import { initPhysics } from "../../src/sim/physics.js";
import { Vehicle } from "../../src/sim/vehicle.js";
import { Rng } from "../../src/rng.js";
import { emptyArena, gunnerLoadout, sandbagLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { fixtureGuard, publicStream } from "../baseline/helpers.js";

beforeAll(async () => {
  await initPhysics();
});

const FRONT = { x: 10, y: 0 };

describe("D-B4 · blindaje interno exacto (guarda de baseline)", () => {
  it("el hp de blindaje tras N impactos = inicial − Σ(base − efectivo), con decimales sin cuantizar", () => {
    const v = new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());
    const initial = v.armor.front!.hp;
    fixtureGuard(initial > 0, "el gunner no tiene blindaje frontal");
    let absorbed = 0;
    for (let i = 0; i < 3; i++) {
      const before = v.armor.front!.hp;
      const res = applyDamage(v, 37, FRONT, { x: 0, y: 0 }, 0, new Rng(`me-armor-exact-${i}`));
      const wear = before - v.armor.front!.hp;
      absorbed += wear;
      expect(wear).toBeCloseTo(37 - res.effectiveDamage, 9); // sin redondeo a enteros
    }
    expect(v.armor.front!.hp).toBeCloseTo(initial - absorbed, 9);
    // Al menos un valor NO entero: si fuera siempre entero la prueba no distinguiría exacto de cuantizado.
    expect(Number.isInteger(v.armor.front!.hp) && Number.isInteger(absorbed)).toBe(false);
  });
});

describe("D-B4 · rotura de blindaje visible en lo público", () => {
  function brokenFrontFrame() {
    const map = emptyArena(200, 80);
    map.spawns = [
      { team: "red", position: { x: 20, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 60, y: 40 }, heading: Math.PI },
    ];
    const b = new Battle({
      battleId: "me_armor_vis",
      seed: "me-armor-vis",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map,
      snapshotEveryNTicks: 1,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    const target = b.getVehicle("veh_2")!;
    fixtureGuard(target.armor.front !== undefined, "el blanco no tiene blindaje frontal");
    for (let t = 0; t < 2; t++) b.step();
    target.armor.front!.hp = 0; // blindaje frontal roto (estado interno)
    for (let t = 0; t < 2; t++) b.step();
    // Integración OLA 2 (M0): adaptador a MA (frame público = proyección public_live).
    const pubFrames = publicStream(b).snapshots;
    const frame: any = pubFrames[pubFrames.length - 1];
    b.free();
    fixtureGuard(frame && Array.isArray(frame.vehicles), "no hay frame público tras la rotura");
    return frame;
  }

  it("[contrato MB cumplido · G2] con el blindaje frontal a 0, el vehículo público marca armorBroken (booleano) del sector", () => {
    const frame = brokenFrontFrame();
    const v = frame.vehicles.find((x: any) => String(x.id).endsWith("2") || x.team === "blue");
    fixtureGuard(v !== undefined, "no se encontró el vehículo azul en el frame");
    expect(v.armorBroken, "el frame público no expone armorBroken").toBeDefined();
    expect(Object.values(v.armorBroken).some((x) => x === true)).toBe(true);
    for (const val of Object.values(v.armorBroken)) expect(typeof val).toBe("boolean");
    // Sólo el booleano del sector roto: ni el hp ni el resto de sectores ni el módulo.
    expect(v.armorBroken).toEqual({ front: true });
    expect(JSON.stringify(frame)).not.toMatch(/"hp"|hpMax|reduction|armor_|"modules"|"slot"/);
  });

  it("[G2] el rojo no es general: sin rotura el frame público del blanco NO lleva armorBroken", () => {
    const map = emptyArena(200, 80);
    map.spawns = [
      { team: "red", position: { x: 20, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 60, y: 40 }, heading: Math.PI },
    ];
    const b = new Battle({
      battleId: "g2_armor_ok",
      seed: "g2-armor-ok",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map,
      snapshotEveryNTicks: 1,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    fixtureGuard(b.getVehicle("veh_2")!.armor.front !== undefined, "el blanco no tiene blindaje frontal");
    b.getVehicle("veh_2")!.armor.front!.hp = 1; // casi roto, pero NO roto
    for (let t = 0; t < 4; t++) b.step();
    const frames = publicStream(b).snapshots as any[];
    b.free();
    fixtureGuard(frames.length > 0, "sin frames públicos");
    expect(JSON.stringify(frames)).not.toMatch(/armorBroken/);
  });
});
