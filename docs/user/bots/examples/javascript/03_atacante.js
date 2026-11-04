import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/** Atacante: va hacia la salida del rival; si el radar ve a alguien, apunta y dispara. */
export default class Bot extends ArenaBot {
  weapons = [];
  goal = { x: 60, y: 40 };

  onWelcome(welcome) {
    // Se dispara con las armas de TU loadout: sus ranuras salen del WELCOME.
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
    const rivales = welcome.map.spawns.filter((s) => s.team !== welcome.team).map((s) => s.position);
    if (rivales.length > 0) this.goal = rivales[0];
  }

  onObservation(observation) {
    const me = observation.self;
    const radar = observation.sensors?.radar ?? [];
    // Un contacto con "team" es un aliado: aquí sólo nos interesan los rivales.
    const rivales = radar.flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length === 0) {
      return { move: this.conducir(me, this.goal, 0.9) };
    }
    const blanco = rivales.reduce((a, b) =>
      distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
    );
    const d = distance(me.position, blanco.position);
    // Mantiene la distancia: se acerca si está lejos, retrocede si está encima.
    const throttle = d > 30 ? 0.6 : d < 15 ? -0.3 : 0.0;
    return {
      move: { ...this.conducir(me, blanco.position, 0.0), throttle },
      turret: { targetPoint: blanco.position },
      fire: this.weapons,
    };
  }

  conducir(me, punto, throttle) {
    const giro = angleDiff(me.heading, angleTo(me.position, punto));
    return { throttle, steer: Math.max(-1, Math.min(1, giro * 2)) };
  }
}
