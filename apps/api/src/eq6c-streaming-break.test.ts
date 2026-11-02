/**
 * EQ6c · Re-revisión adversarial del PR #227 (ronda 2) · API contra PostgreSQL REAL.
 *
 * Convención (igual que el fichero del streamer):
 *  - `CIERRE`: el hallazgo de la ronda 1 está cerrado POR EL ARREGLO (verde en
 *    a41a903; en rojo si se revierte el arreglo: calibración en el informe).
 *  - `DEFECTO`: hallazgo nuevo de la ronda 2, en rojo a propósito.
 *  - `CONTROL`: lo que la entrega resiste.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { HttpStreamerClient, type StreamerCallResult, type StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Streamer falso con la semántica del real: el EFECTO de start/stop ocurre al
 * recibir la orden; la RESPUESTA puede retrasarse (`hold*`) para orquestar
 * entrelazados exactos entre dos instancias de la API.
 */
class GatedStreamer implements StreamerClient {
  configured = true;
  emitting = false;
  startDelayMs = 0;
  stopDelayMs = 0;
  relayState: string | null = null;
  stateOverride: string | null = null;
  holdStartBefore: Promise<void> | null = null; // retrasa el EFECTO del start
  holdStopAfter: Promise<void> | null = null; // retrasa la RESPUESTA del stop (efecto ya hecho)
  onStopEffect: (() => void) | null = null;
  onStartEffect: (() => void) | null = null;
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({
        state: this.stateOverride ?? (this.emitting ? "streaming" : "stopped"),
        desired: this.emitting,
        capabilities: { nvenc: false, sealedCredentials: true },
        relay: { state: this.relayState, bytesOut: 0 },
        lastError: null,
      });
    if (path === "/control/start") {
      const replace = (body as { replace?: boolean }).replace === true;
      if (this.holdStartBefore) await this.holdStartBefore;
      if (this.startDelayMs) await sleep(Math.random() * this.startDelayMs);
      if (this.emitting && !replace) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.emitting = true;
      this.onStartEffect?.();
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      if (this.stopDelayMs) await sleep(Math.random() * this.stopDelayMs);
      this.emitting = false;
      this.onStopEffect?.();
      if (this.holdStopAfter) await this.holdStopAfter;
      return ok({ state: "stopped" });
    }
    if (path === "/recordings")
      return ok({ dir: "arena_replays/video", files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let st: GatedStreamer;
let appA: Express;
let appB: Express;
let admin: string;
let battle: string;

const auth = () => ({ Authorization: `Bearer ${admin}` });
const activeRows = () => h.db("streaming_sessions").where({ state: "active" });
const start = (app: Express) => request(app).post("/admin/streaming/start").set(auth()).send({ target: { kind: "battle", id: battle } });
const stop = (app: Express) => request(app).post("/admin/streaming/stop").set(auth()).send({});
const restart = (app: Express) => request(app).post("/admin/streaming/restart").set(auth()).send({});
async function invariant() {
  const rows = await activeRows();
  return { emitting: st.emitting, activeSessions: rows.length };
}
async function reset() {
  st.emitting = false;
  st.startDelayMs = 0;
  st.stopDelayMs = 0;
  st.holdStartBefore = null;
  st.holdStopAfter = null;
  st.onStartEffect = null;
  st.onStopEffect = null;
  st.relayState = null;
  st.stateOverride = null;
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  st = new GatedStreamer();
  const mk = (streamer: StreamerClient) =>
    createApp({ db: h.db, streamer, streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }), broadcastBaseUrl: "http://web:3000/broadcast" });
  // Dos instancias de la API sobre la MISMA BD y el MISMO streamer (dos procesos / réplicas).
  appA = mk(st);
  appB = mk(st);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  battle = randomUUID();
  await h.db("battles").insert({ id: battle, status: "running", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID, map_id: "mvp-arena-01", map_version: 1 });
  const bot = await createPublishedBot(h.db, `eq6c-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  const v = (await request(appA).get("/admin/streaming").set(auth())).body.settings.version;
  expect((await request(appA).put("/admin/streaming/settings").set(auth()).send({ version: v, enabled: true, mode: "record" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await reset();
});

describe("EQ6c · P2-4 · carreras repetidas en UNA instancia (cerrojo de proceso)", () => {
  const N = 20;
  it(`CIERRE P2-4 · start ‖ stop, restart ‖ stop y stop ‖ start, ${N} veces cada una con latencias aleatorias: nunca un zombi`, async () => {
    const bad: unknown[] = [];
    for (let i = 0; i < N; i++) {
      // start ‖ stop
      await reset();
      st.startDelayMs = 60;
      st.stopDelayMs = 30;
      const a = start(appA).then((r) => r.status);
      await sleep(Math.random() * 40);
      const b = stop(appA).then((r) => r.status);
      const sa = await a;
      const sb = await b;
      let inv = await invariant();
      if (!(inv.emitting === inv.activeSessions > 0) || inv.activeSessions > 1) bad.push({ i, k: "start‖stop", sa, sb, inv });
      // restart ‖ stop
      await reset();
      expect((await start(appA)).status).toBe(201);
      st.startDelayMs = 60;
      st.stopDelayMs = 30;
      const c = restart(appA).then((r) => r.status);
      await sleep(Math.random() * 40);
      const d = stop(appA).then((r) => r.status);
      const sc = await c;
      const sd = await d;
      inv = await invariant();
      if (inv.emitting || inv.activeSessions !== 0) bad.push({ i, k: "restart‖stop", sc, sd, inv });
      // stop ‖ start (sobre emisión activa)
      await reset();
      expect((await start(appA)).status).toBe(201);
      st.startDelayMs = 60;
      st.stopDelayMs = 30;
      const e = stop(appA).then((r) => r.status);
      await sleep(Math.random() * 20);
      const f = start(appA).then((r) => r.status);
      const se = await e;
      const sf = await f;
      inv = await invariant();
      if (!(inv.emitting === inv.activeSessions > 0) || inv.activeSessions > 1) bad.push({ i, k: "stop‖start", se, sf, inv });
    }
    expect(bad).toEqual([]);
  }, 120_000);
});

describe("EQ6c · P2-4 · entre DOS instancias (lo que el autor afirma cubrir con la recomprobación)", () => {
  it("DEFECTO P2 · start(A) ‖ stop(B): B para el streamer ANTES de que llegue el start de A y marca la BD DESPUÉS de la recomprobación de A ⇒ streamer emitiendo sin sesión activa", async () => {
    let releaseStart!: () => void;
    let releaseStop!: () => void;
    st.holdStartBefore = new Promise<void>((r) => (releaseStart = r));
    st.holdStopAfter = new Promise<void>((r) => (releaseStop = r));
    st.onStopEffect = () => releaseStart(); // el start de A se aplica justo tras el stop de B
    // A: inserta la sesión y manda start (retenido hasta que B pare el streamer).
    const a = start(appA).then((r) => r);
    for (let i = 0; i < 100 && (await activeRows()).length === 0; i++) await sleep(10);
    // B: stop. El efecto (streamer parado) ocurre ya; la RESPUESTA se retiene hasta que A termine.
    const b = stop(appB).then((r) => r);
    const ra = await a; // A: start aplicado → recomprueba → la sesión sigue activa → 201
    releaseStop(); // ahora B marca la sesión como parada
    const rb = await b;
    const inv = await invariant();
    expect({ a: ra.status, b: rb.status }).toEqual({ a: 201, b: 200 });
    // Invariante: el streamer emite ⇔ hay una sesión activa.
    expect(inv).toEqual({ emitting: false, activeSessions: 0 });
  }, 30_000);

  it("DEFECTO P2 · restart(A) ‖ stop(B) con el mismo entrelazado ⇒ la emisión parada resucita", async () => {
    expect((await start(appA)).status).toBe(201);
    let releaseStart!: () => void;
    let releaseStop!: () => void;
    st.holdStartBefore = new Promise<void>((r) => (releaseStart = r));
    st.holdStopAfter = new Promise<void>((r) => (releaseStop = r));
    st.onStopEffect = () => releaseStart();
    const a = restart(appA).then((r) => r);
    await sleep(100);
    const b = stop(appB).then((r) => r);
    const ra = await a;
    releaseStop();
    const rb = await b;
    const inv = await invariant();
    expect({ a: ra.status, b: rb.status }).toEqual({ a: 200, b: 200 });
    expect(inv).toEqual({ emitting: false, activeSessions: 0 });
  }, 30_000);
});

describe("EQ6c · el cerrojo no se queda bloqueado por un streamer colgado", () => {
  const servers: Server[] = [];
  const socks: Socket[] = [];
  afterAll(async () => {
    for (const s of socks) s.destroy();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });
  async function blackhole(kind: "silent" | "headers_then_stall") {
    const srv = createServer((s) => {
      socks.push(s);
      s.on("error", () => {});
      s.on("data", () => {
        if (kind === "headers_then_stall") s.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"state\":");
      });
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }
  for (const kind of ["silent", "headers_then_stall"] as const) {
    it(`CONTROL · streamer ${kind}: start, stop y restart responden en plazo y el siguiente start no queda bloqueado`, async () => {
      const url = await blackhole(kind);
      const app = createApp({
        db: h.db,
        streamer: new HttpStreamerClient(url, undefined, 400),
        streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
        broadcastBaseUrl: "http://web:3000/broadcast",
      });
      const t0 = Date.now();
      const rs = await Promise.all([start(app), stop(app), restart(app), start(app)]);
      const elapsed = Date.now() - t0;
      const view = rs.map((r) => `${r.status}:${JSON.stringify(r.body).slice(0, 120)}`);
      expect(elapsed).toBeLessThan(8000);
      // Los start no pueden «salir bien» contra un streamer colgado (el stop con 200 en cabecera es aceptable).
      expect([rs[0].status, rs[2].status, rs[3].status].every((s) => s >= 400), view.join(" | ")).toBe(true);
      expect((await activeRows()).length).toBe(0);
    }, 30_000);
  }
});

describe("EQ6c · P1 en la API/UI", () => {
  it("CIERRE P1 · si el streamer informa `failed`, el estado de UX es «failed» (no «en directo»)", async () => {
    expect((await start(appA)).status).toBe(201);
    st.stateOverride = "failed";
    const r = await request(appA).get("/admin/streaming").set(auth());
    expect(r.body.uxState).toBe("failed");
  });

  it("DEFECTO P3 · rtmps con el relé aún «connecting» (o reintentando la conexión) se presenta como «En directo»", async () => {
    expect((await start(appA)).status).toBe(201);
    st.stateOverride = "streaming";
    st.relayState = "connecting";
    const s = (await request(appA).get("/admin/streaming").set(auth())).body.settings;
    // Para esta prueba basta con que la configuración sea rtmps: el uxState depende del modo.
    await h.db("streaming_settings").update({ mode: "rtmps" });
    const r = await request(appA).get("/admin/streaming").set(auth());
    await h.db("streaming_settings").update({ mode: s.mode });
    expect(r.body.uxState).not.toBe("live");
  });
});
