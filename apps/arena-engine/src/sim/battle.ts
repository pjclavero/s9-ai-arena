/**
 * Bucle de batalla (T2.1, T2.6). Los 9 pasos del capítulo 9.2, en orden estable.
 *
 * DETERMINISMO. Es la propiedad de la que depende todo lo demás (replays, auditoría,
 * torneos justos). Las reglas que lo garantizan:
 *   1. Tick FIJO (TICK_DT). Jamás se lee el reloj del sistema para lógica de juego.
 *   2. Toda aleatoriedad sale del Rng con semilla. Math.random está prohibido por lint.
 *   3. El orden de iteración es SIEMPRE el mismo (arrays ordenados, nunca Set/Map sin orden).
 *   4. Un bot lento no cambia el resultado: si no responde a tiempo, acción segura y a otra cosa.
 * El hash del estado final es la prueba: mismo seed ⇒ mismo hash, siempre.
 */
import {
  DECISION_EVERY_N_TICKS,
  emptyDict,
  OVERTIME_TECHNICAL_LIMIT_TICKS,
  RADIO_DELIVERY_DELAY_DECISIONS,
  TICK_DT,
  TICK_HZ,
  type Ruleset,
} from "../../../../packages/game-rules/index.js";
import { RngStreams } from "../rng.js";
import { computeStateHash, type StateHashBreakdown } from "./state-hash.js";
import deps from "../engine-deps.json" with { type: "json" };
import { canDeployMine, canFire, deployMine, explosionFalloff, fire, type Mine, type Projectile } from "./combat.js";
import { ARENA_BOUNDARY_ID_PREFIX } from "../arena-map.js";
import {
  TECHNICAL_LIMIT,
  chooseSpawn,
  createMode,
  eliminatedByDeath,
  respawnLimited,
  respawnsLeft,
  spawnPoolFor,
  type ArenaMap,
  type GameMode,
  type SpawnDisk,
} from "./modes.js";
import { PhysicsWorld, finite, finiteClamped, initPhysics, type Vec2 } from "./physics.js";
import { captureInternalFrame } from "./internal-frame.js";
import { buildObservation, radioRangeOf, validateRadio, type RadioMessage } from "./sensors.js";
import { Vehicle, type VehicleSpec } from "./vehicle.js";
import { resolveDamage, type EngineDamageRecord, type EnginePacket } from "./damage.js";
import {
  DEFAULT_DIRECT_DAMAGE_TYPE,
  DEFAULT_EXPLOSION_DAMAGE_TYPE,
  ZONE_DAMAGE_TYPE,
} from "../../../../packages/game-rules/damage-contract.js";
import type { DamageSourceKind } from "../../../../packages/module-catalog/contracts/engine-v2.js";

const MAX_MINES_PER_VEHICLE = 3;
/**
 * Guard de longitud de la cola de radio (ERR-ENG-06). Con el retardo de entrega actual
 * la cola es autopurgante, pero un cambio de reglas (retardos largos, más vehículos)
 * la convertiría en fuga. Techo generoso: a 2 msg/s por vehículo jamás se roza; si se
 * alcanza, el mensaje se rechaza con evento, no se acumula.
 */
const MAX_RADIO_QUEUE = 1024;

export interface Participant {
  id: string;
  botId: string;
  team: string;
  spec: VehicleSpec;
}

export interface BattleConfig {
  battleId: string;
  seed: string;
  ruleset: Ruleset;
  map: ArenaMap;
  participants: Participant[];
  /** Frecuencia de snapshot para espectadores. NO afecta al determinismo (test lo prueba). */
  snapshotEveryNTicks?: number;
  /** Cada cuántos ticks se emite un hash de estado para verificar replays. */
  hashEveryNTicks?: number;
  /** OLA2-MD · cada cuántos ticks se graba un checkpoint con el desglose por componentes (defecto 300). */
  checkpointEveryNTicks?: number;
  recordReplay?: boolean;
  /**
   * N2 · Latencia simulada (DETERMINISTA, off por defecto). Cuando está presente, el
   * comando aceptado en un ciclo de decisión no surte efecto en ESE ciclo: se retrasa
   * un número de ciclos de decisión sorteado con el RNG canónico, en [minCycles,
   * maxCycles]. Mientras el comando está "en vuelo" el vehículo sigue con su última
   * acción segura (v.lastMove), igual que la rama de timeout.
   *
   * GARANTÍA: con este campo ausente/undefined no se consume RNG nuevo y la ejecución
   * es byte-idéntica a la de antes de N2 (mismo finalStateHash, mismos stateHashes).
   * El reloj de simulación (tick) NO se altera: solo se difiere QUÉ comando se aplica
   * en cada tick.
   */
  simulatedLatency?: { minCycles: number; maxCycles: number };
}

export interface BattleResult {
  battleId: string;
  /** Equipo ganador, "draw", o null si la batalla se detuvo SIN resultado deportivo. */
  winner: string | "draw" | null;
  /**
   * Motor 0.4.0 (ADR-022) · sólo si la batalla NO terminó por las reglas:
   * `technical_limit` = la salvaguarda técnica de la prórroga la detuvo (sin resultado
   * deportivo). Ausente en toda batalla normal (resultados de 0.3.0 idénticos).
   */
  endReason?: "technical_limit";
  ticks: number;
  score: Record<string, number>;
  finalStateHash: string;
  disqualified: string[];
  versions: {
    engine: string;
    physics: string;
    rules: string;
    protocol: string;
  };
}

/** Un bot: recibe observaciones, devuelve comandos. Los BotStub internos lo implementan. */
export interface BotAgent {
  readonly botId: string;
  /** Devuelve el COMMAND, o null si "no responde" (para probar timeouts). */
  decide(observation: any): any | null;
  onEvent?(event: any): void;
}

/**
 * Grosor (m) de cada muro de perímetro. Sobra con mucho para que un vehículo a
 * velocidad máxima (13 m/s → 0,43 m por tick) no lo atraviese ni sin CCD, y no
 * cuesta nada: son 4 cuerpos fijos por batalla.
 */
export const ARENA_BOUNDARY_THICKNESS_M = 10;

/**
 * Cierra la arena con cuatro muros FUERA del rectángulo [0,widthM]×[0,heightM],
 * con la cara interior exactamente sobre el borde. Los muros norte/sur se alargan
 * el grosor por cada lado para tapar las esquinas.
 *
 * Son muros de verdad (kind "wall"): bloquean el movimiento, la visión y los
 * proyectiles, y los sensores los ven igual que cualquier otro muro (los bots ya
 * reciben solo el tipo de impacto, nunca su id). No se añaden a `config.map`: el
 * mapa de la batalla sigue siendo exactamente el pedido (sameArenaMap).
 */
export function addArenaBoundary(physics: PhysicsWorld, widthM: number, heightM: number): void {
  const t = ARENA_BOUNDARY_THICKNESS_M;
  const half = t / 2;
  physics.addWall(`${ARENA_BOUNDARY_ID_PREFIX}s`, { x: widthM / 2, y: -half }, widthM / 2 + t, half);
  physics.addWall(`${ARENA_BOUNDARY_ID_PREFIX}n`, { x: widthM / 2, y: heightM + half }, widthM / 2 + t, half);
  physics.addWall(`${ARENA_BOUNDARY_ID_PREFIX}w`, { x: -half, y: heightM / 2 }, half, heightM / 2);
  physics.addWall(`${ARENA_BOUNDARY_ID_PREFIX}e`, { x: widthM + half, y: heightM / 2 }, half, heightM / 2);
}

function insideArena(p: Vec2, map: Pick<ArenaMap, "widthM" | "heightM">): boolean {
  return p.x >= 0 && p.x <= map.widthM && p.y >= 0 && p.y <= map.heightM;
}

export class Battle {
  readonly config: BattleConfig;
  /** OLA2-MD · flujos de RNG con nombre (combat, sensors, effects, guidance, latency). */
  private rng: RngStreams;
  private physics: PhysicsWorld;
  private mode: GameMode;
  private vehicles: Vehicle[] = [];
  private agents = new Map<string, BotAgent>();

  private projectiles: Projectile[] = [];
  private mines: Mine[] = [];
  private radioQueue: RadioMessage[] = [];
  private sounds: { position: Vec2; kind: "gunshot" | "engine" | "explosion"; intensity: number }[] = [];
  /**
   * DOBLE BÚFER de sonidos (ERR-ENG-01). `observedSounds` conserva los sonidos del ciclo
   * de decisión ANTERIOR, ya congelados: es lo que oyen las observaciones de este tick.
   * `sounds` es el acumulador del ciclo EN CURSO, donde empujan física y combate. Se
   * mantienen separados para que un bot oiga lo que sonó durante el ciclo completo que
   * acaba de terminar, y para que las dos rutas de observación lean el mismo conjunto.
   */
  private observedSounds: { position: Vec2; kind: "gunshot" | "engine" | "explosion"; intensity: number }[] = [];
  private destructibleHp = new Map<string, number>();

  private entitySeq = 0;
  /**
   * OLA 2 · MB · Registros EXACTOS de daño del tick en curso (INTERNAL_DAMAGE_STATE), en
   * orden de resolución. Derivados: no entran en el hash ni en el replay; los consume la
   * etapa interna (captureInternalFrame, MA) y el damageLog derivado (MD).
   */
  private tickDamage: EngineDamageRecord[] = [];
  tick = 0;
  private finished = false;
  private result: BattleResult | null = null;

  /** Eventos por bot (niebla de guerra: cada uno solo ve lo suyo) + eventos públicos. */
  private pendingEvents = new Map<string, any[]>();
  publicEvents: any[] = [];
  /**
   * Motor 0.4.0 (ADR-022) · bajas de vehículos ENEMIGOS por equipo (criterio de
   * desempate `kills`). SÍ entra en el hash (componente `mode`, state-hash v2).
   */
  private teamKills: Record<string, number> = emptyDict<number>();
  snapshots: any[] = [];
  stateHashes: { tick: number; hash: string }[] = [];
  /** OLA2-MD · checkpoints del replay v2: hash + desglose por componentes (incluye el final). */
  checkpoints: { tick: number; hash: string; components: StateHashBreakdown["components"] }[] = [];
  replayCommands: { tick: number; vehicleId: string; command: any }[] = [];
  /**
   * N2 · Comandos "en vuelo" bajo latencia simulada: readyAtTick es el tick de
   * decisión en el que deben incorporarse al mapa `commands` del step(). Vacía
   * siempre que `simulatedLatency` esté ausente (nunca se empuja nada), así que
   * no afecta a stateHash() ni a ningún camino existente cuando la feature está OFF.
   */
  private pendingLatencyCommands: { readyAtTick: number; vehicleId: string; command: any }[] = [];

  constructor(config: BattleConfig) {
    this.config = config;
    this.rng = new RngStreams(config.seed);
    this.physics = new PhysicsWorld();
    const teams = [...new Set(config.participants.map((p) => p.team))].sort();
    // El modo puede RECHAZAR la lista de participantes (ERR-ENG-07): deathmatch exige
    // que cada vehículo sea su propio equipo, y fallar aquí —en construcción— es lo
    // que evita una batalla de 5 minutos en la que nadie puede puntuar.
    this.mode = createMode(config.ruleset, teams, config.map, config.participants);

    // --- Mundo estático
    // Perímetro IMPLÍCITO (UX-07): la arena se cierra aquí, para TODO mapa, lo declare
    // el documento o no. Antes dependía de que cada mapa trajera sus cuatro muros de
    // borde; el del catálogo no los traía y en producción hubo vehículos a 26-45 m
    // fuera de un mapa de 120×80. Se da de alta ANTES que los muros del mapa: el orden
    // de alta es el orden estable de recorrido del solver (solverFingerprint).
    addArenaBoundary(this.physics, config.map.widthM, config.map.heightM);
    for (const w of config.map.walls) {
      this.physics.addWall(w.id, w.position, w.halfW, w.halfH, w.rotation ?? 0);
    }
    for (const d of config.map.destructibles) {
      this.physics.addDestructible(d.id, d.position, d.halfW, d.halfH);
      this.destructibleHp.set(d.id, d.hp);
    }

    // --- Vehículos. Orden estable: por id, siempre.
    const sorted = [...config.participants].sort((a, b) => a.id.localeCompare(b.id));
    for (const p of sorted) {
      const v = new Vehicle(p.id, p.team, p.botId, p.spec);
      this.vehicles.push(v);
      const spawn = this.spawnFor(v);
      this.physics.addVehicle(p.id, spawn.position, spawn.heading, p.spec.radiusM, p.spec.massKg);
      v.heading = spawn.heading;
      v.turretHeading = spawn.heading;
      this.pendingEvents.set(p.id, []);
    }
  }

  static async create(config: BattleConfig): Promise<Battle> {
    await initPhysics();
    return new Battle(config);
  }

  attachBot(vehicleId: string, agent: BotAgent): void {
    this.agents.set(vehicleId, agent);
  }

  /**
   * Colocación inicial (motor 0.3.0, batallas 4v4). Se llama en orden de id con `v`
   * ya en `this.vehicles` y los anteriores ya en la física. Ver «colocación de
   * spawns» en modes.ts: spawns del mapa primero (1v1 y 2v2 red/blue idénticos a
   * 0.2.0) y, agotados, posiciones auxiliares seguras alrededor del spawn base.
   */
  private spawnFor(v: Vehicle): { position: Vec2; heading: number } {
    const map = this.config.map;
    const teams = [...new Set(this.config.participants.map((p) => p.team))].sort();
    const pool = spawnPoolFor(v.team, teams, map);
    const occupied: SpawnDisk[] = [];
    for (const o of this.vehicles) {
      if (o.id === v.id) continue;
      const p = this.physics.pose(o.id);
      if (p) occupied.push({ position: p.position, radiusM: o.spec.radiusM });
    }
    const radiusMaxM = Math.max(...this.config.participants.map((p) => p.spec.radiusM));
    // Los spawns del mapa aún libres quedan reservados: un auxiliar de un bando no
    // le quita el punto base a quien le toca después.
    const reserved: SpawnDisk[] = map.spawns
      .filter((s) => !occupied.some((d) => Math.hypot(d.position.x - s.position.x, d.position.y - s.position.y) < 1e-3))
      .map((s) => ({ position: s.position, radiusM: radiusMaxM }));
    const chosen = chooseSpawn({ pool, startIndex: 0, radiusM: v.spec.radiusM, radiusMaxM, occupied, reserved, map });
    if (chosen) return chosen;
    // Sin hueco seguro (mapa diminuto o saturado): el reparto cíclico de 0.2.0.
    const idx = this.vehicles.filter((o) => o.team === v.team).indexOf(v);
    const s = pool[Math.max(0, idx) % pool.length];
    return { position: { ...s.position }, heading: s.heading };
  }

  private poses() {
    const m = new Map<string, any>();
    for (const v of this.vehicles) {
      const p = this.physics.pose(v.id);
      if (p) m.set(v.id, p);
    }
    return m;
  }

  private emit(ev: any, toVehicle?: string): void {
    const e = { tick: this.tick, ...ev };
    if (toVehicle) {
      this.pendingEvents.get(toVehicle)?.push(e);
    } else {
      this.publicEvents.push(e);
      // Los eventos públicos (marcador, bandera) los reciben todos: son públicos por definición.
      for (const v of this.vehicles) this.pendingEvents.get(v.id)?.push(e);
    }
  }

  isDecisionTick(): boolean {
    return this.tick % DECISION_EVERY_N_TICKS === 0;
  }

  // =========================================================================
  //  UN TICK · los 9 pasos del capítulo 9.2, en este orden y no otro
  // =========================================================================
  step(): void {
    if (this.finished) return;
    const poses = this.poses();
    for (const v of this.vehicles) {
      const p = poses.get(v.id);
      if (p) v.heading = p.heading;
    }

    // --- PASO 1 · Recoger comandos de los bots (solo en tick de decisión)
    const commands = new Map<string, any>();
    if (this.isDecisionTick()) {
      // DOBLE BÚFER de sonidos (fix ERR-ENG-01). Durante los 3 ticks del ciclo que ACABA de
      // terminar, física y combate acumularon disparos, impactos, minas y motores en
      // `this.sounds`. Ese acumulador se congela ahora en `observedSounds`: es lo que oyen
      // TODAS las observaciones de este tick (este bucle y observationFor leen el MISMO
      // búfer, así que ninguna ruta ve un conjunto distinto). El acumulador se vacía DESPUÉS
      // de construirlas —nunca antes, que era el bug del doble borrado— para recoger los
      // sonidos del ciclo que arranca ahora.
      this.observedSounds = this.sounds;

      // N2 · Liberar hacia `commands` los comandos ya vencidos de ciclos de decisión
      // anteriores, ANTES de recoger las decisiones nuevas de este ciclo. El array
      // se recorre en orden de inserción (estable: siempre se empujó en el mismo
      // orden que this.vehicles), así que el orden de liberación es determinista
      // aunque procedan de distintos ciclos de origen. Si `simulatedLatency` nunca
      // se activó, este array está y seguirá vacío: coste cero, sin efecto.
      if (this.pendingLatencyCommands.length > 0) {
        const stillPending: typeof this.pendingLatencyCommands = [];
        for (const pc of this.pendingLatencyCommands) {
          if (pc.readyAtTick <= this.tick) {
            commands.set(pc.vehicleId, pc.command);
          } else {
            stillPending.push(pc);
          }
        }
        this.pendingLatencyCommands = stillPending;
      }

      const objectives = this.mode.objectives();
      for (const v of this.vehicles) {
        if (v.disqualified) continue;
        const agent = this.agents.get(v.id);
        if (!agent) continue;

        const obs = buildObservation(
          v,
          this.tick,
          {
            vehicles: this.vehicles,
            poses,
            physics: this.physics,
            sounds: this.observedSounds,
            mines: this.mines.map((m) => ({ id: m.id, position: m.position, team: m.team, detectable: m.detectable })),
          },
          this.radioQueue,
          this.mode.score,
          objectives,
          this.rng.stream("sensors"),
        );

        // Los eventos pendientes de ESTE bot se le entregan y se vacían.
        const evs = this.pendingEvents.get(v.id) ?? [];
        for (const e of evs) agent.onEvent?.(e);
        this.pendingEvents.set(v.id, []);

        const cmd = agent.decide(obs);

        // --- PASO 2 · Acción segura para quien no respondió (D2)
        if (cmd == null) {
          v.consecutiveTimeouts++;
          this.emit({ kind: "decision_timeout" }, v.id);
          if (v.consecutiveTimeouts >= this.config.ruleset.maxConsecutiveTimeouts) {
            v.disqualified = true;
            v.alive = false;
            this.emit({ kind: "rejected_action", reason: "timeout_disqualified" }, v.id);
          }
          // La acción segura ES la última orden de movimiento, con el disparo a false.
          commands.set(v.id, { move: v.lastMove, fire: [] });
        } else {
          v.consecutiveTimeouts = 0;
          // El replay graba SIEMPRE en el tick de decisión, tenga o no latencia: es
          // la "receta" de lo que el bot entregó, no de cuándo surtió efecto. La
          // resimulación (verify()/checkpoint) vuelve a sortear el mismo retardo
          // desde el mismo RNG canónico y en el mismo punto de la secuencia, así
          // que reproduce el mismo tick de efecto sin necesidad de grabarlo aparte.
          if (this.config.recordReplay) {
            this.replayCommands.push({ tick: this.tick, vehicleId: v.id, command: cmd });
          }

          const latency = this.config.simulatedLatency;
          if (latency) {
            // Draw SOLO cuando la latencia está activada (config presente): con el
            // campo ausente esta rama entera no se ejecuta y no se toca this.rng,
            // que es la garantía de cero-regresión con latencia OFF.
            const span = Math.max(0, latency.maxCycles - latency.minCycles) + 1;
            const d = latency.minCycles + this.rng.stream("latency").int(span);
            if (d <= 0) {
              // Sin retardo efectivo: mismo comportamiento que sin latencia.
              commands.set(v.id, cmd);
            } else {
              this.pendingLatencyCommands.push({
                readyAtTick: this.tick + d * DECISION_EVERY_N_TICKS,
                vehicleId: v.id,
                command: cmd,
              });
              // No se mete en `commands` este ciclo: el vehículo sigue con su
              // última acción segura (v.lastMove), exactamente como el timeout.
            }
          } else {
            commands.set(v.id, cmd);
          }
        }
      }
      // Intercambio del acumulador: ya servidas TODAS las observaciones con `observedSounds`,
      // el ciclo nuevo arranca con un búfer vacío. `observedSounds` sigue apuntando al array
      // anterior (no se muta), de modo que observationFor() y el snapshot ven lo mismo hasta
      // el próximo tick de decisión.
      this.sounds = [];
    }

    // --- PASO 3 · Validar y aplicar órdenes (energía, munición, cooldown, arco)
    for (const v of this.vehicles) {
      v.tickEnergy(TICK_DT);
      if (!v.alive || v.disqualified) continue;
      const cmd = commands.get(v.id);
      if (!cmd) continue;

      // Movimiento: la intención se guarda; el motor decide si el hardware puede.
      // TODO valor que venga de un bot se sanea aquí: NaN, Infinity, strings, null.
      // Es la frontera con código no confiable (ver finite() en physics.ts).
      if (cmd.move) {
        v.lastMove = {
          throttle: finiteClamped(cmd.move.throttle, -1, 1, v.lastMove.throttle),
          steer: finiteClamped(cmd.move.steer, -1, 1, v.lastMove.steer),
        };
      }

      // Torreta: objetivo, no teletransporte.
      if (cmd.turret) {
        const pose = poses.get(v.id)!;
        if (cmd.turret.targetHeading != null) {
          const h = finite(cmd.turret.targetHeading, NaN);
          if (Number.isFinite(h)) v.lastTurretTarget = h;
        } else if (cmd.turret.targetPoint) {
          const tx = finite(cmd.turret.targetPoint.x, NaN);
          const ty = finite(cmd.turret.targetPoint.y, NaN);
          // Un punto imposible no mueve la torreta: se ignora la orden, no se descuadra.
          if (Number.isFinite(tx) && Number.isFinite(ty)) {
            v.lastTurretTarget = Math.atan2(ty - pose.position.y, tx - pose.position.x);
          }
        }
      }

      // Encender/apagar módulos.
      for (const m of cmd.modules ?? []) {
        const r = v.setModuleEnabled(m.slot, m.enabled, this.tick);
        if (r !== "ok") this.emit({ kind: "rejected_action", slot: m.slot, reason: r }, v.id);
      }

      // Radio. Rate-limit por vehículo con contador que se reinicia al cambiar de
      // segundo (ERR-ENG-06): memoria O(1) por vehículo, sin claves `id:segundo`
      // que se acumulen durante toda la batalla.
      for (const r of cmd.radio ?? []) {
        const second = Math.floor(this.tick / TICK_HZ);
        if (v.radioSecond !== second) {
          v.radioSecond = second;
          v.radioSentThisSecond = 0;
        }
        const rej = validateRadio(v, r.slot, r.data ?? "", v.radioSentThisSecond);
        if (rej) {
          this.emit({ kind: "radio_dropped", slot: r.slot, reason: rej }, v.id);
          continue;
        }
        if (this.radioQueue.length >= MAX_RADIO_QUEUE) {
          this.emit({ kind: "radio_dropped", slot: r.slot, reason: "queue_full" }, v.id);
          continue;
        }
        v.radioSentThisSecond++;
        this.radioQueue.push({
          from: v.id,
          // Equipo del estado de batalla, NUNCA del comando: decide los receptores.
          team: v.team,
          data: r.data,
          sentTick: this.tick,
          deliverAtTick: this.tick + RADIO_DELIVERY_DELAY_DECISIONS * DECISION_EVERY_N_TICKS,
          to: r.to,
          // P-2 · alcance real (radio.rangeM), del estado de batalla al emitir.
          origin: { ...poses.get(v.id)!.position },
          rangeM: radioRangeOf(v, r.slot),
        });
      }
    }

    // --- PASO 4 · Física (timestep fijo)
    for (const v of this.vehicles) {
      if (!v.alive || v.disqualified) {
        this.physics.driveVehicle(v.id, 0, 0, { maxSpeedMs: 0, accelerationMs2: 100, turnRateRads: 0 });
        continue;
      }
      const caps = v.movementCaps();
      if (caps) {
        this.physics.driveVehicle(v.id, v.lastMove.throttle, v.lastMove.steer, caps);
        if (Math.abs(v.lastMove.throttle) > 0.1) {
          const p = poses.get(v.id)!;
          this.sounds.push({ position: p.position, kind: "engine", intensity: Math.abs(v.lastMove.throttle) });
        }
      } else {
        // Sin módulo de movimiento operativo: INMÓVIL. Pero la torreta sigue viva.
        this.physics.driveVehicle(v.id, 0, 0, { maxSpeedMs: 0, accelerationMs2: 100, turnRateRads: 0 });
      }

      // Giro de torreta hacia el objetivo: tasa y arco de la MONTURA (D-B2), en vehicle.ts.
      v.stepTurret(TICK_DT);
    }
    this.physics.step();
    // Perímetro DURO (UX-07): el muro implícito para el movimiento; esta corrección
    // absorbe la penetración residual del contacto blando cuando un vehículo empuja a
    // otro contra el borde. Orden estable: el de this.vehicles.
    const { widthM, heightM } = this.config.map;
    for (const v of this.vehicles) {
      const r = v.spec.radiusM;
      this.physics.clampInsideBox(v.id, r, widthM - r, r, heightM - r);
    }

    const posesAfter = this.poses();
    for (const v of this.vehicles) {
      const p = posesAfter.get(v.id);
      if (p) v.heading = p.heading;
    }

    // --- PASO 5 · Combate: disparos, proyectiles, minas, explosiones, daño
    this.tickDamage = [];
    this.resolveFiring(commands, posesAfter);
    this.resolveProjectiles(posesAfter);
    this.resolveMines(posesAfter);
    this.resolveZoneDamage(posesAfter);

    // --- PASO 6 · Reglas del modo (banderas, zonas, puntuación)
    const ctx = {
      tick: this.tick,
      ruleset: this.config.ruleset,
      vehicles: this.vehicles,
      poses: posesAfter,
      map: this.config.map,
      emit: (ev: any) => this.emit(ev),
    };
    this.mode.tick(ctx);

    // --- PASO 7 · Respawn
    if (this.config.ruleset.respawn.enabled) {
      // Poses vistas por spawnFor: las de este tick, corregidas con quien ya ha
      // reaparecido en este mismo bucle (dos reapariciones simultáneas no pueden
      // elegir el mismo punto). Copia perezosa: sin reapariciones, coste cero.
      let respawnPoses: Map<string, any> | null = null;
      for (const v of this.vehicles) {
        if (v.alive || v.disqualified) continue;
        // R-RULES (ADR-021) · sin reapariciones restantes, se queda fuera. Con respawn
        // ilimitado (0.3.0) `respawnsLeft` es Infinity y esta guarda no actúa.
        if (respawnsLeft(v, this.config.ruleset) === 0) continue;
        if (v.respawnAtTick === 0) {
          v.respawnAtTick = this.tick + this.config.ruleset.respawn.delayTicks;
        } else if (this.tick >= v.respawnAtTick) {
          respawnPoses ??= new Map(posesAfter);
          const sp = this.mode.spawnFor(v, { ...ctx, poses: respawnPoses });
          const prev = respawnPoses.get(v.id);
          respawnPoses.set(v.id, {
            ...(prev ?? { heading: 0, velocity: { x: 0, y: 0 }, angularVelocity: 0 }),
            position: { ...sp },
          });
          v.respawn(sp);
          v.respawnAtTick = 0;
          const body = this.physics.get(v.id);
          body?.rb.setTranslation(sp, true);
          body?.rb.setLinvel({ x: 0, y: 0 }, true);
          this.emit({ kind: "respawned", position: sp }, v.id);
        }
      }
    }

    // --- PASO 8 · Snapshots y hash de estado
    const snapEvery = this.config.snapshotEveryNTicks ?? 3;
    if (this.tick % snapEvery === 0) {
      this.snapshots.push(this.internalFrame(posesAfter));
    }
    // Cadencia del hash: config > ruleset > 30. Va en el ruleset (ERR-ENG-04) para que
    // viaje en la cabecera del replay y una auditoría con hash por tick sea reproducible.
    const hashEvery = this.config.hashEveryNTicks ?? this.config.ruleset.hashEveryNTicks ?? 30;
    const ckptEvery = this.config.checkpointEveryNTicks ?? 300;
    const wantHash = this.tick % hashEvery === 0;
    const wantCkpt = ckptEvery > 0 && this.tick % ckptEvery === 0;
    if (wantHash || wantCkpt) {
      const bd = this.stateHashBreakdown();
      if (wantHash) this.stateHashes.push({ tick: this.tick, hash: bd.hash });
      if (wantCkpt) this.checkpoints.push({ tick: this.tick, hash: bd.hash, components: bd.components });
    }

    // Purga de radio ya entregada. Solo si hay algo: filter() sobre una cola vacía
    // reasignaba un array nuevo CADA tick (ERR-ENG-06), basura gratuita para el GC.
    if (this.radioQueue.length > 0) {
      this.radioQueue = this.radioQueue.filter((m) => m.deliverAtTick >= this.tick);
    }

    // --- PASO 9 · Condición de fin
    const w = this.mode.winner({ ...ctx, kills: this.teamKills });
    if (w !== null) {
      this.finish(w);
      return;
    }
    // Motor 0.4.0 (ADR-022) · la prórroga empieza en este tick: evento PÚBLICO (replay
    // y espectador; no va a los bots, el esquema EVENT de arena/1 no lo declara).
    if (this.config.ruleset.overtime && this.mode.overtimeSince === this.tick) {
      this.publicEvents.push({
        tick: this.tick,
        kind: "overtime_started",
        score: { ...this.mode.score },
        technicalLimitTicks: OVERTIME_TECHNICAL_LIMIT_TICKS,
      });
    }
    this.tick++;
  }

  // ------------------------------------------------------------------ combate
  private resolveFiring(commands: Map<string, any>, poses: Map<string, any>): void {
    for (const v of this.vehicles) {
      if (!v.alive || v.disqualified) continue;
      const cmd = commands.get(v.id);
      if (!cmd) continue;
      const wantsFire = Array.isArray(cmd.fire) && cmd.fire.length > 0;
      if (!wantsFire && !cmd.deployMine) continue; // minar no exige disparar en el mismo comando
      const pose = poses.get(v.id)!;

      // Sanea la lista de ranuras: solo strings, y sin repetidos (un bot que envía la
      // misma arma 100 veces no dispara 100 veces; la cadencia manda igualmente, pero
      // deduplicar evita gastar 100 tiradas del RNG y desplazar la secuencia).
      const slots: string[] = !wantsFire
        ? []
        : [...new Set<string>(cmd.fire.filter((s: unknown): s is string => typeof s === "string"))];

      for (const slot of slots) {
        const rejection = canFire(v, slot, this.tick, this.rng.stream("combat"));
        if (rejection) {
          this.emit({ kind: "rejected_action", slot, reason: rejection }, v.id);
          continue;
        }
        const muzzle = {
          x: pose.position.x + Math.cos(v.turretHeading) * (v.spec.radiusM + 0.3),
          y: pose.position.y + Math.sin(v.turretHeading) * (v.spec.radiusM + 0.3),
        };
        const p = fire(v, slot, this.tick, muzzle, this.rng.stream("combat"), this.entitySeq++);
        if (p) {
          this.projectiles.push(p);
          this.sounds.push({ position: muzzle, kind: "gunshot", intensity: 1 });
        }
      }

      // Minas
      if (cmd.deployMine) {
        const mineCount = this.mines.filter((m) => m.ownerId === v.id).length;
        const rej = canDeployMine(
          v,
          cmd.deployMine.slot,
          this.tick,
          pose.position,
          this.physics,
          mineCount,
          MAX_MINES_PER_VEHICLE,
        );
        if (rej) {
          this.emit({ kind: "rejected_action", slot: cmd.deployMine.slot, reason: rej }, v.id);
        } else {
          const m = deployMine(
            v,
            cmd.deployMine.slot,
            this.tick,
            pose.position,
            finiteClamped(cmd.deployMine.armDelayTicks, 0, 300, 0),
            this.entitySeq++,
          );
          this.mines.push(m);
          this.emit({ kind: "mine_deployed", position: m.position }, v.id);
        }
      }
    }
  }

  private resolveProjectiles(poses: Map<string, any>): void {
    const survivors: Projectile[] = [];

    for (const p of this.projectiles) {
      const from = { ...p.position };
      const to = { x: p.position.x + p.velocity.x * TICK_DT, y: p.position.y + p.velocity.y * TICK_DT };
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);

      // Raycast del segmento recorrido: sin túnel aunque el proyectil sea rápido.
      const hit = this.physics.castRay(from, angle, dist, p.ownerId);

      if (hit && hit.entityId) {
        const impact = hit.point;
        // D-B6 · el vehículo impactado directamente recibe el impacto directo y queda
        // EXCLUIDO de la onda de su propio proyectil: un paquete por vehículo y detonación.
        let directTarget: string | null = null;
        const target = this.vehicles.find((v) => v.id === hit.entityId);

        if (target) {
          // Fuego amigo: si está desactivado, el proyectil ATRAVIESA al aliado.
          const friendly = target.team === p.team;
          if (friendly && !this.config.ruleset.friendlyFire) {
            survivors.push({ ...p, position: to, ttlTicks: p.ttlTicks - 1 });
            continue;
          }
          directTarget = target.id;
          this.damageVehicle(
            target,
            p.damage,
            impact,
            poses,
            p.ownerId,
            p.team,
            DEFAULT_DIRECT_DAMAGE_TYPE,
            "projectile",
          );
        } else if (this.destructibleHp.has(hit.entityId)) {
          const hp = (this.destructibleHp.get(hit.entityId) ?? 0) - p.damage;
          this.destructibleHp.set(hit.entityId, hp);
          if (hp <= 0) {
            this.physics.remove(hit.entityId);
            this.destructibleHp.delete(hit.entityId);
            this.emit({ kind: "vehicle_destroyed", targetId: hit.entityId, position: impact });
          }
        }

        if (p.explosionRadiusM > 0) {
          this.explode(impact, p.damage, p.explosionRadiusM, poses, p.ownerId, p.team, "explosion", directTarget);
        }
        this.sounds.push({ position: impact, kind: "explosion", intensity: 1 });
        continue; // el proyectil muere al impactar
      }

      // Fuera del mapa no hay nada que alcanzar: el proyectil DESAPARECE. Con el
      // perímetro implícito el raycast de arriba ya lo hace impactar en el borde; esto
      // es la red por si una geometría degenerada lo dejara pasar.
      if (!insideArena(to, this.config.map)) continue;

      const ttl = p.ttlTicks - 1;
      if (ttl > 0) survivors.push({ ...p, position: to, ttlTicks: ttl });
    }
    this.projectiles = survivors;
  }

  private resolveMines(poses: Map<string, any>): void {
    const survivors: Mine[] = [];
    for (const m of this.mines) {
      if (this.tick >= m.expiresAtTick) continue;
      if (this.tick < m.armedAtTick) {
        survivors.push(m);
        continue;
      }

      let triggered = false;
      for (const v of this.vehicles) {
        if (!v.alive || v.disqualified) continue;
        const p = poses.get(v.id);
        if (!p) continue;
        if (Math.hypot(p.position.x - m.position.x, p.position.y - m.position.y) > m.triggerRadiusM) continue;
        // Una mina propia no explota bajo un aliado si el fuego amigo está desactivado.
        if (v.team === m.team && !this.config.ruleset.friendlyFire) continue;
        triggered = true;
        break;
      }

      if (triggered) {
        this.emit({ kind: "mine_triggered", position: m.position });
        this.explode(m.position, m.damage, m.explosionRadiusM, poses, m.ownerId, m.team, "deployable", null);
        this.sounds.push({ position: m.position, kind: "explosion", intensity: 1 });
      } else {
        survivors.push(m);
      }
    }
    this.mines = survivors;
  }

  private explode(
    center: Vec2,
    damage: number,
    radius: number,
    poses: Map<string, any>,
    ownerId: string,
    team: string,
    sourceKind: DamageSourceKind,
    excludeId: string | null,
  ): void {
    for (const v of this.vehicles) {
      if (!v.alive || v.disqualified) continue;
      if (v.id === excludeId) continue;
      if (v.team === team && !this.config.ruleset.friendlyFire) continue;
      const p = poses.get(v.id);
      if (!p) continue;
      const d = Math.hypot(p.position.x - center.x, p.position.y - center.y);
      const f = explosionFalloff(d, radius);
      if (f <= 0) continue;
      // Una explosión no atraviesa muros.
      if (!this.physics.hasLineOfSight(center, p.position)) continue;
      this.damageVehicle(v, damage * f, center, poses, ownerId, team, DEFAULT_EXPLOSION_DAMAGE_TYPE, sourceKind);
    }
  }

  private resolveZoneDamage(poses: Map<string, any>): void {
    for (const z of this.config.map.zones) {
      if (z.kind !== "damage") continue;
      const dps = z.damagePerSecond ?? 0;
      if (dps <= 0) continue;
      for (const v of this.vehicles) {
        if (!v.alive || v.disqualified) continue;
        const p = poses.get(v.id);
        if (!p) continue;
        if (Math.hypot(p.position.x - z.position.x, p.position.y - z.position.y) > z.radiusM) continue;
        // El daño ambiental va directo al chasis (perfil `environmental`: sin blindaje,
        // sin sector, sin módulo, sin RNG), pero por la MISMA puerta que el resto.
        this.damageVehicle(v, dps * TICK_DT, z.position, poses, null, null, ZONE_DAMAGE_TYPE, "zone");
      }
    }
  }

  /**
   * ÚNICA puerta de daño de vehículo del bucle: construye el DamagePacket, lo resuelve
   * (damage.ts) y emite los eventos. Muerte y onKill en UN solo sitio, sea cual sea el
   * origen. La firma posicional (target, amount, from, poses, ownerId, ownerTeam, …) se
   * conserva: replay.ts (resimulateWithEvents) lee `ownerId` en la posición 4.
   */
  private damageVehicle(
    target: Vehicle,
    amount: number,
    from: Vec2,
    poses: Map<string, any>,
    ownerId: string | null,
    ownerTeam: string | null,
    type: EnginePacket["type"] = DEFAULT_DIRECT_DAMAGE_TYPE,
    sourceKind: DamageSourceKind = "projectile",
  ): void {
    const packet: EnginePacket = {
      amount,
      type,
      penetration: 0,
      from,
      owner: ownerId,
      ownerTeam,
      sourceKind,
      seq: this.tickDamage.length,
    };
    const tp = poses.get(target.id)!;
    // Integración OLA2 (MD+MB): el sector del impacto se sortea del flujo RNG con nombre "combat"
    // (el mismo que usaba applyDamage en MD).
    const res = resolveDamage(packet, target, tp, this.rng.stream("combat"), this.tick);
    this.tickDamage.push(res);

    // Daño ambiental (sin atacante): sin hit_taken ni hit_dealt, como siempre.
    if (ownerId !== null) {
      // El objetivo SIEMPRE sabe que le han dado y en qué sector: lo nota.
      // Pero el sourceId solo se revela si podía verlo (D8): un disparo desde la niebla
      // te hiere sin decirte quién ha sido.
      const canSee = this.physics.hasLineOfSight(tp.position, packet.from, target.id);
      this.emit(
        {
          kind: "hit_taken",
          sector: res.sector,
          damage: round6(res.effective),
          ...(canSee ? { sourceId: ownerId } : {}),
        },
        target.id,
      );
    }

    if (res.moduleSlot && res.moduleDestroyed) {
      this.emit(
        { kind: "module_state_changed", slot: res.moduleSlot, state: target.stateOf(res.moduleSlot) },
        target.id,
      );
    }

    // El atacante sabe que ha acertado (ve el impacto).
    // DEPENDENCIA MD (arena/2): `damage` exacto → `impact` (impactClassOf en damage-contract).
    const attacker = ownerId !== null ? this.vehicles.find((v) => v.id === ownerId) : undefined;
    if (attacker) {
      this.emit({ kind: "hit_dealt", targetId: target.id, damage: round6(res.effective) }, attacker.id);
    }

    if (res.killed) {
      if (ownerTeam !== null && ownerTeam !== target.team) {
        this.teamKills[ownerTeam] = (this.teamKills[ownerTeam] ?? 0) + 1;
      }
      this.emit({ kind: "vehicle_destroyed", targetId: target.id });
      this.mode.onKill?.(target, ownerTeam, {
        tick: this.tick,
        ruleset: this.config.ruleset,
        vehicles: this.vehicles,
        poses,
        map: this.config.map,
        emit: (e: any) => this.emit(e),
      });
      this.noteElimination(target);
    }
  }

  /** OLA 2 · MB · Registros exactos de daño del último tick (INTERNOS; para la etapa interna). */
  damageRecordsOfLastTick(): readonly EngineDamageRecord[] {
    return this.tickDamage;
  }

  /**
   * R-RULES (ADR-021) · Con respawn LIMITADO, la muerte que agota las reapariciones se
   * marca con un evento PÚBLICO `vehicle_eliminated` (va al replay y al espectador).
   * NO se reparte a los bots: el esquema EVENT del protocolo arena/1 no lo declara. Sin
   * `maxRespawns` (todos los rulesets de 0.3.0) no se emite nada: replays idénticos.
   */
  private noteElimination(v: Vehicle): void {
    if (!respawnLimited(this.config.ruleset)) return;
    if (!eliminatedByDeath(v, this.config.ruleset)) return;
    this.publicEvents.push({ tick: this.tick, kind: "vehicle_eliminated", targetId: v.id, team: v.team });
  }

  // ------------------------------------------------------ frame interno y hash
  /**
   * OLA 2 · MA · INTERNAL FRAME del tick (contrato §2, A2). Ya no hay snapshot «público»
   * fabricado por el motor: cada audiencia lo deriva `projectFrame()` (packages/projection).
   * `this.snapshots` guarda estos frames internos; nunca salen sin proyectar.
   */
  private internalFrame(poses: Map<string, any>): any {
    const limited = respawnLimited(this.config.ruleset);
    return captureInternalFrame({
      battleId: this.config.battleId,
      tick: this.tick,
      // Motor 0.4.0 · sólo con prórroga declarada.
      ...(this.config.ruleset.overtime
        ? { overtime: this.mode.overtimeSince !== null && this.mode.overtimeSince !== undefined }
        : {}),
      vehicles: this.vehicles,
      poses,
      projectiles: this.projectiles,
      mines: this.mines,
      score: this.mode.score,
      objectives: this.mode.objectives(),
      // R-RULES · sólo con respawn limitado.
      ...(limited ? { respawnsLeft: (v: Vehicle) => respawnsLeft(v, this.config.ruleset) } : {}),
    });
  }

  /**
   * Hash canónico del estado de simulación. Es LA prueba de determinismo.
   * OLA2-MD · v2 por componentes (state-hash.ts): cubre TODO el estado vivo que decide el
   * futuro, incluidos los flujos de RNG con nombre. Nada de proyección ni visibilidad.
   */
  stateHash(): string {
    return this.stateHashBreakdown().hash;
  }

  /** OLA2-MD · desglose por componentes (contrato §13). Los campos los nombra stateHashInput(). */
  stateHashBreakdown(): StateHashBreakdown {
    return computeStateHash(this.stateHashInput(), { skipKeys: STATE_HASH_SKIP });
  }

  /**
   * Estado vivo por componente. Regla: todo campo mutable de la simulación entra aquí (los
   * objetos se serializan ENTEROS con canonicalize, así que un campo nuevo de Vehicle,
   * proyectil, mina o modo entra solo). Sólo se omite `spec` (configuración inmutable que
   * ya viaja en la cabecera). `effects`, `effectQueue`, `interference` y `botRefs` están
   * vacíos hasta que MC/MA los rellenen en su fase.
   */
  private stateHashInput() {
    const poses = this.poses();
    // Huella del solver (ERR-ENG-04): cuerpos despiertos + pares de contacto.
    const solver = this.physics.solverFingerprint();
    return {
      tick: this.tick,
      rng: this.rng.getState(),
      allocator: { nextSeq: this.entitySeq, ownCounters: {}, contactCounters: {} },
      solver: [solver.awakeBodies, solver.contactPairs],
      vehicles: this.vehicles.map((v) => ({ pose: poses.get(v.id) ?? null, state: v })),
      projectiles: this.projectiles,
      deployables: this.mines,
      effects: [],
      effectQueue: [],
      interference: [],
      destructibles: this.destructibleHp,
      // Colas de entrega hacia los bots: radio en vuelo, búferes de sonido y eventos
      // privados aún no entregados (deciden la próxima observación).
      radioQueue: {
        radio: this.radioQueue,
        sounds: this.sounds,
        observedSounds: this.observedSounds,
        pendingEvents: this.pendingEvents,
      },
      pendingCommands: this.pendingLatencyCommands,
      botRefs: {},
      mode: { state: this.mode, objectives: this.mode.objectives(), teamKills: this.teamKills },
    };
  }

  private finish(winner: string | "draw"): void {
    this.finished = true;
    // Snapshot FINAL garantizado: si la batalla acaba en un tick que no toca snapshot
    // (cadencia de 3), el último que veía un espectador o el reproductor era anterior
    // al golpe decisivo y su marcador no coincidía con el resultado (destapado al
    // cambiar las trayectorias con el perímetro de UX-07). Los snapshots no entran en
    // el hash de estado: no altera el determinismo.
    const last = this.snapshots[this.snapshots.length - 1];
    if (!last || last.tick !== this.tick) this.snapshots.push(this.internalFrame(this.poses()));
    // Salvaguarda técnica (ADR-022): sin resultado deportivo y con el motivo explícito.
    const technical = winner === TECHNICAL_LIMIT;
    if (technical) {
      this.publicEvents.push({ tick: this.tick, kind: "technical_limit", score: { ...this.mode.score } });
    }
    // OLA2-MD · checkpoint FINAL garantizado (desglose por componentes del estado final).
    const finalHash = this.stateHashBreakdown();
    const lastCkpt = this.checkpoints[this.checkpoints.length - 1];
    if (!lastCkpt || lastCkpt.tick !== this.tick) {
      this.checkpoints.push({ tick: this.tick, hash: finalHash.hash, components: finalHash.components });
    }
    this.result = {
      battleId: this.config.battleId,
      winner: technical ? null : winner,
      ...(technical ? { endReason: "technical_limit" as const } : {}),
      ticks: this.tick,
      score: { ...this.mode.score },
      finalStateHash: finalHash.hash,
      disqualified: this.vehicles.filter((v) => v.disqualified).map((v) => v.id),
      versions: {
        engine: deps.engine.version,
        physics: `${deps.physics.package}@${deps.physics.version}`,
        rules: this.config.ruleset.rulesetId,
        protocol: deps.protocol,
      },
    };
  }

  /** Corre hasta el final o hasta maxTicks. Devuelve el resultado. */
  run(maxTicks = 100000): BattleResult {
    while (!this.finished && this.tick < maxTicks) this.step();
    if (!this.finished) this.finish("draw");
    return this.result!;
  }

  getResult(): BattleResult | null {
    return this.result;
  }

  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Frame INTERNO del estado actual, on-demand: lo mismo que se guarda periódicamente en
   * `this.snapshots`. Sólo para proyectarlo (inspector, tests); nunca se publica tal cual.
   */
  getInternalFrame(): any {
    return this.internalFrame(this.poses());
  }

  /** Observación de un bot concreto: la usan el servidor de protocolo (E5) y los tests. */
  observationFor(vehicleId: string): any {
    // OLA2-MD · GUARDA (review MD P2): los raycasts de Rapier fuera del bucle (y el step
    // dt=0 de syncQueries tras un alta/baja de cuerpo) alteran contactos/sueño y por tanto
    // la física posterior. En una batalla GRABADA (oficial) eso rompería verify(), así que
    // no se admite. Residual: batallas sin recordReplay (tests, spectator) no son verificables.
    if (this.config.recordReplay) {
      throw new Error(
        "observationFor() no se puede llamar fuera del bucle en una batalla grabada (recordReplay): altera la física y rompe verify()",
      );
    }
    const v = this.vehicles.find((x) => x.id === vehicleId);
    if (!v) throw new Error(`Vehículo desconocido: ${vehicleId}`);
    return buildObservation(
      v,
      this.tick,
      {
        // Mismo búfer de sonidos que sirve el bucle de decisión (ERR-ENG-01): las dos rutas
        // de observación leen EXACTAMENTE el mismo conjunto para el mismo tick.
        vehicles: this.vehicles,
        poses: this.poses(),
        physics: this.physics,
        sounds: this.observedSounds,
        mines: this.mines.map((m) => ({ id: m.id, position: m.position, team: m.team, detectable: m.detectable })),
      },
      this.radioQueue,
      this.mode.score,
      this.mode.objectives(),
      // OLA2-MD · COPIA del flujo de sensores: una observación pedida fuera del bucle no
      // avanza el RNG de la simulación (cierra R1). Ver residual en el informe MD.
      this.rng.stream("sensors").clone(),
    );
  }

  getVehicle(id: string): Vehicle | undefined {
    return this.vehicles.find((v) => v.id === id);
  }

  getVehicles(): Vehicle[] {
    return this.vehicles;
  }

  getPhysics(): PhysicsWorld {
    return this.physics;
  }

  getMines(): Mine[] {
    return this.mines;
  }

  free(): void {
    this.physics.free();
  }
}

/** OLA2-MD · configuración inmutable (ya en la cabecera del replay): fuera del hash. */
const STATE_HASH_SKIP: ReadonlySet<string> = new Set(["spec"]);
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
