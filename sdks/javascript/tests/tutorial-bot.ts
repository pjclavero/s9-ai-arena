/** El bot de la sección "Tu primer bot" de sdks/javascript/README.md. Vive aquí para
 * que contract.test.ts lo ejecute de verdad: si el README miente, el test falla. */
import { ArenaBot, angleDiff, angleTo, type ObservationPayload, type CommandIntent } from "../src/index.js";

export class TutorialBot extends ArenaBot {
  onObservation(observation: ObservationPayload): CommandIntent {
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);

    if (contacts.length === 0) {
      return { move: { throttle: 0.8, steer: 0.2 } }; // sin nadie a la vista: patrulla
    }

    const target = contacts.reduce((a, b) =>
      (a.position.x - me.position.x) ** 2 + (a.position.y - me.position.y) ** 2 <
      (b.position.x - me.position.x) ** 2 + (b.position.y - me.position.y) ** 2
        ? a
        : b,
    );
    const bearing = angleTo(me.position, target.position);
    const turn = angleDiff(me.heading, bearing);

    return {
      move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, turn * 1.5)) },
      turret: { targetPoint: target.position },
      fire: ["turret_main"],
    };
  }
}
