/**
 * Helper de test compartido: levanta una Battle real + ProtocolServer real (T5.1)
 * EN PROCESO (sin subproceso: a diferencia del SDK de Python, un bot de JS puede
 * vivir en el mismo runtime que el motor — ver docs/sdk-paridad.md) y devuelve el
 * puerto al que conectar bots de prueba.
 */
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BattleResult } from "../../../apps/arena-engine/src/sim/battle.js";
import { emptyArena } from "../../../apps/arena-engine/src/fixtures.js";
import { IdleBot, HunterBot } from "../../../apps/arena-engine/src/stubs.js";
import { ProtocolServer, type ExpectedBot } from "../../../apps/arena-engine/src/protocol-server.js";

export interface LocalBattleHandle {
  server: ProtocolServer;
  port: number;
  battleTokenFor: Map<string, string>;
  waitForResult: () => Promise<BattleResult>;
  /** Para el servidor y libera la física de Rapier. Llamar al terminar cada batalla
   * en un bucle (p. ej. un test de winrate de 20 iteraciones) para no acumular
   * WebSocketServers ni mundos de físicas abiertos. */
  free: () => void;
}

const STUBS: Record<string, (id: string) => any> = { idle: (id) => new IdleBot(id), hunter: (id) => new HunterBot(id) };

export async function startLocalBattle(opts: {
  externalBots: { botId: string; archetype: keyof typeof ARCHETYPES }[];
  stubBots?: { botId: string; archetype: keyof typeof ARCHETYPES; kind: "idle" | "hunter" }[];
  ticks?: number;
  seed?: string;
}): Promise<LocalBattleHandle> {
  const catalog = loadCatalog();
  const stubBots = opts.stubBots ?? [];
  const all = [...opts.externalBots, ...stubBots];
  const participants = all.map((s, i) => ({
    id: `veh_${i + 1}`,
    botId: s.botId,
    team: i % 2 === 0 ? "red" : "blue",
    spec: resolveVehicle(ARCHETYPES[s.archetype], catalog),
  }));

  const battle = await Battle.create({
    battleId: "jssdk_" + Math.random().toString(36).slice(2),
    seed: opts.seed ?? "js-sdk-test",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: opts.ticks ?? 900 }),
    map: emptyArena(),
    participants,
  });

  for (let i = 0; i < stubBots.length; i++) {
    const vehicleId = `veh_${opts.externalBots.length + i + 1}`;
    battle.attachBot(vehicleId, STUBS[stubBots[i].kind](stubBots[i].botId));
  }

  const battleTokenFor = new Map<string, string>();
  const expected: ExpectedBot[] = opts.externalBots.map((s, i) => {
    const token = "tok_" + Math.random().toString(36).slice(2).padEnd(16, "0");
    battleTokenFor.set(s.botId, token);
    return { botId: s.botId, vehicleId: `veh_${i + 1}`, battleToken: token };
  });

  const server = new ProtocolServer({
    battle,
    catalogVersion: CATALOG_VERSION,
    expected,
    tickIntervalMs: 3,
    decisionDeadlineMs: 60,
    port: 0,
  });
  server.start();

  return {
    server,
    port: server.port,
    battleTokenFor,
    waitForResult: () => server.waitForResult(),
    free: () => {
      server.stop();
      battle.free();
    },
  };
}
