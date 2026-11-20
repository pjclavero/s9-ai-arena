/**
 * UX-06 / G-13 · Diagnóstico de transporte por bot del ProtocolServer.
 *
 * Antes un COMMAND que no validaba contra el esquema se descartaba EN SILENCIO
 * (`if (!envelopeValidator()(msg)) return;`): el bot acababa descalificado por
 * timeouts sin saber por qué, y nadie lo contaba. Ahora:
 *  - se cuenta (`invalidCommands`, `firstInvalidReason`),
 *  - el bot recibe `EVENT rejected_action` con `reason: "invalid_command: …"`,
 *  - y el servidor expone `protocolDiagnostics()` con HELLO, comandos
 *    recibidos, tardíos y desconexión.
 * WebSocket real contra un ProtocolServer real (sin mocks), como protocol-server.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "./sim/battle.js";
import { initPhysics } from "./sim/physics.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "./fixtures.js";
import { HunterBot } from "./stubs.js";
import { ProtocolServer } from "./protocol-server.js";

beforeAll(async () => {
  await initPhysics();
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

let seq = 0;
function send(ws: WebSocket, type: string, payload: any) {
  const msg: any = { proto: "arena/1", type, seq: seq++, payload };
  if (type === "COMMAND") msg.tick = payload.forTick; // el envelope de ciclo exige tick
  ws.send(JSON.stringify(msg));
}

async function setup(timeLimitTicks = 240) {
  const battle = await Battle.create({
    battleId: "diag_" + Math.random().toString(36).slice(2),
    seed: "protocol-diagnostics",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks }),
    map: emptyArena(),
    participants: [
      { id: "veh_1", botId: "bot_ws1", team: "red", spec: scoutLoadout() },
      { id: "veh_2", botId: "bot_ws2", team: "blue", spec: gunnerLoadout() },
    ],
  });
  battle.attachBot("veh_2", new HunterBot("bot_2"));
  const server = new ProtocolServer({
    battle,
    catalogVersion: "mvp@1",
    expected: [
      { botId: "bot_ws1", vehicleId: "veh_1", battleToken: "t".repeat(16) },
      { botId: "bot_ws9", vehicleId: "veh_9", battleToken: "u".repeat(16) },
    ],
    tickIntervalMs: 5,
    decisionDeadlineMs: 40,
  });
  cleanup.push(() => server.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  cleanup.push(() => ws.close());
  const received: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    received.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const waitFor = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const hit = received.find(pred);
      if (hit) resolve(hit);
      else waiters.push({ pred, resolve });
    });
  await new Promise<void>((r, j) => {
    ws.once("open", () => r());
    ws.once("error", j);
  });
  return { battle, server, ws, received, waitFor };
}

describe("UX-06 · ProtocolServer cuenta y explica lo que descarta", () => {
  it("COMMAND con forma inválida: se cuenta, se avisa con invalid_command y no se aplica", async () => {
    const { server, ws, waitFor } = await setup();
    send(ws, "HELLO", {
      botId: "bot_ws1",
      botVersion: "1.0.0",
      sdk: { name: "custom", version: "0" },
      battleToken: "t".repeat(16),
    });
    await waitFor((m) => m.type === "WELCOME");
    server.start();
    const obs = await waitFor((m) => m.type === "OBSERVATION");
    // throttle fuera de [-1, 1]: el esquema lo rechaza.
    send(ws, "COMMAND", { forTick: obs.payload.tick + 3, move: { throttle: 5, steer: 0 } });
    send(ws, "COMMAND", { forTick: obs.payload.tick + 3, move: { throttle: 7, steer: 0 } });
    const ev = await waitFor(
      (m) =>
        m.type === "EVENT" &&
        m.payload.kind === "rejected_action" &&
        String(m.payload.reason).startsWith("invalid_command"),
    );
    expect(ev.payload.reason).toMatch(/^invalid_command: \/move\/throttle maximum$/);
    expect(ev.payload.reason.length).toBeLessThanOrEqual(64);

    await expect.poll(() => server.protocolDiagnostics().veh_1.invalidCommands).toBe(2);
    const d = server.protocolDiagnostics();
    expect(d.veh_1.helloOk).toBe(true);
    expect(d.veh_1.helloTick).toBe(0);
    expect(d.veh_1.firstInvalidReason).toBe("/move/throttle maximum");

    // Sin `tick` en el envelope: el motivo nombra la propiedad que falta.
    ws.send(JSON.stringify({ proto: "arena/1", type: "COMMAND", seq: seq++, payload: { forTick: 3 } }));
    await expect.poll(() => server.protocolDiagnostics().veh_1.invalidCommands).toBe(3);
    // Un COMMAND inválido no es un comando recibido: no llegó a la ventana.
    expect(d.veh_1.commandsReceived).toBe(0);
    // El bot esperado que nunca llegó: helloOk false, nada contado.
    expect(d.veh_9).toMatchObject({ helloOk: false, helloTick: null, invalidCommands: 0 });
  }, 15000);

  it("COMMAND válido tardío, JSON roto y desconexión en mitad de la batalla quedan contados", async () => {
    const { battle, server, ws, waitFor } = await setup(600);
    send(ws, "HELLO", {
      botId: "bot_ws1",
      botVersion: "1.0.0",
      sdk: { name: "custom", version: "0" },
      battleToken: "t".repeat(16),
    });
    await waitFor((m) => m.type === "WELCOME");
    server.start();
    const obs = await waitFor((m) => m.type === "OBSERVATION");
    ws.send("{no-es-json");
    // forTick de un ciclo que no es el abierto.
    send(ws, "COMMAND", { forTick: obs.payload.tick + 999, move: { throttle: 1, steer: 0 } });
    await expect
      .poll(() => {
        const d = server.protocolDiagnostics().veh_1;
        return d.invalidJson + d.wrongTickCommands + d.lateCommands;
      })
      .toBeGreaterThanOrEqual(2);
    const d1 = server.protocolDiagnostics().veh_1;
    expect(d1.invalidJson).toBe(1);
    expect(d1.commandsReceived).toBe(1);
    expect(d1.wrongTickCommands + d1.lateCommands).toBe(1);

    const disconnected = new Promise<string>((r) => server.onDisconnect(r));
    ws.close();
    expect(await disconnected).toBe("veh_1");
    const d2 = server.protocolDiagnostics().veh_1;
    expect(d2.disconnectedAtTick).not.toBeNull();
    expect(d2.disconnectedAtTick!).toBeGreaterThanOrEqual(0);
    expect(battle.isFinished()).toBe(false);
  }, 15000);
});
