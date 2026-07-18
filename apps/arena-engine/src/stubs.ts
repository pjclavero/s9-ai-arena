/**
 * BotStubs internos (T2.1). Bots de comportamiento FIJO para probar el motor sin
 * depender del protocolo ni de contenedores. E5 los sustituirá por bots reales por
 * WebSocket; el motor no notará la diferencia porque la interfaz es la misma.
 *
 * Ninguno usa aleatoriedad: si necesitan variar, lo hacen en función del tick.
 * Un stub aleatorio arruinaría las pruebas de determinismo que justifican su existencia.
 */
import type { BotAgent } from "./sim/battle.js";

/** No hace absolutamente nada. El saco de arena de referencia. */
export class IdleBot implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick };
  }
}

/** Nunca responde. Provoca timeouts y, al final, descalificación (D2). */
export class DeadBot implements BotAgent {
  constructor(readonly botId: string) {}
  decide(): null {
    return null;
  }
}

/** Avanza recto sin parar. Prueba de aceleración, inercia y colisión con muros. */
export class ForwardBot implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick, move: { throttle: 1, steer: 0 } };
  }
}

/** Gira en círculo. Prueba de velocidad angular. */
export class CircleBot implements BotAgent {
  constructor(
    readonly botId: string,
    private steer = 0.6,
  ) {}
  decide(obs: any) {
    return { forTick: obs.tick, move: { throttle: 0.7, steer: this.steer } };
  }
}

/**
 * Persigue al contacto de radar más cercano y le dispara. Es el stub "de combate":
 * ejercita torreta, arco, cooldown, munición y energía.
 */
export class HunterBot implements BotAgent {
  constructor(
    readonly botId: string,
    private weaponSlot = "turret_main",
  ) {}

  decide(obs: any) {
    const cmd: any = { forTick: obs.tick, move: { throttle: 0.5, steer: 0 } };

    const contacts = (obs.sensors?.radar ?? []).flatMap((r: any) => r.contacts ?? []);
    const enemy = contacts
      .filter((c: any) => !c.team) // sin team = no es aliado (IFF, ver sensors.ts)
      .sort((a: any, b: any) => dist(obs.self.position, a.position) - dist(obs.self.position, b.position))[0];

    if (!enemy) {
      // Sin contactos: BUSCA. Girar en el sitio no encuentra a nadie —el radar tiene
      // alcance finito (50 m) y los vehículos nacen a 80 m: hay que recorrer distancia.
      // Avanza barriendo con un giro suave, y esquiva paredes si tiene lidar.
      const avoid = avoidanceSteer(obs, 8);
      cmd.move = { throttle: 0.9, steer: avoid !== null ? Math.max(-1, Math.min(1, avoid * 2)) : 0.08 };
      return cmd;
    }

    cmd.turret = { targetPoint: enemy.position };

    const dx = enemy.position.x - obs.self.position.x;
    const dy = enemy.position.y - obs.self.position.y;
    const d = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);
    let rel = bearing - obs.self.heading;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;

    // Mantiene distancia media: ni pegado ni fuera de alcance.
    cmd.move = {
      throttle: d > 25 ? 0.8 : d < 12 ? -0.4 : 0,
      steer: Math.max(-1, Math.min(1, rel * 1.5)),
    };

    // Dispara si la torreta ya apunta razonablemente bien.
    const turretErr = Math.abs(angleDiff(obs.self.turretHeading ?? 0, bearing));
    if (turretErr < 0.15) cmd.fire = [this.weaponSlot];

    return cmd;
  }
}

/** Va derecho a un punto fijo. Base de los escenarios guionizados (CTF, slalom). */
export class SeekBot implements BotAgent {
  constructor(
    readonly botId: string,
    private target: { x: number; y: number },
    private throttle = 1,
  ) {}

  setTarget(t: { x: number; y: number }): void {
    this.target = t;
  }

  decide(obs: any) {
    const dx = this.target.x - obs.self.position.x;
    const dy = this.target.y - obs.self.position.y;
    const bearing = Math.atan2(dy, dx);
    const rel = angleDiff(obs.self.heading, bearing);
    const d = Math.hypot(dx, dy);

    return {
      forTick: obs.tick,
      move: {
        throttle: d < 1.5 ? 0 : this.throttle * (Math.abs(rel) > 1.2 ? 0.25 : 1),
        steer: Math.max(-1, Math.min(1, rel * 2)),
      },
    };
  }
}

/**
 * CTF guionizado: va a por la bandera enemiga y la lleva a su base.
 *
 * Usa solo información PÚBLICA (posición de bases y de banderas en base) y su propio
 * lidar para esquivar. No tiene acceso privilegiado al estado del motor: navega con
 * lo que percibe, exactamente igual que tendrá que hacer un bot real de E5.
 */
export class FlagRunnerBot implements BotAgent {
  constructor(
    readonly botId: string,
    private enemyFlagPos: { x: number; y: number },
    private homeBasePos: { x: number; y: number },
  ) {}

  decide(obs: any) {
    const target = obs.self.carryingFlag ? this.homeBasePos : this.enemyFlagPos;
    const dx = target.x - obs.self.position.x;
    const dy = target.y - obs.self.position.y;
    const bearing = Math.atan2(dy, dx);
    let rel = angleDiff(obs.self.heading, bearing);
    const d = Math.hypot(dx, dy);

    // Evitación con lidar: si hay algo cerca al frente, busca el hueco más despejado.
    // Sin esto, un bot de "ir en línea recta" se queda pegado a la primera pared.
    const avoid = avoidanceSteer(obs);
    if (avoid !== null) rel = avoid;

    return {
      forTick: obs.tick,
      move: {
        throttle: d < 0.8 ? 0 : Math.abs(rel) > 1.0 ? 0.35 : 1,
        steer: Math.max(-1, Math.min(1, rel * 2.5)),
      },
    };
  }
}

/**
 * Dirección de escape a partir del lidar, o null si el camino está libre.
 * Heurística deliberadamente simple: mira el sector frontal; si el rayo más corto
 * está por debajo del umbral, apunta hacia el rayo más largo disponible.
 */
function avoidanceSteer(obs: any, thresholdM = 6): number | null {
  const lidar = obs.sensors?.lidar?.[0];
  if (!lidar) return null;

  // Solo importan los rayos que apuntan hacia delante (±60°).
  const front = lidar.rays.filter((r: any) => Math.abs(r.angle) < Math.PI / 3);
  if (front.length === 0) return null;

  const nearest = front.reduce((a: any, b: any) => (a.distanceM < b.distanceM ? a : b));
  if (nearest.distanceM > thresholdM) return null; // vía libre

  const freest = lidar.rays.reduce((a: any, b: any) => (a.distanceM > b.distanceM ? a : b));
  return freest.angle;
}

function dist(a: any, b: any): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDiff(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
