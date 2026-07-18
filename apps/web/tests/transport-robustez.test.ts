/**
 * R3.2 · ERR-VIS-08 — Transporte robusto del visor: backoff exponencial con
 * jitter, fallo inicial enrutado al bucle de reconexión, watchdog de conexión
 * zombi, corte-y-restauración del gateway y buffer circular de eventos.
 *
 * El "gateway" de estas pruebas es un WebSocketServer REAL de `ws` en un puerto
 * efímero (el nivel de transporte de verdad, sin fingir sockets); la integración
 * completa con tickets firmados y batalla del motor ya la cubre
 * spectator.e2e.test.ts — aquí se prueba lo que aquel no puede: apagar y
 * volver a levantar el gateway EN EL MISMO PUERTO, y los tiempos del backoff.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import { backoffDelayMs, RingBuffer, SpectatorClient } from "../src/viewer/spectator-client.js";

function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15000, everyMs = 10): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const v = fn();
      if (v) {
        clearInterval(timer);
        resolve(v as T);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout esperando condición"));
      }
    }, everyMs);
  });
}

/** Mini-gateway: acepta cualquier conexión y emite init + snapshots a 10 Hz. */
class FakeGateway {
  wss: WebSocketServer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;

  start(port = 0): Promise<number> {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "init",
          serverTimeMs: Date.now(),
          snapshot: { tick: this.tick, vehicles: [], projectiles: [] },
          spectator: { allowFogView: false, delaySeconds: 0, debug: false },
          meta: {},
        }),
      );
    });
    this.timer = setInterval(() => {
      this.tick += 3;
      const msg = JSON.stringify({
        type: "snapshot",
        serverTimeMs: Date.now(),
        snapshot: { tick: this.tick, vehicles: [], projectiles: [] },
      });
      for (const c of this.wss?.clients ?? []) c.send(msg);
    }, 30);
    return new Promise((resolve) => this.wss!.once("listening", () => resolve((this.wss!.address() as any).port)));
  }

  /** Corte: tira todas las conexiones y deja de escuchar (puerto rechazando). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeClient(
  port: number,
  opts: Partial<ConstructorParameters<typeof SpectatorClient>[0]> = {},
): SpectatorClient {
  const c = new SpectatorClient({
    getTicket: async () => ({ ticket: "t", wsUrl: `ws://127.0.0.1:${port}/spectate/x` }),
    WebSocketImpl: WsWebSocket as unknown as typeof WebSocket,
    reconnectDelayMs: 40,
    reconnectMaxDelayMs: 400,
    maxReconnectAttempts: 40,
    ...opts,
  });
  cleanups.push(() => c.stop());
  return c;
}

// ───────────────────────────────────────────────── backoff exponencial + jitter

describe("backoffDelayMs: exponencial, con techo y jitter (sin estampida)", () => {
  it("crece 2× por intento hasta el techo", () => {
    const noJitter = () => 1; // extremo superior del sorteo = delay exponencial pleno
    expect(backoffDelayMs(1, 100, 10_000, noJitter)).toBe(100);
    expect(backoffDelayMs(2, 100, 10_000, noJitter)).toBe(200);
    expect(backoffDelayMs(5, 100, 10_000, noJitter)).toBe(1600);
    expect(backoffDelayMs(10, 100, 10_000, noJitter)).toBe(10_000); // techo
  });

  it("el jitter sortea uniformemente en [delay/2, delay]: dos clientes no reintentan a la vez", () => {
    expect(backoffDelayMs(3, 100, 10_000, () => 0)).toBe(200); // 400/2
    expect(backoffDelayMs(3, 100, 10_000, () => 0.5)).toBe(300);
    expect(backoffDelayMs(3, 100, 10_000, () => 1)).toBe(400);
    // Con aleatoriedad real, la dispersión existe (probabilísticamente trivial).
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(backoffDelayMs(3, 100, 10_000));
    expect(seen.size).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────────────── buffer circular

describe("RingBuffer: los eventos de una batalla larga no crecen sin límite", () => {
  it("conserva los N más recientes, en orden", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    expect(rb.toArray()).toEqual([1, 2]);
    rb.push(3);
    rb.push(4); // expulsa al 1
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it("capacidad inválida ⇒ error; clear vacía", () => {
    expect(() => new RingBuffer(0)).toThrow();
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.clear();
    expect(rb.toArray()).toEqual([]);
  });

  it("el cliente acota state.events a maxBufferedEvents", async () => {
    const gw = new FakeGateway();
    const port = await gw.start();
    cleanups.push(() => gw.stop());
    const c = makeClient(port, { maxBufferedEvents: 5 });
    await c.connect();
    await waitFor(() => c.state.connected);
    // 20 eventos por el canal: solo quedan los 5 últimos.
    for (const ws of gw.wss!.clients) {
      for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: "event", event: { tick: i, kind: "e" } }));
    }
    await waitFor(() => c.state.events.length === 5 && c.state.events.toArray().at(-1)!.tick === 19);
    expect(c.state.events.toArray().map((e) => e.tick)).toEqual([15, 16, 17, 18, 19]);
  });
});

// ─────────────────────────────── reconexión: corte y restauración del gateway

describe("SpectatorClient: corte y restauración del gateway (ERR-VIS-08)", () => {
  it("el FALLO INICIAL entra al bucle de reconexión: gateway caído al arrancar ⇒ conecta cuando vuelve", async () => {
    const gw = new FakeGateway();
    cleanups.push(() => gw.stop());
    // Puerto reservado y CERRADO: la primera conexión falla seguro.
    const probe = new FakeGateway();
    const port = await probe.start();
    await probe.stop();

    const c = makeClient(port);
    const scheduled: { attempt: number; delayMs: number }[] = [];
    c.on("reconnect_scheduled", (s) => scheduled.push(s));
    await c.connect(); // NO lanza: enruta el fallo al bucle
    await waitFor(() => scheduled.length >= 3);
    expect(c.state.connected).toBe(false);

    // El gateway "vuelve" en el mismo puerto: el visor conecta él solo.
    await gw.start(port);
    await waitFor(() => c.state.connected && c.state.snapshot);
    expect(c.state.serverTimeMs).toBeTypeOf("number");
  }, 30000);

  it("corte a mitad de stream ⇒ reintentos con backoff creciente y jitter, reconexión al restaurar", async () => {
    const gw = new FakeGateway();
    const port = await gw.start();
    cleanups.push(() => gw.stop());
    const c = makeClient(port);
    const scheduled: { attempt: number; delayMs: number }[] = [];
    c.on("reconnect_scheduled", (s) => scheduled.push(s));
    let reconnected = false;
    c.on("reconnected", () => (reconnected = true));
    await c.connect();
    await waitFor(() => c.state.connected && c.state.snapshot);
    const tickBeforeCut = c.state.snapshot.tick;

    await gw.stop(); // corte TOTAL: conexiones fuera y puerto cerrado
    await waitFor(() => scheduled.length >= 4, 20000);
    // Backoff creciente: la base exponencial de cada intento dobla la anterior
    // (cada delay sorteado vive en [2^(n-1)·base/2, 2^(n-1)·base], hasta el techo).
    for (const [i, s] of scheduled.entries()) {
      const exp = Math.min(400, 40 * Math.pow(2, s.attempt - 1));
      expect(s.attempt).toBe(i + 1);
      expect(s.delayMs).toBeGreaterThanOrEqual(exp / 2);
      expect(s.delayMs).toBeLessThanOrEqual(exp);
    }
    expect(scheduled[2].delayMs).toBeGreaterThan(scheduled[0].delayMs); // crece de verdad

    await gw.start(port); // restauración en el MISMO puerto
    await waitFor(() => reconnected && c.state.connected && c.state.snapshot.tick >= tickBeforeCut, 20000);
    expect(c.state.reconnects).toBeGreaterThanOrEqual(1);
  }, 40000);

  it("watchdog: un stream mudo (conexión zombi) fuerza el cierre y la reconexión", async () => {
    // Gateway que acepta la conexión y NO envía nada nunca (zombi desde el open).
    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((r) => wss.once("listening", () => r((wss.address() as any).port)));
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));

    const c = makeClient(port, { watchdogTimeoutMs: 200 });
    let disconnects = 0;
    c.on("disconnect", () => disconnects++);
    const scheduled: any[] = [];
    c.on("reconnect_scheduled", (s) => scheduled.push(s));
    await c.connect();
    await waitFor(() => c.state.connected);
    // Sin ningún mensaje en 200 ms ⇒ el watchdog corta y se programa reconexión.
    await waitFor(() => disconnects >= 1 && scheduled.length >= 1, 10000);
    expect(c.state.connected).toBe(false);
  }, 20000);
});
