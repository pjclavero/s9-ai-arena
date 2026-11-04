import { ArenaBot, distance } from "@arena/sdk";

/**
 * Usa lo que haya montado: lidar para esquivar muros, radar para apuntar,
 * acústico para mirar hacia un disparo y proximidad para recular.
 */
export default class Bot extends ArenaBot {
  weapons = [];

  onWelcome(welcome) {
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
  }

  onObservation(observation) {
    const me = observation.self;
    const sensors = observation.sensors ?? {}; // sin sensores operativos no hay clave
    const cmd = { move: { throttle: 0.7, steer: 0.2 } };

    // Lidar: "angle" es RELATIVO al morro; distanceM es la distancia libre.
    for (const scan of sensors.lidar ?? []) {
      const delante = scan.rays.filter((r) => Math.abs(r.angle) < 0.4).map((r) => r.distanceM);
      if (delante.length > 0 && Math.min(...delante) < 10) {
        const libre = scan.rays.reduce((a, b) => (a.distanceM >= b.distanceM ? a : b));
        cmd.move = { throttle: 0.3, steer: Math.max(-1, Math.min(1, libre.angle * 2)) };
      }
    }

    // Radar: posiciones ABSOLUTAS con error (errorM). "team" sólo aparece en aliados.
    const rivales = (sensors.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length > 0) {
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      cmd.turret = { targetPoint: blanco.position };
      cmd.fire = this.weapons;
    } else {
      // Acústico: sólo da dirección absoluta (bearing), nunca posición.
      for (const ac of sensors.acoustic ?? []) {
        for (const fuente of ac.sources) {
          if (fuente.kind === "gunshot") cmd.turret = { targetHeading: fuente.bearing };
        }
      }
    }

    // Proximidad: algo (vehículo o mina) muy cerca; retrocede.
    if ((sensors.proximity ?? []).some((p) => p.triggered)) {
      cmd.move = { throttle: -0.6, steer: 0.0 };
    }
    return cmd;
  }
}
