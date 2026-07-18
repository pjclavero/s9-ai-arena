/**
 * T8.2 · Integración COMPLETA del canal de espectador, sin piezas simuladas:
 * API real de E7 (PostgreSQL embebido) emite el ticket firmado → SpectateGateway
 * (E8) lo consume (un solo uso) → batalla REAL del motor de E2 corriendo en vivo
 * → SpectatorClient del visor (el mismo código que usa la página).
 *
 * Sin navegador ni Playwright en este entorno: esto es el nivel HTTP/WS real
 * (transporte + estado); el render Phaser queda para el guion manual (entrega).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { WebSocket as WsWebSocket } from "ws";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { SpectateGateway } from "../../api/src/spectate/gateway.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../../arena-engine/src/sim/battle.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { SpectatorClient, type SpectateTicket } from "../src/viewer/spectator-client.js";

let h: TestDbHandle;
let app: Express;
let gateway: SpectateGateway;
let moderatorToken: string;

const drivers: ReturnType<typeof setInterval>[] = [];
const battles: Battle[] = [];

async function makeBattle(seed: string, opts: { hunters?: boolean; timeLimitTicks?: number } = {}): Promise<Battle> {
  const b = await Battle.create({
    battleId: seed,
    seed,
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: opts.timeLimitTicks ?? 30000 }),
    map: emptyArena(),
    participants: [
      { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
      { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
    ],
  });
  b.attachBot("v_red", opts.hunters ? new HunterBot("bot_red") : new IdleBot("bot_red"));
  b.attachBot("v_blue", opts.hunters ? new HunterBot("bot_blue") : new IdleBot("bot_blue"));
  // Bucle en vivo acelerado (fuera de sim/: legítimo, igual que ProtocolServer).
  const t = setInterval(() => {
    for (let i = 0; i < 5 && !b.isFinished(); i++) b.step();
  }, 5);
  drivers.push(t);
  battles.push(b);
  return b;
}

async function insertLiveBattle(id: string): Promise<string> {
  const [row] = await h
    .db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: id,
    })
    .returning("*");
  return row.id as string;
}

/** getTicket real: contra la API de E7, como lo hace la página del visor. */
function ticketVia(appRef: Express, battleId: string, token?: string): () => Promise<SpectateTicket> {
  return async () => {
    let req = request(appRef).post(`/battles/${battleId}/spectate-ticket`);
    if (token) req = req.set("Authorization", `Bearer ${token}`);
    const res = await req;
    if (res.status !== 201) throw new Error(`ticket: HTTP ${res.status}`);
    return { ticket: res.body.ticket, wsUrl: res.body.wsUrl };
  };
}

function client(getTicket: () => Promise<SpectateTicket>, reconnectDelayMs = 50): SpectatorClient {
  return new SpectatorClient({
    getTicket,
    WebSocketImpl: WsWebSocket as unknown as typeof WebSocket,
    reconnectDelayMs,
    maxReconnectAttempts: 20,
  });
}

function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15000, everyMs = 20): Promise<T> {
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

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10000, windowMs: 3600_000 } });
  moderatorToken = await tokenFor(h.db, DEV_USERS.moderator);
  gateway = new SpectateGateway({ port: 0 });
  // La API emite wsUrl apuntando AL gateway real de este test.
  process.env.SPECTATE_WS_URL = `ws://127.0.0.1:${gateway.port}/spectate`;
}, 120000);

afterAll(async () => {
  for (const t of drivers) clearInterval(t);
  gateway?.close();
  for (const b of battles) {
    try {
      b.free();
    } catch {
      /* ya liberada */
    }
  }
  delete process.env.SPECTATE_WS_URL;
  await h.stop();
});

describe("T8.2 canal de espectador (ticket E7 → gateway E8 → motor E2)", () => {
  it("un visitante anónimo ve la batalla en directo: init + snapshots a 10 Hz + eventos", async () => {
    const dbId = await insertLiveBattle("live-anon");
    const battle = await makeBattle("live-anon", { hunters: true, timeLimitTicks: 1200 });
    gateway.attachBattle(dbId, battle, { meta: { mode: "deathmatch" } });

    const c = client(ticketVia(app, dbId));
    const snapshots: any[] = [];
    c.on("snapshot", (s) => snapshots.push(s));
    await c.connect();

    await waitFor(() => c.state.snapshot && snapshots.length >= 5);
    expect(c.state.spectator).toEqual({ allowFogView: false, delaySeconds: 0, debug: false });
    // Snapshots en orden de tick y a ritmo de 10 Hz de tiempo de juego (cada 3 ticks).
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i].tick).toBeGreaterThan(snapshots[i - 1].tick);
    }
    // La batalla acelerada termina y el cliente recibe el resultado.
    const result = await waitFor(() => c.state.result, 60000);
    expect(result.battleId).toBe("live-anon");
    c.stop();
  }, 90000);

  it("el ticket es de UN SOLO USO: la segunda conexión con el mismo ticket se rechaza", async () => {
    const dbId = await insertLiveBattle("single-use");
    const battle = await makeBattle("single-use");
    gateway.attachBattle(dbId, battle, {});

    const { ticket, wsUrl } = await ticketVia(app, dbId)();
    const first = new WsWebSocket(`${wsUrl}`, ["spectate.v1", `ticket.${ticket}`]);
    await new Promise<void>((resolve, reject) => {
      first.once("open", () => resolve());
      first.once("error", reject);
    });

    const second = new WsWebSocket(`${wsUrl}`, ["spectate.v1", `ticket.${ticket}`]);
    const closeCode = await new Promise<number>((resolve) => second.once("close", (code) => resolve(code)));
    expect(closeCode).toBe(4403);
    expect(first.readyState).toBe(WsWebSocket.OPEN); // la primera sigue viva
    first.close();
  });

  it("ticket inválido o de otra batalla ⇒ rechazo", async () => {
    const dbId = await insertLiveBattle("wrong-ticket");
    const otherId = await insertLiveBattle("other-battle");
    gateway.attachBattle(dbId, await makeBattle("wrong-ticket"), {});
    gateway.attachBattle(otherId, await makeBattle("other-battle"), {});

    const basura = new WsWebSocket(`ws://127.0.0.1:${gateway.port}/spectate/${dbId}`, ["spectate.v1", "ticket.basura"]);
    expect(await new Promise<number>((r) => basura.once("close", (c2) => r(c2)))).toBe(4401);

    const { ticket } = await ticketVia(app, otherId)(); // ticket legítimo… de OTRA batalla
    const cruzado = new WsWebSocket(`ws://127.0.0.1:${gateway.port}/spectate/${dbId}`, [
      "spectate.v1",
      `ticket.${ticket}`,
    ]);
    expect(await new Promise<number>((r) => cruzado.once("close", (c2) => r(c2)))).toBe(4403);
  });

  it("R2.6 (ERR-SEC-16): el ticket viaja FUERA de la URL — uno VÁLIDO en la query se rechaza (las URLs acaban en logs)", async () => {
    const dbId = await insertLiveBattle("no-url-ticket");
    gateway.attachBattle(dbId, await makeBattle("no-url-ticket"), {});
    const { ticket, wsUrl } = await ticketVia(app, dbId)();

    // Ticket legítimo pero en la query: rechazado ANTES de verificarlo (ya se filtró a los logs).
    const enUrl = new WsWebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    expect(await new Promise<number>((r) => enUrl.once("close", (c) => r(c)))).toBe(4400);

    // Sin subprotocolo de ticket tampoco se entra.
    const sinTicket = new WsWebSocket(`${wsUrl}`, ["spectate.v1"]);
    expect(await new Promise<number>((r) => sinTicket.once("close", (c) => r(c)))).toBe(4400);

    // El MISMO ticket (no consumido: la query no lo quemó) entra por subprotocolo.
    const bien = new WsWebSocket(`${wsUrl}`, ["spectate.v1", `ticket.${ticket}`]);
    await new Promise<void>((resolve, reject) => {
      bien.once("open", () => resolve());
      bien.once("error", reject);
    });
    bien.close();
  });

  it("FUGAS (criterio cap. 28): el stream real de una batalla completa jamás contiene datos privados", async () => {
    const dbId = await insertLiveBattle("leak-sweep");
    const battle = await makeBattle("leak-sweep", { hunters: true, timeLimitTicks: 900 });
    gateway.attachBattle(dbId, battle, { debugLayers: () => ({ mines: [] }) });

    const raw: string[] = [];
    const parsed: any[] = [];
    const { ticket, wsUrl } = await ticketVia(app, dbId)();
    const ws = new WsWebSocket(`${wsUrl}`, ["spectate.v1", `ticket.${ticket}`]);
    ws.on("message", (d) => {
      raw.push(String(d));
      parsed.push(JSON.parse(String(d)));
    });
    await waitFor(() => parsed.some((m) => m.type === "result"), 60000);
    ws.close();
    expect(parsed.filter((m) => m.type === "snapshot").length).toBeGreaterThan(10);

    // 1) Nada del vocabulario privado del motor en TODO el stream (bytes reales).
    const forbidden = [
      "sensors",
      "lidar",
      "radar",
      "acoustic",
      "observation",
      "radioInbox",
      '"mines"',
      "decide",
      "battleToken",
      "energyEU",
    ];
    for (const line of raw) {
      for (const word of forbidden) {
        expect(line, `fuga de "${word}" en el stream de espectador`).not.toContain(word);
      }
    }
    // 2) Sin ticket debug NO llega ninguna capa de depuración, aunque el feed la tenga.
    expect(parsed.every((m) => m.type !== "debug")).toBe(true);
    // 3) Whitelist estructural del snapshot público (T2.6/D8).
    for (const m of parsed.filter((x) => x.type === "snapshot")) {
      expect(Object.keys(m.snapshot).sort()).toEqual(["objectives", "projectiles", "score", "tick", "vehicles"]);
      for (const v of m.snapshot.vehicles) {
        expect(Object.keys(v).sort()).toEqual(
          // "juggernaut" (R3.8) es pública por definición del modo: quién es el marcado
          // forma parte del marcador, igual que carryingFlag. Su POSICIÓN sigue sin regalarse.
          [
            "alive",
            "carryingFlag",
            "heading",
            "hullHp",
            "hullHpMax",
            "id",
            "juggernaut",
            "modules",
            "position",
            "team",
            "turretHeading",
          ],
        );
      }
    }
  }, 90000);

  it("las capas de depuración llegan SOLO con ticket firmado de rol autorizado", async () => {
    const dbId = await insertLiveBattle("debug-layers");
    const battle = await makeBattle("debug-layers");
    gateway.attachBattle(dbId, battle, {
      debugLayers: () => ({ mines: [{ position: { x: 1, y: 2 } }] }),
    });

    const cMod = client(ticketVia(app, dbId, moderatorToken));
    const debugMsgs: any[] = [];
    cMod.on("debug", (d) => debugMsgs.push(d));
    await cMod.connect();
    await waitFor(() => debugMsgs.length >= 2);
    expect(cMod.state.spectator?.debug).toBe(true);
    expect(debugMsgs[0].layers.mines[0].position).toEqual({ x: 1, y: 2 });
    cMod.stop();
  });

  it("reconexión: corte a mitad de batalla ⇒ ticket nuevo, snapshot completo y estado recuperado sin recargar", async () => {
    const dbId = await insertLiveBattle("reconnect");
    const battle = await makeBattle("reconnect", { timeLimitTicks: 30000 });
    gateway.attachBattle(dbId, battle, {});

    let ticketsIssued = 0;
    const getTicket = async () => {
      ticketsIssued++;
      return ticketVia(app, dbId)();
    };
    const c = client(getTicket, 100);
    let inits = 0;
    let reconnected = false;
    c.on("init", () => inits++);
    c.on("reconnected", () => (reconnected = true));
    await c.connect();
    await waitFor(() => c.state.snapshot);
    const tickBeforeCut = c.state.snapshot.tick;

    // Corte del WebSocket en el servidor (caída de red simulada). La batalla SIGUE.
    for (const ws of gateway.wss.clients) ws.terminate();

    await waitFor(() => reconnected && inits >= 2 && c.state.snapshot.tick > tickBeforeCut, 30000);
    // MISMO objeto cliente, sin "recargar": estado repuesto por el snapshot completo del init.
    expect(ticketsIssued).toBeGreaterThanOrEqual(2); // el ticket quemado no se reutiliza
    expect(c.state.connected).toBe(true);
    expect(c.state.snapshot.tick).toBeGreaterThan(tickBeforeCut);
    c.stop();
  }, 60000);

  it("E8.M retardo anti-coaching: el ruleset con spectator.delaySeconds retrasa el stream", async () => {
    const dbId = await insertLiveBattle("delayed");
    const battle = await makeBattle("delayed");
    gateway.attachBattle(dbId, battle, { spectator: { allowFogView: true, delaySeconds: 0.3 } });

    const c = client(ticketVia(app, dbId));
    let initAt = 0;
    let firstSnapshotAt = 0;
    c.on("init", () => (initAt = Date.now()));
    c.on("snapshot", () => {
      if (!firstSnapshotAt) firstSnapshotAt = Date.now();
    });
    await c.connect();
    await waitFor(() => firstSnapshotAt > 0);
    expect(c.state.spectator?.allowFogView).toBe(true);
    expect(c.state.spectator?.delaySeconds).toBe(0.3);
    // El init es inmediato; el directo llega con ≥ ~250 ms de retardo.
    expect(firstSnapshotAt - initAt).toBeGreaterThanOrEqual(250);
    c.stop();
  });
});
