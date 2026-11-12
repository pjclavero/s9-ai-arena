/**
 * OLA 2 · MC · Sonda diferencial del gate CATALOG_CONTRACT (sólo para tests).
 *
 * Monta una batalla corta y determinista con el módulo bajo prueba instalado en el vehículo
 * «E» (resuelto por resolveVehicle desde el catálogo recibido: la MISMA frontera que usa
 * producción) y devuelve una TRAZA DE EFECTOS OBSERVABLES por canal (`ProbeChannel`).
 *
 * G1 (post-integración OLA 2): la sonda ya NO mide «¿cambia stateHash()?». Con el hash v2
 * de MD los objetos vivos se serializan enteros, así que COPIAR un campo del catálogo a una
 * entidad (la cola de radio, la mina) cambiaba el hash sin que ningún comportamiento lo
 * leyera, y el gate lo daba por usado (mutantes M6/M12 de MC vivos). Ahora cada canal es una
 * lista blanca de MAGNITUDES DE EFECTO leídas campo a campo (nunca objetos enteros):
 *   kinematics  posición y rumbo de cada vehículo (física)
 *   turret      rumbo de la torreta de cada vehículo
 *   hull        casco vivo y alive de cada vehículo
 *   modules     hp vivo y estado (stateOf) de cada módulo, hp de cada sector de blindaje
 *   energy      energía almacenada de cada vehículo
 *   projectiles id y posición de cada proyectil vivo (su vida = su alcance)
 *   mines       id y posición de cada mina sobre el terreno (siembra, detonación, caducidad)
 *   damage      registros exactos de daño aplicados (importe, reducción, casco, módulo)
 *   events      eventos entregados a los bots (rechazos, impactos, detonaciones…)
 *   sensors     lo que devuelven los sensores en la observación de cada bot
 *   radio       los mensajes de radio que recibe cada bot
 *   score       marcador
 * Un campo que la simulación sólo COPIA en su estado, sin que ninguna de estas magnitudes
 * cambie, NO cuenta como usado. `full` (todos los canales + observaciones completas +
 * stateHash) sólo se usa para las comprobaciones NEGATIVAS del gate (D2/D3: «no cambia la
 * batalla»), donde ser más sensible es más estricto.
 *
 * Escenario (arena vacía 120×80, tdm):
 *  - E (rojo): avanza, retrocede soltando minas en línea, gira; barre la torreta, dispara
 *    cada decisión y emite por radio cada decisión.
 *  - A (rojo, compañero) a 30 m de E: escucha la radio.
 *  - X (azul): persigue a E pasando por encima de sus minas y le dispara.
 *  - W (azul, G1): inmóvil junto al muro este, en la línea de tiro de E. Los proyectiles de E
 *    que impactan en el muro cerca de W lo alcanzan con su ONDA: así el radio de explosión de
 *    la munición tiene efecto observable (al impacto directo, el impactado queda excluido de
 *    su propia onda, D-B6, y X no se acerca a los muros).
 *  - G1: E siembra durante más tiempo (hasta la decisión 120) para que las cargas y el
 *    enfriamiento de la mina limiten de verdad cuántas minas hay en el terreno.
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
import { PROBE_CHANNELS, type ProbeChannel } from "./field-status.js";

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
/** W: blanco inmóvil junto al muro (sin blindaje ni armas). */
const WALL_SITTER: LoadoutInput = {
  ...PROBE_BASE,
  loadoutId: "ldt_probe04",
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
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

/** Acumulador de la traza: un array por canal + las observaciones completas (sólo para `full`). */
class Recorder {
  readonly ch = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, [] as unknown[]])) as Record<ProbeChannel, unknown[]>;
  readonly full: unknown[] = [];
  obs(tag: string, obs: any) {
    this.full.push([tag, obs]);
    // Sólo la SALIDA de los sensores y lo recibido por radio: no el autoinforme del bot
    // (hullHpMax, capacityEU… son copias del spec, no efectos).
    if (obs.sensors !== undefined) this.ch.sensors.push([tag, obs.tick, obs.sensors]);
    if (obs.radio !== undefined) this.ch.radio.push([tag, obs.tick, obs.radio]);
  }
  event(tag: string, e: unknown) {
    this.full.push([`${tag}!`, e]);
    this.ch.events.push([tag, e]);
  }
}

class Exerciser implements BotAgent {
  private d = 0;
  constructor(
    readonly botId: string,
    private log: Recorder,
  ) {}
  decide(obs: any) {
    const d = this.d++;
    this.log.obs("E", obs);
    const throttle = d < 15 ? 1 : d < 30 ? -1 : d < 45 ? 0.6 : 0;
    const steer = d >= 30 && d < 45 ? 1 : 0;
    return {
      forTick: obs.tick,
      move: { throttle, steer },
      turret: { targetHeading: Math.sin(d * 0.15) * 2.5 },
      fire: ["turret_main"],
      // Minas desde el final del avance: la primera queda en la línea y=40, entre E (que
      // retrocede) y X; el resto, donde E se detiene. La ventana (decisiones 12-119) da para
      // más de una siembra con el enfriamiento real, así que cargas y enfriamiento cuentan.
      ...(d >= 12 && d < 120 ? { deployMine: { slot: "mine_bay" } } : {}),
      radio: [{ slot: "radio_a", data: b64(`probe-${String(d).padStart(10, "0")}`) }],
    };
  }
  onEvent(e: unknown) {
    this.log.event("E", e);
  }
}

class Listener implements BotAgent {
  constructor(
    readonly botId: string,
    private tag: string,
    private log: Recorder,
  ) {}
  decide(obs: any) {
    this.log.obs(this.tag, obs);
    return { forTick: obs.tick };
  }
  onEvent(e: unknown) {
    this.log.event(this.tag, e);
  }
}

/** Persigue a E (posición de la simulación: es la sonda, no un bot real) y le dispara. */
class Chaser implements BotAgent {
  battle: Battle | null = null;
  constructor(
    readonly botId: string,
    private log: Recorder,
  ) {}
  decide(obs: any) {
    this.log.obs("X", obs);
    const me = obs.self.position;
    // Si E ha sembrado una mina, X pasa por encima (es la sonda: así daño, radio de explosión y
    // retardo de armado de la mina tienen consecuencia observable); si no, persigue a E.
    const mine = this.battle!.getMines()[0];
    const target = mine?.position ?? this.battle!.getPhysics().pose("veh_1")?.position ?? me;
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
    this.log.event("X", e);
  }
}

export const PROBE_TICKS = 450;

/** Traza de la sonda: digest por canal de efecto y digest completo (sólo negativas). */
export interface ProbeTrace {
  readonly channels: Readonly<Record<ProbeChannel, string>>;
  readonly full: string;
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** Magnitudes de efecto del tick, campo a campo (lista blanca: nada de objetos enteros). */
function sample(battle: Battle, rec: Recorder): void {
  const t = battle.tick;
  const ch = rec.ch;
  for (const v of battle.getVehicles()) {
    const p = battle.getPhysics().pose(v.id);
    ch.kinematics.push([t, v.id, p ? [r6(p.position.x), r6(p.position.y), r6(p.heading)] : null]);
    ch.turret.push([t, v.id, r6(v.turretHeading)]);
    ch.hull.push([t, v.id, r6(v.hullHp), v.alive]);
    ch.energy.push([t, v.id, r6(v.energyEU)]);
    ch.modules.push([
      t,
      v.id,
      [...v.modules.values()].map((m) => [m.spec.slot, r6(m.hp), v.stateOf(m.spec.slot)]),
      Object.entries(v.armor).map(([sec, a]) => [sec, r6(a!.hp)]),
    ]);
  }
  const frame = battle.getInternalFrame();
  ch.projectiles.push([t, frame.projectiles.map((p: any) => [p.id, p.position.x, p.position.y])]);
  ch.mines.push([t, battle.getMines().map((m) => [m.id, r6(m.position.x), r6(m.position.y)])]);
  ch.score.push([t, frame.score]);
  for (const d of battle.damageRecordsOfLastTick())
    ch.damage.push([
      t,
      d.target,
      d.sourceKind,
      d.type,
      r6(d.base),
      r6(d.reduction),
      r6(d.absorbed),
      r6(d.effective),
      r6(d.hull),
      d.moduleSlot,
      r6(d.moduleDamage),
      d.sector,
    ]);
}

/**
 * Traza de la batalla de sonda con `testedRef` instalado, resuelto contra `catalog`.
 * `loadout` fija el loadout de E (por defecto, loadoutWith sobre el mismo catálogo).
 */
export function probeTrace(catalog: ModuleDefinition[], testedRef: string, loadout?: LoadoutInput): ProbeTrace {
  const tested = findModule(catalog, testedRef);
  if (!tested) throw new Error(`sonda: ${testedRef} no está en el catálogo`);
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: 0 },
    { team: "red", position: { x: 20, y: 70 }, heading: 0 },
    { team: "blue", position: { x: 100, y: 40 }, heading: Math.PI },
    { team: "blue", position: { x: 117, y: 44 }, heading: Math.PI },
  ];
  const rec = new Recorder();
  const battle = new Battle({
    battleId: "catalog-probe",
    seed: "catalog-probe",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bE", team: "red", spec: resolveVehicle(loadout ?? loadoutWith(tested, catalog), catalog) },
      { id: "veh_2", botId: "bA", team: "red", spec: resolveVehicle(ALLY, catalog) },
      { id: "veh_3", botId: "bX", team: "blue", spec: resolveVehicle(ENEMY, catalog) },
      { id: "veh_4", botId: "bW", team: "blue", spec: resolveVehicle(WALL_SITTER, catalog) },
    ],
  });
  const chaser = new Chaser("bX", rec);
  chaser.battle = battle;
  battle.attachBot("veh_1", new Exerciser("bE", rec));
  battle.attachBot("veh_2", new Listener("bA", "A", rec));
  battle.attachBot("veh_3", chaser);
  battle.attachBot("veh_4", new Listener("bW", "W", rec));
  try {
    for (let i = 0; i < PROBE_TICKS; i++) {
      battle.step();
      sample(battle, rec);
      if (i % 15 === 0) rec.full.push(["hash", battle.tick, battle.stateHash()]);
    }
    rec.full.push(["final", battle.stateHash()]);
  } finally {
    battle.free();
  }
  const channels = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, sha(rec.ch[c])])) as Record<ProbeChannel, string>;
  return { channels, full: sha([channels, rec.full]) };
}
