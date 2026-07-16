/**
 * T5.1 · DoD del servidor de protocolo. Usa clientes WebSocket reales (paquete `ws`)
 * contra un ProtocolServer real levantado en un puerto libre (`port: 0`); nada de
 * esto es un mock. tickIntervalMs/decisionDeadlineMs se acortan respecto a producción
 * SOLO para que los tests no tarden minutos — el mecanismo es el mismo.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "./sim/battle.js";
import { initPhysics } from "./sim/physics.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "./fixtures.js";
import { HunterBot } from "./stubs.js";
import { ProtocolServer, type ExpectedBot } from "./protocol-server.js";
import { verify } from "./replay.js";

beforeAll(async () => {
  await initPhysics();
});

const servers: ProtocolServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) s.stop();
});

function track<T extends ProtocolServer | WebSocket>(x: T): T {
  if (x instanceof WebSocket) sockets.push(x);
  else servers.push(x as ProtocolServer);
  return x;
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** Cola de mensajes recibidos, parseados. */
function messageQueue(ws: WebSocket): { next: () => Promise<any>; all: any[] } {
  const pending: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const w = waiters.shift();
    if (w) w(msg);
    else pending.push(msg);
  });
  return {
    all: pending,
    next: () =>
      new Promise((resolve) => {
        if (pending.length > 0) resolve(pending.shift());
        else waiters.push(resolve);
      }),
  };
}

let seq = 0;
function send(ws: WebSocket, type: string, payload: unknown, tick?: number) {
  const msg: any = { proto: "arena/1", type, seq: seq++, payload };
  if (tick !== undefined) msg.tick = tick;
  ws.send(JSON.stringify(msg));
}

function makeExpected(botId: string, vehicleId: string, token = "t".repeat(16)): ExpectedBot {
  return { botId, vehicleId, battleToken: token };
}

async function makeBattle(ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 300 })) {
  return Battle.create({
    battleId: "proto_test_" + Math.random().toString(36).slice(2),
    seed: "protocol-server-test",
    ruleset,
    map: emptyArena(),
    participants: [
      { id: "veh_1", botId: "bot_ws1", team: "red", spec: scoutLoadout() },
      { id: "veh_2", botId: "bot_ws2", team: "blue", spec: gunnerLoadout() },
    ],
  });
}

describe("T5.1 · handshake", () => {
  it("HELLO con proto no soportado recibe SHUTDOWN protocol_version_unsupported y cierra", async () => {
    const battle = await makeBattle();
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1")],
      tickIntervalMs: 3, decisionDeadlineMs: 50,
    }));
    server.start();

    const ws = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await waitOpen(ws);
    const q = messageQueue(ws);
    ws.send(JSON.stringify({ proto: "arena/2", type: "HELLO", seq: 999, payload: { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) } }));

    const msg = await q.next();
    expect(msg.type).toBe("SHUTDOWN");
    expect(msg.payload.reason).toBe("protocol_version_unsupported");

    await new Promise((r) => setTimeout(r, 20));
    expect(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING).toBe(true);
    battle.free();
  });

  it("battleToken incorrecto recibe SHUTDOWN handshake_failed", async () => {
    const battle = await makeBattle();
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1", "correct-token-16char")],
      tickIntervalMs: 3, decisionDeadlineMs: 50,
    }));
    server.start();
    const ws = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await waitOpen(ws);
    const q = messageQueue(ws);
    send(ws, "HELLO", { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "wrong-token-16char!!" });
    const msg = await q.next();
    expect(msg.type).toBe("SHUTDOWN");
    expect(msg.payload.reason).toBe("handshake_failed");
    battle.free();
  });

  it("HELLO válido recibe WELCOME con timing/versions/vehicle coherentes", async () => {
    const battle = await makeBattle();
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1")],
      tickIntervalMs: 3, decisionDeadlineMs: 50,
    }));
    server.start();
    const ws = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await waitOpen(ws);
    const q = messageQueue(ws);
    send(ws, "HELLO", { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "arena-sdk-js", version: "0.1.0" }, battleToken: "t".repeat(16) });
    const msg = await q.next();
    expect(msg.type).toBe("WELCOME");
    expect(msg.payload.selfId).toBe("veh_1");
    expect(msg.payload.timing.decisionDeadlineMs).toBe(50);
    expect(msg.payload.timing.decisionEveryNTicks).toBe(3);
    expect(msg.payload.versions.protocol).toBe("arena/1");
    expect(msg.payload.versions.catalog).toBe("mvp@1");
    expect(msg.payload.vehicle.chassis.moduleId).toBe("chassis.light@1");
    battle.free();
  });

  it("un HELLO con forma inválida (botId con carácter no permitido) no deja al bot colgado: SHUTDOWN invalid_message tras el timeout de handshake", async () => {
    // Hallazgo real de T5.4: un botId con guion bajo tras el prefijo no matchea
    // ^bot_[0-9a-zA-Z]{1,24}$; sin este timeout, el mensaje se descarta (regla 4)
    // y la conexión queda abierta para siempre, sin ninguna señal para el bot.
    const battle = await makeBattle();
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1")],
      tickIntervalMs: 3, decisionDeadlineMs: 50, handshakeTimeoutMs: 100,
    }));
    server.start();
    const ws = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await waitOpen(ws);
    const q = messageQueue(ws);
    send(ws, "HELLO", { botId: "bot_con_guion_bajo", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) });

    const msg = await q.next();
    expect(msg.type).toBe("SHUTDOWN");
    expect(msg.payload.reason).toBe("invalid_message");
    battle.free();
  });
});

describe("T5.1 · timeouts y descalificación", () => {
  it("un bot que hace HELLO y jamás responde: la batalla termina y aparece en disqualified", async () => {
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 400, maxConsecutiveTimeouts: 5 });
    const battle = await makeBattle(ruleset);
    battle.attachBot("veh_2", new HunterBot("bot_2")); // el otro vehículo sí actúa
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1")],
      tickIntervalMs: 2, decisionDeadlineMs: 10,
    }));
    server.start();
    const ws = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await waitOpen(ws);
    const q = messageQueue(ws);
    send(ws, "HELLO", { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) });
    const welcome = await q.next();
    expect(welcome.type).toBe("WELCOME");
    // A partir de aquí, silencio absoluto: nunca respondemos a ninguna OBSERVATION.

    const result = await server.waitForResult();
    expect(result.disqualified).toContain("veh_1");
  }, 15000);
});

describe("T5.1 · un COMMAND por ciclo, y solo a tiempo", () => {
  it("un COMMAND que llega DESPUÉS del deadline no se aplica en ese tick", async () => {
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 60 });
    const battle = await makeBattle(ruleset);
    const server = track(new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1"), makeExpected("bot_ws2", "veh_2")],
      tickIntervalMs: 10, decisionDeadlineMs: 10,
    }));
    server.start();

    const ws1 = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    const ws2 = track(new WebSocket(`ws://127.0.0.1:${server.port}`));
    await Promise.all([waitOpen(ws1), waitOpen(ws2)]);
    const q1 = messageQueue(ws1);
    const q2 = messageQueue(ws2);
    send(ws1, "HELLO", { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) });
    send(ws2, "HELLO", { botId: "bot_ws2", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) });
    await q1.next();
    await q2.next();

    // veh_2 nunca manda comando de movimiento (queda quieto: control).
    // veh_1: a la primera OBSERVATION, responde DELIBERADAMENTE TARDE (25 ms > deadline 10 ms)
    // con throttle a fondo. Si el motor lo ignora, lastMove de veh_1 sigue en 0.
    const obs1 = await q1.next();
    expect(obs1.type).toBe("OBSERVATION");
    await new Promise((r) => setTimeout(r, 25));
    send(ws1, "COMMAND", { forTick: obs1.payload.tick + 3, move: { throttle: 1, steer: 0 } }, obs1.payload.tick + 3);

    // Esperamos a que el reloj interno procese unos cuantos ciclos más.
    await new Promise((r) => setTimeout(r, 150));

    const v1 = battle.getVehicle("veh_1")!;
    expect(v1.lastMove.throttle).toBe(0); // el comando tardío nunca llegó a aplicarse

    server.stop();
    battle.free();
  }, 10000);
});

describe("T5.1 · fuzzing: 1000 payloads corruptos no rompen el servidor ni desincronizan el hash", () => {
  /**
   * Ejecuta UNA batalla en vivo (WebSocket real) con bombardeo de payloads
   * corruptos, grabando los comandos realmente aplicados (`recordReplay: true`).
   * Devuelve el resultado y el Replay de esa misma ejecución.
   *
   * OJO: aquí NO se comparan dos ejecuciones en vivo entre sí. Dos ejecuciones
   * en vivo con la misma semilla NO tienen por qué dar el mismo hash: el jitter
   * real del transporte (ida-vuelta del socket vs. deadline) puede hacer que un
   * comando llegue a tiempo en una y tarde en la otra — y eso es comportamiento
   * CORRECTO del protocolo, no una desincronización. La garantía que sí exige el
   * protocolo es AUTOCONSISTENCIA: la ejecución en vivo, re-simulada desde su
   * cabecera con los comandos que el motor aplicó de verdad (incluidos los ticks
   * sin comando por timeout), debe reproducirse bit a bit. Eso lo comprueba
   * verify() de replay.ts — el mismo mecanismo que E2 usa en replay-golden.
   */
  async function runFuzzedLive(seed: string) {
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 150 });
    const battle = await Battle.create({
      battleId: "fuzz_" + seed,
      seed,
      ruleset,
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_ws1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "bot_2", team: "blue", spec: gunnerLoadout() },
      ],
      recordReplay: true,
    });
    battle.attachBot("veh_2", new HunterBot("bot_2"));

    const server = new ProtocolServer({
      battle, catalogVersion: "mvp@1",
      expected: [makeExpected("bot_ws1", "veh_1")],
      tickIntervalMs: 2, decisionDeadlineMs: 40,
    });

    // Handshake ANTES de arrancar el bucle: así el agente WebSocket está
    // enganchado desde el tick 0, igual que lo estará el ReplayAgent en la
    // re-simulación de verify(). (Si el bucle arrancara primero, los ticks de
    // decisión previos al WELCOME no tendrían agente para veh_1 y la
    // re-simulación no partiría de las mismas condiciones.)
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await waitOpen(ws);
    const q = messageQueue(ws);
    send(ws, "HELLO", { botId: "bot_ws1", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) });
    await q.next(); // WELCOME
    server.start();

    // Bot determinista: por cada OBSERVATION responde con el MISMO comando (función pura del tick).
    (async () => {
      for (;;) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msg = await q.next().catch(() => null);
        if (!msg) return;
        if (msg.type === "OBSERVATION") {
          send(ws, "COMMAND", { forTick: msg.payload.tick + 3, move: { throttle: 0.6, steer: 0.15 } }, msg.payload.tick + 3);
        }
        if (msg.type === "SHUTDOWN") return;
      }
    })();

    {
      const garbage = [
        () => "not even json {{{",
        () => JSON.stringify({ proto: "arena/1", type: "COMMAND" }), // sin seq/payload
        () => JSON.stringify({ proto: "arena/1", type: "COMMAND", seq: 1, tick: 1, payload: { forTick: "not-a-number" } }),
        () => JSON.stringify({ proto: "arena/1", type: "UNKNOWN_TYPE", seq: 1, payload: {} }),
        () => JSON.stringify({ proto: "arena/1", type: "COMMAND", seq: 1, tick: 1, payload: { forTick: 1, move: { throttle: 99 } } }),
        () => JSON.stringify({ proto: "arena/1", type: "COMMAND", seq: 1, tick: 1, payload: { forTick: 1, turret: { targetHeading: 0, targetPoint: { x: 1, y: 1 } } } }),
        () => JSON.stringify(null),
        () => JSON.stringify(42),
        () => JSON.stringify({ proto: "arena/1", type: "COMMAND", seq: 1, tick: 1, payload: { forTick: 1, fire: "not-an-array" } }),
      ];
      for (let i = 0; i < 1000; i++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(garbage[i % garbage.length]());
      }
    }

    const result = await server.waitForResult();
    const replay = server.getReplay();
    ws.close();
    server.stop();
    battle.free();
    return { result, replay };
  }

  it("la ejecución en vivo con fuzzing es autoconsistente: verify(replay) la reproduce bit a bit", async () => {
    const { result, replay } = await runFuzzedLive("fuzz-hash-check");

    // El servidor sobrevivió a los 1000 payloads corruptos: la batalla terminó
    // de verdad y produjo un hash final.
    expect(result.finalStateHash).toBeTruthy();
    expect(result.ticks).toBeGreaterThan(0);
    expect(replay.header.seed).toBe("fuzz-hash-check");
    expect(replay.stateHashes.length).toBeGreaterThan(0);

    // Autoconsistencia: re-simular el replay (comandos realmente aplicados)
    // reproduce exactamente los hashes intermedios y el resultado de la
    // ejecución en vivo. Si el fuzzing hubiera colado basura en el motor o
    // corrompido el estado, la re-simulación divergiría en un tick concreto.
    const v = await verify(replay);
    expect(v.divergedAtTick).toBeNull();
    expect(v.matches).toBe(true);
    expect(v.recomputedHash).toBe(result.finalStateHash);
  }, 30000);
});
