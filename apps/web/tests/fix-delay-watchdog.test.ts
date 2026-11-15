/**
 * FIX-DELAY · Watchdog del visor frente al directo con retardo anti-coaching.
 *
 * Defecto demostrado en producción (2026-11-15, torneo con delaySeconds=30): el
 * gateway retiene snapshots y eventos 30 s, el watchdog del cliente cerraba a los
 * 10 s sin mensajes y reconectaba en bucle; la emisión se quedaba en el tick 0.
 *
 * Reloj FALSO (vi.useFakeTimers: setTimeout/setInterval/Date) y un WebSocket
 * falso que el test gobierna, para simular 30-60 s de espera de forma
 * determinista. El transporte real (gateway + ws) está en
 * apps/api/src/spectate/fix-delay-heartbeat.test.ts y en spectator.e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpectatorClient } from "../src/viewer/spectator-client.js";
import { announcedDelayMs, delayedWaitText } from "../src/viewer/delay-wait.js";

type Server = (ws: FakeWs) => void;

/** WebSocket falso: abre en el siguiente macrotick y el "servidor" del test le habla. */
class FakeWs {
  static instances: FakeWs[] = [];
  static server: Server = () => undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWs.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      FakeWs.server(this);
    }, 0);
  }
  /** El servidor envía un mensaje (si la conexión sigue abierta). */
  push(msg: Record<string, unknown>): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ v: 1, ...msg }) });
  }
  at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }
  every(ms: number, fn: () => void, untilMs = Infinity): void {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (Date.now() - t0 > untilMs) return clearInterval(t);
      fn();
    }, ms);
    this.timers.push(t as unknown as ReturnType<typeof setTimeout>);
  }
  send(): void {}
  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    for (const t of this.timers) clearTimeout(t);
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
  }
}

const DELAY_MS = 30_000;

function init(delayMs: number, snapshot: unknown = null) {
  return {
    type: "init",
    serverTimeMs: Date.now() - delayMs,
    spectator: {
      allowFogView: false,
      delaySeconds: delayMs / 1000,
      delayMs,
      heartbeatIntervalMs: delayMs > 0 ? 1000 : 0,
      debug: false,
    },
    meta: {},
    snapshot,
    finished: false,
  };
}
const beat = (delayMs = DELAY_MS) => ({
  type: "heartbeat",
  serverTimeMs: Date.now(),
  delayMs,
  bufferedUntil: Date.now() - delayMs,
});
const snap = (tick: number) => ({ type: "snapshot", serverTimeMs: Date.now() - DELAY_MS, snapshot: { tick, vehicles: [] } });

function makeClient(opts: Partial<ConstructorParameters<typeof SpectatorClient>[0]> = {}) {
  let tickets = 0;
  const c = new SpectatorClient({
    getTicket: async () => {
      tickets++;
      return { ticket: `t${tickets}`, wsUrl: "ws://gw.test/spectate/b" };
    },
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    reconnectDelayMs: 200,
    random: () => 0.5,
    ...opts,
  });
  const ev = { disconnects: 0, snapshots: [] as number[], heartbeats: 0 };
  c.on("disconnect", () => ev.disconnects++);
  c.on("snapshot", (s) => ev.snapshots.push(s.tick));
  c.on("heartbeat", () => ev.heartbeats++);
  return { c, ev, tickets: () => tickets };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.instances = [];
  FakeWs.server = () => undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FIX-DELAY · el watchdog no confunde el directo diferido con una conexión zombi", () => {
  it("delay=30 s con latidos: NO reconecta durante la espera y recibe el primer snapshot a los 30 s", async () => {
    FakeWs.server = (ws) => {
      ws.push(init(DELAY_MS));
      ws.every(1000, () => ws.push(beat()));
      ws.at(DELAY_MS, () => ws.push(snap(1)));
      ws.every(100, () => undefined); // (nada más: sólo latidos y el stream diferido)
    };
    const { c, ev, tickets } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(DELAY_MS + 500);
    expect(ev.disconnects, "reconectó durante la espera del retardo").toBe(0);
    expect(tickets()).toBe(1);
    expect(FakeWs.instances.length).toBe(1);
    expect(ev.heartbeats).toBeGreaterThanOrEqual(29);
    expect(ev.snapshots).toEqual([1]);
    expect(c.state.connected).toBe(true);
    c.stop();
  });

  it("con latidos, una espera MÁS LARGA que retardo + margen (batalla que tarda en producir) tampoco reconecta", async () => {
    // P. ej. bots arrancando: el primer snapshot se produce a los 30 s ⇒ llega a los 60 s.
    FakeWs.server = (ws) => {
      ws.push(init(DELAY_MS));
      ws.every(1000, () => ws.push(beat()));
      ws.at(60_000, () => ws.push(snap(1)));
    };
    const { c, ev, tickets } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ev.disconnects).toBe(0);
    expect(tickets()).toBe(1);
    expect(ev.snapshots).toEqual([1]);
    c.stop();
  });

  it("cinturón: gateway SIN latidos que anuncia retardo ⇒ tolera retardo + margen antes de dar la conexión por zombi", async () => {
    FakeWs.server = (ws) => {
      ws.push(init(DELAY_MS));
      ws.at(DELAY_MS, () => ws.push(snap(1)));
    };
    const { c, ev, tickets } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(DELAY_MS + 500);
    expect(ev.disconnects, "el watchdog de 10 s cortó la espera del retardo").toBe(0);
    expect(tickets()).toBe(1);
    expect(ev.snapshots).toEqual([1]);
    c.stop();
  });

  it("el watchdog SIGUE detectando una conexión zombi real: los latidos se apagan ⇒ reconecta con el umbral normal", async () => {
    FakeWs.server = (ws) => {
      if (FakeWs.instances.length > 1) return; // la reconexión: no importa lo que haga
      ws.push(init(DELAY_MS));
      ws.every(1000, () => ws.push(beat()), 4000); // late 4 s y se calla (NAT caído)
    };
    const { c, ev, tickets } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    // Último latido ≈ 4 s; umbral 10 s + sondeo 2,5 s ⇒ cortado antes de los ~17 s,
    // MUCHO antes de retardo + margen (35 s).
    await vi.advanceTimersByTimeAsync(18_000);
    expect(ev.disconnects, "la conexión zombi no se detectó").toBeGreaterThanOrEqual(1);
    expect(tickets()).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it("zombi sin ningún mensaje tras el init con retardo: también acaba reconectando (pasado retardo + margen)", async () => {
    FakeWs.server = (ws) => {
      if (FakeWs.instances.length === 1) ws.push(init(DELAY_MS));
    };
    const { c, ev } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(DELAY_MS + 5000 + 3000);
    expect(ev.disconnects).toBeGreaterThanOrEqual(1);
    c.stop();
  });

  it("delay=0: comportamiento de siempre — sin mensajes en el umbral ⇒ zombi y reconexión, sin margen extra", async () => {
    FakeWs.server = (ws) => {
      if (FakeWs.instances.length === 1) ws.push(init(0, { tick: 5, vehicles: [] }));
    };
    const { c, ev, tickets } = makeClient({ watchdogTimeoutMs: 2000 });
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(3000);
    expect(ev.disconnects).toBeGreaterThanOrEqual(1);
    expect(tickets()).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it("delay=0 con stream normal: sin latidos, sin reconexiones, snapshots al ritmo de siempre", async () => {
    FakeWs.server = (ws) => {
      ws.push(init(0, { tick: 0, vehicles: [] }));
      let t = 0;
      ws.every(100, () => ws.push({ type: "snapshot", serverTimeMs: Date.now(), snapshot: { tick: ++t, vehicles: [] } }));
    };
    const { c, ev, tickets } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ev.disconnects).toBe(0);
    expect(tickets()).toBe(1);
    expect(ev.heartbeats).toBe(0);
    expect(ev.snapshots.length).toBeGreaterThan(100);
    c.stop();
  });

  it("el latido no pisa serverTimeMs (que fecha el stream diferido) y queda en state.heartbeat", async () => {
    FakeWs.server = (ws) => {
      ws.push(init(DELAY_MS));
      ws.at(500, () => ws.push(beat()));
    };
    const { c } = makeClient();
    void c.connect(); // el open llega por el reloj falso: no se espera aquí
    await vi.advanceTimersByTimeAsync(10);
    const fromInit = c.state.serverTimeMs;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.state.serverTimeMs).toBe(fromInit);
    expect(c.state.heartbeat?.delayMs).toBe(DELAY_MS);
    expect(c.state.heartbeat!.serverTimeMs - c.state.heartbeat!.bufferedUntil!).toBe(DELAY_MS);
    c.stop();
  });
});

describe("FIX-DELAY · rótulo de espera (puro)", () => {
  it("con retardo y sin imagen ⇒ «Directo con retardo de 30 s…»; con imagen o sin retardo ⇒ nada", () => {
    expect(delayedWaitText({ delaySeconds: 30 }, false)).toMatch(/^Directo con retardo de 30 s/);
    expect(delayedWaitText({ delayMs: 30_000, delaySeconds: 30 }, false)).toMatch(/30 s/);
    expect(delayedWaitText({ delaySeconds: 30 }, true)).toBeNull();
    expect(delayedWaitText({ delaySeconds: 0 }, false)).toBeNull();
    expect(delayedWaitText(null, false)).toBeNull();
    expect(announcedDelayMs({ delaySeconds: Number.NaN })).toBe(0);
    expect(announcedDelayMs({ delaySeconds: -3 })).toBe(0);
  });
});
