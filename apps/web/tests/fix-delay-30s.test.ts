/**
 * FIX-DELAY · Extremo a extremo a ESCALA REAL (30 s) con reloj falso:
 * SpectateGateway REAL (apps/api) + SpectatorClient REAL (apps/web) con su
 * watchdog de siempre (10 s), unidos por un puente WebSocket en memoria.
 *
 * Reproduce la prueba de aceptación de producción (2026-11-15, torneo con
 * delaySeconds=30): antes del arreglo, el visor recibía el init, el canal quedaba
 * mudo 30 s, el watchdog cerraba a los ~10-13 s y reconectaba en bucle, sin
 * llegar nunca al primer snapshot. Gates: SPECTATOR_DELAY_HEARTBEAT,
 * WATCHDOG_WITH_DELAY, DELAY_ZERO_REGRESSION, ANTI_COACHING_NOT_BYPASSED.
 *
 * El transporte ws real (puertos efímeros) lo cubren
 * apps/api/src/spectate/fix-delay-heartbeat.test.ts y spectator.e2e.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { SpectateGateway, type SpectatableBattle } from "../../api/src/spectate/gateway.js";
import { signSpectateTicket } from "../../api/src/auth/tokens.js";
import { SpectatorClient } from "../src/viewer/spectator-client.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

const DELAY_MS = 30_000;
const BATTLE = "btl-fix-delay";

/** Lado servidor del puente: lo que el gateway cree que es un `ws`. */
class ServerSide {
  readyState = 1; // WebSocket.OPEN
  private handlers = new Map<string, (() => void)[]>();
  /** «Agujero negro»: el gateway escribe pero nada llega (gateway sin respuesta). */
  blackhole = false;
  constructor(private readonly client: BridgeWs) {}
  send(payload: string): void {
    if (this.blackhole || this.readyState !== 1) return;
    this.client.deliver(payload);
  }
  on(ev: string, fn: () => void): void {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  fire(ev: string): void {
    for (const fn of this.handlers.get(ev) ?? []) fn();
  }
  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.fire("close");
    this.client.closedByServer(code ?? 1000, reason ?? "");
  }
}

let gw: SpectateGateway;
const servers: ServerSide[] = [];

/** Lado cliente del puente: lo que el SpectatorClient cree que es un WebSocket. */
class BridgeWs {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private server: ServerSide | null = null;
  constructor(url: string, protocols: string[]) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.server = new ServerSide(this);
      servers.push(this.server);
      const path = new URL(url).pathname;
      gw.wss.emit("connection", this.server, {
        url: path,
        headers: { "sec-websocket-protocol": protocols.join(", ") },
      });
    }, 0);
  }
  deliver(payload: string): void {
    if (this.readyState === 1) this.onmessage?.({ data: payload });
  }
  closedByServer(code: number, reason: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    void Promise.resolve().then(() => this.onclose?.({ code, reason }));
  }
  send(): void {}
  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    if (this.server && this.server.readyState === 1) {
      this.server.readyState = 3;
      this.server.fire("close");
    }
    void Promise.resolve().then(() => this.onclose?.({ code: 1000, reason: "" }));
  }
}

/** Batalla a 10 Hz con estado reconocible (posición, hp) y eventos periódicos. */
function liveBattle() {
  const producedAt = new Map<number, number>();
  const battle: SpectatableBattle = { snapshots: [], publicEvents: [], isFinished: () => false, getResult: () => null };
  let tick = 0;
  setInterval(() => {
    tick++;
    producedAt.set(tick, Date.now());
    battle.snapshots.push({ tick, vehicles: [{ id: "v_red", position: { x: tick, y: tick }, hp: 1000 - tick }] });
    if (tick % 10 === 0) battle.publicEvents.push({ type: "score", tick, team: "red" });
  }, 100);
  return { battle, producedAt, tick: () => tick };
}

function spectator() {
  let tickets = 0;
  const c = new SpectatorClient({
    getTicket: async () => {
      tickets++;
      return {
        ticket: signSpectateTicket({ battleId: BATTLE, jti: randomUUID(), anon: true } as any, 60),
        wsUrl: `ws://gw.test/spectate/${BATTLE}`,
      };
    },
    WebSocketImpl: BridgeWs as unknown as typeof WebSocket,
    reconnectDelayMs: 500,
    random: () => 0.5,
    // watchdogTimeoutMs: el de SIEMPRE (10 s). No se toca.
  });
  const ev = {
    disconnects: 0,
    heartbeats: 0,
    inits: [] as any[],
    snapshots: [] as { tick: number; at: number }[],
    events: [] as { tick: number; at: number }[],
  };
  c.on("disconnect", () => ev.disconnects++);
  c.on("heartbeat", () => ev.heartbeats++);
  c.on("init", (m) => ev.inits.push(m));
  c.on("snapshot", (s) => ev.snapshots.push({ tick: s.tick, at: Date.now() }));
  c.on("event", (e) => ev.events.push({ tick: e.tick, at: Date.now() }));
  return { c, ev, tickets: () => tickets };
}

beforeEach(() => {
  vi.useFakeTimers();
  servers.length = 0;
  gw = new SpectateGateway({ wss: new WebSocketServer({ noServer: true }), publicSpectateEnabled: true });
});
afterEach(() => {
  gw.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("FIX-DELAY · directo con retardo de 30 s y watchdog de 10 s (gateway y visor reales)", () => {
  it("SPECTATOR_DELAY_HEARTBEAT · WATCHDOG_WITH_DELAY · ANTI_COACHING_NOT_BYPASSED: sigue conectado, late, no reconecta y el primer snapshot llega tras el retardo", async () => {
    const { battle, producedAt } = liveBattle();
    gw.attachBattle(BATTLE, battle, { spectator: { delaySeconds: 30 }, pollIntervalMs: 33 });
    const { c, ev, tickets } = spectator();
    void c.connect();

    // Primeros ~30 s: la batalla produce ~300 snapshots internos y ~30 eventos.
    await vi.advanceTimersByTimeAsync(DELAY_MS - 200);
    expect(ev.inits.length).toBe(1);
    expect(ev.inits[0].snapshot, "el init adelantó estado").toBeNull();
    expect(ev.inits[0].spectator.delayMs).toBe(DELAY_MS);
    expect(ev.disconnects, "el watchdog cortó la espera del retardo").toBe(0);
    expect(tickets(), "pidió tickets nuevos: bucle de reconexión").toBe(1);
    expect(c.state.connected).toBe(true);
    expect(ev.heartbeats, "no llegaron latidos (≥ 1 Hz)").toBeGreaterThanOrEqual(29);
    expect(ev.snapshots, "ANTI_COACHING: snapshots antes del retardo").toEqual([]);
    expect(ev.events, "ANTI_COACHING: eventos antes del retardo").toEqual([]);

    // Pasado el retardo, el directo fluye.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ev.snapshots.length, "nunca llegó el primer snapshot").toBeGreaterThan(20);
    expect(ev.snapshots[0].tick).toBe(1);
    for (const s of [...ev.snapshots, ...ev.events]) {
      const lag = s.at - producedAt.get(s.tick)!;
      expect(lag, `ANTI_COACHING: tick ${s.tick} con ${lag} ms`).toBeGreaterThanOrEqual(DELAY_MS);
    }
    expect(ev.disconnects).toBe(0);
    expect(tickets()).toBe(1);
    expect(c.state.snapshot.tick).toBeGreaterThan(1);
    c.stop();
  });

  it("ANTI_COACHING_NOT_BYPASSED · quien llega tarde ve el estado de ahora − 30 s, nunca el vivo", async () => {
    const { battle, producedAt, tick } = liveBattle();
    gw.attachBattle(BATTLE, battle, { spectator: { delaySeconds: 30 }, pollIntervalMs: 33 });
    await vi.advanceTimersByTimeAsync(45_000);
    const live = tick();
    const { c, ev } = spectator();
    void c.connect();
    await vi.advanceTimersByTimeAsync(3_000);
    const t0 = ev.inits[0].snapshot.tick;
    expect(t0, `init con tick ${t0}; vivo ${live}`).toBeLessThanOrEqual(live - 290);
    expect(ev.snapshots.length).toBeGreaterThan(10);
    for (const s of ev.snapshots) {
      expect(s.at - producedAt.get(s.tick)!, `ANTI_COACHING: tick ${s.tick}`).toBeGreaterThanOrEqual(DELAY_MS);
    }
    expect(ev.disconnects).toBe(0);
    c.stop();
  });

  it("WATCHDOG_WITH_DELAY · gateway sin respuesta (ni latidos ni snapshots) ⇒ el watchdog de 10 s detecta la pérdida", async () => {
    const { battle } = liveBattle();
    gw.attachBattle(BATTLE, battle, { spectator: { delaySeconds: 30 }, pollIntervalMs: 33 });
    const { c, ev, tickets } = spectator();
    void c.connect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ev.heartbeats).toBeGreaterThanOrEqual(4);
    servers[0].blackhole = true; // el gateway deja de responder (cable fuera, proceso colgado)
    // Último mensaje ≈ 5 s; umbral 10 s + sondeo 2,5 s ⇒ detectado antes de ~18 s.
    // (Un «watchdog = retardo + margen» lo detectaría a los 35-40 s.)
    await vi.advanceTimersByTimeAsync(13_000);
    expect(ev.disconnects, "la pérdida del gateway no se detectó").toBeGreaterThanOrEqual(1);
    expect(tickets()).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it("WATCHDOG_WITH_DELAY · gateway que sólo manda el init y enmudece ⇒ detectado a los ~10 s, no a los 30", async () => {
    const { battle } = liveBattle();
    gw.attachBattle(BATTLE, battle, { spectator: { delaySeconds: 30 }, pollIntervalMs: 33 });
    const { c, ev } = spectator();
    void c.connect();
    await vi.advanceTimersByTimeAsync(1);
    servers[0].blackhole = true;
    await vi.advanceTimersByTimeAsync(13_000);
    expect(ev.disconnects).toBeGreaterThanOrEqual(1);
    c.stop();
  });

  it("DELAY_ZERO_REGRESSION · delay=0: sin latidos, init con el tick vivo, stream inmediato, sin reconexiones", async () => {
    const { battle, producedAt } = liveBattle();
    gw.attachBattle(BATTLE, battle, { pollIntervalMs: 33 });
    await vi.advanceTimersByTimeAsync(2_000);
    const { c, ev, tickets } = spectator();
    void c.connect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ev.inits[0].snapshot.tick).toBeGreaterThanOrEqual(19);
    expect(ev.inits[0].spectator.delayMs).toBe(0);
    expect(ev.heartbeats).toBe(0);
    expect(ev.disconnects).toBe(0);
    expect(tickets()).toBe(1);
    expect(ev.snapshots.length).toBeGreaterThan(150);
    for (const s of ev.snapshots) expect(s.at - producedAt.get(s.tick)!).toBeLessThan(100);
    c.stop();
  });
});
