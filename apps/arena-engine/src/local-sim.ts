#!/usr/bin/env -S npx tsx
/**
 * Puente para los simuladores locales de los SDKs (T5.2/T5.3). Levanta una Battle
 * real con el catálogo real de E3 y el ProtocolServer real de T5.1, sin Docker ni
 * plataforma: el SDK (Python o JS) lo invoca como subproceso y conecta sus bots por
 * WebSocket al puerto que este script imprime.
 *
 * Protocolo de subproceso (por stdout, una línea = un JSON):
 *   1) {"event":"ready","port":N,"catalogVersion":"...","bots":[{"botId","vehicleId","battleToken"}]}
 *   2) {"event":"result","result": BattleResult}
 *
 * Uso:
 *   npx tsx local-sim.ts --map empty|mvp|ctf --ruleset dm_practice@1 --ticks 900
 *     --bots botId1:scout,botId2:gunner              (bots EXTERNOS, se conectan por WS)
 *     --stub-bots botId3:heavy:idle,botId4:scout:hunter   (opcional, corren dentro del motor)
 */
import { randomUUID } from "node:crypto";
import { nowMs } from "./wall-clock.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "./sim/battle.js";
import { ctfArena, emptyArena, mvpArena } from "./fixtures.js";
import { CircleBot, ForwardBot, HunterBot, IdleBot } from "./stubs.js";
import { ProtocolServer, type ExpectedBot } from "./protocol-server.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MAPS: Record<string, () => any> = { empty: emptyArena, mvp: mvpArena, ctf: ctfArena };
const STUBS: Record<string, (id: string) => any> = {
  idle: (id) => new IdleBot(id),
  hunter: (id) => new HunterBot(id),
  circle: (id) => new CircleBot(id),
  forward: (id) => new ForwardBot(id),
};

function parseBotList(s: string | undefined): { botId: string; archetype: string; kind?: string }[] {
  if (!s) return [];
  return s
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [botId, archetype, kind] = entry.split(":");
      return { botId, archetype, kind };
    });
}

async function main(): Promise<void> {
  const mapName = arg("map", "empty")!;
  const rulesetId = arg("ruleset", "dm_practice@1")!;
  const ticks = Number(arg("ticks", "9000"));
  const seed = arg("seed", "localsim")!;
  const external = parseBotList(arg("bots"));
  const stubBots = parseBotList(arg("stub-bots"));

  if (external.length + stubBots.length === 0) {
    throw new Error("Ningún bot especificado (--bots y/o --stub-bots)");
  }

  const catalog = loadCatalog();
  const all = [...external, ...stubBots];
  const participants: Participant[] = all.map((s, i) => {
    const archetypeKey = s.archetype as keyof typeof ARCHETYPES;
    const loadout = ARCHETYPES[archetypeKey];
    if (!loadout)
      throw new Error(`Arquetipo desconocido: ${s.archetype}. Opciones: ${Object.keys(ARCHETYPES).join(", ")}`);
    return {
      id: `veh_${i + 1}`,
      botId: s.botId,
      team: i % 2 === 0 ? "red" : "blue",
      spec: resolveVehicle(loadout, catalog),
    };
  });

  const battle = await Battle.create({
    // Id local, no simulación: el reloj de pared va vía wall-clock.ts (lint ERR-ENG-02).
    battleId: "localsim_" + nowMs(),
    seed,
    ruleset: loadRuleset(rulesetId, { timeLimitTicks: ticks }),
    map: (MAPS[mapName] ?? emptyArena)(),
    participants,
  });

  // Los stub-bots corren DENTRO del motor: no pasan por el protocolo ni por WebSocket.
  for (let i = 0; i < stubBots.length; i++) {
    const s = stubBots[i];
    const vehicleId = `veh_${external.length + i + 1}`;
    const mk = STUBS[s.kind ?? "idle"] ?? STUBS.idle;
    battle.attachBot(vehicleId, mk(s.botId));
  }

  const expected: ExpectedBot[] = external.map((s, i) => ({
    botId: s.botId,
    vehicleId: `veh_${i + 1}`,
    battleToken: randomUUID(),
  }));

  // Ritmo del bucle. Por defecto tiempo real (~33 ms/tick); los tests lo aceleran con
  // --tick-interval-ms para no correr 40 batallas en tiempo real. No bajar demasiado:
  // la ventana de decisión (3 ticks) debe superar el round-trip WebSocket del bot.
  const tickIntervalMs = arg("tick-interval-ms") ? Number(arg("tick-interval-ms")) : undefined;
  const server = new ProtocolServer({
    battle,
    catalogVersion: CATALOG_VERSION,
    expected,
    port: Number(arg("port", "0")),
    ...(tickIntervalMs !== undefined ? { tickIntervalMs, decisionDeadlineMs: Math.max(80, tickIntervalMs * 6) } : {}),
  });
  server.start();

  console.log(JSON.stringify({ event: "ready", port: server.port, catalogVersion: CATALOG_VERSION, bots: expected }));

  const result = await server.waitForResult();
  console.log(JSON.stringify({ event: "result", result }));
  server.stop();
  battle.free();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
