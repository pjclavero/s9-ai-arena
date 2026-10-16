/**
 * SÓLO TESTS / DEMO · agentes deterministas del motor (HunterBot) EN PROCESO.
 *
 * Antes eran el `defaultAgentResolver` del worker y jugaban, en silencio, TODAS
 * las batallas del producto en nombre del código de cada usuario (TD-002). Ahora
 * hay que pedirlos explícitamente y NO se pueden construir en producción: con
 * NODE_ENV=production lanzan. `main.ts` no importa este módulo (lo vigila
 * no-stub-in-production.test.ts).
 */
import { HunterBot } from "../../../arena-engine/src/stubs.js";
import { inProcessAgents, type AgentDriver, type AgentResolver } from "../engine-executor.js";

function refuseInProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "testing/stub-agents: los agentes stub (HunterBot) no se pueden usar con NODE_ENV=production: " +
        "las batallas de producción las juega el código real de cada bot (containerAgents).",
    );
  }
}

/** Resolver explícito: todos los vehículos los conduce HunterBot. */
export const hunterBotResolver: AgentResolver = (botId) => {
  refuseInProduction();
  return new HunterBot(botId);
};

/** Driver en proceso con HunterBot para todos (tests de torneo/cola/espectador). */
export function testStubAgents(): AgentDriver {
  refuseInProduction();
  return inProcessAgents(hunterBotResolver);
}
