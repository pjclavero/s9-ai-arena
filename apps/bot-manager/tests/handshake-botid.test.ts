/**
 * issue #92 · Una batalla lanzada con identificadores REALES tiene que completarse.
 *
 * El defecto: `participants.bot_id` es un uuid. Ese uuid llegaba a `/run`, se
 * inyectaba tal cual como `BOT_ID` del contenedor, el bot lo mandaba en su
 * HELLO… y `hello.schema.json` exige `^bot_[0-9a-zA-Z]{1,24}$`. El envelope no
 * validaba, el mensaje se DESCARTABA en silencio (regla 4 del protocolo), el
 * handshake expiraba y la batalla no arrancaba. Ninguna batalla lanzada desde
 * la web podía terminar.
 *
 * Por qué no lo cazó ningún test: los fixtures existentes usan `bot_a`/`bot_b`,
 * que YA cumplen el patrón. El bug solo aparece con identificadores como los
 * que produce la base de datos de verdad. Este test usa uuids reales.
 *
 * El bot en proceso valida su propio HELLO contra el esquema publicado antes de
 * enviarlo. Ojo: eso NO es lo que hace el SDK — ni el de JavaScript
 * (`sdks/javascript/src/index.ts`) ni el de Python (`sdks/python/arena_sdk/bot.py`)
 * validan nada antes de emitir. Es un extra de este test, y con la corrección
 * revertida el fallo que se observa PRIMERO no es ese `expect`, sino
 * `whenAllConnected: solo 0/2 bots conectaron`, porque `runContainerBattle`
 * rechaza antes. La comprobación estricta sobrevive como red de diagnóstico
 * para el caso en que alguien alargue ese timeout, no como la señal principal.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { type ContainerHandle, type ContainerRunner, type SandboxSpec } from "../src/container-runner.js";
import { runContainerBattle, type ContainerBattleBot } from "../src/container-battle.js";
import { protocolBotHandle } from "../../../packages/protocol/bot-handle.js";

const REAL_DIGEST =
  "ghcr.io/pjclavero/s9-ai-arena/bot-runtime-python@sha256:a337716702a710a5d3497c81e422ab08e07ddfab5186eb824efce9940306e6aa";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "protocol", "schemas");

/** El validador del HELLO cargado del esquema PUBLICADO, no una copia del regex. */
function helloValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
  }
  const v = ajv.getSchema("hello.schema.json");
  if (!v) throw new Error("no se pudo compilar hello.schema.json");
  return v;
}

beforeAll(async () => {
  await initPhysics();
});

const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
});

/** Bot en proceso que RECHAZA emitir un HELLO no conforme (como el SDK real). */
function startStrictBot(spec: SandboxSpec, onHelloInvalido: (motivo: string) => void): void {
  const valida = helloValidator();
  const ws = new WebSocket(spec.env.WS_URL);
  let seq = 0;
  ws.on("open", () => {
    const payload = {
      botId: spec.env.BOT_ID,
      botVersion: "0.1.0",
      sdk: { name: "custom", version: "0" },
      battleToken: spec.env.BATTLE_TOKEN,
    };
    if (!valida(payload)) {
      onHelloInvalido(`BOT_ID="${spec.env.BOT_ID}" no cumple hello.schema.json`);
      return; // el bot real tampoco llegaría a hablar: el motor nunca lo vería.
    }
    ws.send(JSON.stringify({ proto: "arena/1", type: "HELLO", seq: seq++, payload }));
  });
  ws.on("message", (raw) => {
    let msg: { type?: string; payload?: { tick?: number } };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "OBSERVATION" && typeof msg.payload?.tick === "number") {
      const forTick = msg.payload.tick + 3;
      ws.send(
        JSON.stringify({
          proto: "arena/1",
          type: "COMMAND",
          seq: seq++,
          tick: forTick,
          payload: { forTick, move: { throttle: 0.6, steer: 0.15 } },
        }),
      );
    }
  });
  ws.on("error", () => {
    /* el transporte se cierra al terminar la batalla; sin ruido. */
  });
  openSockets.push(ws);
}

describe("issue #92 · el identificador del cable cumple el contrato del HELLO", () => {
  it("el asa derivada valida contra hello.schema.json; un uuid NO (la regresión)", () => {
    const valida = helloValidator();
    const base = { botVersion: "0.1.0", sdk: { name: "custom", version: "0" }, battleToken: randomUUID() };

    expect(valida({ ...base, botId: protocolBotHandle(0) })).toBe(true);
    expect(valida({ ...base, botId: protocolBotHandle(7) })).toBe(true);

    // El identificador que el sistema maneja de verdad: así estaba el cable.
    expect(valida({ ...base, botId: randomUUID() })).toBe(false);
  });

  it("el ProtocolServer RECHAZA un expected no conforme en vez de callarse (obs. 2 del supervisor)", async () => {
    // Cierra la CLASE, no solo el caso: local-sim.ts y el simulador del SDK
    // construyen `expected` con identificadores sueltos. Antes eso no daba
    // error; solo un timeout de conexión 15 s más tarde, sin diagnóstico.
    const { ProtocolServer } = await import("../../arena-engine/src/protocol-server.js");
    const battle = { getVehicle: () => undefined } as never;
    expect(
      () =>
        new ProtocolServer({
          battle,
          catalogVersion: "x",
          expected: [{ botId: randomUUID(), vehicleId: "veh_1", battleToken: randomUUID() }],
          port: 0,
        }),
    ).toThrow(/no cumple el patrón del HELLO/);
  });

  it("una batalla con botIds uuid (los REALES de la BD) llega a completarse", async () => {
    const helloRechazados: string[] = [];
    const runner: ContainerRunner = {
      async launch(spec: SandboxSpec): Promise<ContainerHandle> {
        startStrictBot(spec, (motivo) => helloRechazados.push(motivo));
        return {
          id: spec.botId,
          async stop() {},
          async posture() {
            return {} as never;
          },
        };
      },
    };

    // Exactamente lo que hay en `participants.bot_id`: uuids, no `bot_a`.
    const bots: ContainerBattleBot[] = [
      { botId: randomUUID(), version: 1, archetype: "scout", imageDigest: REAL_DIGEST },
      { botId: randomUUID(), version: 1, archetype: "gunner", imageDigest: REAL_DIGEST },
    ];

    const { result } = await runContainerBattle({
      battleId: "issue92_" + bots[0].botId,
      seed: "issue92-seed",
      rulesetId: "dm_practice@1",
      ticks: 120,
      mapName: "empty",
      bots,
      runner,
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 3,
      overallTimeoutMs: 20_000,
    });

    // Diagnóstico accionable: si el asa vuelve a ser el uuid, esto lo dice.
    expect(helloRechazados, `HELLO no conforme: ${helloRechazados.join("; ")}`).toEqual([]);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.finalStateHash).toBeTruthy();
  }, 30_000);

  it("los resultados siguen indexados por el botId REAL, no por el asa del cable", async () => {
    const runner: ContainerRunner = {
      async launch(spec: SandboxSpec): Promise<ContainerHandle> {
        startStrictBot(spec, () => {});
        return {
          id: spec.botId,
          async stop() {},
          async posture() {
            return {} as never;
          },
        };
      },
    };
    const bots: ContainerBattleBot[] = [
      { botId: randomUUID(), version: 1, archetype: "scout", imageDigest: REAL_DIGEST },
      { botId: randomUUID(), version: 1, archetype: "gunner", imageDigest: REAL_DIGEST },
    ];

    const { postures, replay } = await runContainerBattle({
      battleId: "issue92b_" + bots[0].botId,
      seed: "issue92b-seed",
      rulesetId: "dm_practice@1",
      ticks: 60,
      mapName: "empty",
      bots,
      runner,
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 3,
      overallTimeoutMs: 20_000,
    });

    // El asa vive SOLO en el cable: nada aguas abajo debe haber cambiado de clave,
    // porque la API correlaciona cpu_ms y participantes por el uuid.
    expect(Object.keys(postures).sort()).toEqual([bots[0].botId, bots[1].botId].sort());
    const asas = [protocolBotHandle(0), protocolBotHandle(1)];
    expect(Object.keys(postures).some((k) => asas.includes(k))).toBe(false);
    expect(replay.result.finalStateHash).toBeTruthy();
  }, 30_000);
});
