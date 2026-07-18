#!/usr/bin/env -S npx tsx
/**
 * R2.8 · `arena-sim` para el SDK de JS/TS: el envoltorio CLI equivalente al
 * `arena-sim` del SDK de Python (sdks/python/arena_sdk/simulator.py::cli).
 * Corre TU bot (un .ts o .js que exporte una subclase de ArenaBot) contra un
 * stub del motor, con el motor REAL de E2 y el ProtocolServer real de T5.1,
 * sin Docker ni plataforma.
 *
 * Diferencia deliberada con Python (documentada en docs/sdk-paridad.md): aquí
 * NO hay subproceso — el motor y el bot corren en el mismo proceso Node,
 * reutilizando src/local-simulator.ts (el mismo código que usan los tests del
 * SDK), en vez de lanzar apps/arena-engine/src/local-sim.ts con npx.
 *
 * Uso (desde la raíz del repo, tras `npm install`):
 *   npx arena-sim example-bots/javascript/gunner.ts --archetype gunner --opponent idle
 *   npx tsx sdks/javascript/src/arena-sim.ts <bot.ts|js> [flags]   # equivalente
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArenaBot } from "./index.js";
import { startLocalBattle, MAPS, STUBS, type StubKind } from "./local-simulator.js";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Igual que el CLI de Python: primera subclase de ArenaBot que exporte el módulo.
 * El `instanceof` cubre el caso normal (mismo módulo `@arena/sdk` resuelto por el
 * symlink del workspace); el duck-typing es la red de seguridad para un bot que
 * cargue una COPIA distinta del SDK (otro node_modules), donde `instanceof` cruza
 * dos clases ArenaBot diferentes y miente. */
function findBotClass(module: Record<string, unknown>): (new (botId: string) => ArenaBot) | null {
  for (const value of Object.values(module)) {
    if (typeof value !== "function" || value === (ArenaBot as unknown)) continue;
    const proto = (value as { prototype?: unknown }).prototype;
    if (proto instanceof ArenaBot) return value as new (botId: string) => ArenaBot;
    if (
      proto !== null && typeof proto === "object" &&
      typeof (proto as any).onObservation === "function" &&
      typeof (proto as any).run === "function"
    ) return value as new (botId: string) => ArenaBot;
  }
  return null;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      archetype: { type: "string", default: "scout" },
      opponent: { type: "string", default: "idle" },
      "opponent-archetype": { type: "string", default: "scout" },
      map: { type: "string", default: "empty" },
      ruleset: { type: "string", default: "dm_practice@1" },
      ticks: { type: "string", default: "900" },
      seed: { type: "string", default: "cli-sim" },
      "tick-interval-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length !== 1) {
    console.error(
      "Uso: arena-sim <bot.ts|bot.js> [--archetype scout|gunner|miner|heavy]\n" +
        `                [--opponent ${Object.keys(STUBS).join("|")}] [--opponent-archetype scout]\n` +
        `                [--map ${Object.keys(MAPS).join("|")}] [--ruleset dm_practice@1]\n` +
        "                [--ticks 900] [--seed cli-sim] [--tick-interval-ms N]\n\n" +
        "Simulador local de S9 AI Arena (motor real, sin Docker). El bot es un módulo\n" +
        "TS/JS que exporta una subclase de ArenaBot (usa la primera que encuentre).",
    );
    process.exit(values.help ? 0 : 1);
  }

  if (!STUBS[values.opponent!]) fail(`--opponent inválido: ${values.opponent}. Opciones: ${Object.keys(STUBS).join(", ")}`);
  if (!MAPS[values.map!]) fail(`--map inválido: ${values.map}. Opciones: ${Object.keys(MAPS).join(", ")}`);
  const ticks = Number(values.ticks);
  if (!Number.isInteger(ticks) || ticks <= 0) fail(`--ticks inválido: ${values.ticks}`);

  const botPath = resolve(positionals[0]);
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(botPath).href);
  } catch (err) {
    fail(`No se pudo cargar ${botPath}:\n${err}`);
  }
  const BotClass = findBotClass(module);
  if (BotClass === null) fail(`${botPath} no exporta ninguna subclase de ArenaBot`);

  const bot = new BotClass("bot_cli01");

  const tickIntervalMs = values["tick-interval-ms"] !== undefined ? Number(values["tick-interval-ms"]) : undefined;
  const handle = await startLocalBattle({
    externalBots: [{ botId: bot.botId, archetype: values.archetype as any }],
    stubBots: [{ botId: "bot_opp01", archetype: values["opponent-archetype"] as any, kind: values.opponent as StubKind }],
    ticks,
    seed: values.seed,
    map: values.map,
    ruleset: values.ruleset,
    // Igual que local-sim.ts: si se acelera el tick, la ventana de decisión debe
    // seguir superando el round-trip del WebSocket del bot.
    ...(tickIntervalMs !== undefined
      ? { tickIntervalMs, decisionDeadlineMs: Math.max(80, tickIntervalMs * 6) }
      : {}),
  });

  const botDone = bot.run(`ws://127.0.0.1:${handle.port}`, handle.battleTokenFor.get(bot.botId)!);
  const result = await handle.waitForResult();
  await botDone;
  handle.free();

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
