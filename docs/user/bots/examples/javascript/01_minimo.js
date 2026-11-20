import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation(observation) {
    // Se llama en cada ciclo de decisión. Devuelve la orden del ciclo:
    // avanzar recto a media potencia. {} significaría "sin cambios".
    return { move: { throttle: 0.5, steer: 0.0 } };
  }
}
