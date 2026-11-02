/**
 * EQ5 · REGRESSION LOCK — el retardo anti-coaching (E8.M, `spectator.delaySeconds`)
 * cubre TAMBIÉN el mensaje `init`.
 *
 * Defecto (auditoría EQ5, 2026-11-02): el `init` salía `immediate` con
 * `snapshots.at(-1)`, el ÚLTIMO tick producido. El stream posterior sí iba
 * retrasado, pero cualquier espectador que se conectara (o reconectara: cada
 * reconexión pide ticket nuevo) recibía el estado VIVO de la batalla. El retardo
 * se saltaba reconectando.
 *
 * Contrato que fija este test:
 *  - con retardo, el `init` lleva el estado de `ahora - retardo` (nunca uno más
 *    reciente) y ningún snapshot llega antes de su producción + retardo;
 *  - el tramo de la ventana se entrega a continuación, sin huecos;
 *  - sin retardo, nada cambia: `init` con el último tick y stream inmediato.
 *
 * Gateway real en un puerto efímero, batalla estructural con reloj real.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SpectateGateway, spectateProtocols, type SpectatableBattle } from "./gateway.js";
import { signSpectateTicket } from "../auth/tokens.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const PRODUCE_EVERY_MS = 40;
/** Holgura del sondeo del gateway (pollIntervalMs) y del planificador. */
const SLACK_MS = 60;

/** Batalla que produce un snapshot cada PRODUCE_EVERY_MS y anota cuándo. */
function liveBattle() {
  const producedAt = new Map<number, number>();
  const battle: SpectatableBattle = { snapshots: [], publicEvents: [], isFinished: () => false, getResult: () => null };
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    producedAt.set(tick, Date.now());
    battle.snapshots.push({ tick, vehicles: [] });
  }, PRODUCE_EVERY_MS);
  cleanups.push(() => clearInterval(timer));
  return { battle, producedAt, currentTick: () => tick };
}

type Received = { msg: any; at: number };
function connect(
  gw: SpectateGateway,
  battleId: string,
): Promise<{ ws: WebSocket; got: Received[]; connectedAt: number }> {
  const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true } as any, 60);
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${battleId}`, spectateProtocols(ticket));
  cleanups.push(() => ws.terminate());
  const got: Received[] = [];
  ws.on("message", (d) => got.push({ msg: JSON.parse(String(d)), at: Date.now() }));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, got, connectedAt: Date.now() }));
    ws.once("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gateway(): SpectateGateway {
  const gw = new SpectateGateway({ publicSpectateEnabled: true });
  cleanups.push(() => gw.close());
  return gw;
}

describe("EQ5 · el init respeta el retardo anti-coaching", () => {
  it("con retardo, el init NO lleva el tick vivo sino el de `ahora - retardo`, y el stream sigue sin huecos ni adelantos", async () => {
    const DELAY_MS = 600;
    const gw = gateway();
    const { battle, producedAt, currentTick } = liveBattle();
    gw.attachBattle("b-delay", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });

    await sleep(1500); // la batalla ya lleva ~37 ticks
    const { got, connectedAt } = await connect(gw, "b-delay");
    const liveAtConnect = currentTick();
    await sleep(DELAY_MS + 500);

    const init = got[0];
    expect(init.msg.type).toBe("init");
    expect(init.msg.spectator.delaySeconds).toBe(DELAY_MS / 1000);
    const t0: number = init.msg.snapshot.tick;
    // EL defecto: en main t0 === tick vivo (producido justo al conectar).
    expect(t0, `init con tick ${t0}; vivo ${liveAtConnect}`).toBeLessThan(liveAtConnect - 5);
    expect(producedAt.get(t0)!).toBeLessThanOrEqual(connectedAt - DELAY_MS + SLACK_MS);

    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(5);
    // Ningún snapshot llega antes de su producción + retardo.
    for (const s of snaps) {
      const lag = s.at - producedAt.get(s.msg.snapshot.tick)!;
      expect(lag, `tick ${s.msg.snapshot.tick} llegó con ${lag} ms`).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
    // Continuidad: tras el init, los ticks siguientes en orden y sin huecos.
    const ticks = snaps.map((s) => s.msg.snapshot.tick);
    expect(ticks[0]).toBe(t0 + 1);
    ticks.forEach((t, i) => expect(t).toBe(t0 + 1 + i));
  }, 15_000);

  it("con retardo y la batalla recién registrada, el init no adelanta nada (snapshot null)", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    await sleep(300); // snapshots previos al registro
    gw.attachBattle("b-fresh", battle, { spectator: { delaySeconds: 2 }, pollIntervalMs: 10 });
    const { got } = await connect(gw, "b-fresh");
    await sleep(200);
    expect(got[0].msg.type).toBe("init");
    expect(got[0].msg.snapshot).toBeNull();
    expect(got.filter((g) => g.msg.type === "snapshot")).toEqual([]);
  }, 10_000);

  it("NO REGRESIÓN · sin retardo: init con el último tick y stream inmediato", async () => {
    const gw = gateway();
    const { battle, producedAt, currentTick } = liveBattle();
    gw.attachBattle("b-live", battle, { pollIntervalMs: 10 });
    await sleep(800);
    const { got } = await connect(gw, "b-live");
    const liveAtConnect = currentTick();
    await sleep(400);

    expect(got[0].msg.type).toBe("init");
    expect(got[0].msg.spectator.delaySeconds).toBe(0);
    expect(got[0].msg.snapshot.tick).toBeGreaterThanOrEqual(liveAtConnect - 1);
    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(3);
    for (const s of snaps) {
      expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeLessThan(250);
    }
  }, 10_000);
});
