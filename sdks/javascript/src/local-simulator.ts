/**
 * R2.8 · Simulador local del SDK de JS: levanta una Battle real + ProtocolServer
 * real (T5.1) EN PROCESO — sin subproceso: a diferencia del SDK de Python, un bot
 * de JS puede vivir en el mismo runtime que el motor (ver docs/sdk-paridad.md).
 *
 * Nació como `tests/helpers.ts::startLocalBattle` (E5); se movió aquí para que el
 * CLI `arena-sim` (src/arena-sim.ts) y los tests compartan la MISMA implementación
 * en vez de reimplementarla. `tests/helpers.ts` sigue existiendo como envoltorio
 * con los defaults rápidos de test.
 */
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BattleResult } from "../../../apps/arena-engine/src/sim/battle.js";
import { ctfArena, emptyArena, mvpArena } from "../../../apps/arena-engine/src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot, IdleBot } from "../../../apps/arena-engine/src/stubs.js";
import { ProtocolServer, type ExpectedBot } from "../../../apps/arena-engine/src/protocol-server.js";

export type { BattleResult };

export const MAPS: Record<string, () => any> = { empty: emptyArena, mvp: mvpArena, ctf: ctfArena };

/** Los mismos stubs internos del motor que expone local-sim.ts (T5.2). */
export const STUBS: Record<string, (id: string) => any> = {
  idle: (id) => new IdleBot(id),
  hunter: (id) => new HunterBot(id),
  circle: (id) => new CircleBot(id),
  forward: (id) => new ForwardBot(id),
};

export type StubKind = keyof typeof STUBS;

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

export interface LocalBattleOptions {
  externalBots: { botId: string; archetype: keyof typeof ARCHETYPES }[];
  stubBots?: { botId: string; archetype: keyof typeof ARCHETYPES; kind: StubKind }[];
  ticks?: number;
  seed?: string;
  map?: keyof typeof MAPS;
  ruleset?: string;
  /** ms reales por tick. Sin especificar, el ritmo real del motor (~33 ms/tick). */
  tickIntervalMs?: number;
  /** Deadline de decisión en ms reales. Sin especificar, el del motor (80 ms). */
  decisionDeadlineMs?: number;
}

export async function startLocalBattle(opts: LocalBattleOptions): Promise<LocalBattleHandle> {
  const catalog = loadCatalog();
  const stubBots = opts.stubBots ?? [];
  const all = [...opts.externalBots, ...stubBots];
  const participants = all.map((s, i) => {
    const loadout = ARCHETYPES[s.archetype];
    if (!loadout) throw new Error(`Arquetipo desconocido: ${s.archetype}. Opciones: ${Object.keys(ARCHETYPES).join(", ")}`);
    return {
      id: `veh_${i + 1}`,
      botId: s.botId,
      team: i % 2 === 0 ? "red" : "blue",
      spec: resolveVehicle(loadout, catalog),
    };
  });

  const mapName = opts.map ?? "empty";
  if (!MAPS[mapName]) throw new Error(`Mapa desconocido: ${mapName}. Opciones: ${Object.keys(MAPS).join(", ")}`);

  const battle = await Battle.create({
    battleId: "jssdk_" + Math.random().toString(36).slice(2),
    seed: opts.seed ?? "js-sdk-test",
    ruleset: loadRuleset(opts.ruleset ?? "dm_practice@1", { timeLimitTicks: opts.ticks ?? 900 }),
    map: MAPS[mapName](),
    participants,
  });

  for (let i = 0; i < stubBots.length; i++) {
    const s = stubBots[i];
    if (!STUBS[s.kind]) throw new Error(`Stub desconocido: ${s.kind}. Opciones: ${Object.keys(STUBS).join(", ")}`);
    const vehicleId = `veh_${opts.externalBots.length + i + 1}`;
    battle.attachBot(vehicleId, STUBS[s.kind](s.botId));
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
    port: 0,
    ...(opts.tickIntervalMs !== undefined ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    ...(opts.decisionDeadlineMs !== undefined ? { decisionDeadlineMs: opts.decisionDeadlineMs } : {}),
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
