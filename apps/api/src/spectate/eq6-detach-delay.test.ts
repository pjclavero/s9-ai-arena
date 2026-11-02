/** EQ6 · #201 × #211 · el detach del espectador espera el retardo (montaje copiado de delay-init.test.ts). */
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

import { spectateDetachDelayMs, SPECTATE_DETACH_BASE_MS } from "../../../tournament-worker/src/engine-executor.js";

describe("EQ6 · #201 × #211 · detach del espectador con retardo", () => {
  it("con retardo, el detach del worker espera a que el espectador reciba el final y el resultado (incluido quien llega tarde)", async () => {
    const DELAY_S = 1.2;
    const gw = gateway();
    const { battle } = liveBattle();
    let done = false;
    battle.isFinished = () => done;
    battle.getResult = () => ({ winner: "red" });
    gw.attachBattle("b-detach", battle, { spectator: { delaySeconds: DELAY_S }, pollIntervalMs: 10 });
    const early = await connect(gw, "b-detach");
    await sleep(600);
    done = true;
    // Lo que hace engine-executor al acabar la batalla (finally): detach diferido.
    const detachMs = spectateDetachDelayMs(300, { delaySeconds: DELAY_S });
    expect(detachMs).toBe(300 + DELAY_S * 1000);
    setTimeout(() => gw.detachBattle("b-detach"), detachMs);
    await sleep(DELAY_S * 1000 - 300);
    const late = await connect(gw, "b-detach"); // llega tarde, dentro del retardo
    await sleep(detachMs + 600);
    for (const [who, c] of [
      ["temprano", early],
      ["tardío", late],
    ] as const) {
      const res = c.got.find((g) => g.msg.type === "result");
      expect(res, `${who}: el detach cortó el resultado`).toBeTruthy();
    }
    expect(spectateDetachDelayMs(SPECTATE_DETACH_BASE_MS, { delaySeconds: 30 })).toBe(33_000);
    expect(spectateDetachDelayMs(SPECTATE_DETACH_BASE_MS, { delaySeconds: 0 })).toBe(SPECTATE_DETACH_BASE_MS);
  }, 15_000);

  it("control: si el detach llega ANTES de vencer el retardo, el resultado se pierde (la prueba no es ciega)", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    let done = false;
    battle.isFinished = () => done;
    battle.getResult = () => ({ winner: "red" });
    gw.attachBattle("b-cut", battle, { spectator: { delaySeconds: 1.2 }, pollIntervalMs: 10 });
    const c = await connect(gw, "b-cut");
    await sleep(400);
    done = true;
    setTimeout(() => gw.detachBattle("b-cut"), 300); // como el detach fijo de 3 s frente a 30 s
    await sleep(2000);
    expect(c.got.find((g) => g.msg.type === "result")).toBeUndefined();
  }, 10_000);
});
