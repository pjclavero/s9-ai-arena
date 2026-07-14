/**
 * T5.3 DoD: "un proyecto consumidor mínimo con tsc --noEmit que importe @arena/sdk
 * compila sin errores". Este archivo simula ESE proyecto externo: importa el
 * paquete por su nombre público (resuelto vía "paths" en tsconfig.json, ya que
 * no está publicado en un registro), no por ruta relativa a src/.
 *
 * Verificar: npx tsc --noEmit -p sdks/javascript/consumer-typecheck-example/tsconfig.json
 */
import { ArenaBot, angleTo, distance, type ObservationPayload, type CommandIntent, type Vec2 } from "@arena/sdk";

class ConsumerBot extends ArenaBot {
  onObservation(observation: ObservationPayload): CommandIntent {
    const me: Vec2 = observation.self.position;
    const contacts = observation.sensors?.radar?.[0]?.contacts ?? [];
    if (contacts.length === 0) return {};

    const closest = contacts.reduce((a, b) => (distance(me, a.position) < distance(me, b.position) ? a : b));
    return {
      turret: { targetPoint: closest.position },
      move: { throttle: 0.5, steer: 0 },
      fire: ["turret_main"],
    };
  }
}

const bot = new ConsumerBot("bot_consumer01");
const bearing: number = angleTo({ x: 0, y: 0 }, { x: 1, y: 1 });
console.log(bot.botId, bearing);
