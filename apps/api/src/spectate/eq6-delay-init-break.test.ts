/** EQ6 · rotura del init con retardo (#211). Montaje copiado de delay-init.test.ts. */
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

/*
 * EQ6 · revisión independiente de #211 · intentos de ROTURA del init con retardo.
 * (Montaje copiado de delay-init.test.ts.)
 */
function connectWith(gw: SpectateGateway, battleId: string, debug: boolean) {
  const ticket = signSpectateTicket(
    { battleId, jti: randomUUID(), anon: !debug, debug, userId: debug ? "u-staff" : undefined } as any,
    60,
  );
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${battleId}`, spectateProtocols(ticket));
  cleanups.push(() => ws.terminate());
  const got: Received[] = [];
  ws.on("message", (d) => got.push({ msg: JSON.parse(String(d)), at: Date.now() }));
  return new Promise<{ ws: WebSocket; got: Received[]; connectedAt: number }>((resolve, reject) => {
    ws.once("open", () => resolve({ ws, got, connectedAt: Date.now() }));
    ws.once("error", reject);
  });
}

describe("EQ6 · #211 · rotura del init con retardo", () => {
  it("reconectar a mitad de la ventana no adelanta nada: cada init lleva un tick de `ahora - retardo`", async () => {
    const DELAY_MS = 800;
    const gw = gateway();
    const { battle, producedAt, currentTick } = liveBattle();
    gw.attachBattle("b-rc", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    await sleep(1200);
    for (let round = 0; round < 4; round++) {
      const { ws, got, connectedAt } = await connect(gw, "b-rc");
      const live = currentTick();
      await sleep(150);
      const init = got[0].msg;
      expect(init.type).toBe("init");
      const t0 = init.snapshot?.tick ?? 0;
      expect(t0, `vuelta ${round}: init ${t0} con vivo ${live}`).toBeLessThan(live - 5);
      if (t0) expect(producedAt.get(t0)!).toBeLessThanOrEqual(connectedAt - DELAY_MS + SLACK_MS);
      for (const s of got.filter((g) => g.msg.type === "snapshot"))
        expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
      ws.terminate();
      await sleep(100);
    }
  }, 20_000);

  it("fin de batalla DENTRO del retardo (y retardo mayor que la batalla): el resultado no sale antes de tiempo", async () => {
    const DELAY_MS = 1500;
    const gw = gateway();
    const { battle } = liveBattle();
    let done = false;
    battle.isFinished = () => done;
    battle.getResult = () => ({ winner: "red", secret: "resultado" });
    gw.attachBattle("b-end", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    await sleep(400); // batalla más corta que el retardo
    done = true;
    const finishedAt = Date.now();
    await sleep(100);
    const { got } = await connect(gw, "b-end");
    await sleep(50);
    const init = got[0].msg;
    expect(init.type).toBe("init");
    expect(init.finished, "init dice finished antes de que venza el retardo").toBe(false);
    expect(init.result).toBeUndefined();
    expect(init.snapshot).toBeNull(); // nada es tan antiguo todavía
    await sleep(DELAY_MS + 400);
    const res = got.find((g) => g.msg.type === "result");
    expect(res, "el resultado llega al vencer el retardo").toBeTruthy();
    expect(res!.at - finishedAt).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    // Y quien conecta DESPUÉS de vencer el retardo ve finished=true en el init.
    const late = await connect(gw, "b-end");
    await sleep(50);
    expect(late.got[0].msg.finished).toBe(true);
    expect(late.got[0].msg.result).toEqual({ winner: "red", secret: "resultado" });
  }, 15_000);

  it("la capa de depuración no sale ni en el tramo pendiente ni en vivo para un ticket sin debug", async () => {
    const DELAY_MS = 600;
    const gw = gateway();
    const { battle } = liveBattle();
    gw.attachBattle("b-dbg", battle, {
      spectator: { delaySeconds: DELAY_MS / 1000 },
      pollIntervalMs: 10,
      debugLayers: () => ({ privado: "intención del bot" }),
    });
    await sleep(900);
    const anon = await connectWith(gw, "b-dbg", false);
    await sleep(DELAY_MS + 400);
    expect(anon.got.length).toBeGreaterThan(3);
    expect(anon.got.filter((g) => g.msg.type === "debug")).toEqual([]);
    expect(JSON.stringify(anon.got.map((g) => g.msg))).not.toContain("intención del bot");
    // Control positivo: un ticket CON debug sí recibe la capa (la prueba no es ciega).
    const staff = await connectWith(gw, "b-dbg", true);
    await sleep(DELAY_MS + 400);
    expect(staff.got.filter((g) => g.msg.type === "debug").length).toBeGreaterThan(0);
  }, 10_000);

  it("la ventana del retardo está acotada en una batalla larga (no crece con la duración)", async () => {
    const DELAY_MS = 300;
    const gw = gateway();
    const { battle } = liveBattle();
    gw.attachBattle("b-long", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const sizes: number[] = [];
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      sizes.push((gw as any).feeds.get("b-long").history.length);
    }
    // ~300 ms / 40 ms ≈ 8 snapshots en ventana: nunca debe acumular toda la batalla (~75 ticks).
    expect(Math.max(...sizes), `tamaños ${sizes.join(",")}`).toBeLessThanOrEqual(20);
  }, 10_000);
});
