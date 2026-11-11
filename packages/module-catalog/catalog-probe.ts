/**
 * OLA 2 · MC · Sonda diferencial del gate CATALOG_CONTRACT (sólo para tests).
 *
 * Monta una batalla corta y determinista con el módulo bajo prueba instalado en el vehículo
 * «E» (resuelto por resolveVehicle desde el catálogo recibido: la MISMA frontera que usa
 * producción) y devuelve un resumen (digest) de todo lo que la simulación produce: las
 * observaciones que recibe cada bot, sus eventos y el hash de estado. Dos catálogos que
 * sólo difieren en un campo dan digests distintos si, y sólo si, ese campo tiene consumidor
 * en la simulación.
 *
 * Escenario (arena vacía 120×80, tdm):
 *  - E (rojo): avanza, retrocede soltando minas en línea, gira; barre la torreta, dispara
 *    cada decisión y emite por radio cada decisión.
 *  - A (rojo, compañero) a 30 m de E: escucha la radio.
 *  - X (azul): persigue a E pasando por encima de sus minas y le dispara.
 * Selección de módulos: por categoría y datos (slot que acepta la categoría, sector del
 * blindaje, arma que acepta la munición), nunca por id de módulo.
 */
import { createHash } from "node:crypto";
import { loadRuleset } from "../game-rules/index.js";
import { Battle, type BotAgent } from "../../apps/arena-engine/src/sim/battle.js";
import { emptyArena } from "../../apps/arena-engine/src/fixtures.js";
import { resolveVehicle } from "./resolve/index.js";
import { CATALOG_VERSION } from "./loadCatalog.js";
import { findModule, type LoadoutInput, type LoadoutModuleEntry, type ModuleDefinition } from "./types.js";

const ref = (m: ModuleDefinition): string => `${m.id}@${m.version}`;

/** Loadout base de E (chasis medio con todo lo que la sonda ejercita). */
export const PROBE_BASE: LoadoutInput = {
  loadoutId: "ldt_probe01",
  revision: 1,
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "mine_bay", moduleId: "mine.explosive@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};
const ALLY: LoadoutInput = {
  ...PROBE_BASE,
  loadoutId: "ldt_probe02",
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};
const ENEMY: LoadoutInput = {
  ...PROBE_BASE,
  loadoutId: "ldt_probe03",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  ],
};

/**
 * Loadout de E con `tested` instalado. Para un chasis se cambia el chasis y se conservan
 * las entradas cuyas ranuras existan; para un módulo, sustituye al de su categoría.
 */
export function loadoutWith(tested: ModuleDefinition, catalog: ModuleDefinition[]): LoadoutInput {
  const base = structuredClone(PROBE_BASE);
  if (tested.category === "chassis") {
    const slots = new Set((tested.slots ?? []).map((s) => s.id));
    return { ...base, chassis: ref(tested), modules: base.modules.filter((m) => slots.has(m.slot)) };
  }
  const chassis = findModule(catalog, base.chassis)!;
  const catOf = (e: LoadoutModuleEntry) => findModule(catalog, e.moduleId)?.category;
  if (tested.category === "ammo") {
    // Un arma del catálogo que acepte esta munición (por datos), con la munición montada.
    const weapon = catalog.find((m) => m.category === "weapon" && (m.acceptsAmmo ?? []).includes(tested.id))!;
    base.modules = base.modules.map((e) =>
      catOf(e) === "weapon" ? { ...e, moduleId: ref(weapon), ammo: ref(tested) } : e,
    );
    return base;
  }
  if (tested.category === "weapon") {
    const ammo = catalog.find((m) => m.category === "ammo" && (tested.acceptsAmmo ?? []).includes(m.id));
    base.modules = base.modules.map((e) =>
      catOf(e) === "weapon" ? { ...e, moduleId: ref(tested), ...(ammo ? { ammo: ref(ammo) } : {}) } : e,
    );
    return base;
  }
  // Ranura del chasis que acepta la categoría (y, para blindaje, su sector).
  const slot = (chassis.slots ?? []).find(
    (s) => s.accepts.includes(tested.category) && (tested.category !== "armor" || s.sector === tested.sector),
  );
  if (!slot) throw new Error(`sonda: ${ref(tested)} no cabe en ${base.chassis}`);
  base.modules = base.modules.filter((e) => e.slot !== slot.id && catOf(e) !== tested.category);
  base.modules.push({ slot: slot.id, moduleId: ref(tested) });
  return base;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

class Exerciser implements BotAgent {
  private d = 0;
  constructor(
    readonly botId: string,
    private log: unknown[],
  ) {}
  decide(obs: any) {
    const d = this.d++;
    this.log.push(["E", obs]);
    const throttle = d < 15 ? 1 : d < 30 ? -1 : d < 45 ? 0.6 : 0;
    const steer = d >= 30 && d < 45 ? 1 : 0;
    return {
      forTick: obs.tick,
      move: { throttle, steer },
      turret: { targetHeading: Math.sin(d * 0.15) * 2.5 },
      fire: ["turret_main"],
      ...(d >= 3 && d < 15 ? { deployMine: { slot: "mine_bay" } } : {}),
      radio: [{ slot: "radio_a", data: b64(`probe-${String(d).padStart(10, "0")}`) }],
    };
  }
  onEvent(e: unknown) {
    this.log.push(["E!", e]);
  }
}

class Listener implements BotAgent {
  constructor(
    readonly botId: string,
    private tag: string,
    private log: unknown[],
  ) {}
  decide(obs: any) {
    this.log.push([this.tag, obs]);
    return { forTick: obs.tick };
  }
  onEvent(e: unknown) {
    this.log.push([`${this.tag}!`, e]);
  }
}

/** Persigue a E (posición de la simulación: es la sonda, no un bot real) y le dispara. */
class Chaser implements BotAgent {
  battle: Battle | null = null;
  constructor(
    readonly botId: string,
    private log: unknown[],
  ) {}
  decide(obs: any) {
    this.log.push(["X", obs]);
    const me = obs.self.position;
    const target = this.battle!.getPhysics().pose("veh_1")?.position ?? me;
    const want = Math.atan2(target.y - me.y, target.x - me.x);
    let diff = want - obs.self.heading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return {
      forTick: obs.tick,
      move: { throttle: 0.7, steer: Math.max(-1, Math.min(1, diff * 2)) },
      turret: { targetPoint: target },
      fire: ["turret_main"],
    };
  }
  onEvent(e: unknown) {
    this.log.push(["X!", e]);
  }
}

export const PROBE_TICKS = 450;

/** Digest de la batalla de sonda con `testedRef` instalado, resuelto contra `catalog`. */
export function probeDigest(catalog: ModuleDefinition[], testedRef: string): string {
  const tested = findModule(catalog, testedRef);
  if (!tested) throw new Error(`sonda: ${testedRef} no está en el catálogo`);
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: 0 },
    { team: "red", position: { x: 20, y: 70 }, heading: 0 },
    { team: "blue", position: { x: 100, y: 40 }, heading: Math.PI },
  ];
  const log: unknown[] = [];
  const battle = new Battle({
    battleId: "catalog-probe",
    seed: "catalog-probe",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bE", team: "red", spec: resolveVehicle(loadoutWith(tested, catalog), catalog) },
      { id: "veh_2", botId: "bA", team: "red", spec: resolveVehicle(ALLY, catalog) },
      { id: "veh_3", botId: "bX", team: "blue", spec: resolveVehicle(ENEMY, catalog) },
    ],
  });
  const chaser = new Chaser("bX", log);
  chaser.battle = battle;
  battle.attachBot("veh_1", new Exerciser("bE", log));
  battle.attachBot("veh_2", new Listener("bA", "A", log));
  battle.attachBot("veh_3", chaser);
  try {
    for (let i = 0; i < PROBE_TICKS; i++) {
      battle.step();
      if (i % 15 === 0) log.push(["hash", battle.tick, battle.stateHash()]);
    }
    log.push(["final", battle.stateHash()]);
  } finally {
    battle.free();
  }
  return createHash("sha256").update(JSON.stringify(log)).digest("hex");
}
