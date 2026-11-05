/**
 * DOC-A · BOT_EXAMPLES (JavaScript) y SDK_DOCS_CURRENT.
 *
 * Los seis ejemplos de la guía del programador de bots (docs/user/bots/examples/) NO son
 * texto suelto: aquí se ejecutan de verdad contra el motor real y el SDK real, y cada
 * COMMAND que envían se valida contra el esquema `arena/1` de packages/protocol. Además:
 *   - el bloque de código de la guía (docs/user/bots/ejemplos.md) es idéntico al fichero;
 *   - cada ejemplo pasa el análisis estático del build (lo que la web exige al subirlo);
 *   - la guía sólo nombra campos y comandos que existen en los esquemas reales.
 *
 * Los ejemplos de Python se validan en sdks/python/tests/test_docs_examples.py.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { analyze } from "../../../apps/bot-manager/src/static-analysis.js";
import { DEFAULT_CONFIG } from "../../../apps/bot-manager/src/config.js";
import { wrapSingleFile } from "../../../apps/api/src/services/source-package.js";
import { ArenaBot } from "../src/index.js";
import { startLocalBattle } from "./helpers.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle } from "../../../apps/arena-engine/src/sim/battle.js";
import { ctfArena } from "../../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../../apps/arena-engine/src/stubs.js";
import { ProtocolServer, type ExpectedBot } from "../../../apps/arena-engine/src/protocol-server.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EX_DIR = join(ROOT, "docs", "user", "bots", "examples", "javascript");
const FILES = readdirSync(EX_DIR)
  .filter((f) => f.endsWith(".js"))
  .sort();
const read = (f: string) => readFileSync(join(EX_DIR, f), "utf8");

// ---- validador de los COMMAND reales contra packages/protocol/schemas
const SCHEMA_DIR = join(ROOT, "packages", "protocol", "schemas");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
}
const validateEnvelope = ajv.getSchema("envelope.schema.json")!;

async function load(file: string): Promise<new (id: string) => ArenaBot> {
  return (await import(join(EX_DIR, file))).default;
}

/** Envuelve un ejemplo SIN tocar su lógica: sólo graba lo que envía y lo que recibe. */
function recorded(Base: new (id: string) => ArenaBot) {
  return class Recorded extends (Base as any) {
    sent: any[] = [];
    observations: any[] = [];
    welcomeMsg: any = null;
    debugOnSend(msg: any) {
      if (msg.type === "COMMAND") this.sent.push(msg);
    }
    onObservation(obs: any) {
      this.observations.push(obs);
      return super.onObservation(obs);
    }
  } as any;
}

function expectValidCommands(bot: { sent: any[] }) {
  expect(bot.sent.length).toBeGreaterThan(10);
  for (const m of bot.sent) {
    const ok = validateEnvelope(m);
    expect(ok, JSON.stringify([m, validateEnvelope.errors])).toBe(true);
  }
}

describe("DOC-A · los seis ejemplos JavaScript existen y son subibles", () => {
  it("hay seis ejemplos", () => {
    expect(FILES).toEqual([
      "01_minimo.js",
      "02_patrulla.js",
      "03_atacante.js",
      "04_sensores.js",
      "05_radio.js",
      "06_equipo.js",
    ]);
  });

  for (const f of FILES) {
    it(`${f}: pasa el análisis estático del build tal cual`, () => {
      const res = analyze("node", wrapSingleFile("node", read(f)), DEFAULT_CONFIG);
      expect(res.parseErrors).toEqual([]);
      expect(res.dynamicFindings).toEqual([]);
      expect(res.disallowedImports).toEqual([]);
    });

    it(`${f}: exporta por defecto una subclase de ArenaBot que implementa onObservation`, async () => {
      const Bot = await load(f);
      expect(Bot.prototype).toBeInstanceOf(ArenaBot);
      expect(Bot.prototype.onObservation).not.toBe(ArenaBot.prototype.onObservation);
    });
  }
});

describe("DOC-A · los ejemplos JavaScript juegan de verdad (motor real, SDK real)", () => {
  it("01_minimo: avanza y todos sus COMMAND son válidos", async () => {
    const Bot = recorded(await load("01_minimo.js"));
    const bot = new Bot("bot_ex01");
    const battle = await startLocalBattle({
      externalBots: [{ botId: "bot_ex01", archetype: "scout" }],
      stubBots: [{ botId: "bot_idle01", archetype: "scout", kind: "idle" }],
      ticks: 600,
    });
    await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_ex01")!);
    const result = await battle.waitForResult();
    battle.free();
    expect(result.disqualified).toEqual([]);
    expectValidCommands(bot);
    const first = bot.observations[0].self.position;
    const last = bot.observations.at(-1).self.position;
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(10);
  }, 60000);

  it("02_patrulla: completa tramos de la ruta sin sensores", async () => {
    const Bot = recorded(await load("02_patrulla.js"));
    const bot = new Bot("bot_ex02");
    const battle = await startLocalBattle({
      externalBots: [{ botId: "bot_ex02", archetype: "scout" }],
      stubBots: [{ botId: "bot_idle02", archetype: "scout", kind: "idle" }],
      ticks: 1500,
    });
    await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_ex02")!);
    const result = await battle.waitForResult();
    battle.free();
    expect(result.disqualified).toEqual([]);
    expectValidCommands(bot);
    expect(bot.route.length).toBe(4);
    expect(bot.leg).toBeGreaterThanOrEqual(1); // llegó al menos a la primera esquina
  }, 60000);

  it("03_atacante: gana a un rival inmóvil", async () => {
    const Bot = recorded(await load("03_atacante.js"));
    const bot = new Bot("bot_ex03");
    const battle = await startLocalBattle({
      externalBots: [{ botId: "bot_ex03", archetype: "gunner" }],
      stubBots: [{ botId: "bot_idle03", archetype: "scout", kind: "idle" }],
      ticks: 1800,
    });
    await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_ex03")!);
    const result = await battle.waitForResult();
    battle.free();
    expect(result.disqualified).toEqual([]);
    expectValidCommands(bot);
    expect(result.winner).toBe("red");
  }, 60000);

  for (const archetype of ["scout", "gunner", "heavy"] as const) {
    it(`04_sensores: funciona con el sensor del arquetipo ${archetype}`, async () => {
      const Bot = recorded(await load("04_sensores.js"));
      const bot = new Bot("bot_ex04");
      const battle = await startLocalBattle({
        externalBots: [{ botId: "bot_ex04", archetype }],
        stubBots: [{ botId: "bot_hunt04", archetype: "scout", kind: "hunter" }],
        ticks: 900,
      });
      await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_ex04")!);
      const result = await battle.waitForResult();
      battle.free();
      expect(result.disqualified).toEqual([]);
      expectValidCommands(bot);
      // El ejemplo lee bloques de sensor que de verdad existen en la observación.
      const kinds = new Set(bot.observations.flatMap((o: any) => Object.keys(o.sensors ?? {})));
      expect(kinds.size).toBeGreaterThan(0);
    }, 60000);
  }

  it("05_radio: dos compañeros se mandan mensajes y el rival no recibe nada (TDM)", async () => {
    const Bot = recorded(await load("05_radio.js"));
    // El simulador reparte los bandos en orden alterno: veh_1 y veh_3 son rojos, veh_2 azul.
    const a = new Bot("bot_ex05a");
    const rival = new Bot("bot_ex05r");
    const b = new Bot("bot_ex05b");
    const battle = await startLocalBattle({
      externalBots: [
        { botId: "bot_ex05a", archetype: "gunner" },
        { botId: "bot_ex05r", archetype: "gunner" },
        { botId: "bot_ex05b", archetype: "gunner" },
      ],
      ruleset: "tdm_mvp@1",
      ticks: 900,
    });
    const url = `ws://127.0.0.1:${battle.port}`;
    await Promise.all([
      a.run(url, battle.battleTokenFor.get("bot_ex05a")!),
      rival.run(url, battle.battleTokenFor.get("bot_ex05r")!),
      b.run(url, battle.battleTokenFor.get("bot_ex05b")!),
    ]);
    const result = await battle.waitForResult();
    battle.free();
    expect(result.disqualified).toEqual([]);
    expectValidCommands(a);
    expect(a.welcome.teammates).toEqual(["veh_3"]);
    expect(b.welcome.teammates).toEqual(["veh_1"]);
    expect(rival.welcome.teammates).toEqual([]);
    const sent = a.sent.concat(b.sent).filter((m: any) => m.payload.radio);
    expect(sent.length).toBeGreaterThan(0);
    // Los compañeros se oyen entre ellos, y sólo entre ellos.
    expect(a.heard.length + b.heard.length).toBeGreaterThan(0);
    expect(a.heard.every((h: any) => h.from === "veh_3")).toBe(true);
    expect(b.heard.every((h: any) => h.from === "veh_1")).toBe(true);
    for (const h of a.heard.concat(b.heard)) {
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeGreaterThanOrEqual(0);
    }
    // El rival no recibe nada: ni mensajes ni una clave `radio` en su observación.
    expect(rival.heard).toEqual([]);
    expect(rival.observations.some((o: any) => "radio" in o)).toBe(false);
    // Sin compañeros, el ejemplo no gasta radio.
    expect(rival.sent.some((m: any) => m.payload.radio)).toBe(false);
  }, 60000);

  it("06_equipo: dos compañeros del MISMO equipo reparten papeles distintos (CTF 2v2)", async () => {
    const Bot = recorded(await load("06_equipo.js"));
    const catalog = loadCatalog();
    const participants = [
      { id: "veh_1", botId: "bot_ex06a", team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      { id: "veh_2", botId: "bot_ex06b", team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      { id: "veh_3", botId: "bot_hunt06a", team: "blue", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
      { id: "veh_4", botId: "bot_hunt06b", team: "blue", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
    ];
    const battle = await Battle.create({
      battleId: "doc_a_team_example",
      seed: "doc-a-team",
      ruleset: loadRuleset("ctf_mvp@1", { timeLimitTicks: 1200 }),
      map: ctfArena(),
      participants,
    });
    battle.attachBot("veh_3", new HunterBot("bot_hunt06a"));
    battle.attachBot("veh_4", new HunterBot("bot_hunt06b"));
    const expected: ExpectedBot[] = participants.slice(0, 2).map((p) => ({
      botId: p.botId,
      vehicleId: p.id,
      battleToken: "tok_" + p.botId.padEnd(16, "0"),
    }));
    const server = new ProtocolServer({
      battle,
      catalogVersion: CATALOG_VERSION,
      expected,
      tickIntervalMs: 3,
      decisionDeadlineMs: 60,
      port: 0,
    });
    server.start();
    const a = new Bot("bot_ex06a");
    const b = new Bot("bot_ex06b");
    const url = `ws://127.0.0.1:${server.port}`;
    await Promise.all([a.run(url, expected[0].battleToken), b.run(url, expected[1].battleToken)]);
    const result = await server.waitForResult();
    server.stop();
    battle.free();
    expect(result.disqualified).toEqual([]);
    expectValidCommands(a);
    expectValidCommands(b);
    // Cada uno ve al otro como compañero y se reparten los papeles sin hablar.
    expect(a.welcome.teammates).toEqual(["veh_2"]);
    expect([a.role, b.role].sort()).toEqual(["attacker", "defender"]);
    // El atacante sale hacia la base rival (x grande); el defensor se queda cerca de la suya.
    const attacker = a.role === "attacker" ? a : b;
    const defender = a.role === "attacker" ? b : a;
    const maxX = (bot: any) => Math.max(...bot.observations.map((o: any) => o.self.position.x));
    expect(maxX(attacker)).toBeGreaterThan(maxX(defender));
  }, 60000);
});
