/**
 * T5.4 · DoD: "los cuatro bots completan una batalla CTF 2v2 real (servidor de
 * T5.1 + SDK, SIN stubs internos) sin timeouts ni descalificaciones — usa
 * ctfArena()". Cross-lenguaje de verdad: explorer.py y defender.py corren como
 * subprocesos Python reales (arena-sdk); gunner.ts y miner.ts corren en el mismo
 * proceso Node del test, ambos conectados por WebSocket real al mismo servidor de
 * protocolo — exactamente como en producción, salvo que los cuatro viven en la
 * misma máquina.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadRuleset } from "../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../packages/module-catalog/resolve/archetypes.js";
import { Battle } from "../apps/arena-engine/src/sim/battle.js";
import { ctfArena } from "../apps/arena-engine/src/fixtures.js";
import { ProtocolServer, type ExpectedBot } from "../apps/arena-engine/src/protocol-server.js";
import { GunnerBot } from "./javascript/gunner.js";
import { MinerBot } from "./javascript/miner.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const PYTHON = join(REPO_ROOT, "sdks", "python", ".venv", "Scripts", "python.exe");
const RUN_BOT_SCRIPT = join(REPO_ROOT, "example-bots", "python", "_run_bot.py");

function spawnPythonBot(file: string, className: string, botId: string, url: string, token: string) {
  return spawn(PYTHON, [RUN_BOT_SCRIPT, join(REPO_ROOT, "example-bots", "python", file), className, botId, url, token], {
    stdio: "ignore",
  });
}

// Batalla CTF completa con 2 subprocesos Python (~46 s) + requiere el venv de
// sdks/python instalado: sólo con RUN_SLOW=1 (ver gunner.test.ts).
const slow = process.env.RUN_SLOW === "1" ? describe : describe.skip;

slow("T5.4 · CTF 2v2 con los 4 bots oficiales, sin stubs internos", () => {
  it("explorer.py + gunner.ts (red) vs defender.py + miner.ts (blue) terminan sin timeouts ni descalificaciones", async () => {
    const catalog = loadCatalog();
    const participants = [
      { id: "veh_1", botId: "bot_explorer", team: "red", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
      { id: "veh_2", botId: "bot_defender", team: "blue", spec: resolveVehicle(ARCHETYPES.heavy, catalog) },
      { id: "veh_3", botId: "bot_gunner", team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      { id: "veh_4", botId: "bot_miner", team: "blue", spec: resolveVehicle(ARCHETYPES.miner, catalog) },
    ];

    const battle = await Battle.create({
      battleId: "ctf_integration_test",
      seed: "ctf-integration",
      ruleset: loadRuleset("ctf_mvp@1", { timeLimitTicks: 1500, maxConsecutiveTimeouts: 20 }),
      map: ctfArena(),
      participants,
    });

    const expected: ExpectedBot[] = participants.map((p) => ({
      botId: p.botId,
      vehicleId: p.id,
      battleToken: "tok_" + p.botId + "_".padEnd(8, "0"),
    }));

    // Ventana de decisión holgada (3 ticks × 25 ms = 75 ms) para que el round-trip
    // WebSocket sobreviva incluso con dos bots en SUBPROCESO de Python: con ventanas
    // muy cortas, un subproceso lento perdería deadlines y acabaría descalificado por
    // timeouts consecutivos (D2), que es justo lo que la DoD prohíbe.
    const server = new ProtocolServer({
      battle,
      catalogVersion: CATALOG_VERSION,
      expected,
      tickIntervalMs: 25,
      decisionDeadlineMs: 300,
      port: 0,
    });
    server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    const tokenFor = (botId: string) => expected.find((e) => e.botId === botId)!.battleToken;

    const pyExplorer = spawnPythonBot("explorer.py", "ExplorerBot", "bot_explorer", url, tokenFor("bot_explorer"));
    const pyDefender = spawnPythonBot("defender.py", "DefenderBot", "bot_defender", url, tokenFor("bot_defender"));

    const jsGunner = new GunnerBot("bot_gunner");
    const jsMiner = new MinerBot("bot_miner");
    const jsRuns = Promise.all([
      jsGunner.run(url, tokenFor("bot_gunner")),
      jsMiner.run(url, tokenFor("bot_miner")),
    ]);

    const result = await server.waitForResult();
    await jsRuns;
    pyExplorer.kill();
    pyDefender.kill();
    server.stop();
    battle.free();

    console.log(`CTF 2v2: ganador=${result.winner}, ticks=${result.ticks}, marcador=${JSON.stringify(result.score)}, descalificados=${JSON.stringify(result.disqualified)}`);
    expect(result.disqualified).toEqual([]);
  }, 180000);
});
