import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/**
 * Avisa por radio de dónde ve a un rival (x, y en decímetros, 4 bytes) y guarda
 * lo que oye. Respeta el límite de mensajes por segundo.
 */
export default class Bot extends ArenaBot {
  radioSlot = null;
  lastSent = -1000;
  center = { x: 60, y: 40 };
  heard = [];

  onWelcome(welcome) {
    this.center = { x: welcome.map.widthM / 2, y: welcome.map.heightM / 2 };
    this.radioSlot = welcome.vehicle.modules.find((m) => m.category === "radio")?.slot ?? null;
  }

  onObservation(observation) {
    const me = observation.self;
    const tick = observation.tick;
    // Avanza hacia el centro del mapa, donde se cruzan los caminos.
    const giro = angleDiff(me.heading, angleTo(me.position, this.center));
    const cmd = { move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, giro * 2)) } };

    // Lo recibido llega en observation.radio; "data" es base64 opaco.
    for (const msg of observation.radio ?? []) {
      const bytes = Buffer.from(msg.data, "base64");
      this.heard.push({ from: msg.from, x: bytes.readUInt16BE(0) / 10, y: bytes.readUInt16BE(2) / 10 });
    }

    const rivales = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length > 0 && this.radioSlot && tick - this.lastSent >= 30) {
      // a lo sumo 1 mensaje por segundo
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      // Máximo 32 bytes por mensaje; aquí son 4. Se acota para que quepa en 16 bits.
      const acota = (v) => Math.max(0, Math.min(65535, Math.trunc(v * 10)));
      const bytes = Buffer.alloc(4);
      bytes.writeUInt16BE(acota(blanco.position.x), 0);
      bytes.writeUInt16BE(acota(blanco.position.y), 2);
      cmd.radio = [{ slot: this.radioSlot, data: bytes.toString("base64") }];
      this.lastSent = tick;
    }
    return cmd;
  }
}
