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
 * lista blanca de MAGNITUDES DE EFECTO leídas campo a campo (nunca objetos enteros).
 *
 * REGLA DE LOS CANALES (ronda 3, P2-1b, cerrada como CLASE): ningún canal registra un valor
 * cuyo origen sea una COPIA de la configuración, ni un valor inicial copiado del spec ni el
 * de un registro interno que refleje lo calculado sin haberlo aplicado. Un canal sólo puede
 * registrar:
 *   (F) FLUJOS: variaciones del estado vivo medidas entre ticks (`Recorder.flow`: el nivel
 *       absoluto NUNCA entra en un canal; la primera medida y la restauración de una
 *       reaparición sólo fijan la referencia, y la reaparición se anota como hecho SIN valor);
 *   (E) EVENTOS observables con su tick y su objetivo (lista blanca de campos: sin importes
 *       del registro de daño);
 *   (P) POSICIONES o DETECCIONES resultantes.
 * Canales:
 *   kinematics  (P) posición y rumbo de cada vehículo
 *   turret      (P) rumbo de la torreta de cada vehículo
 *   hull        (F) hp que pierde el casco en cada tick + (E) tick de muerte y de reaparición
 *   modules     (F) hp que pierde cada módulo (blindaje incluido) + (E) tick y estado de cada
 *               TRANSICIÓN de estado (stateOf: lo que lee el rendimiento); su valor inicial
 *               («ok») no depende del spec y no se registra
 *   energy      (F) flujo de la energía almacenada en cada tick
 *   projectiles (P) etiqueta observable (propietario + orden de aparición; ronda 6: nunca el id
 *               interno) y posición de cada proyectil vivo (su vida = su alcance)
 *   mines       (P) ídem para cada mina sobre el terreno (siembra, detonación, caducidad)
 *   damage      (F) daño APLICADO medido en el ESTADO: hp que pierden casco, módulos y
 *               blindaje en cada tick. NUNCA el registro de daño (effective/hull/
 *               moduleDamage/base…): el registro puede decir una cosa y el estado recibir otra
 *   events      (E) eventos entregados a los bots, campo a campo (sin el `damage` de
 *               hit_taken/hit_dealt, que es el `effective` del registro)
 *   sensors     (P) QUÉ detecta cada sensor y DÓNDE: por rayo, distancia y objeto SÓLO si
 *               toca algo (sin el ángulo calculado del spec); contactos con identidad y
 *               posición/velocidad medidas; rumbos
 *   radio       (E) mensajes de radio que recibe cada bot (emisor, contenido, tick de envío)
 *   score       (E) marcador
 * La regla la hace cumplir el bloque D0 del gate (catalog-contract.test.ts), calibrado con
 * mutantes de la propia sonda (scripts/hardening/g1-mutants.py, P1-P6):
 *   D0a  dos sondas con specs DISTINTOS de dinámica IDÉNTICA (reservas iniciales trasladadas
 *        donde nunca limitan: casco de quien no muere, energía de quien nunca va justo,
 *        munición y cargas que no se agotan, hp de módulos que nadie toca) ⇒ todos los
 *        canales idénticos. Un canal que registre un nivel copiado del spec cambia.
 *   D0b  registro de daño y `damage` de los eventos FALSEADOS después de aplicarse (estado
 *        intacto) ⇒ todos los canales idénticos. Un canal que lea el registro cambia.
 * `full` (todos los canales + observaciones completas + stateHash) sólo se usa para las
 * comprobaciones NEGATIVAS del gate (D2/D3: «no cambia la batalla»), donde ser más sensible
 * es más estricto.
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
 *    Ronda 4: en ella el blanco USA su módulo (gira, mueve la torreta, dispara, siembra, emite
 *    y observa), así que el estado del módulo tiene consecuencia de COMPORTAMIENTO y no sólo
 *    de contabilidad (P2-1c).
 *  - G1: E siembra durante más tiempo (hasta la decisión 120) para que las cargas y el
 *    enfriamiento de la mina limiten de verdad cuántas minas hay en el terreno.
 * Selección de módulos: por categoría y datos (slot que acepta la categoría, sector del
 * blindaje, arma que acepta la munición), nunca por id de módulo.
 */
import { createHash } from "node:crypto";
import { loadRuleset } from "../game-rules/index.js";
import { Battle, type BotAgent } from "../../apps/arena-engine/src/sim/battle.js";
import type {
  ModuleCategory as EngineCategory,
  ModuleSpec,
  Vehicle,
  VehicleSpec,
} from "../../apps/arena-engine/src/sim/vehicle.js";
import { emptyArena } from "../../apps/arena-engine/src/fixtures.js";
import { Rng } from "../../apps/arena-engine/src/rng.js";
import { resolveVehicle } from "./resolve/index.js";
import { CATALOG_VERSION } from "./loadCatalog.js";
import { findModule, type LoadoutInput, type LoadoutModuleEntry, type ModuleDefinition } from "./types.js";
import { PROBE_CHANNELS, type ProbeChannel } from "./field-status.js";

const ref = (m: ModuleDefinition): string => `${m.id}@${m.version}`;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

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
 * Ronda 4 · P, el tirador de la durabilidad: el de X con la ametralladora y su munición (las de
 * E). Muchos impactos pequeños en vez de diez grandes: el daño de módulo se sortea en cada
 * impacto (damage.ts, ponderado por masa), así que un módulo ligero (munición, radio) también
 * lo recibe, y D sigue vivo los 300 ticks (en el chasis más resistente) para que se vea lo
 * que HACE con sus módulos dañados.
 */
const POUNDER: LoadoutInput = {
  ...ENEMY,
  loadoutId: "ldt_probe06",
  modules: ENEMY.modules.map((e) =>
    e.slot === "turret_main" ? PROBE_BASE.modules.find((m) => m.slot === e.slot)! : e,
  ),
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
 * Lo que los sensores DETECTAN y DÓNDE, campo a campo (lista blanca de sensors.ts
 * buildObservation). Fuera: `fovRad` y `originHeading` del lidar, `errorM` y `confidence` del
 * radar, `intensity` del acústico y `triggered` del de proximidad (copias del spec o derivados
 * de él y de la distancia), la distancia de un rayo que no toca nada (es el alcance) y, desde
 * la ronda 3, el ÁNGULO de cada rayo: es `heading − fov/2 + fov·t`, una función del spec que la
 * observación puede informar sin que el rayo se lance ahí. Del rayo sólo queda lo que
 * resulta de lanzarlo: qué toca y a qué distancia (si no toca nada, sólo «nada»).
 */
function sensorEffect(sensors: any): unknown {
  const out: unknown[] = [];
  for (const l of sensors.lidar ?? [])
    out.push(["lidar", l.slot, l.rays.map((r: any) => (r.hit === "unknown" ? null : [r.distanceM, r.hit]))]);
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

/**
 * Campos de evento que entran en el canal `events` (lista blanca): tipo, tick, objetivo,
 * quién (si se revela), ranura, motivo, estado nuevo del módulo, sector y posición. Fuera
 * `damage` (hit_taken/hit_dealt): es el `effective` del REGISTRO de daño, no lo aplicado
 * (lo aplicado se mide en el estado: canal `damage`).
 */
const EVENT_FIELDS = ["tick", "kind", "targetId", "sourceId", "slot", "reason", "state", "sector", "position"] as const;
function eventEffect(e: any): unknown {
  return EVENT_FIELDS.map((k) => {
    const v = e?.[k];
    if (v && typeof v === "object" && "x" in v && "y" in v) return [r6(v.x), r6(v.y)];
    return v ?? null;
  });
}

/**
 * Acumulador de la traza: un array por canal + las observaciones completas (sólo para `full`).
 * Las magnitudes de estado sólo entran por `flow` (variación medida); los niveles medidos
 * (`level`) son la referencia del flujo y NUNCA salen a un canal.
 */
class Recorder {
  readonly ch = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, [] as unknown[]])) as Record<ProbeChannel, unknown[]>;
  readonly full: unknown[] = [];
  private readonly level = new Map<string, number>();
  /**
   * Flujo de una magnitud de estado: registra en `channels` la variación desde la medida
   * anterior (si no es cero). La primera medida sólo fija la referencia. `reset` = la
   * magnitud se acaba de restaurar desde el spec (reaparición): se fija la nueva referencia
   * y se anota el HECHO sin valor (el salto sería una copia del spec).
   */
  flow(channels: readonly ProbeChannel[], t: number | string, key: string, value: number, reset = false): void {
    const prev = this.level.get(key);
    this.level.set(key, value);
    if (prev === undefined) return;
    if (reset) {
      for (const c of channels) this.ch[c].push([t, key, "reset"]);
      return;
    }
    const d = r6(value - prev);
    if (d !== 0) for (const c of channels) this.ch[c].push([t, key, d]);
  }
  /** Transición de un valor categórico (estado de módulo, vivo/muerto): sólo cuando cambia. */
  private readonly cat = new Map<string, unknown>();
  transition(channel: ProbeChannel, t: number | string, key: string, value: unknown): void {
    const had = this.cat.has(key);
    const prev = this.cat.get(key);
    this.cat.set(key, value);
    if (had && prev !== value) this.ch[channel].push([t, key, value]);
  }
  obs(tag: string, obs: any) {
    this.full.push([tag, obs]);
    // Sólo la SALIDA de los sensores y lo recibido por radio: no el autoinforme del bot
    // (hullHpMax, capacityEU… son copias del spec, no efectos).
    if (obs.sensors !== undefined) this.ch.sensors.push([tag, obs.tick, sensorEffect(obs.sensors)]);
    if (obs.radio !== undefined)
      this.ch.radio.push([tag, obs.tick, obs.radio.map((m: any) => [m.from, m.data, m.sentTick])]);
  }
  event(tag: string, e: unknown) {
    this.full.push([`${tag}!`, e]);
    this.ch.events.push([tag, eventEffect(e)]);
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

/**
 * Hechos de la batalla, por vehículo («main:veh_1», «durability:veh_1»). NO son canales: sólo
 * los usa la defensa D0a del gate para saber qué reservas puede trasladar sin cambiar la
 * dinámica (una reserva que nunca limita).
 */
export interface VehicleFacts {
  /** Murió (o reapareció) en algún momento: su casco SÍ limita. */
  died: boolean;
  /** Su energía bajó cerca del coste de una acción o a 0: la reserva SÍ limita. */
  energyShort: boolean;
  /** Alguna munición llegó a 0. */
  ammoOut: boolean;
  /** Alguna mina se quedó sin cargas. */
  chargesOut: boolean;
  /** Ranuras cuyo hp cambió (su estado depende del hp máximo: no se trasladan). */
  hitSlots: string[];
}
export type ProbeFacts = Record<string, VehicleFacts>;

/**
 * Ronda 5 (P2-1d) · Modo del RNG de la sonda.
 *   - "engine": el RNG del motor tal cual (flujos xoshiro con semilla). Es el de las
 *     comprobaciones NEGATIVAS del gate (D0, D2, D3: «no cambia nada»), donde ser más sensible
 *     es más estricto: una tirada de más sólo puede poner esas comprobaciones en ROJO.
 *   - "neutral": toda tirada de la batalla vale lo mismo DENTRO de un tick, y ese valor sólo
 *     depende del tick (sucesión de Weyl, ver `neutralUint32`), nunca de cuántas tiradas se
 *     hayan hecho antes ni de qué flujo las pida. Es el de las comprobaciones POSITIVAS (D1
 *     «cambia», D1 «gobierna», ablación D4): mismo comportamiento observable con distinto
 *     consumo del RNG ⇒ misma traza, así que un campo sólo puede «tener efecto» por un efecto
 *     observable real, nunca porque cambie el número de tiradas (mutantes F1/F2 de la revisión).
 *     La dispersión y el error del radar siguen escalando con su campo (la tirada del tick no
 *     está centrada en 0 salvo por casualidad), y el sorteo del módulo dañado sigue variando
 *     de un tick a otro.
 * Se neutraliza en la SONDA (interposición temporal de `Rng.prototype.nextUint32` mientras
 * corre la batalla de sonda), nunca en el motor: producción no cambia.
 */
export type ProbeRngMode = "engine" | "neutral";

/** Opciones de la sonda. */
export interface ProbeOptions {
  /** Transforma el VehicleSpec resuelto de un participante («main:veh_1»…) antes de la batalla (D0a). */
  readonly tweakSpec?: (key: string, spec: VehicleSpec) => VehicleSpec;
  /** Modo del RNG (por defecto "engine"; el gate pasa "neutral" en D1 y D4). */
  readonly rng?: ProbeRngMode;
}

/** Reloj del RNG neutro: el tick de la batalla de sonda en curso (lo fija el bucle antes de cada paso). */
const NEUTRAL_CLOCK = { tick: 0 };
/**
 * Tirada neutra del tick `t`: frac((t+1)·φ) en 32 bits (sucesión de Weyl: bien repartida en
 * [0,1) de un tick a otro). Función PURA del tick: no tiene estado que una tirada avance.
 */
export const neutralUint32 = (t: number): number => Math.imul((t + 1) >>> 0, 0x9e3779b9) >>> 0;

/** Ejecuta `fn` con el RNG en el modo pedido; el original se restaura siempre. */
function withRngMode<T>(mode: ProbeRngMode, fn: () => T): T {
  if (mode !== "neutral") return fn();
  const proto = Rng.prototype as { nextUint32: () => number };
  const orig = proto.nextUint32;
  NEUTRAL_CLOCK.tick = 0;
  proto.nextUint32 = function (): number {
    return neutralUint32(NEUTRAL_CLOCK.tick);
  };
  try {
    return fn();
  } finally {
    proto.nextUint32 = orig;
  }
}

/** Traza de la sonda: digest por canal de efecto, digest completo (sólo negativas) y hechos. */
export interface ProbeTrace {
  readonly channels: Readonly<Record<ProbeChannel, string>>;
  readonly full: string;
  readonly facts: ProbeFacts;
}

const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** Hechos y reapariciones vistas, por vehículo de una batalla. */
class Watch {
  private readonly respawns = new Map<string, number>();
  constructor(
    private readonly battleName: string,
    readonly facts: ProbeFacts,
  ) {}
  /** ¿Reapareció `v` desde la última muestra? (el estado se restauró desde el spec). */
  respawned(v: Vehicle): boolean {
    const before = this.respawns.get(v.id);
    this.respawns.set(v.id, v.respawnsUsed);
    return before !== undefined && before !== v.respawnsUsed;
  }
  note(v: Vehicle): void {
    const k = `${this.battleName}:${v.id}`;
    const f = (this.facts[k] ??= { died: false, energyShort: false, ammoOut: false, chargesOut: false, hitSlots: [] });
    if (!v.alive || v.respawnsUsed > 0) f.died = true;
    let maxCost = 0;
    for (const m of v.modules.values()) {
      maxCost = Math.max(maxCost, m.spec.perActionEU ?? 0);
      if (m.spec.category === "ammo" && m.ammo <= 0) f.ammoOut = true;
      if (m.spec.category === "mine" && m.charges <= 0) f.chargesOut = true;
      if (m.hp !== m.spec.hp && !f.hitSlots.includes(m.spec.slot)) f.hitSlots.push(m.spec.slot);
    }
    if (v.energyEU < 2 * maxCost + 5) f.energyShort = true;
  }
}

/**
 * Estado de un vehículo como FLUJOS + transiciones (regla de la cabecera). `prefix` separa
 * las batallas. `withEnergy`: la batalla de durabilidad no registra energía.
 */
function sampleVehicle(
  rec: Recorder,
  w: Watch,
  t: number | string,
  prefix: string,
  v: Vehicle,
  withEnergy: boolean,
): void {
  const reset = w.respawned(v);
  w.note(v);
  const id = `${prefix}${v.id}`;
  // Casco: hp que pierde en el tick (va también a `damage`: es daño aplicado) y tick de
  // muerte / reaparición.
  rec.flow(["hull", "damage"], t, `${id}:hull`, v.hullHp, reset);
  rec.transition("hull", t, `${id}:alive`, v.alive);
  if (withEnergy) rec.flow(["energy"], t, `${id}:energy`, v.energyEU, reset);
  for (const m of v.modules.values()) {
    // hp que pierde cada módulo, blindaje incluido (su desgaste), medido en el ESTADO.
    rec.flow(["modules", "damage"], t, `${id}:${m.spec.slot}:hp`, m.hp, reset);
    rec.transition("modules", t, `${id}:${m.spec.slot}:state`, v.stateOf(m.spec.slot));
  }
}

/**
 * Ronda 6 (P2-1e) · Identidad OBSERVABLE de proyectiles y minas. El id interno de una entidad
 * (`proj_<entitySeq>`, `mine_<entitySeq>`) sale de un contador del motor que cualquier ruta
 * puede avanzar sin efecto observable (un id gastado de más). Los canales `projectiles` y
 * `mines` NO lo registran: cada entidad se reetiqueta como «el n-ésimo proyectil (o mina) de
 * su propietario, por orden de aparición en la traza» (`veh_1:p0`, `veh_1:p1`, `veh_3:m0`…).
 * El id crudo sólo se usa como CLAVE interna para reconocer la misma entidad de un tick a otro
 * (nunca sale al canal), así que dos batallas con el mismo comportamiento y distinta secuencia
 * de ids dan la misma traza. Una etiqueta por batalla (la principal y la de durabilidad).
 * Dentro de un tick, el orden de aparición es el del array del motor (orden de creación).
 */
export class EntityLabels {
  private readonly label = new Map<string, string>();
  private readonly count = new Map<string, number>();
  of(kind: "p" | "m", rawId: string, ownerId: string): string {
    const key = `${kind}\0${rawId}`;
    let l = this.label.get(key);
    if (l === undefined) {
      const ok = `${kind}\0${ownerId}`;
      const n = this.count.get(ok) ?? 0;
      this.count.set(ok, n + 1);
      l = `${ownerId}:${kind}${n}`;
      this.label.set(key, l);
    }
    return l;
  }
}

/** Proyectiles vivos del tick: etiqueta observable y posición (nunca el id crudo). */
const projectileEffect = (labels: EntityLabels, frame: any): unknown =>
  frame.projectiles.map((p: any) => [labels.of("p", p.id, p.ownerId), p.position.x, p.position.y]);
/** Minas sobre el terreno: etiqueta observable y posición (nunca el id crudo). */
const mineEffect = (labels: EntityLabels, battle: Battle): unknown =>
  battle.getMines().map((m) => [labels.of("m", m.id, m.ownerId), r6(m.position.x), r6(m.position.y)]);

/** Magnitudes de efecto del tick, campo a campo (lista blanca: nada de objetos enteros). */
function sample(battle: Battle, rec: Recorder, w: Watch, labels: EntityLabels): void {
  const t = battle.tick;
  const ch = rec.ch;
  for (const v of battle.getVehicles()) {
    const p = battle.getPhysics().pose(v.id);
    ch.kinematics.push([t, v.id, p ? [r6(p.position.x), r6(p.position.y), r6(p.heading)] : null]);
    ch.turret.push([t, v.id, r6(v.turretHeading)]);
    sampleVehicle(rec, w, t, "", v, true);
  }
  const frame = battle.getInternalFrame();
  ch.projectiles.push([t, projectileEffect(labels, frame)]);
  ch.mines.push([t, mineEffect(labels, battle)]);
  ch.score.push([t, frame.score]);
}

/** D con el sumidero inerte (ver DURABILITY_SINK). */
const withSink = (s: VehicleSpec): VehicleSpec => ({ ...s, modules: [...s.modules, { ...DURABILITY_SINK }] });

/** Participante con su spec resuelto (y, sólo en D0a, transformado). */
function spec(key: string, loadout: LoadoutInput, catalog: ModuleDefinition[], opts: ProbeOptions): VehicleSpec {
  const s = resolveVehicle(loadout, catalog);
  return opts.tweakSpec ? opts.tweakSpec(key, structuredClone(s)) : s;
}

/**
 * Traza de la batalla de sonda con `testedRef` instalado, resuelto contra `catalog`.
 * `loadout` fija el loadout de E (por defecto, loadoutWith sobre el mismo catálogo).
 */
export function probeTrace(
  catalog: ModuleDefinition[],
  testedRef: string,
  loadout?: LoadoutInput,
  opts: ProbeOptions = {},
): ProbeTrace {
  return withRngMode(opts.rng ?? "engine", () => probeTraceIn(catalog, testedRef, loadout, opts));
}

function probeTraceIn(
  catalog: ModuleDefinition[],
  testedRef: string,
  loadout: LoadoutInput | undefined,
  opts: ProbeOptions,
): ProbeTrace {
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
  const facts: ProbeFacts = {};
  const eLoadout = loadout ?? loadoutWith(tested, catalog);
  const battle = new Battle({
    battleId: "catalog-probe",
    seed: "catalog-probe",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bE", team: "red", spec: spec("main:veh_1", eLoadout, catalog, opts) },
      { id: "veh_2", botId: "bA", team: "red", spec: spec("main:veh_2", ALLY, catalog, opts) },
      { id: "veh_3", botId: "bX", team: "blue", spec: spec("main:veh_3", ENEMY, catalog, opts) },
      { id: "veh_4", botId: "bW", team: "blue", spec: spec("main:veh_4", WALL_SITTER, catalog, opts) },
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
  const w = new Watch("main", facts);
  const labels = new EntityLabels();
  try {
    // Referencia de los flujos ANTES del primer paso (no entra en ningún canal).
    sample(battle, rec, w, labels);
    for (const c of PROBE_CHANNELS) rec.ch[c].length = 0;
    for (let i = 0; i < PROBE_TICKS; i++) {
      NEUTRAL_CLOCK.tick = battle.tick;
      battle.step();
      sample(battle, rec, w, labels);
      if (i % 15 === 0) rec.full.push(["hash", battle.tick, battle.stateHash()]);
    }
    rec.full.push(["final", battle.stateHash()]);
  } finally {
    battle.free();
  }
  durability(tested, catalog, eLoadout, rec, facts, opts);
  const channels = Object.fromEntries(PROBE_CHANNELS.map((c) => [c, sha(rec.ch[c])])) as Record<ProbeChannel, string>;
  return { channels, full: sha([channels, rec.full]), facts };
}

/**
 * Ronda 4 · El blanco «D» de la batalla de durabilidad USA lo que lleva en cada decisión: gira
 * sobre sí mismo (sin avanzar: sigue en el punto al que apunta el tirador), barre la torreta
 * hacia el borde de y=0 (lejos del tirador: sus disparos no tocan a nadie), dispara, siembra y
 * emite por radio a un compañero. Así el ESTADO de cada módulo (lo que gobierna su hp) cambia
 * lo que el vehículo HACE, no sólo lo que la sonda contabiliza.
 */
class Operator implements BotAgent {
  private d = 0;
  constructor(
    readonly botId: string,
    private log: Recorder,
  ) {}
  decide(obs: any) {
    const d = this.d++;
    this.log.obs("D", obs);
    return {
      forTick: obs.tick,
      move: { throttle: 0, steer: 1 },
      turret: { targetHeading: -Math.PI / 2 + 0.6 * Math.sin(d * 0.2) },
      fire: ["turret_main"],
      deployMine: { slot: "mine_bay" },
      radio: [{ slot: "radio_a", data: b64(`dur-${String(d).padStart(10, "0")}`) }],
    };
  }
  onEvent(e: unknown) {
    this.log.event("D", e);
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
 * Ronda 4 · Qué lleva el blanco «D» de la durabilidad según la categoría bajo prueba: el módulo
 * bajo prueba y, si sólo con él no puede hacer nada observable, lo mínimo para que su ESTADO
 * tenga consecuencia de comportamiento:
 *   - arma, munición y mina gastan energía al actuar: llevan además el generador de E;
 *   - el generador sólo cuenta por lo que la energía limita: lleva además el arma y la mina de
 *     E (lo que gasta energía al actuar), para que la reserva llegue a agotarse sin él;
 *   - la munición y la pieza `utility` no tienen acción propia: su hp cuenta porque, mientras
 *     viven, absorben daño de módulo que si no recibe el arma (damage.ts, candidatos con hp > 0);
 *   - ronda 5 · el blindaje lleva además el tren de rodaje de E: D gira sobre sí mismo y el
 *     tirador le da en TODOS los sectores. Sin él, D no se mueve, todos los impactos le llegan
 *     por delante y un blindaje en otro sector (la mutación de armor.sector) sólo se veía en la
 *     batalla principal cuando la dispersión del RNG hacía llegar algún impacto por ese lado:
 *     con el RNG neutro de D1/D4 ese impacto casual desaparece.
 */
/**
 * Ronda 4 · Sumidero inerte de D (no es contenido del catálogo: sólo existe en la sonda). Un
 * módulo sin acción (utility), de 1 kg e indestructible en 300 ticks. Mientras D tenga módulos
 * vivos con él, cada impacto sigue sorteando el módulo dañado (damage.ts: sólo hay sorteo si
 * hay candidatos), así que la destrucción del módulo bajo prueba NO desplaza el flujo «combat»
 * del RNG (con el que también se sortea la dispersión del tirador). Sin él, cualquier hp
 * «gobernaría» cualquier canal sólo por ese desplazamiento, sin que su consumidor actuara.
 */
const DURABILITY_SINK: ModuleSpec = {
  slot: "probe_sink",
  moduleId: "probe.sink@0",
  category: "utility",
  hp: 1e6,
  massKg: 1,
  costCredits: 0,
};

const DURABILITY_KIT: Readonly<Record<string, readonly EngineCategory[]>> = {
  chassis: [],
  movement: ["movement"],
  power: ["power", "weapon", "mine"],
  sensor: ["sensor"],
  weapon: ["weapon", "power"],
  ammo: ["weapon", "power"],
  mine: ["mine", "power"],
  armor: ["armor", "movement"],
  radio: ["radio"],
  utility: ["utility", "weapon", "power"],
};

/**
 * G1.2 · Batalla de DURABILIDAD: el `hp` de un módulo sólo tiene efecto observable cuando
 * el módulo recibe daño (cambia su estado → su rendimiento). En la batalla principal el
 * daño de módulo se reparte por masa (damage.ts: `weighted` por massKg) y un módulo ligero
 * (radio, sensor, mina) casi nunca lo recibe en 450 ticks. Aquí el blanco «D» lleva el
 * módulo bajo prueba (las entradas de su categoría en el loadout de E; para un arma, con su
 * munición) y lo mínimo para usarlo (DURABILITY_KIT), y le disparan a 12 m sin parar (con el
 * cañón hasta la ronda 3; desde la ronda 4, con la ametralladora: ver POUNDER).
 * Ronda 3 · se registran, con la misma regla que la batalla principal, el hp que pierden el
 * casco y cada módulo de D en cada tick, las transiciones de estado y el tick de muerte de D
 * (el cañón lo lleva hasta la destrucción: así el hp del casco decide CUÁNDO muere).
 * Ronda 4 · D usa su módulo (Operator) y se registra su COMPORTAMIENTO: rumbo y posición,
 * torreta, proyectiles, minas, lo que detectan sus sensores, lo que recibe por radio su
 * compañero «R» y el marcador (una muerte puntúa).
 */
function durability(
  tested: ModuleDefinition,
  catalog: ModuleDefinition[],
  base: LoadoutInput,
  rec: Recorder,
  facts: ProbeFacts,
  opts: ProbeOptions,
): void {
  const catOf = (e: LoadoutModuleEntry) => findModule(catalog, e.moduleId)?.category;
  const kit = DURABILITY_KIT[tested.category] ?? [];
  // Ronda 4 · para un módulo, D va en el chasis de más casco del catálogo (por datos): así
  // sigue vivo toda la batalla y su comportamiento depende del estado de sus módulos, no de
  // cuándo muere. Para un chasis, el chasis bajo prueba (su casco decide CUÁNDO muere).
  const sturdiest = catalog
    .filter((m) => m.category === "chassis")
    .reduce((a, b) => ((b.hullHp ?? 0) > (a.hullHp ?? 0) ? b : a));
  const target: LoadoutInput = {
    ...base,
    loadoutId: "ldt_probe05",
    chassis: tested.category === "chassis" ? base.chassis : ref(sturdiest),
    modules: base.modules.filter((e) => kit.includes(catOf(e) as EngineCategory)),
  };
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: { x: 40, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 52, y: 40 }, heading: Math.PI },
    // R: compañero de D a 16 m, fuera de la línea de tiro: dentro del alcance de la radio
    // incluso con el módulo crítico (alcance · rendimiento).
    { team: "red", position: { x: 40, y: 56 }, heading: 0 },
  ];
  NEUTRAL_CLOCK.tick = 0;
  const battle = new Battle({
    battleId: "catalog-probe-durability",
    seed: "catalog-probe-durability",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bD", team: "red", spec: withSink(spec("durability:veh_1", target, catalog, opts)) },
      { id: "veh_2", botId: "bP", team: "blue", spec: spec("durability:veh_2", POUNDER, catalog, opts) },
      { id: "veh_3", botId: "bR", team: "red", spec: spec("durability:veh_3", ALLY, catalog, opts) },
    ],
  });
  battle.attachBot("veh_1", new Operator("bD", rec));
  battle.attachBot("veh_2", new Pounder("bP", { x: 40, y: 40 }));
  battle.attachBot("veh_3", new Listener("bR", "DR", rec));
  const w = new Watch("durability", facts);
  const labels = new EntityLabels();
  const byId = (id: string) => battle.getVehicles().find((v) => v.id === id)!;
  const d = () => byId("veh_1");
  // Tirador y compañero sólo aportan hechos (D0a): sus reservas no entran en ningún canal.
  const noteOthers = () => {
    w.note(byId("veh_2"));
    w.note(byId("veh_3"));
  };
  try {
    sampleVehicle(rec, w, "D0", "D:", d(), false);
    noteOthers();
    for (let i = 0; i < DURABILITY_TICKS; i++) {
      NEUTRAL_CLOCK.tick = battle.tick;
      battle.step();
      const t = `D${battle.tick}`;
      sampleVehicle(rec, w, t, "D:", d(), false);
      noteOthers();
      // Comportamiento de D (ronda 4): lo que HACE con lo que lleva.
      const p = battle.getPhysics().pose("veh_1");
      rec.ch.kinematics.push([t, p ? [r6(p.position.x), r6(p.position.y), r6(p.heading)] : null]);
      rec.ch.turret.push([t, r6(d().turretHeading)]);
      const frame = battle.getInternalFrame();
      rec.ch.projectiles.push([t, projectileEffect(labels, frame)]);
      rec.ch.mines.push([t, mineEffect(labels, battle)]);
      rec.ch.score.push([t, frame.score]);
      rec.full.push(["D", battle.tick, d().alive]);
    }
    rec.full.push(["D-final", battle.stateHash()]);
  } finally {
    battle.free();
  }
}
