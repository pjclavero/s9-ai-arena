/**
 * T5.3 · Contract tests del SDK de JavaScript. Misma estructura que
 * sdks/python/tests/test_contract.py y — más importante — MISMOS archivos de
 * sdks/shared-contract-tests/cases/*.json: ninguno de los dos SDKs mantiene su
 * propia copia de la suite.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ArenaBot, type Envelope } from "../src/index.js";
import { startLocalBattle } from "./helpers.js";
import { TutorialBot } from "./tutorial-bot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "..", "..", "packages", "protocol", "schemas");
const CASES_DIR = join(__dirname, "..", "..", "shared-contract-tests", "cases");
const ENGINE_DEPS = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "apps", "arena-engine", "src", "engine-deps.json"), "utf8"),
);

function buildValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
  }
  return ajv.getSchema("envelope.schema.json")!;
}

const validate = buildValidator();

interface Case {
  name: string;
  kind: "valid" | "invalid";
  why?: string;
  envelope: unknown;
}

const cases: Case[] = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")));

describe("T5.3 · suite compartida (sdks/shared-contract-tests/cases)", () => {
  it("hay al menos 30 casos (si esto falla, CASES_DIR apunta mal)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    it(`${c.name}: ${c.kind === "valid" ? "valida" : "se rechaza"}`, () => {
      const ok = validate(c.envelope);
      if (c.kind === "valid") {
        expect(ok, JSON.stringify(validate.errors)).toBe(true);
      } else {
        expect(ok, `debía SER RECHAZADO (${c.why}) pero validó`).toBe(false);
      }
    });
  }
});

// --------------------------------------------------------- mensajes reales del SDK
class RecordingBot extends ArenaBot {
  captured: Envelope[] = [];

  onObservation(observation: any) {
    const contacts = (observation.sensors?.radar ?? []).flatMap((r: any) => r.contacts);
    if (contacts.length > 0) {
      return { move: { throttle: 0.5, steer: 0.1 }, turret: { targetPoint: contacts[0].position }, fire: ["turret_main"] };
    }
    return { move: { throttle: 0.7, steer: 0.05 } };
  }

  protected debugOnMessage(msg: Envelope): void {
    this.captured.push(msg);
  }
  protected debugOnSend(msg: Envelope): void {
    this.captured.push(msg);
  }
}

describe("T5.3 · mensajes reales contra una batalla real (motor de E2, en proceso)", () => {
  let captured: Envelope[];

  beforeAll(async () => {
    const bot = new RecordingBot("bot_jscontract1");
    const battle = await startLocalBattle({
      externalBots: [{ botId: "bot_jscontract1", archetype: "gunner" }],
      stubBots: [{ botId: "bot_opp01", archetype: "scout", kind: "hunter" }],
      ticks: 300,
      seed: "js-contract-capture",
    });
    await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_jscontract1")!);
    await battle.waitForResult();
    captured = bot.captured;
  }, 20000);

  it("hubo tráfico real (HELLO, WELCOME, OBSERVATION, COMMAND)", () => {
    const byType: Record<string, number> = {};
    for (const m of captured) byType[m.type] = (byType[m.type] ?? 0) + 1;
    expect(byType.HELLO ?? 0).toBeGreaterThanOrEqual(1);
    expect(byType.WELCOME ?? 0).toBeGreaterThanOrEqual(1);
    expect(byType.OBSERVATION ?? 0).toBeGreaterThan(0);
    expect(byType.COMMAND ?? 0).toBeGreaterThan(0);
  });

  it("cada mensaje capturado valida contra los esquemas reales de E1", () => {
    for (const msg of captured) {
      const ok = validate(msg);
      expect(ok, `${msg.type} (seq ${msg.seq}) no valida: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("WELCOME reporta la versión REAL del motor (no hay reimplementación en JS)", () => {
    const welcome = captured.find((m) => m.type === "WELCOME")!;
    const payload = welcome.payload as any;
    expect(payload.versions.engine).toBe(ENGINE_DEPS.engine.version);
    expect(payload.versions.physics).toBe(`${ENGINE_DEPS.physics.package}@${ENGINE_DEPS.physics.version}`);
  });
});

// ------------------------------------------------------------------------ E2E
describe("T5.3 · el bot TypeScript de ejemplo completa una batalla sin descalificación", () => {
  it("gana contra un stub inmóvil", async () => {
    const bot = new TutorialBot("bot_jstutorial01");
    const battle = await startLocalBattle({
      externalBots: [{ botId: "bot_jstutorial01", archetype: "gunner" }],
      stubBots: [{ botId: "bot_immobile01", archetype: "scout", kind: "idle" }],
      ticks: 1800,
      seed: "js-tutorial-vs-immobile",
    });
    await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_jstutorial01")!);
    const result = await battle.waitForResult();

    expect(result.winner).toBe("red");
    expect(result.disqualified).not.toContain("veh_1");
  }, 20000);
});
