/**
 * Revisión independiente · ronda 3 del PR #227 (sobre 787db33) · API contra
 * PostgreSQL REAL. NO es una suite del autor y NO se mergea.
 *
 * Convención:
 *  - `CIERRE`: el hallazgo de la ronda 2 está cerrado por el arreglo (verde en
 *    787db33; en rojo con el mutante que revierte el arreglo, ver el informe).
 *  - `DEFECTO`: hallazgo NUEVO de la ronda 3; en ROJO a propósito sobre 787db33.
 *  - `CONTROL`: lo que la entrega resiste.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
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
const jitter = (max: number) => sleep(Math.random() * max);

/**
 * Streamer falso con la semántica del real (control.ts): start sin `replace`
 * con una emisión activa ⇒ 409; stop idempotente; el EFECTO ocurre al recibir
 * la orden y la RESPUESTA llega después. Latencias aleatorias antes del efecto
 * y antes de la respuesta, o puertas explícitas por llamada.
 */
class RaceStreamer implements StreamerClient {
  configured = true;
  active: string | null = null; // sessionId que emite
  activeMode: string | null = null;
  relayState: string | null = null;
  maxBefore = 0;
  maxAfter = 0;
  startGates: Array<Promise<void>> = []; // puerta ANTES del efecto, una por start (FIFO)
  get emitting() {
    return this.active !== null;
  }
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({
        state: this.active ? "streaming" : "stopped",
        desired: !!this.active,
        mode: this.activeMode,
        capabilities: { nvenc: false, sealedCredentials: true },
        relay: { state: this.active && this.activeMode === "rtmps" ? this.relayState : null, bytesOut: 0 },
        lastError: null,
      });
    if (path === "/control/start") {
      const b = body as { sessionId: string; replace?: boolean; mode: string };
      const gate = this.startGates.shift();
      if (gate) await gate;
      if (this.maxBefore) await jitter(this.maxBefore);
      if (this.active && b.replace !== true) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.active = b.sessionId;
      this.activeMode = b.mode;
      if (this.maxAfter) await jitter(this.maxAfter);
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      if (this.maxBefore) await jitter(this.maxBefore);
      this.active = null;
      this.activeMode = null;
      if (this.maxAfter) await jitter(this.maxAfter);
      return ok({ state: "stopped" });
    }
    if (path === "/recordings")
      return ok({
        dir: "arena_replays/video",
        files: [],
        count: 0,
        totalBytes: 0,
        disk: { totalBytes: 1e12, freeBytes: 1e11 },
      });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let st: RaceStreamer;
let appA: Express;
let appB: Express;
let admin: string;
let battle: string;

const auth = () => ({ Authorization: `Bearer ${admin}` });
const activeRows = () => h.db("streaming_sessions").where({ state: "active" });
const start = (app: Express) =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth())
    .send({ target: { kind: "battle", id: battle } });
const stop = (app: Express) => request(app).post("/admin/streaming/stop").set(auth()).send({});
const restart = (app: Express) => request(app).post("/admin/streaming/restart").set(auth()).send({});
const getAdmin = async (app: Express = appA) => (await request(app).get("/admin/streaming").set(auth())).body;
async function putSettings(app: Express, patch: Record<string, unknown>) {
  const v = (await getAdmin(app)).settings.version;
  return request(app)
    .put("/admin/streaming/settings")
    .set(auth())
    .send({ version: v, ...patch });
}
async function enabled(): Promise<boolean> {
  return (await h.db("streaming_settings").where({ id: 1 }).first()).enabled === true;
}
async function invariant() {
  const rows = await activeRows();
  return { enabled: await enabled(), emitting: st.emitting, activeSessions: rows.length };
}
async function reset(mode: "record" | "rtmps" = "record") {
  st.active = null;
  st.activeMode = null;
  st.relayState = null;
  st.maxBefore = 0;
  st.maxAfter = 0;
  st.startGates = [];
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode });
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  st = new RaceStreamer();
  const mk = (streamer: StreamerClient) =>
    createApp({
      db: h.db,
      streamer,
      streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
      broadcastBaseUrl: "http://web:3000/broadcast",
    });
  // Dos instancias de la API sobre la MISMA BD y el MISMO streamer.
  appA = mk(st);
  appB = mk(st);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  battle = randomUUID();
  await h.db("battles").insert({
    id: battle,
    status: "running",
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
  });
  const bot = await createPublishedBot(h.db, `r3-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  expect((await putSettings(appA, { enabled: true, mode: "record" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await reset();
});

/** Invariante final: desactivado ⇒ nada emite ni hay sesión; activado ⇒ emite ⇔ sesión (≤ 1). */
function violates(inv: { enabled: boolean; emitting: boolean; activeSessions: number }): boolean {
  if (inv.activeSessions > 1) return true;
  if (!inv.enabled) return inv.emitting || inv.activeSessions !== 0;
  return inv.emitting !== inv.activeSessions > 0;
}

// ── P2 de la ronda 2: carreras REPETIDAS con latencias aleatorias ───────────
describe("R3 · P2 (ronda 2) · `enabled:false` en carrera, muchas veces", () => {
  const N = 40;
  type Scenario = {
    name: string;
    op: () => Express; // instancia que lanza la operación
    put: () => Express; // instancia que desactiva
    kind: "start" | "restart";
    confirmStop: boolean;
  };
  const scenarios: Scenario[] = [
    { name: "start(A) ‖ PUT off(A), confirmStop", op: () => appA, put: () => appA, kind: "start", confirmStop: true },
    {
      name: "start(A) ‖ PUT off(A), sin confirmStop",
      op: () => appA,
      put: () => appA,
      kind: "start",
      confirmStop: false,
    },
    { name: "restart(A) ‖ PUT off(A)", op: () => appA, put: () => appA, kind: "restart", confirmStop: true },
    { name: "start(A) ‖ PUT off(B)", op: () => appA, put: () => appB, kind: "start", confirmStop: true },
    {
      name: "start(A) ‖ PUT off(B), sin confirmStop",
      op: () => appA,
      put: () => appB,
      kind: "start",
      confirmStop: false,
    },
    { name: "restart(A) ‖ PUT off(B)", op: () => appA, put: () => appB, kind: "restart", confirmStop: true },
  ];
  for (const sc of scenarios) {
    it(`CIERRE P2 · ${sc.name}, ${N} veces: con el streaming desactivado nunca queda nada emitiendo`, async () => {
      const bad: unknown[] = [];
      for (let i = 0; i < N; i++) {
        await reset();
        if (sc.kind === "restart") expect((await start(appA)).status).toBe(201);
        st.maxBefore = 25;
        st.maxAfter = 25;
        const v = (await getAdmin(sc.put())).settings.version;
        const op = (sc.kind === "start" ? start(sc.op()) : restart(sc.op())).then((r) => r.status);
        await jitter(30);
        const off = request(sc.put())
          .put("/admin/streaming/settings")
          .set(auth())
          .send({ version: v, enabled: false, confirmStop: sc.confirmStop })
          .then((r) => r.status);
        const [so, sp] = await Promise.all([op, off]);
        st.maxBefore = 0;
        st.maxAfter = 0;
        const inv = await invariant();
        if (violates(inv)) bad.push({ i, op: so, put: sp, inv });
      }
      expect(bad).toEqual([]);
    }, 180_000);
  }
});

// ── Hallazgos nuevos ────────────────────────────────────────────────────────
describe("R3 · DEFECTO P3 · tres operaciones entre dos instancias: la recomprobación no para si hay OTRA sesión", () => {
  it("DEFECTO P3 · start(A) ‖ stop(B) ‖ start(C en B): el start de A aterriza en el streamer, ve la sesión de C activa y no para; C recibe 409 del streamer y marca la suya fallida ⇒ emitiendo SIN sesión", async () => {
    let releaseA!: () => void;
    let releaseC!: () => void;
    st.startGates = [new Promise<void>((r) => (releaseA = r)), new Promise<void>((r) => (releaseC = r))];
    // A: inserta S1 y manda start (retenido ANTES del efecto).
    const a = start(appA).then((r) => r);
    for (let i = 0; i < 200 && (await activeRows()).length === 0; i++) await sleep(5);
    // B: stop (marca S1 parada y para el streamer; el start de A aún no llegó).
    expect((await stop(appB)).status).toBe(200);
    // C (instancia B): nueva sesión S2; su start queda retenido.
    const c = start(appB).then((r) => r);
    for (let i = 0; i < 200 && (await activeRows()).length === 0; i++) await sleep(5);
    expect((await activeRows()).length).toBe(1); // S2
    // Llega el start de A: el streamer emite S1. A recomprueba: S1 parada, pero S2 activa ⇒ no para.
    releaseA();
    const ra = await a;
    // Llega el start de C: el streamer ya emite (S1) ⇒ 409 ⇒ C marca S2 fallida.
    releaseC();
    const rc = await c;
    const inv = await invariant();
    expect({ a: ra.status, c: rc.status }).toEqual({ a: 409, c: 409 }); // control del entrelazado
    // Invariante: el streamer emite ⇔ hay una sesión activa.
    expect({ emitting: inv.emitting, activeSessions: inv.activeSessions, emittingSession: st.active }).toEqual({
      emitting: false,
      activeSessions: 0,
      emittingSession: null,
    });
  }, 30_000);
});

describe("R3 · DEFECTO P3 · el start cuya RESPUESTA se pierde tras aplicar el efecto deja una emisión sin sesión", () => {
  let srv: Server;
  let emitting = false;
  beforeAll(async () => {
    // Streamer HTTP real (cliente de producción HttpStreamerClient): aplica el
    // start al recibirlo y responde tarde (más que el plazo del cliente).
    srv = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const send = (code: number, b: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(b));
        };
        if (req.url === "/status")
          return send(200, {
            state: emitting ? "streaming" : "stopped",
            desired: emitting,
            relay: { state: null },
            capabilities: { nvenc: false, sealedCredentials: true },
          });
        if (req.url === "/recordings")
          return send(200, { files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
        if (req.url === "/control/start") {
          emitting = true; // EFECTO aplicado
          setTimeout(() => send(200, { state: "streaming" }), 1500); // respuesta tardía
          return;
        }
        if (req.url === "/control/stop") {
          emitting = false;
          return send(200, { state: "stopped" });
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  });
  afterAll(async () => {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });
  it("DEFECTO P3 · start con plazo vencido tras el efecto ⇒ 503, sesión `failed` y el streamer EMITIENDO (no se manda stop compensatorio)", async () => {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const app = createApp({
      db: h.db,
      streamer: new HttpStreamerClient(url, undefined, 400),
      streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
      broadcastBaseUrl: "http://web:3000/broadcast",
    });
    emitting = false;
    const r = await start(app);
    await sleep(1600); // la respuesta tardía llega y se descarta
    const rows = await activeRows();
    const view = { status: r.status, emitting, activeSessions: rows.length };
    await request(app).post("/admin/streaming/stop").set(auth()).send({ force: true });
    expect(view.status).toBe(503); // control: el plazo venció
    expect({ emitting: view.emitting, activeSessions: view.activeSessions }).toEqual({
      emitting: false,
      activeSessions: 0,
    });
  }, 30_000);
});

describe("R3 · DEFECTO P3 · uxState decide con el modo de la CONFIGURACIÓN, no con el de la emisión", () => {
  async function rtmpsReady() {
    await reset("rtmps");
    await h.db("streaming_settings").where({ id: 1 }).update({ platform: "youtube", ingest_url: null });
    const put = await request(appA)
      .put("/admin/streaming/credentials/youtube")
      .set(auth())
      .send({ streamKey: `r3-fake-${randomUUID().slice(0, 8)}` });
    expect(put.status).toBe(200);
  }
  it("DEFECTO P3 · emitiendo en RTMPS (relé publicando) y con `mode: record` guardado pendiente de reinicio ⇒ la UI dice «recording» y no «live»", async () => {
    await rtmpsReady();
    st.relayState = "publishing";
    expect((await start(appA)).status).toBe(201);
    expect((await getAdmin()).uxState).toBe("live"); // control
    const put = await putSettings(appA, { mode: "record" });
    expect(put.status).toBe(200);
    const ui = await getAdmin();
    await stop(appA);
    expect({ pendingRestart: ui.pendingRestart, streamerMode: ui.streamer.mode }).toEqual({
      pendingRestart: true,
      streamerMode: "rtmps",
    });
    expect(ui.uxState).toBe("live");
  }, 30_000);
  it("DEFECTO P3 · grabando (record) y con `mode: rtmps` guardado pendiente de reinicio ⇒ la UI dice «starting» (Iniciando) para siempre", async () => {
    await rtmpsReady();
    await h.db("streaming_settings").where({ id: 1 }).update({ mode: "record" });
    expect((await start(appA)).status).toBe(201);
    expect((await getAdmin()).uxState).toBe("recording"); // control
    const put = await putSettings(appA, { mode: "rtmps" });
    expect(put.status).toBe(200);
    const ui = await getAdmin();
    await stop(appA);
    expect(ui.pendingRestart).toBe(true);
    expect(ui.uxState).toBe("recording");
  }, 30_000);
});
