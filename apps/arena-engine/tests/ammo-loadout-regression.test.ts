/**
 * R13.0 · REGRESSION LOCK — munición del loadout + respawn.
 *
 * Fallo histórico: la munición configurada en el loadout no se propagaba al motor y
 * los bots reales recibían `no_ammo` con un arma cargada. El código actual la inicializa
 * desde `spec.rounds` (vehicle.ts) y la restaura en `respawn()`. La suite previa solo
 * cubría el NEGATIVO (`ammo=0 ⇒ no_ammo`). Estos candados fijan el POSITIVO, el consumo,
 * el límite y el respawn, de modo que una regresión de propagación rompa CI.
 *
 * Nivel unitario (Vehicle + combat): rápido, determinista, sin Docker, sin red, sin reloj.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { canFire, fire } from "../src/sim/combat.js";
import { initPhysics } from "../src/sim/physics.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { Rng } from "../src/rng.js";
import { gunnerLoadout } from "../src/fixtures.js";

const WEAPON = "turret_main";
const AMMO = "ammo_main";

beforeAll(async () => {
  await initPhysics();
});

const mk = () => new Vehicle("veh_t", "red", "bot_t", gunnerLoadout());

describe("R13.0 · munición del loadout (positivo)", () => {
  it("inicializa la munición desde el loadout (rounds del spec), no a 0/undefined", () => {
    const v = mk();
    const ammo = v.modules.get(AMMO)!;
    const rounds = ammo.spec.rounds ?? 0;
    expect(rounds).toBeGreaterThan(0); // premisa: el gunner trae munición real
    expect(typeof ammo.ammo).toBe("number");
    expect(Number.isFinite(ammo.ammo)).toBe(true);
    expect(ammo.ammo).toBe(rounds); // propagado, no un valor por defecto incorrecto
  });

  it("un loadout con munición PUEDE disparar (no devuelve no_ammo)", () => {
    const v = mk();
    // energía llena y sin cooldown: aislamos la munición como única variable.
    expect(canFire(v, WEAPON, 0, new Rng("x"))).toBeNull();
  });

  it("disparar consume munición (una ronda por disparo)", () => {
    const v = mk();
    const ammo = v.modules.get(AMMO)!;
    const before = ammo.ammo;
    expect(canFire(v, WEAPON, 0, new Rng("x"))).toBeNull();
    const p = fire(v, WEAPON, 0, { x: 0, y: 0 }, new Rng("x"), 1);
    expect(p).not.toBeNull(); // se creó proyectil
    expect(ammo.ammo).toBe(before - 1);
  });

  it("al agotar la munición devuelve no_ammo (límite inferior)", () => {
    const v = mk();
    v.modules.get(AMMO)!.ammo = 0;
    expect(canFire(v, WEAPON, 0, new Rng("x"))).toBe("no_ammo");
  });
});

describe("R13.0 · respawn restaura la munición", () => {
  it("tras respawn, la munición vuelve al valor del loadout (regla del motor: restaurar)", () => {
    const v = mk();
    const ammo = v.modules.get(AMMO)!;
    const rounds = ammo.spec.rounds ?? 0;

    // Gastamos toda la munición.
    ammo.ammo = 0;
    expect(canFire(v, WEAPON, 0, new Rng("x"))).toBe("no_ammo");

    v.respawn({ x: 10, y: 10 });

    expect(v.alive).toBe(true);
    expect(typeof ammo.ammo).toBe("number");
    expect(Number.isFinite(ammo.ammo)).toBe(true);
    expect(ammo.ammo).not.toBeUndefined();
    expect(ammo.ammo).toBe(rounds); // restaurada desde el loadout
    // Y vuelve a poder disparar tras revivir.
    expect(canFire(v, WEAPON, 0, new Rng("x"))).toBeNull();
  });

  it("respawn no duplica ni desborda la munición (queda exactamente en rounds)", () => {
    const v = mk();
    const ammo = v.modules.get(AMMO)!;
    const rounds = ammo.spec.rounds ?? 0;
    // Aunque partiéramos de un valor raro, respawn la normaliza al loadout.
    ammo.ammo = rounds - 1;
    v.respawn({ x: 0, y: 0 });
    expect(ammo.ammo).toBe(rounds);
  });
});
