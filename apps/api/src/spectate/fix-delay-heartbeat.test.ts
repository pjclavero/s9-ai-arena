/**
 * FIX-DELAY · Latidos de control del canal de espectador con retardo anti-coaching.
 *
 * Defecto demostrado en producción (2026-11-15, torneo con delaySeconds=30): el
 * gateway difería TODOS los mensajes `delayMs`; tras el init el canal quedaba mudo
 * 30 s y el watchdog del visor (10 s) lo cerraba en bucle: emisión congelada en el
 * tick 0.
 *
 * Contrato que fija este test (gateway REAL en un puerto efímero, ws real):
 *  - con retardo, los latidos llegan SIN retardo (≥ 1 Hz) y los snapshots CON él;
 *  - un latido no contiene estado de la batalla ni marcas de tiempo: tipo fijo y
 *    `delayMs` constante, cadencia fija;
 *  - el init anuncia el retardo efectivo en ms;
 *  - reconectar NO reinicia el retardo: la conexión nueva sigue del buffer del feed;
 *  - sin retardo, ni un latido: todo como siempre.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SpectateGateway, heartbeatMessage, spectateProtocols, type SpectatableBattle } from "./gateway.js";
import { signSpectateTicket } from "../auth/tokens.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const PRODUCE_EVERY_MS = 40;
const SLACK_MS = 80;
const HB_MS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Batalla con vehículos (posición + hp) y eventos: lo que un latido NO debe llevar. */
function liveBattle() {
  const producedAt = new Map<number, number>();
  const battle: SpectatableBattle = { snapshots: [], publicEvents: [], isFinished: () => false, getResult: () => null };
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    producedAt.set(tick, Date.now());
    battle.snapshots.push({
      tick,
      vehicles: [{ id: "v_red", team: "red", position: { x: 1000 + tick, y: 2000 + tick }, hp: 777 - tick }],
    });
    if (tick % 5 === 0) battle.publicEvents.push({ type: "vehicle_destroyed", tick, vehicleId: "v_blue" });
  }, PRODUCE_EVERY_MS);
  cleanups.push(() => clearInterval(timer));
  return { battle, producedAt };
}

type Received = { msg: any; raw: string; at: number };
function connect(
  gw: SpectateGateway,
  battleId: string,
): Promise<{ ws: WebSocket; got: Received[]; connectedAt: number }> {
  const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true } as any, 60);
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${battleId}`, spectateProtocols(ticket));
  cleanups.push(() => ws.terminate());
  const got: Received[] = [];
  ws.on("message", (d) => got.push({ msg: JSON.parse(String(d)), raw: String(d), at: Date.now() }));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, got, connectedAt: Date.now() }));
    ws.once("error", reject);
  });
}

function gateway(): SpectateGateway {
  const gw = new SpectateGateway({ publicSpectateEnabled: true, heartbeatIntervalMs: HB_MS });
  cleanups.push(() => gw.close());
  return gw;
}

describe("FIX-DELAY · latidos sin retardo, snapshots con retardo", () => {
  it("SPECTATOR_DELAY_HEARTBEAT · ANTI_COACHING_NOT_BYPASSED · con retardo: latidos inmediatos y ≥ 1 Hz durante la espera; snapshots y eventos sólo tras el retardo", async () => {
    const DELAY_MS = 1500;
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    gw.attachBattle("b-hb", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const { got, connectedAt } = await connect(gw, "b-hb");
    await sleep(DELAY_MS + 700);

    expect(got[0].msg.type).toBe("init");
    // El init anuncia el retardo efectivo (ms) y el periodo de latidos.
    expect(got[0].msg.spectator.delayMs).toBe(DELAY_MS);
    expect(got[0].msg.spectator.heartbeatIntervalMs).toBe(HB_MS);

    const beats = got.filter((g) => g.msg.type === "heartbeat");
    const firstSnap = got.find((g) => g.msg.type === "snapshot");
    expect(firstSnap, "no llegó ningún snapshot tras el retardo").toBeDefined();
    // Latidos SIN retardo: el primero casi al conectar, y varios ANTES del primer snapshot.
    expect(beats.length).toBeGreaterThan(5);
    expect(beats[0].at - connectedAt, "el primer latido llegó diferido").toBeLessThan(300);
    const beforeFirstSnap = beats.filter((b) => b.at < firstSnap!.at);
    expect(beforeFirstSnap.length).toBeGreaterThanOrEqual(Math.floor((DELAY_MS - 300) / HB_MS));
    // Ningún hueco entre latidos supera 1 s (≥ 1 Hz) mientras se espera.
    for (let i = 1; i < beforeFirstSnap.length; i++) {
      expect(beforeFirstSnap[i].at - beforeFirstSnap[i - 1].at).toBeLessThan(1000);
    }
    for (const b of beats) expect(b.msg.delayMs).toBe(DELAY_MS);

    // Snapshots y eventos CON retardo: ninguno antes de su producción + retardo.
    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(3);
    for (const s of snaps) {
      const lag = s.at - producedAt.get(s.msg.snapshot.tick)!;
      expect(lag, `tick ${s.msg.snapshot.tick} llegó con ${lag} ms`).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
    const events = got.filter((g) => g.msg.type === "event");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.at - producedAt.get(e.msg.event.tick)!).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
  }, 15_000);

  it("NO_STATE_LEAK_IN_HEARTBEAT · un latido NO contiene estado de la batalla ni marcas de tiempo: tipo fijo y retardo constante", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    await sleep(400); // la batalla ya tiene snapshots y eventos con valores reconocibles
    gw.attachBattle("b-leak", battle, { spectator: { delaySeconds: 1 }, pollIntervalMs: 10 });
    const { got } = await connect(gw, "b-leak");
    await sleep(1600);
    const beats = got.filter((g) => g.msg.type === "heartbeat");
    expect(beats.length).toBeGreaterThan(5);
    for (const b of beats) {
      // Whitelist ESTRUCTURAL exacta: tipo fijo + retardo constante (+ el sobre
      // común v/id). Ni estado de batalla ni marcas de tiempo ni nada que dependa
      // de lo retenido (sería un canal lateral): cualquier campo nuevo rompe aquí.
      expect(Object.keys(b.msg).sort()).toEqual(["delayMs", "id", "type", "v"]);
      expect(b.msg.type).toBe("heartbeat");
      expect(b.msg.v).toBe(1);
      expect(b.msg.delayMs).toBe(1000);
    }
    // Todos los latidos son IDÉNTICOS salvo el id aleatorio: nada varía con la batalla.
    const bodies = new Set(beats.map(({ msg: { id: _id, ...rest } }) => JSON.stringify(rest)));
    expect([...bodies]).toEqual([JSON.stringify({ v: 1, type: "heartbeat", delayMs: 1000 })]);
    // Cadencia FIJA: el intervalo entre latidos no depende de la actividad de la batalla.
    const gaps = beats.slice(1).map((b, i) => b.at - beats[i].at);
    for (const g of gaps) expect(g).toBeLessThan(HB_MS * 3);
    // La fábrica pura tampoco: sólo relojes.
    expect(heartbeatMessage(30_000)).toEqual({ type: "heartbeat", delayMs: 30_000 });
  }, 10_000);

  it("reconectar NO reinicia el retardo: la conexión nueva sigue del buffer del feed", async () => {
    const DELAY_MS = 1500;
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    const attachedAt = Date.now();
    gw.attachBattle("b-resume", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const first = await connect(gw, "b-resume");
    await sleep(1000);
    first.ws.close(); // corte a mitad de la espera
    await sleep(100);
    const second = await connect(gw, "b-resume");
    await sleep(DELAY_MS);
    const snaps = second.got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length, "la reconexión no recibió nada").toBeGreaterThan(3);
    const firstAt = snaps[0].at;
    // Si el retardo se reiniciara, el primer snapshot llegaría en connectedAt + retardo.
    expect(firstAt - second.connectedAt, "el retardo se reinició con la reconexión").toBeLessThan(DELAY_MS - 500);
    expect(firstAt - attachedAt).toBeLessThan(DELAY_MS + 400);
    // …y sin adelantar nada: cada snapshot, tras su producción + retardo.
    for (const s of snaps) {
      expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
  }, 15_000);

  it("al cerrar la conexión se apaga su latido (sin temporizadores huérfanos)", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    gw.attachBattle("b-close", battle, { spectator: { delaySeconds: 2 }, pollIntervalMs: 10 });
    const { ws } = await connect(gw, "b-close");
    await sleep(300);
    const feed = (gw as any).feeds.get("b-close");
    const [conn] = [...feed.clients];
    expect(conn.heartbeat).not.toBeNull();
    ws.close();
    await sleep(200);
    expect(feed.clients.size).toBe(0);
    expect(conn.heartbeat).toBeNull();
  }, 10_000);

  it("DELAY_ZERO_REGRESSION · delay=0: ni un latido, init con el tick vivo y stream inmediato", async () => {
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    gw.attachBattle("b-zero", battle, { pollIntervalMs: 10 });
    await sleep(300);
    const { got } = await connect(gw, "b-zero");
    await sleep(800);
    expect(got[0].msg.type).toBe("init");
    expect(got[0].msg.spectator.delaySeconds).toBe(0);
    expect(got[0].msg.spectator.delayMs).toBe(0);
    expect(got[0].msg.snapshot).not.toBeNull();
    expect(got.filter((g) => g.msg.type === "heartbeat")).toEqual([]);
    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(5);
    for (const s of snaps) expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeLessThan(250);
  }, 10_000);
});
