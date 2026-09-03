/**
 * Carril J · FAIL-CLOSED del canal de espectador (gate de activación).
 *
 * Hallazgo que motiva estas pruebas: `S9_PUBLIC_SPECTATE_ENABLED` gobernaba solo
 * los endpoints REST `/public/*`. El canal REAL de espectador —el WebSocket del
 * gateway— NO lo consultaba en ningún punto, y el endpoint que emite tickets
 * (`POST /battles/{id}/spectate-ticket`) es `security: []`, así que con la puerta
 * APAGADA un visitante anónimo podía obtener un ticket válido y abrir el canal en
 * vivo. La puerta "apagada" no cerraba nada del canal.
 *
 * Estos tests fijan el invariante en el proceso del GATEWAY (la segunda línea de
 * defensa, que vive en el tournament-worker, no en la API). Son de propósito
 * PUROS —sin BD— para que corran en cualquier entorno; la mitad del invariante
 * que vive en la ruta HTTP está en `apps/api/src/j-fail-closed-ticket.test.ts`.
 *
 * MUTACIÓN de calibración (documentada para que cualquiera pueda repetirla):
 * borrar el bloque `claims.anon === true && !this.publicSpectateEnabled` de
 * `gateway.ts`, o cambiar el default de `publicSpectateEnabled` a `true`, pone en
 * ROJO los casos de "puerta apagada". Sin esa comprobación estos tests fallan.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SpectateGateway, spectateProtocols, type SpectatableBattle } from "./gateway.js";
import { signSpectateTicket } from "../auth/tokens.js";
import { publicSpectateEnabledFromEnv } from "../public-spectate.js";

beforeAll(() => {
  // R1.4 (ERR-SEC-01): modo dev explícito, secreto efímero por proceso.
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

/** Batalla en vivo con contenido REAL en los arrays públicos: si el canal sirve
 *  algo, el test lo verá; un feed vacío no distinguiría "cerrado" de "sin datos". */
function liveBattle(): SpectatableBattle {
  return {
    snapshots: [{ tick: 7, vehicles: [], projectiles: [], score: {}, objectives: [] }],
    publicEvents: [{ kind: "spawn", tick: 0 }],
    isFinished: () => false,
    getResult: () => null,
  };
}

const gateways: SpectateGateway[] = [];
function makeGateway(publicSpectateEnabled: boolean): SpectateGateway {
  const gw = new SpectateGateway({ publicSpectateEnabled });
  gateways.push(gw);
  return gw;
}

const sockets: WebSocket[] = [];
function connect(port: number, battleId: string, ticket: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/spectate/${battleId}`, spectateProtocols(ticket));
  sockets.push(ws);
  return ws;
}

/** Resultado observable de un intento: o llega el primer mensaje, o cierra con código. */
async function attempt(ws: WebSocket): Promise<{ served: true; msg: any } | { served: false; code: number }> {
  return await new Promise((resolve) => {
    ws.once("message", (d) => resolve({ served: true, msg: JSON.parse(d.toString()) }));
    ws.once("close", (code) => resolve({ served: false, code }));
    ws.once("error", () => resolve({ served: false, code: -1 }));
  });
}

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const gw of gateways.splice(0)) gw.close();
});

describe("Carril J · el gateway NO sirve espectador público con la capability apagada", () => {
  it("un ticket ANÓNIMO criptográficamente válido NO abre el canal: close(4403) y CERO datos", async () => {
    const gw = makeGateway(false);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true }, 60);

    const r = await attempt(connect(gw.port, battleId, ticket));
    expect(r.served, "con la puerta apagada el canal sirvió datos a un anónimo").toBe(false);
    expect((r as { code: number }).code).toBe(4403);
  });

  it("el rechazo NO distingue una batalla en directo de un id inexistente (no filtra existencia)", async () => {
    const gw = makeGateway(false);
    const vivo = randomUUID();
    const inexistente = randomUUID();
    gw.attachBattle(vivo, liveBattle());

    const a = await attempt(
      connect(gw.port, vivo, signSpectateTicket({ battleId: vivo, jti: randomUUID(), anon: true }, 60)),
    );
    const b = await attempt(
      connect(gw.port, inexistente, signSpectateTicket({ battleId: inexistente, jti: randomUUID(), anon: true }, 60)),
    );
    expect(a).toEqual(b);
  });

  it("el ticket anónimo rechazado NO quema su jti de forma que enmascare la puerta: sigue siendo 4403 al reintentar", async () => {
    const gw = makeGateway(false);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true }, 60);

    const primero = await attempt(connect(gw.port, battleId, ticket));
    const segundo = await attempt(connect(gw.port, battleId, ticket));
    expect(primero).toEqual({ served: false, code: 4403 });
    // Nunca "ticket_already_used" (4403 también) sirviendo antes datos: lo que
    // importa es que en NINGÚN intento se sirvió nada.
    expect(segundo.served).toBe(false);
  });

  it("MUTANTE M2 · el DEFAULT de producción (sin opción explícita, sin variable) cierra igual", async () => {
    // El resto de casos inyecta la capability; este NO: construye el gateway como
    // lo hace el tournament-worker en producción (`new SpectateGateway({ port })`)
    // con la variable AUSENTE del entorno. Sin este caso, cambiar el default a
    // `true` pasaría la suite entera — se comprobó ejecutando esa mutación.
    const previo = process.env.S9_PUBLIC_SPECTATE_ENABLED;
    delete process.env.S9_PUBLIC_SPECTATE_ENABLED;
    try {
      const gw = new SpectateGateway();
      gateways.push(gw);
      const battleId = randomUUID();
      gw.attachBattle(battleId, liveBattle());
      const r = await attempt(
        connect(gw.port, battleId, signSpectateTicket({ battleId, jti: randomUUID(), anon: true }, 60)),
      );
      expect(r).toEqual({ served: false, code: 4403 });
    } finally {
      if (previo !== undefined) process.env.S9_PUBLIC_SPECTATE_ENABLED = previo;
    }
  });

  it("el default del gateway sale del entorno y el entorno sin la variable está APAGADO", () => {
    expect(publicSpectateEnabledFromEnv({})).toBe(false);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "0" })).toBe(false);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "no" })).toBe(false);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "1" })).toBe(true);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "TRUE" })).toBe(true);
  });

  it("un ticket anónimo FALSIFICADO (firmado con otro secreto) tampoco pasa, con la puerta encendida", async () => {
    const gw = makeGateway(true);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    // JWT con la misma forma pero firmado con un secreto ajeno.
    const jwt = (await import("jsonwebtoken")).default;
    const falso = jwt.sign({ battleId, anon: true }, "secreto-del-atacante", {
      algorithm: "HS256",
      jwtid: randomUUID(),
      expiresIn: 60,
      issuer: "s9-ai-arena",
      audience: "s9-arena/spectate",
    });
    const r = await attempt(connect(gw.port, battleId, falso));
    expect(r).toEqual({ served: false, code: 4401 });
  });

  it("un ticket anónimo CADUCADO no pasa ni con la puerta encendida", async () => {
    const gw = makeGateway(true);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const vencido = signSpectateTicket({ battleId, jti: randomUUID(), anon: true }, -10);
    const r = await attempt(connect(gw.port, battleId, vencido));
    expect(r).toEqual({ served: false, code: 4401 });
  });
});

describe("Carril J · control POSITIVO: la puerta encendida SÍ sirve el canal (el test puede ponerse rojo)", () => {
  it("el mismo ticket anónimo que fallaba abre el canal y recibe init con el snapshot público", async () => {
    const gw = makeGateway(true);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true }, 60);

    const r = await attempt(connect(gw.port, battleId, ticket));
    expect(r.served).toBe(true);
    const msg = (r as { msg: any }).msg;
    expect(msg.type).toBe("init");
    expect(msg.snapshot.tick).toBe(7);
    // El init nunca concede depuración a un ticket sin `debug` firmado.
    expect(msg.spectator.debug).toBe(false);
  });
});

describe("Carril J · el espectador AUTENTICADO no depende de la capability pública", () => {
  it("un ticket SIN el flag anon abre el canal aunque la puerta pública esté apagada", async () => {
    const gw = makeGateway(false);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const ticket = signSpectateTicket({ battleId, jti: randomUUID() }, 60);

    const r = await attempt(connect(gw.port, battleId, ticket));
    expect(r.served, "el espectador interno autenticado no debe quedar bloqueado por la puerta PÚBLICA").toBe(true);
  });

  it("el cliente NO puede autoconcederse el flag: `anon` lo firma la API, y un ticket ajeno no valida", async () => {
    // Un atacante no puede fabricar un ticket "no anónimo": necesitaría el
    // secreto de espectador. Este caso lo demuestra con la puerta APAGADA, que es
    // el estado en el que el flag decide.
    const gw = makeGateway(false);
    const battleId = randomUUID();
    gw.attachBattle(battleId, liveBattle());
    const jwt = (await import("jsonwebtoken")).default;
    const falso = jwt.sign({ battleId }, "secreto-del-atacante", {
      algorithm: "HS256",
      jwtid: randomUUID(),
      expiresIn: 60,
      issuer: "s9-ai-arena",
      audience: "s9-arena/spectate",
    });
    const r = await attempt(connect(gw.port, battleId, falso));
    expect(r).toEqual({ served: false, code: 4401 });
  });
});
