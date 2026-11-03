import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/**
 * Captura la bandera en equipo: el compañero con el id más bajo ataca y el resto
 * defiende la base. Todos disparan a lo que vea su radar.
 */
export default class Bot extends ArenaBot {
  weapons = [];
  role = "attacker";
  ownBase = { x: 10, y: 40 };
  enemyBase = { x: 110, y: 40 };

  onWelcome(welcome) {
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
    // Todos los miembros del equipo ordenan la misma lista, así que reparten
    // los papeles sin hablar: sólo el id más bajo es el atacante.
    const escuadra = [welcome.selfId, ...(welcome.teammates ?? [])].sort();
    this.role = escuadra[0] === welcome.selfId ? "attacker" : "defender";
    for (const base of welcome.map.bases ?? []) {
      if (base.team === welcome.team) this.ownBase = base.position;
      else this.enemyBase = base.position;
    }
  }

  onObservation(observation) {
    const me = observation.self;
    const rivales = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);

    let destino;
    if (me.carryingFlag) destino = this.ownBase; // llevo la bandera rival: a mi base
    else if (this.role === "attacker") destino = this.enemyBase; // la bandera rival está en su base
    else destino = this.ownBase; // el defensor guarda la suya

    const giro = angleDiff(me.heading, angleTo(me.position, destino));
    const parado = this.role === "defender" && distance(me.position, destino) < 8;
    const cmd = { move: { throttle: parado ? 0.0 : 0.8, steer: Math.max(-1, Math.min(1, giro * 2)) } };
    if (rivales.length > 0) {
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      cmd.turret = { targetPoint: blanco.position };
      cmd.fire = this.weapons;
    }
    return cmd;
  }
}
