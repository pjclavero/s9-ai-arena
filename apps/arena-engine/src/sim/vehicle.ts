/**
 * Vehículo en simulación (T2.3).
 *
 * La ficha efectiva la resuelve E3 (resolveVehicle). Aquí vive el ESTADO en batalla:
 * salud de chasis, salud y estado de cada módulo, energía, munición, cooldowns.
 *
 * Principio del proyecto: el hardware determina lo que el código puede hacer.
 * Si el módulo de movimiento está destruido, ninguna orden lo mueve. Si el lidar está
 * destruido, ninguna observación lo incluye. La comprobación vive aquí, no en el bot.
 */
import {
  MASS_SPEED_FLOOR,
  MODULE_REACTIVATION_TICKS,
  SECTORS,
  performanceOf,
  stateFromHealth,
  type ModuleState,
  type Sector,
} from "../../../../packages/game-rules/index.js";
import { clamp } from "./physics.js";

export type ModuleCategory =
  | "movement" | "power" | "sensor" | "weapon" | "ammo"
  | "mine" | "armor" | "radio" | "utility";

/** Especificación efectiva de un módulo, tal y como la entrega E3 (catálogo congelado). */
export interface ModuleSpec {
  slot: string;
  moduleId: string;
  category: ModuleCategory;
  hp: number;
  massKg: number;
  costCredits: number;
  passiveEUs?: number;
  perActionEU?: number;
  // movement
  maxSpeedMs?: number;
  accelerationMs2?: number;
  turnRateRads?: number;
  ratedLoadKg?: number;
  // power
  capacityEU?: number;
  generationEUs?: number;
  // sensor
  sensorType?: "lidar" | "radar" | "proximity" | "acoustic";
  rangeM?: number;
  fovRad?: number;
  rays?: number;
  errorM?: number;
  // weapon
  damage?: number;
  cooldownTicks?: number;
  projectileSpeedMs?: number;
  spreadRad?: number;
  turretArcRad?: number;
  turretRateRads?: number;
  acceptsAmmo?: string[];
  // ammo
  rounds?: number;
  damageMultiplier?: number;
  explosionRadiusM?: number;
  // mine
  charges?: number;
  triggerRadiusM?: number;
  armDelayTicks?: number;
  lifetimeTicks?: number;
  // armor
  sector?: Sector;
  reduction?: number;
  // radio
  maxMessageBytes?: number;
  maxMessagesPerSecond?: number;
}

export interface VehicleSpec {
  chassisId: string;
  hullHp: number;
  radiusM: number;
  massKg: number;
  modules: ModuleSpec[];
}

export interface ModuleRuntime {
  spec: ModuleSpec;
  hp: number;
  /** offline = apagado a voluntad por el bot (no es daño). */
  offline: boolean;
  reactivateAtTick: number;
  cooldownUntilTick: number;
  ammo: number;
  charges: number;
}

export class Vehicle {
  readonly id: string;
  readonly team: string;
  readonly botId: string;
  readonly spec: VehicleSpec;

  hullHp: number;
  /**
   * Heading del CHASIS, espejo del último conocido por la física (el mundo es la
   * autoridad; el bucle lo refresca tras cada step). Antes vivía en un WeakMap global
   * de combat.ts (ERR-ENG-05): estado mutable a nivel de módulo, compartido entre
   * batallas del proceso, y que devolvía 0 para un vehículo aún no registrado. Es
   * estado del vehículo y vive aquí.
   */
  heading = 0;
  turretHeading = 0;
  energyEU: number;
  alive = true;
  respawnAtTick = 0;
  carryingFlag: string | null = null;
  /**
   * R3.8 · Marca de Juggernaut/VIP, al estilo carryingFlag: estado por vehículo que
   * SOLO el modo juggernaut activa. Entra en el hash canónico de estado y en el
   * snapshot público (battle.ts): es estado de simulación, no decoración.
   */
  juggernaut = false;

  /** Salud del blindaje por sector, en fracción 0..1. Sin blindaje = sin entrada. */
  armor: Partial<Record<Sector, { hp: number; hpMax: number; reduction: number; slot: string }>> = {};
  modules = new Map<string, ModuleRuntime>();

  /** Contabilidad para timeouts y descalificación (D2). */
  consecutiveTimeouts = 0;
  disconnectedSinceTick: number | null = null;
  disqualified = false;

  /** Última orden válida: es la base de la ACCIÓN SEGURA (D2). */
  lastMove = { throttle: 0, steer: 0 };
  lastTurretTarget: number | null = null;

  /**
   * Rate-limit de radio SIN fuga (ERR-ENG-06): un contador por vehículo que guarda el
   * segundo de juego al que pertenece y se reinicia al cambiar de segundo. Sustituye al
   * Map `id:segundo` de Battle, que crecía una entrada por vehículo y segundo y nunca
   * se purgaba (~2 entradas/s con 2 vehículos durante toda la batalla).
   */
  radioSecond = -1;
  radioSentThisSecond = 0;

  constructor(id: string, team: string, botId: string, spec: VehicleSpec) {
    this.id = id;
    this.team = team;
    this.botId = botId;
    this.spec = spec;
    this.hullHp = spec.hullHp;

    for (const m of spec.modules) {
      this.modules.set(m.slot, {
        spec: m,
        hp: m.hp,
        offline: false,
        reactivateAtTick: 0,
        cooldownUntilTick: 0,
        ammo: m.rounds ?? 0,
        charges: m.charges ?? 0,
      });
      if (m.category === "armor" && m.sector) {
        this.armor[m.sector] = {
          hp: m.hp,
          hpMax: m.hp,
          reduction: m.reduction ?? 0,
          slot: m.slot,
        };
      }
    }
    this.energyEU = this.energyCapacity();
  }

  // ------------------------------------------------------------------ estados
  stateOf(slot: string): ModuleState {
    const m = this.modules.get(slot);
    if (!m) return "destroyed";
    if (m.offline) return "offline";
    return stateFromHealth(m.hp / m.spec.hp);
  }

  /** Rendimiento efectivo de un módulo: 0 si no puede actuar. */
  performanceOf(slot: string): number {
    return performanceOf(this.stateOf(slot));
  }

  modulesOf(category: ModuleCategory): ModuleRuntime[] {
    return [...this.modules.values()].filter((m) => m.spec.category === category);
  }

  /** Módulos vivos de una categoría (excluye destruidos y apagados). */
  activeModulesOf(category: ModuleCategory): ModuleRuntime[] {
    return this.modulesOf(category).filter((m) => {
      const st = this.stateOf(m.spec.slot);
      return st !== "destroyed" && st !== "offline";
    });
  }

  // ------------------------------------------------------------------ energía
  energyCapacity(): number {
    return this.modulesOf("power").reduce((a, m) => a + (m.spec.capacityEU ?? 0), 0);
  }

  /** Generación efectiva: un generador dañado genera menos. */
  energyGeneration(): number {
    return this.modulesOf("power").reduce(
      (a, m) => a + (m.spec.generationEUs ?? 0) * this.performanceOf(m.spec.slot),
      0,
    );
  }

  /** Consumo pasivo: los módulos apagados no consumen (D7). */
  passiveDrain(): number {
    let sum = 0;
    for (const m of this.modules.values()) {
      const st = this.stateOf(m.spec.slot);
      if (st === "destroyed" || st === "offline") continue;
      sum += m.spec.passiveEUs ?? 0;
    }
    return sum;
  }

  /** Se ejecuta una vez por tick (paso 3 del bucle). */
  tickEnergy(dt: number): void {
    const net = this.energyGeneration() - this.passiveDrain();
    this.energyEU = clamp(this.energyEU + net * dt, 0, this.energyCapacity());
  }

  /** Intenta gastar energía para una acción puntual. Falso = no hay bastante. */
  spendEnergy(eu: number): boolean {
    if (this.energyEU < eu) return false;
    this.energyEU -= eu;
    return true;
  }

  // ---------------------------------------------------------------- movilidad
  /**
   * Prestaciones de movimiento efectivas: módulo de movimiento degradado por su estado
   * Y por el exceso de masa (D7). Sin movimiento operativo ⇒ el vehículo no se mueve.
   */
  movementCaps(): { maxSpeedMs: number; accelerationMs2: number; turnRateRads: number } | null {
    const drives = this.activeModulesOf("movement");
    if (drives.length === 0) return null;

    // El mejor módulo de movimiento operativo manda (no se suman).
    let best: { caps: any; perf: number } | null = null;
    for (const d of drives) {
      const perf = this.performanceOf(d.spec.slot);
      if (perf <= 0) continue;
      if (!best || perf * (d.spec.maxSpeedMs ?? 0) > best.perf * (best.caps.maxSpeedMs ?? 0)) {
        best = { caps: d.spec, perf };
      }
    }
    if (!best) return null;

    const rated = best.caps.ratedLoadKg ?? this.spec.massKg;
    const massRatio = this.spec.massKg / rated;
    const massFactor = clamp(massRatio <= 1 ? 1 : 1 / massRatio, MASS_SPEED_FLOOR, 1);
    const f = best.perf * massFactor;

    return {
      maxSpeedMs: (best.caps.maxSpeedMs ?? 0) * f,
      accelerationMs2: (best.caps.accelerationMs2 ?? 0) * f,
      turnRateRads: (best.caps.turnRateRads ?? 0) * f,
    };
  }

  /**
   * ¿Puede girar la torreta? Es INDEPENDIENTE del movimiento: un vehículo con las
   * orugas destruidas sigue girando la torreta y disparando (criterio de T2.3).
   */
  turretRate(): number {
    const weapons = this.activeModulesOf("weapon");
    if (weapons.length === 0) return 0;
    let rate = 0;
    for (const w of weapons) {
      rate = Math.max(rate, (w.spec.turretRateRads ?? 0) * this.performanceOf(w.spec.slot));
    }
    return rate;
  }

  // -------------------------------------------------------------- apagar/encender
  setModuleEnabled(slot: string, enabled: boolean, tick: number): "ok" | "unknown_slot" | "reactivating" {
    const m = this.modules.get(slot);
    if (!m) return "unknown_slot";
    if (enabled) {
      if (!m.offline) return "ok";
      if (tick < m.reactivateAtTick) return "reactivating";
      m.offline = false;
      return "ok";
    }
    if (!m.offline) {
      m.offline = true;
      m.reactivateAtTick = tick + MODULE_REACTIVATION_TICKS;
    }
    return "ok";
  }

  /** Reactivación diferida: apagar es instantáneo, encender cuesta ticks (D6/mejora E3.M). */
  tickReactivation(tick: number): void {
    for (const m of this.modules.values()) {
      if (m.offline && m.reactivateAtTick > 0 && tick >= m.reactivateAtTick) {
        // Solo se reactiva si el bot lo pidió; el reloj marca cuándo PUEDE hacerlo.
      }
    }
  }

  // --------------------------------------------------------------- respawn
  respawn(position: { x: number; y: number }): void {
    this.hullHp = this.spec.hullHp;
    this.alive = true;
    this.carryingFlag = null;
    // La marca de juggernaut NO revive con el vehículo: la reasigna el modo al morir
    // el marcado (onKill). Limpiarla aquí es la red de seguridad que evita dos marcados.
    this.juggernaut = false;
    this.energyEU = this.energyCapacity();
    for (const m of this.modules.values()) {
      m.hp = m.spec.hp;
      m.offline = false;
      m.cooldownUntilTick = 0;
      m.ammo = m.spec.rounds ?? 0;
      m.charges = m.spec.charges ?? 0;
    }
    for (const s of SECTORS) {
      const a = this.armor[s];
      if (a) a.hp = a.hpMax;
    }
    this.lastMove = { throttle: 0, steer: 0 };
    this.lastTurretTarget = null;
  }
}
