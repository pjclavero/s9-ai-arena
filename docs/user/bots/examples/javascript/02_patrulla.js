import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/** Patrulla: recorre las cuatro esquinas interiores del mapa, sin sensores. */
export default class Bot extends ArenaBot {
  route = [];
  leg = 0;

  onWelcome(welcome) {
    // Las medidas del mapa llegan en el WELCOME: nunca las supongas.
    const ancho = welcome.map.widthM;
    const largo = welcome.map.heightM;
    const margen = 15; // metros de separación respecto a los muros
    this.route = [
      { x: margen, y: margen },
      { x: ancho - margen, y: margen },
      { x: ancho - margen, y: largo - margen },
      { x: margen, y: largo - margen },
    ];
  }

  onObservation(observation) {
    if (this.route.length === 0) return {};
    const me = observation.self;
    let goal = this.route[this.leg];
    if (distance(me.position, goal) < 6) {
      // llegado: siguiente tramo
      this.leg = (this.leg + 1) % this.route.length;
      goal = this.route[this.leg];
    }
    const giro = angleDiff(me.heading, angleTo(me.position, goal));
    // Si el destino queda muy desviado, frena y gira; si no, acelera.
    const throttle = Math.abs(giro) < 0.6 ? 0.9 : 0.2;
    return { move: { throttle, steer: Math.max(-1, Math.min(1, giro * 2)) } };
  }
}
