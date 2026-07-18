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
import { createHash } from "node:crypto";
import {
  DECISION_EVERY_N_TICKS,
  RADIO_DELIVERY_DELAY_DECISIONS,
  TICK_DT,
  TICK_HZ,
  type Ruleset,
} from "../../../../packages/game-rules/index.js";
import { Rng } from "../rng.js";
import deps from "../engine-deps.json" with { type: "json" };
import {
  applyDamage,
  canDeployMine,
  canFire,
  deployMine,
  explosionFalloff,
  fire,
  type Mine,
  type Projectile,
} from "./combat.js";
import { createMode, type ArenaMap, type GameMode } from "./modes.js";
import { PhysicsWorld, clamp, finite, finiteClamped, initPhysics, type Vec2 } from "./physics.js";
import { buildObservation, radioReaches, validateRadio, type RadioMessage } from "./sensors.js";
import { Vehicle, type VehicleSpec } from "./vehicle.js";

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
  recordReplay?: boolean;
}

export interface BattleResult {
  battleId: string;
  winner: string | "draw";
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

export class Battle {
  readonly config: BattleConfig;
  private rng: Rng;
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
  tick = 0;
  private finished = false;
  private result: BattleResult | null = null;

  /** Eventos por bot (niebla de guerra: cada uno solo ve lo suyo) + eventos públicos. */
  private pendingEvents = new Map<string, any[]>();
  publicEvents: any[] = [];
  snapshots: any[] = [];
  stateHashes: { tick: number; hash: string }[] = [];
  replayCommands: { tick: number; vehicleId: string; command: any }[] = [];

  constructor(config: BattleConfig) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.physics = new PhysicsWorld();
    const teams = [...new Set(config.participants.map((p) => p.team))].sort();
    // El modo puede RECHAZAR la lista de participantes (ERR-ENG-07): deathmatch exige
    // que cada vehículo sea su propio equipo, y fallar aquí —en construcción— es lo
    // que evita una batalla de 5 minutos en la que nadie puede puntuar.
    this.mode = createMode(config.ruleset, teams, config.map, config.participants);

    // --- Mundo estático
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

  private spawnFor(v: Vehicle): { position: Vec2; heading: number } {
    const own = this.config.map.spawns.filter((s) => s.team === v.team);
    const pool = own.length > 0 ? own : this.config.map.spawns;
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
          this.rng,
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
          commands.set(v.id, cmd);
          if (this.config.recordReplay) {
            this.replayCommands.push({ tick: this.tick, vehicleId: v.id, command: cmd });
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
          team: v.team,
          data: r.data,
          sentTick: this.tick,
          deliverAtTick: this.tick + RADIO_DELIVERY_DELAY_DECISIONS * DECISION_EVERY_N_TICKS,
          to: r.to,
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

      // Giro de torreta hacia el objetivo, limitado por la velocidad del módulo.
      const rate = v.turretRate();
      if (v.lastTurretTarget != null && rate > 0) {
        let diff = v.lastTurretTarget - v.turretHeading;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const maxStep = rate * TICK_DT;
        v.turretHeading += clamp(diff, -maxStep, maxStep);
      }
    }
    this.physics.step();

    const posesAfter = this.poses();
    for (const v of this.vehicles) {
      const p = posesAfter.get(v.id);
      if (p) v.heading = p.heading;
    }

    // --- PASO 5 · Combate: disparos, proyectiles, minas, explosiones, daño
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
      for (const v of this.vehicles) {
        if (v.alive || v.disqualified) continue;
        if (v.respawnAtTick === 0) {
          v.respawnAtTick = this.tick + this.config.ruleset.respawn.delayTicks;
        } else if (this.tick >= v.respawnAtTick) {
          const sp = this.mode.spawnFor(v, ctx);
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
      this.snapshots.push(this.publicSnapshot(posesAfter));
    }
    // Cadencia del hash: config > ruleset > 30. Va en el ruleset (ERR-ENG-04) para que
    // viaje en la cabecera del replay y una auditoría con hash por tick sea reproducible.
    const hashEvery = this.config.hashEveryNTicks ?? this.config.ruleset.hashEveryNTicks ?? 30;
    if (this.tick % hashEvery === 0) {
      this.stateHashes.push({ tick: this.tick, hash: this.stateHash() });
    }

    // Purga de radio ya entregada. Solo si hay algo: filter() sobre una cola vacía
    // reasignaba un array nuevo CADA tick (ERR-ENG-06), basura gratuita para el GC.
    if (this.radioQueue.length > 0) {
      this.radioQueue = this.radioQueue.filter((m) => m.deliverAtTick >= this.tick);
    }

    // --- PASO 9 · Condición de fin
    const w = this.mode.winner(ctx);
    if (w !== null) {
      this.finish(w);
      return;
    }
    this.tick++;
  }

  // ------------------------------------------------------------------ combate
  private resolveFiring(commands: Map<string, any>, poses: Map<string, any>): void {
    for (const v of this.vehicles) {
      if (!v.alive || v.disqualified) continue;
      const cmd = commands.get(v.id);
      if (!cmd?.fire?.length || !Array.isArray(cmd.fire)) continue;
      const pose = poses.get(v.id)!;

      // Sanea la lista de ranuras: solo strings, y sin repetidos (un bot que envía la
      // misma arma 100 veces no dispara 100 veces; la cadencia manda igualmente, pero
      // deduplicar evita gastar 100 tiradas del RNG y desplazar la secuencia).
      const slots: string[] = [...new Set<string>(cmd.fire.filter((s: unknown): s is string => typeof s === "string"))];

      for (const slot of slots) {
        const rejection = canFire(v, slot, this.tick, this.rng);
        if (rejection) {
          this.emit({ kind: "rejected_action", slot, reason: rejection }, v.id);
          continue;
        }
        const muzzle = {
          x: pose.position.x + Math.cos(v.turretHeading) * (v.spec.radiusM + 0.3),
          y: pose.position.y + Math.sin(v.turretHeading) * (v.spec.radiusM + 0.3),
        };
        const p = fire(v, slot, this.tick, muzzle, this.rng, this.entitySeq++);
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
        const target = this.vehicles.find((v) => v.id === hit.entityId);

        if (target) {
          // Fuego amigo: si está desactivado, el proyectil ATRAVIESA al aliado.
          const friendly = target.team === p.team;
          if (friendly && !this.config.ruleset.friendlyFire) {
            survivors.push({ ...p, position: to, ttlTicks: p.ttlTicks - 1 });
            continue;
          }
          this.damageVehicle(target, p.damage, impact, poses, p.ownerId, p.team);
        } else if (this.destructibleHp.has(hit.entityId)) {
          const hp = (this.destructibleHp.get(hit.entityId) ?? 0) - p.damage;
          this.destructibleHp.set(hit.entityId, hp);
          if (hp <= 0) {
            this.physics.remove(hit.entityId);
            this.destructibleHp.delete(hit.entityId);
            this.emit({ kind: "vehicle_destroyed", targetId: hit.entityId, position: impact });
          }
        }

        if (p.explosionRadiusM > 0) this.explode(impact, p.damage, p.explosionRadiusM, poses, p.ownerId, p.team);
        this.sounds.push({ position: impact, kind: "explosion", intensity: 1 });
        continue; // el proyectil muere al impactar
      }

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
        this.explode(m.position, m.damage, m.explosionRadiusM, poses, m.ownerId, m.team);
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
  ): void {
    for (const v of this.vehicles) {
      if (!v.alive || v.disqualified) continue;
      if (v.team === team && !this.config.ruleset.friendlyFire) continue;
      const p = poses.get(v.id);
      if (!p) continue;
      const d = Math.hypot(p.position.x - center.x, p.position.y - center.y);
      const f = explosionFalloff(d, radius);
      if (f <= 0) continue;
      // Una explosión no atraviesa muros.
      if (!this.physics.hasLineOfSight(center, p.position)) continue;
      this.damageVehicle(v, damage * f, center, poses, ownerId, team);
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
        // El daño ambiental va directo al chasis: no hay blindaje contra el ácido.
        v.hullHp = Math.max(0, v.hullHp - dps * TICK_DT);
        if (v.hullHp <= 0 && v.alive) {
          v.alive = false;
          this.emit({ kind: "vehicle_destroyed", targetId: v.id });
          this.mode.onKill?.(v, null, {
            tick: this.tick,
            ruleset: this.config.ruleset,
            vehicles: this.vehicles,
            poses,
            map: this.config.map,
            emit: (e: any) => this.emit(e),
          });
        }
      }
    }
  }

  private damageVehicle(
    target: Vehicle,
    damage: number,
    from: Vec2,
    poses: Map<string, any>,
    ownerId: string,
    ownerTeam: string,
  ): void {
    const tp = poses.get(target.id)!;
    const res = applyDamage(target, damage, from, tp.position, tp.heading, this.rng);

    // El objetivo SIEMPRE sabe que le han dado y en qué sector: lo nota.
    // Pero el sourceId solo se revela si podía verlo (D8): un disparo desde la niebla
    // te hiere sin decirte quién ha sido.
    const canSee = this.physics.hasLineOfSight(tp.position, from, target.id);
    this.emit(
      {
        kind: "hit_taken",
        sector: res.sector,
        damage: round6(res.effectiveDamage),
        ...(canSee ? { sourceId: ownerId } : {}),
      },
      target.id,
    );

    if (res.moduleSlot && res.moduleDestroyed) {
      this.emit(
        { kind: "module_state_changed", slot: res.moduleSlot, state: target.stateOf(res.moduleSlot) },
        target.id,
      );
    }

    // El atacante sabe que ha acertado (ve el impacto).
    const attacker = this.vehicles.find((v) => v.id === ownerId);
    if (attacker) {
      this.emit({ kind: "hit_dealt", targetId: target.id, damage: round6(res.effectiveDamage) }, attacker.id);
    }

    if (res.killed) {
      this.emit({ kind: "vehicle_destroyed", targetId: target.id });
      this.mode.onKill?.(target, ownerTeam, {
        tick: this.tick,
        ruleset: this.config.ruleset,
        vehicles: this.vehicles,
        poses,
        map: this.config.map,
        emit: (e: any) => this.emit(e),
      });
    }
  }

  // ------------------------------------------------------ snapshot y hash
  /**
   * Snapshot PÚBLICO: lo que ve un espectador. Jamás contiene observaciones privadas
   * ni el estado interno de los sensores de un bot (test de fuga en E8).
   */
  private publicSnapshot(poses: Map<string, any>): any {
    return {
      tick: this.tick,
      vehicles: this.vehicles.map((v) => {
        const p = poses.get(v.id);
        return {
          id: v.id,
          team: v.team,
          alive: v.alive,
          position: p ? { x: round6(p.position.x), y: round6(p.position.y) } : null,
          heading: p ? round6(p.heading) : 0,
          turretHeading: round6(v.turretHeading),
          hullHp: round6(v.hullHp),
          hullHpMax: v.spec.hullHp,
          carryingFlag: v.carryingFlag,
          juggernaut: v.juggernaut,
          modules: [...v.modules.values()].map((m) => ({
            slot: m.spec.slot,
            state: v.stateOf(m.spec.slot),
          })),
        };
      }),
      projectiles: this.projectiles.map((p) => ({
        id: p.id,
        position: { x: round6(p.position.x), y: round6(p.position.y) },
      })),
      // Las minas NO van en el snapshot público: son información oculta hasta que explotan.
      score: { ...this.mode.score },
      objectives: this.mode.objectives(),
    };
  }

  /**
   * Hash canónico del estado de simulación. Es LA prueba de determinismo.
   * Incluye el estado del RNG: dos batallas con el mismo hash han consumido
   * exactamente la misma aleatoriedad.
   */
  stateHash(): string {
    const poses = this.poses();
    // Huella del solver (ERR-ENG-04): cuerpos despiertos + pares de contacto. Una
    // divergencia interna de Rapier (islas de sueño, contactos) puede ser invisible
    // en las poses cuantizadas y aun así seguir viva; esto la saca a la luz.
    const solver = this.physics.solverFingerprint();
    const canonical = {
      tick: this.tick,
      rng: this.rng.getState(),
      solver: [solver.awakeBodies, solver.contactPairs],
      vehicles: this.vehicles.map((v) => {
        const p = poses.get(v.id);
        return {
          id: v.id,
          pos: p ? [q(p.position.x), q(p.position.y)] : null,
          h: p ? q(p.heading) : 0,
          vel: p ? [q(p.velocity.x), q(p.velocity.y)] : null,
          turret: q(v.turretHeading),
          hp: q(v.hullHp),
          energy: q(v.energyEU),
          alive: v.alive,
          dq: v.disqualified,
          flag: v.carryingFlag,
          // R3.8 · la marca de juggernaut es estado de simulación: va en el hash como
          // carryingFlag. Añadirla invalida los goldens con hash (regenerados y documentados).
          jug: v.juggernaut,
          modules: [...v.modules.values()]
            .sort((a, b) => a.spec.slot.localeCompare(b.spec.slot))
            .map((m) => [m.spec.slot, q(m.hp), m.offline, m.ammo, m.charges, m.cooldownUntilTick]),
          armor: Object.entries(v.armor)
            .sort()
            .map(([s, a]) => [s, q(a!.hp)]),
        };
      }),
      projectiles: this.projectiles.map((p) => [p.id, q(p.position.x), q(p.position.y), q(p.damage)]),
      mines: this.mines.map((m) => [m.id, q(m.position.x), q(m.position.y)]),
      destructibles: [...this.destructibleHp.entries()].sort().map(([k, v]) => [k, q(v)]),
      score: Object.entries(this.mode.score).sort(),
      objectives: this.mode.objectives(),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private finish(winner: string | "draw"): void {
    this.finished = true;
    this.result = {
      battleId: this.config.battleId,
      winner,
      ticks: this.tick,
      score: { ...this.mode.score },
      finalStateHash: this.stateHash(),
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

  /** Observación de un bot concreto: la usan el servidor de protocolo (E5) y los tests. */
  observationFor(vehicleId: string): any {
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
      this.rng,
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

/** Cuantización para el hash: elimina el ruido del último bit sin ocultar divergencias reales. */
function q(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
