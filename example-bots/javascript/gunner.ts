/**
 * Artillero — cañón pesado, mantiene distancia, disparo predictivo simple: usa la
 * velocity del contacto de radar para anticipar dónde estará el objetivo, no solo
 * su posición actual.
 *
 * Loadout de referencia: arquetipo "gunner" del catálogo real de E3
 * (packages/module-catalog/resolve/archetypes.ts): chasis medio, cañón, radar,
 * blindaje frontal.
 */
import {
  ArenaBot,
  angleDiff,
  angleTo,
  distance,
  type CommandIntent,
  type ObservationPayload,
  type WelcomePayload,
} from "@arena/sdk";

const IDEAL_RANGE_M = 35;
const DEFAULT_PROJECTILE_SPEED_MS = 120;

export class GunnerBot extends ArenaBot {
  static readonly ARCHETYPE = "gunner";

  private projectileSpeedMs = DEFAULT_PROJECTILE_SPEED_MS;
  private weaponSlot = "turret_main";
  private mapCenter = { x: 60, y: 40 };

  override onWelcome(welcome: WelcomePayload): void {
    this.mapCenter = { x: welcome.map.widthM / 2, y: welcome.map.heightM / 2 };
    for (const m of welcome.vehicle.modules) {
      if (m.category === "weapon") {
        this.weaponSlot = m.slot;
        const speed = (m.specs as any)?.projectileSpeedMs;
        if (typeof speed === "number") this.projectileSpeedMs = speed;
      }
    }
  }

  override onObservation(observation: ObservationPayload): CommandIntent {
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);

    if (contacts.length === 0) {
      // Sin blanco: AVANZA hacia el centro del mapa a buscar (el radar solo alcanza
      // 50 m; merodear en el sitio no encuentra a un enemigo que nace a 80 m). Al
      // pasar el centro, barre con un giro suave para cubrir la otra mitad.
      const toCenter = angleDiff(me.heading, angleTo(me.position, this.mapCenter));
      const past = distance(me.position, this.mapCenter) < 12;
      return { move: { throttle: past ? 0.7 : 0.9, steer: past ? 0.5 : Math.max(-1, Math.min(1, toCenter * 1.5)) } };
    }

    const target = contacts.reduce((a, b) =>
      distance(me.position, a.position) < distance(me.position, b.position) ? a : b,
    );
    const aimPoint = this.predictedAimPoint(me.position, target);

    const d = distance(me.position, target.position);
    const bearingToTarget = angleTo(me.position, target.position);
    const turn = angleDiff(me.heading, bearingToTarget);

    // Mantiene distancia: se acerca si está lejos, retrocede si está demasiado cerca.
    const throttle = d > IDEAL_RANGE_M + 10 ? 0.6 : d < IDEAL_RANGE_M - 10 ? -0.3 : 0;

    return {
      move: { throttle, steer: Math.max(-1, Math.min(1, turn * 1.2)) },
      turret: { targetPoint: aimPoint },
      fire: [this.weaponSlot],
    };
  }

  /**
   * Punto de intercepción: NO basta con posición + velocidad × (distanciaActual /
   * velProyectil), porque el tiempo de vuelo depende de la distancia al punto FUTURO,
   * no al actual. Se itera un par de veces la solución de intercepción: estimar el
   * tiempo, proyectar dónde estará el blanco, recalcular el tiempo a ese punto. Dos
   * iteraciones convergen de sobra para un blanco a velocidad constante y mejoran
   * claramente el acierto contra objetivos que cruzan la línea de tiro.
   */
  private predictedAimPoint(
    from: { x: number; y: number },
    target: { position: { x: number; y: number }; velocity?: { x: number; y: number } },
  ) {
    if (!target.velocity) return target.position;
    let timeToImpact = distance(from, target.position) / this.projectileSpeedMs;
    for (let i = 0; i < 2; i++) {
      const px = target.position.x + target.velocity.x * timeToImpact;
      const py = target.position.y + target.velocity.y * timeToImpact;
      timeToImpact = Math.hypot(px - from.x, py - from.y) / this.projectileSpeedMs;
    }
    return {
      x: target.position.x + target.velocity.x * timeToImpact,
      y: target.position.y + target.velocity.y * timeToImpact,
    };
  }
}
