/**
 * R13.2 · REGRESSION LOCK — hardening del gateway de espectador (E8/T8.2).
 *
 * Tres candados de una superficie ya existente:
 *  - `maxPayload` en el WebSocketServer: el canal es de solo lectura para el
 *    cliente (nunca se procesan mensajes suyos), así que un frame entrante
 *    grande solo puede ser ruido/abuso; `ws` cierra con 1009 (message too big).
 *  - Límite de conexiones simultáneas por batalla: sin él, un enjambre de
 *    espectadores en una sola batalla agota memoria/handles del proceso; por
 *    encima del límite se rechaza con 4429 y las conexiones previas siguen
 *    vivas.
 *  - Ticket con `exp` vencido: el comportamiento ya era correcto
 *    (`verifySpectateTicket` + `close(4401)` en `handleConnection`), este test
 *    solo lo deja bajo candado de regresión.
 *
 * Usa `SpectateGateway` en un puerto efímero real (sin DB: la ruta HTTP que
 * emite tickets no participa aquí, se firman directamente con `signSpectateTicket`).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SpectateGateway, spectateProtocols, type SpectatableBattle } from "./gateway.js";
import { signSpectateTicket } from "../auth/tokens.js";

beforeAll(() => {
  // R1.4 (ERR-SEC-01): modo dev explícito, secreto efímero por proceso — igual
  // que el resto de tests que firman/verifican tokens en el mismo proceso.
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

function fakeBattle(): SpectatableBattle {
  return {
    snapshots: [],
    publicEvents: [],
    isFinished: () => false,
    getResult: () => null,
  };
}

const gateways: SpectateGateway[] = [];
function makeGateway(maxClientsPerBattle?: number): SpectateGateway {
  const gw = new SpectateGateway({ maxClientsPerBattle });
  gateways.push(gw);
  return gw;
}

const sockets: WebSocket[] = [];
function connect(port: number, battleId: string, ticket: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/spectate/${battleId}`, spectateProtocols(ticket));
  sockets.push(ws);
  return ws;
}

function ticketFor(battleId: string): string {
  return signSpectateTicket({ battleId, jti: randomUUID() }, 60);
}

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const gw of gateways.splice(0)) gw.close();
});

describe("R13.2 · REGRESSION LOCK — maxPayload del gateway de espectador", () => {
  it("un frame entrante sobredimensionado cierra la conexión con 1009", async () => {
    const battleId = "battle-r132-payload";
    const gateway = makeGateway();
    gateway.attachBattle(battleId, fakeBattle());

    const ws = connect(gateway.port, battleId, ticketFor(battleId));
    await once(ws, "open");

    // El canal es de solo lectura para el cliente: cualquier frame de este
    // tamaño (por encima de 64 KiB) es ruido, nunca protocolo legítimo.
    ws.send(Buffer.alloc(200 * 1024, 1));

    const [code] = (await once(ws, "close")) as [number, Buffer];
    expect(code).toBe(1009);
  });
});

describe("R13.2 · REGRESSION LOCK — límite de conexiones por batalla", () => {
  it("la conexión que supera el límite recibe 4429 y las previas siguen vivas", async () => {
    const battleId = "battle-r132-limit";
    const gateway = makeGateway(2);
    gateway.attachBattle(battleId, fakeBattle());

    const ws1 = connect(gateway.port, battleId, ticketFor(battleId));
    await once(ws1, "open");
    const ws2 = connect(gateway.port, battleId, ticketFor(battleId));
    await once(ws2, "open");

    const ws3 = connect(gateway.port, battleId, ticketFor(battleId));
    const [code] = (await once(ws3, "close")) as [number, Buffer];
    expect(code).toBe(4429);

    // Las dos conexiones previas no se ven afectadas por el rechazo de la tercera.
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
  });
});

describe("R13.2 · REGRESSION LOCK — ticket de espectador vencido", () => {
  it("un ticket con exp en el pasado se rechaza con close(4401)", async () => {
    const battleId = "battle-r132-expired";
    const gateway = makeGateway();
    gateway.attachBattle(battleId, fakeBattle());

    // TTL negativo ⇒ `exp` queda en el pasado desde el momento de la firma:
    // `verifySpectateTicket` lo rechaza como cualquier JWT expirado.
    const expired = signSpectateTicket({ battleId, jti: randomUUID() }, -10);

    const ws = connect(gateway.port, battleId, expired);
    const [code] = (await once(ws, "close")) as [number, Buffer];
    expect(code).toBe(4401);
  });
});
