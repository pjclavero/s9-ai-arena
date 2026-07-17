/**
 * R1.1 · Bug CRÍTICO de munición (issue #15, ERR-ENG-08).
 *
 * La forma CANÓNICA de un loadout (la que produce el editor/API y valida E3) guarda la
 * munición como PROPIEDAD del arma (`entry.ammo`), SIN un módulo de munición aparte.
 * Antes de la corrección, resolveVehicle mapeaba `loadout.modules` 1:1 y descartaba
 * `entry.ammo`: el VehicleSpec resuelto salía SIN módulo de categoría `ammo`, el motor
 * no encontraba nada en `modulesOf("ammo")`, y todo disparo se resolvía como `no_ammo`.
 *
 * Los golden de T3.3 no lo cazaban porque sus fixtures (resolve/archetypes.ts)
 * DUPLICABAN la munición a mano (un módulo `ammo_main` además de la propiedad `ammo:`).
 * Estos tests parten del loadout REAL persistido, que NO duplica nada.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVehicle } from "./index.js";
import { loadCatalog } from "../loadCatalog.js";
import type { LoadoutInput } from "../types.js";
import { loadRuleset } from "../../game-rules/index.js";
import { Battle, type BotAgent } from "../../../apps/arena-engine/src/sim/battle.js";
import { emptyArena } from "../../../apps/arena-engine/src/fixtures.js";
import { IdleBot } from "../../../apps/arena-engine/src/stubs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog();

function loadExample(name: string): LoadoutInput {
  return JSON.parse(readFileSync(join(__dirname, "..", "examples", `${name}.json`), "utf8"));
}

describe("R1.1 · resolveVehicle materializa la munición del arma (ERR-ENG-08 / issue #15)", () => {
  it("el loadout canónico persistido (munición como propiedad del arma) resuelve CON un módulo de categoría ammo", () => {
    const loadout = loadExample("loadout-medium-gunner");

    // Precondición del bug: el loadout REAL no lleva ningún módulo de munición aparte;
    // la munición es una propiedad del arma. Esto es lo que valida E3 y persiste la API.
    expect(loadout.modules.some((m) => m.moduleId.startsWith("ammo."))).toBe(false);
    const weaponEntry = loadout.modules.find((m) => m.ammo);
    expect(weaponEntry?.ammo).toBe("ammo.ap@1");

    const spec = resolveVehicle(loadout, catalog);

    // El VehicleSpec resuelto DEBE contener el módulo de munición materializado.
    const ammoModules = spec.modules.filter((m) => m.category === "ammo");
    expect(ammoModules.length).toBeGreaterThan(0);
    expect(ammoModules[0].moduleId).toBe("ammo.ap@1");
    expect(ammoModules[0].rounds).toBeGreaterThan(0);

    // Contrato con combat.ammoFor(): el arma acepta la base de esa munición.
    const weapon = spec.modules.find((m) => m.category === "weapon")!;
    expect(weapon.acceptsAmmo).toContain(ammoModules[0].moduleId.split("@")[0]);
  });
});

describe("R1.1 · prueba vertical: loadout persistido → resolveVehicle → batalla → daño > 0", () => {
  it("un artillero resuelto del loadout canónico dispara, impacta y registra daño > 0 (sin fixtures que dupliquen munición)", async () => {
    const loadout = loadExample("loadout-medium-gunner");
    const redSpec = resolveVehicle(loadout, catalog);
    const blueSpec = resolveVehicle(loadout, catalog);

    const battle = await Battle.create({
      battleId: "r11_vertical",
      seed: "r11-vertical",
      ruleset: loadRuleset("dm_practice@1"),
      map: emptyArena(),
      participants: [
        // emptyArena: red nace en (20,40) mirando +X; blue (el blanco) en (100,40).
        { id: "veh_red", botId: "bot_red", team: "red", spec: redSpec },
        { id: "veh_blue", botId: "bot_blue", team: "blue", spec: blueSpec },
      ],
    });

    // El artillero se queda quieto, apunta la torreta al blanco y dispara. El blanco
    // no responde (IdleBot): un blanco fijo con línea de visión limpia.
    const hitsDealt: any[] = [];
    const shooter: BotAgent = {
      botId: "bot_red",
      decide: (obs: any) => ({
        forTick: obs.tick,
        move: { throttle: 0, steer: 0 },
        turret: { targetPoint: { x: 100, y: 40 } },
        fire: ["turret_main"],
      }),
      onEvent: (e: any) => {
        if (e.kind === "hit_dealt") hitsDealt.push(e);
      },
    };
    battle.attachBot("veh_red", shooter);
    battle.attachBot("veh_blue", new IdleBot("bot_blue"));

    const blue = battle.getVehicle("veh_blue")!;
    const hp0 = blue.hullHp;

    for (let i = 0; i < 150; i++) battle.step();

    // El arma disparó, el proyectil impactó y se registró daño.
    expect(hitsDealt.length).toBeGreaterThan(0);
    expect(hitsDealt.some((e) => e.damage > 0)).toBe(true);
    // Y el daño llegó al blanco: su casco bajó.
    expect(blue.hullHp).toBeLessThan(hp0);

    battle.free();
  });
});
