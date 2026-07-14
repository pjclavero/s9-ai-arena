/**
 * Minador — siembra minas en su avance hacia territorio rival, combate cuerpo a
 * cuerpo con su ametralladora cuando detecta a alguien con el lidar.
 *
 * Loadout de referencia: arquetipo "miner" del catálogo real de E3
 * (packages/module-catalog/resolve/archetypes.ts): chasis medio, orugas, mina
 * explosiva, ametralladora, blindaje trasero.
 *
 * Nota honesta: el encargo sugiere sembrar en "cuellos de botella" detectados con
 * el lidar; el mapa de práctica CTF (ctfArena() de apps/arena-engine/src/fixtures.ts)
 * es deliberadamente ABIERTO — sin obstáculos entre bases, por diseño de E2, para
 * aislar la FSM de bandera de la navegación — así que no existe ningún cuello de
 * botella real que detectar ahí. Este bot usa la alternativa que el propio encargo
 * deja explícita: sembrar en puntos conocidos de su ruta de avance, cada
 * MINE_INTERVAL_TICKS mientras dure el cooldown del módulo.
 */
import { ArenaBot, angleDiff, angleTo, distance, type CommandIntent, type ObservationPayload, type WelcomePayload } from "@arena/sdk";

const MINE_INTERVAL_TICKS = 100; // algo más que el cooldown real (90 ticks) del módulo

export class MinerBot extends ArenaBot {
  static readonly ARCHETYPE = "miner";

  private mineSlot: string | null = null;
  private enemyBase: { x: number; y: number } | null = null;
  private mapCenter = { x: 60, y: 40 };
  private lastMineTick = -MINE_INTERVAL_TICKS;

  override onWelcome(welcome: WelcomePayload): void {
    for (const m of welcome.vehicle.modules) {
      if (m.category === "mine") this.mineSlot = m.slot;
    }
    this.mapCenter = { x: welcome.map.widthM / 2, y: welcome.map.heightM / 2 };
    const enemy = welcome.map.bases?.find((b) => b.team !== welcome.team);
    // Sin bases en el mapa (p. ej. emptyArena), avanza hacia el centro a buscar
    // enemigos: su lidar frontal solo cubre 90°, así que apuntar hacia donde avanza
    // es también apuntar el sensor hacia el enemigo.
    this.enemyBase = enemy?.position ?? this.mapCenter;
  }

  override onObservation(observation: ObservationPayload): CommandIntent {
    const me = observation.self;
    const lidarRays = observation.sensors?.lidar?.[0]?.rays ?? [];
    // Detecta hasta el alcance real del lidar frontal (~45 m), no un umbral corto:
    // con 30 m el minador se quedaba merodeando sin "ver" a un enemigo a 40 m.
    const intruders = lidarRays.filter((r) => r.hit === "vehicle" && r.distanceM <= 44);

    const command: CommandIntent = {};

    if (intruders.length > 0) {
      const nearest = intruders.reduce((a, b) => (a.distanceM < b.distanceM ? a : b));
      // targetHeading DEBE estar en [-pi, pi] (command.schema.json / common.schema
      // angle). me.heading + nearest.angle puede salirse; angleDiff(0, x) lo normaliza.
      // Sin esto, el COMMAND es inválido, el servidor lo descarta y se cuenta como
      // timeout (D2) -> descalificación tras 20 seguidos.
      const bearing = angleDiff(0, me.heading + nearest.angle);
      // Cierra distancia hasta ponerse a tiro de la ametralladora y dispara.
      command.move = { throttle: 0.6, steer: Math.max(-1, Math.min(1, nearest.angle * 2)) };
      command.turret = { targetHeading: bearing };
      command.fire = ["turret_main"];
    } else {
      // Sin enemigos: avanza hacia territorio enemigo (la mitad OPUESTA a la suya) a
      // buscar, barriendo con el lidar frontal por el camino. Cuando llega, sigue
      // rondando esa mitad en vez de pararse.
      const target = this.patrolTarget(me.position);
      const turn = angleDiff(me.heading, angleTo(me.position, target));
      const arrived = distance(me.position, target) < 10;
      command.move = arrived
        ? { throttle: 0.6, steer: 0.5 }
        : { throttle: 0.75, steer: Math.max(-1, Math.min(1, turn * 1.5)) };
    }

    if (this.mineSlot && observation.tick - this.lastMineTick >= MINE_INTERVAL_TICKS) {
      command.deployMine = { slot: this.mineSlot };
      this.lastMineTick = observation.tick;
    }

    return command;
  }

  /** Punto de patrulla: la base enemiga si el mapa la declara; si no, un punto en la
   * mitad OPUESTA del mapa a la que ocupa el minador (así avanza hacia el enemigo). */
  private patrolTarget(myPos: { x: number; y: number }): { x: number; y: number } {
    if (this.enemyBase && this.enemyBase !== this.mapCenter) return this.enemyBase;
    const farX = myPos.x < this.mapCenter.x ? this.mapCenter.x * 1.7 : this.mapCenter.x * 0.3;
    return { x: farX, y: this.mapCenter.y };
  }
}
