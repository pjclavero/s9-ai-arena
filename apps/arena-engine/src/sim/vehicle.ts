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
import { emptyDict, safeLookup } from "../../../../packages/game-rules/safe-lookup.js";
import { normalizeAngle } from "../../../../packages/game-rules/damage-contract.js";
import type { ArmorProfile, TurretMountDef } from "../../../../packages/module-catalog/contracts/engine-v2.js";

/** Arco completo: a partir de aquí la montura no limita el giro. */
const FULL_ARC = Math.PI * 2 - 1e-6;

export type ModuleCategory =
  "movement" | "power" | "sensor" | "weapon" | "ammo" | "mine" | "armor" | "radio" | "utility";

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
  // D-B2 · la tasa y el arco de la torreta NO son del arma: son de la montura
  // (VehicleSpec.turretMounts, por ranura del chasis).
  acceptsAmmo?: string[];
  /**
   * SÓLO DERIVADO (informativo): lo calcula resolveVehicle() desde weapon.rangeM y la velocidad.
   * El motor NO lo lee como entrada: deriva la vida de rangeM/velocidad (combat.ts
   * projectileLifetimeOf) y, si este campo discrepa, lanza (spec incoherente).
   */
  projectileLifetimeTicks?: number;
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
  /**
   * D-B2 · Monturas de torreta por RANURA del chasis (dato del chasis, público por diseño).
   * Una ranura de arma sin montura no gira la torreta ni dispara fuera del frente.
   */
  turretMounts?: Record<string, TurretMountDef>;
}

/**
 * Estado de un sector de blindaje. FUENTE ÚNICA: `hp` ES el hp del módulo de blindaje
 * (ModuleRuntime de su ranura); no hay una segunda copia que pueda divergir.
 */
export interface ArmorSectorState {
  readonly slot: string;
  readonly hpMax: number;
  readonly profile: ArmorProfile;
  /** Compatibilidad de lectura: resistencia por defecto (`resist.default`). */
  readonly reduction: number;
  hp: number;
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
  /** R-RULES (ADR-021) · reapariciones ya usadas (sólo limita con `respawn.maxRespawns`). */
  respawnsUsed = 0;
  carryingFlag: string | null = null;
  /**
   * R3.8 · Marca de Juggernaut/VIP, al estilo carryingFlag: estado por vehículo que
   * SOLO el modo juggernaut activa. Entra en el hash canónico de estado y en el
   * snapshot público (battle.ts): es estado de simulación, no decoración.
   */
  juggernaut = false;

  /**
   * Blindaje por sector (hp ABSOLUTO del módulo de blindaje de ese sector; sin blindaje =
   * sin entrada). Fuente única: cada entrada lee y escribe el `hp` del módulo.
   *
   * B8 (barrido, 2ª pasada) · `emptyDict()`, NO `{}`. Se rellena con
   * `this.armor[m.sector] = ...` y `m.sector` sale del CATÁLOGO de módulos
   * (JSON de datos, no código). Con `{}`, un `sector: "__proto__"` no crearía la
   * entrada: reemplazaría el prototipo del objeto, y a partir de ahí la lectura
   * de CUALQUIER otro sector (`this.armor[s]`) heredaría ese blindaje. Además
   * `armor` entra en el hash canónico de estado, así que el daño sería silencioso Y
   * determinista-incompatible.
   */
  armor: Partial<Record<Sector, ArmorSectorState>> = emptyDict<ArmorSectorState>();
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
        const rt = this.modules.get(m.slot)!;
        const reduction = m.reduction ?? 0;
        const profile: ArmorProfile = Object.freeze({
          resist: Object.freeze({ default: reduction }),
          degradation: "binary" as const,
        });
        this.armor[m.sector] = {
          slot: m.slot,
          hpMax: m.hp,
          profile,
          reduction,
          get hp() {
            return rt.hp;
          },
          set hp(v: number) {
            rt.hp = v;
          },
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

  /** D-B2 · Montura de la ranura (dato del chasis). Lectura segura frente a `__proto__`. */
  mountOf(slot: string): TurretMountDef | undefined {
    const mounts = this.spec.turretMounts;
    return mounts ? safeLookup(mounts, slot) : undefined;
  }

  /**
   * ¿Puede girar la torreta? Es INDEPENDIENTE del movimiento: un vehículo con las
   * orugas destruidas sigue girando la torreta y disparando (criterio de T2.3).
   * La tasa es la de la MONTURA de cada arma activa (D-B2), degradada por el estado del
   * arma; manda la mejor.
   */
  turretRate(): number {
    let rate = 0;
    for (const w of this.activeModulesOf("weapon")) {
      const mount = this.mountOf(w.spec.slot);
      if (!mount) continue;
      rate = Math.max(rate, mount.turretRateRads * this.performanceOf(w.spec.slot));
    }
    return rate;
  }

  /**
   * Arco de giro de la torreta respecto al morro (rad, centrado). Una sola torreta lleva
   * todas las armas: manda la montura MÁS restrictiva entre las armas activas. Sin armas
   * activas, la torreta no gira (tasa 0) y el arco es irrelevante: se devuelve 2π.
   */
  turretArc(): number {
    let arc = Math.PI * 2;
    for (const w of this.activeModulesOf("weapon")) {
      arc = Math.min(arc, this.mountArcOf(w.spec.slot));
    }
    return arc;
  }

  /** Arco de la montura de una ranura de arma; sin montura = 0 (sólo el frente exacto). */
  mountArcOf(slot: string): number {
    return this.mountOf(slot)?.turretArcRad ?? 0;
  }

  /**
   * Un tick de torreta: gira hacia el objetivo limitado por la tasa de la montura y, si
   * el arco no es completo, LIMITA EL GIRO al arco (antes sólo se comprobaba al
   * disparar). El ángulo queda normalizado a (−π, π].
   */
  stepTurret(dt: number): void {
    const rate = this.turretRate();
    const arc = this.turretArc();
    const limited = arc < FULL_ARC;
    const half = arc / 2;
    if (limited) {
      // En el marco del casco, el arco es un intervalo contiguo [−half, half]: se mueve
      // sin envolver para no cruzar nunca la zona prohibida.
      let rel = clamp(normalizeAngle(this.turretHeading - this.heading), -half, half);
      if (this.lastTurretTarget != null && rate > 0) {
        const want = clamp(normalizeAngle(this.lastTurretTarget - this.heading), -half, half);
        const maxStep = rate * dt;
        rel += clamp(want - rel, -maxStep, maxStep);
      }
      this.turretHeading = normalizeAngle(this.heading + rel);
      return;
    }
    if (this.lastTurretTarget != null && rate > 0) {
      // Mismo envolvimiento que el bucle histórico ([−π, π]): conserva el sentido de giro
      // en el empate exacto de ±π (caracterización).
      let diff = this.lastTurretTarget - this.turretHeading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const maxStep = rate * dt;
      this.turretHeading += clamp(diff, -maxStep, maxStep);
    }
    this.turretHeading = normalizeAngle(this.turretHeading);
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
  /**
   * OLA2-G3 · REARME: munición al MÁXIMO de catálogo (rondas de `ammo`, cargas de `mine`).
   * Asignación, no suma: idempotente y nunca por encima del máximo. No repara módulos ni
   * toca energía o cooldowns. Lo usan `respawn()` (siempre) y la regla
   * `respawn.rearmPolicy = "all_alive_participants"` del bucle (PASO 7) para los vivos.
   */
  rearm(): void {
    for (const m of this.modules.values()) {
      m.ammo = m.spec.rounds ?? 0;
      m.charges = m.spec.charges ?? 0;
    }
  }

  respawn(position: { x: number; y: number }): void {
    this.respawnsUsed += 1;
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
    }
    this.rearm();
    for (const s of SECTORS) {
      const a = this.armor[s];
      if (a) a.hp = a.hpMax;
    }
    this.lastMove = { throttle: 0, steer: 0 };
    this.lastTurretTarget = null;
  }
}
