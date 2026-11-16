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
 *   hull        hp REAL del casco en valor absoluto (el que decide la muerte) y alive
 *   modules     estado (stateOf: lo que lee el rendimiento) de cada módulo, blindaje incluido
 *   energy      flujo REAL de la energía almacenada en cada tick (almacenada(t) − almacenada(t−1):
 *               lo que gastan las acciones y el drenaje, lo que repone la generación y lo que
 *               corta el tope)
 *   projectiles id y posición de cada proyectil vivo (su vida = su alcance)
 *   mines       id y posición de cada mina sobre el terreno (siembra, detonación, caducidad)
 *   damage      daño APLICADO: de cada registro, el efectivo, lo que va al casco y al módulo
 *               (sin el importe ni la reducción de entrada), y la pérdida de hp medida en cada
 *               módulo (blindaje incluido: su desgaste)
 *   events      eventos entregados a los bots (rechazos, impactos, detonaciones…)
 *   sensors     QUÉ detecta cada sensor y DÓNDE (rayos: ángulo, distancia sólo si toca algo y
 *               qué toca; contactos: identidad revelada y posición/velocidad medidas; rumbos)
 *   radio       los mensajes de radio que recibe cada bot
 *   score       marcador
 * Un campo que la simulación sólo COPIA en su estado, sin que ninguna de estas magnitudes
 * cambie, NO cuenta como usado. Ronda 2 (P2-1 de la revisión): ningún canal lleva un valor de
 * ENTRADA, es decir, una función sólo del spec que la simulación podría copiar sin usarlo:
 * nada de `fovRad`/`errorM` del sensor, ni de la confianza o intensidad (= 1 − d/alcance), ni
 * de la distancia «sin impacto» del lidar (= alcance), ni del importe `base` ni la
 * `reduction`/`absorbed` del registro de daño, ni de la capacidad de energía, ni del hp máximo
 * como denominador del casco. El hp del casco va en absoluto porque es la variable que la
 * simulación lee para matar; el estado del módulo sí usa su hp máximo de denominador, pero ese
 * estado es lo que lee el rendimiento (performanceOf/moduleActs): es efecto, no copia.
 * `full` (todos los canales + observaciones completas +
 * stateHash) sólo se usa para las comprobaciones NEGATIVAS del gate (D2/D3: «no cambia la
 * batalla»), donde ser más sensible es más estricto.
 *
 * Escenario (arena vacía 120×80, tdm):
 *  - E (rojo): avanza, retrocede soltando minas en línea, gira; barre la torreta, dispara
 *    cada decisión y emite por radio cada decisión.
 *  - A (rojo, compañero) a 30 m de E: escucha la radio.
 *  - X (azul): persigue a E pasando por encima de sus minas y le dispara.
 *  - W (azul, G1): escolta a X pegada a ~3 m (sin armas ni blindaje). Cuando un proyectil de E
 *    impacta en X, W queda dentro de su ONDA: así el radio de explosión de la munición tiene
 *    efecto observable aunque el proyectil no impacte en un muro, y el impactado directo
 *    queda excluido de su propia onda (D-B6). (Los impactos en MURO también dañan con la
 *    onda desde G1.5: ver apps/arena-engine/tests/g1-he-wall-los.test.ts.)
 *  - G1.2: además, una batalla de DURABILIDAD (ver `durability`) para el hp de los módulos.
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
/** W: escolta de X (sin blindaje ni armas). */
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

/**
 * Ronda 2 (P2-1) · Lo que los sensores DETECTAN y DÓNDE, campo a campo (lista blanca de
 * sensors.ts buildObservation). Fuera: `fovRad` y `originHeading` del lidar, `errorM` y
 * `confidence` del radar, `intensity` del acústico y `triggered` del de proximidad (copias del
 * spec o derivados de él y de la distancia), y la distancia de un rayo que no toca nada (es el
 * alcance). Un rayo sin impacto sólo dice «nada» (`hit` = "unknown": todo collider tiene id).
 */
function sensorEffect(sensors: any): unknown {
  const out: unknown[] = [];
  for (const l of sensors.lidar ?? [])
    out.push(["lidar", l.slot, l.rays.map((r: any) => [r.angle, r.hit === "unknown" ? null : r.distanceM, r.hit])]);
  for (const r of sensors.radar ?? [])
    out.push([
      "radar",
      r.slot,
      r.contacts.map((c: any) => [
        c.entityId ?? null,
        c.kind,
        c.team ?? null,
        c.position.x,
        c.position.y,
        c.velocity.x,
        c.velocity.y,
      ]),
    ]);
  for (const p of sensors.proximity ?? []) out.push(["proximity", p.slot, p.bearings]);
  for (const a of sensors.acoustic ?? [])
    out.push(["acoustic", a.slot, a.sources.map((s: any) => [s.bearing, s.kind])]);
  return out;
}

/** Acumulador de la traza: un array por canal + las observaciones completas (sólo para `full`). */
class Recorder {
  readonly ch = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, [] as unknown[]])) as Record<ProbeChannel, unknown[]>;
  readonly full: unknown[] = [];
  obs(tag: string, obs: any) {
    this.full.push([tag, obs]);
    // Sólo la SALIDA de los sensores y lo recibido por radio: no el autoinforme del bot
    // (hullHpMax, capacityEU… son copias del spec, no efectos).
    if (obs.sensors !== undefined) this.ch.sensors.push([tag, obs.tick, sensorEffect(obs.sensors)]);
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

/** Escolta a X (veh_3) pegada a ~3 m: queda en la onda de los impactos de E sobre X. */
class Escort implements BotAgent {
  battle: Battle | null = null;
  constructor(
    readonly botId: string,
    private log: Recorder,
  ) {}
  decide(obs: any) {
    this.log.obs("W", obs);
    const me = obs.self.position;
    const x = this.battle!.getPhysics().pose("veh_3")?.position ?? me;
    const d = Math.hypot(x.x - me.x, x.y - me.y);
    let diff = Math.atan2(x.y - me.y, x.x - me.x) - obs.self.heading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return { forTick: obs.tick, move: { throttle: d > 3 ? 0.8 : 0, steer: Math.max(-1, Math.min(1, diff * 2)) } };
  }
  onEvent(e: unknown) {
    this.log.event("W", e);
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

/** Valores del tick anterior para medir flujos (energía, hp de módulo). */
type Prev = Map<string, number>;

/**
 * Valores iniciales (antes del primer paso) de lo que se mide por diferencia. El valor
 * inicial NUNCA entra en un canal: sólo sirve de referencia para el primer flujo.
 */
function prevOf(battle: Battle): Prev {
  const prev: Prev = new Map();
  for (const v of battle.getVehicles()) {
    prev.set(`${v.id}:energy`, v.energyEU);
    for (const m of v.modules.values()) prev.set(`${v.id}:${m.spec.slot}:hp`, m.hp);
  }
  return prev;
}

/** Magnitudes de efecto del tick, campo a campo (lista blanca: nada de objetos enteros). */
function sample(battle: Battle, rec: Recorder, prev: Prev): void {
  const t = battle.tick;
  const ch = rec.ch;
  for (const v of battle.getVehicles()) {
    const p = battle.getPhysics().pose(v.id);
    ch.kinematics.push([t, v.id, p ? [r6(p.position.x), r6(p.position.y), r6(p.heading)] : null]);
    ch.turret.push([t, v.id, r6(v.turretHeading)]);
    // Ronda 2 (P2-1) · el casco por su hp REAL en absoluto (el que lee la simulación para
    // matar), sin el hp máximo del spec de denominador; la energía por su FLUJO real en el
    // tick (sin la capacidad del spec); los módulos por su ESTADO (lo que lee el rendimiento).
    ch.hull.push([t, v.id, r6(v.hullHp), v.alive]);
    const ek = `${v.id}:energy`;
    ch.energy.push([t, v.id, r6(v.energyEU - prev.get(ek)!)]);
    prev.set(ek, v.energyEU);
    ch.modules.push([t, v.id, [...v.modules.values()].map((m) => [m.spec.slot, v.stateOf(m.spec.slot)])]);
    // Pérdida de hp APLICADA a cada módulo (blindaje incluido: su desgaste), medida en el
    // estado, no en el registro.
    for (const m of v.modules.values()) {
      const hk = `${v.id}:${m.spec.slot}:hp`;
      const lost = prev.get(hk)! - m.hp;
      if (lost !== 0) ch.damage.push([t, v.id, "hp", m.spec.slot, r6(lost)]);
      prev.set(hk, m.hp);
    }
  }
  const frame = battle.getInternalFrame();
  ch.projectiles.push([t, frame.projectiles.map((p: any) => [p.id, p.position.x, p.position.y])]);
  ch.mines.push([t, battle.getMines().map((m) => [m.id, r6(m.position.x), r6(m.position.y)])]);
  ch.score.push([t, frame.score]);
  // Sin `base` (importe de entrada), `reduction` (reducción de entrada) ni `absorbed`
  // (= base − efectivo): el desgaste real del blindaje ya va arriba, medido en su hp.
  for (const d of battle.damageRecordsOfLastTick())
    ch.damage.push([
      t,
      d.target,
      d.sourceKind,
      d.type,
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
    { team: "blue", position: { x: 104, y: 44 }, heading: Math.PI },
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
  const escort = new Escort("bW", rec);
  escort.battle = battle;
  battle.attachBot("veh_4", escort);
  const prev = prevOf(battle);
  try {
    for (let i = 0; i < PROBE_TICKS; i++) {
      battle.step();
      sample(battle, rec, prev);
      if (i % 15 === 0) rec.full.push(["hash", battle.tick, battle.stateHash()]);
    }
    rec.full.push(["final", battle.stateHash()]);
  } finally {
    battle.free();
  }
  durability(tested, catalog, loadout ?? loadoutWith(tested, catalog), rec);
  const channels = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, sha(rec.ch[c])])) as Record<ProbeChannel, string>;
  return { channels, full: sha([channels, rec.full]) };
}

/** Quieto: no decide nada (el blanco de la batalla de durabilidad). */
class Sitter implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick };
  }
}
/** Dispara sin parar contra un punto fijo. */
class Pounder implements BotAgent {
  constructor(
    readonly botId: string,
    private target: { x: number; y: number },
  ) {}
  decide(obs: any) {
    return { forTick: obs.tick, turret: { targetPoint: this.target }, fire: ["turret_main"] };
  }
}

export const DURABILITY_TICKS = 300;

/**
 * G1.2 · Batalla de DURABILIDAD: el `hp` de un módulo sólo tiene efecto observable cuando
 * el módulo recibe daño (cambia su estado → su rendimiento). En la batalla principal el
 * daño de módulo se reparte por masa (damage.ts: `weighted` por massKg) y un módulo ligero
 * (radio, sensor, mina) casi nunca lo recibe en 450 ticks: con el canal antiguo (hp vivo,
 * que ARRANCA como copia del spec) el gate lo daba por usado sin que nada cambiara. Aquí el
 * blanco «D» lleva SÓLO el módulo bajo prueba (las entradas de su categoría en el loadout
 * de E; para un arma, con su munición), así que todo el daño de módulo va a él, y un
 * cañón le dispara a 12 m sin parar. Se registra, por tick, el ESTADO de cada módulo de D
 * (canal `modules`), no su hp.
 */
function durability(tested: ModuleDefinition, catalog: ModuleDefinition[], base: LoadoutInput, rec: Recorder): void {
  const catOf = (e: LoadoutModuleEntry) => findModule(catalog, e.moduleId)?.category;
  const keep = tested.category === "ammo" ? "weapon" : tested.category;
  const target: LoadoutInput = {
    ...base,
    loadoutId: "ldt_probe05",
    modules: tested.category === "chassis" ? [] : base.modules.filter((e) => catOf(e) === keep),
  };
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: { x: 40, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 52, y: 40 }, heading: Math.PI },
  ];
  const battle = new Battle({
    battleId: "catalog-probe-durability",
    seed: "catalog-probe-durability",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bD", team: "red", spec: resolveVehicle(target, catalog) },
      { id: "veh_2", botId: "bP", team: "blue", spec: resolveVehicle(ENEMY, catalog) },
    ],
  });
  battle.attachBot("veh_1", new Sitter("bD"));
  battle.attachBot("veh_2", new Pounder("bP", { x: 40, y: 40 }));
  try {
    for (let i = 0; i < DURABILITY_TICKS; i++) {
      battle.step();
      const d = battle.getVehicles().find((v) => v.id === "veh_1")!;
      rec.ch.modules.push([
        "D",
        battle.tick,
        [...d.modules.values()].map((m) => [m.spec.slot, d.stateOf(m.spec.slot)]),
      ]);
      rec.full.push(["D", battle.tick, d.alive]);
    }
    rec.full.push(["D-final", battle.stateHash()]);
  } finally {
    battle.free();
  }
}
