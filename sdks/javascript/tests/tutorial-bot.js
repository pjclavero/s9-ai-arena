import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";

export default class TutorialBot extends ArenaBot {
  onObservation(observation) {
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);

    if (contacts.length === 0) {
      return { move: { throttle: 0.8, steer: 0.2 } }; // sin nadie a la vista: patrulla
    }

    const d2 = (c) => (c.position.x - me.position.x) ** 2 + (c.position.y - me.position.y) ** 2;
    const target = contacts.reduce((a, b) => (d2(a) < d2(b) ? a : b));
    const turn = angleDiff(me.heading, angleTo(me.position, target.position));

    return {
      move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, turn * 1.5)) },
      turret: { targetPoint: target.position },
      fire: ["turret_main"],
    };
  }
}

export { TutorialBot };
