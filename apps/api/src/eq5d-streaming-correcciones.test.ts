/**
 * EQ5d · Regresiones propias de las correcciones de la re-revisión EQ6c (ronda 2)
 * en la API, contra PostgreSQL REAL. Complementan las pruebas de rotura del
 * revisor (eq6c-streaming-break.test.ts) aislando CADA barrera:
 *
 *  - P2 · (a) el start vuelve a leer la configuración DENTRO del cerrojo: si se
 *    desactivó durante las comprobaciones previas, ni siquiera llama al
 *    streamer; (b) al responder el streamer recomprueba `enabled` (lo que cubre
 *    a otra instancia que desactivó cuando la sesión aún no existía).
 *  - P3-1 · el stop marca la sesión en BD ANTES de llamar a /control/stop.
 *  - P3-5 · «En directo» sólo con el relé publicando; si no, «Iniciando».
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { StreamerUnavailable, type StreamerCallResult, type StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Streamer falso: el EFECTO de start/stop ocurre al recibir la orden. */
class Streamer implements StreamerClient {
  configured = true;
  emitting = false;
  startCalls = 0;
  stopDown = false;
  state: string | null = null;
  relay: { state: string | null } | null = null;
  holdStart: Promise<void> | null = null;
  onStart: (() => void) | null = null;
  holdRecordings: Promise<void> | null = null;
  onRecordings: (() => void) | null = null;
  beforeStopEffect: (() => Promise<void>) | null = null;
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({
        state: this.state ?? (this.emitting ? "streaming" : "stopped"),
        desired: this.emitting,
        capabilities: { nvenc: false, sealedCredentials: true },
        relay: this.relay,
        lastError: null,
      });
    if (path === "/control/start") {
      this.startCalls++;
      this.onStart?.();
      if (this.holdStart) await this.holdStart;
      const replace = (body as { replace?: boolean }).replace === true;
      if (this.emitting && !replace) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.emitting = true;
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      if (this.beforeStopEffect) await this.beforeStopEffect();
      if (this.stopDown) throw new StreamerUnavailable("el streamer no responde");
      this.emitting = false;
      return ok({ state: "stopped" });
    }
    if (path === "/recordings") {
      this.onRecordings?.();
      if (this.holdRecordings) await this.holdRecordings;
      return ok({ dir: "x", files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
    }
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let st: Streamer;
let app: Express;
let admin: string;
let battle: string;
const auth = () => ({ Authorization: `Bearer ${admin}` });
const active = () => h.db("streaming_sessions").where({ state: "active" });
const start = () =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth())
    .send({ target: { kind: "battle", id: battle } });
const getState = async () => (await request(app).get("/admin/streaming").set(auth())).body;
async function put(patch: Record<string, unknown>) {
  const v = (await getState()).settings.version;
  return request(app)
    .put("/admin/streaming/settings")
    .set(auth())
    .send({ version: v, ...patch });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  st = new Streamer();
  app = createApp({
    db: h.db,
    streamer: st,
    streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
    broadcastBaseUrl: "http://web:3000/broadcast",
  });
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
  const bot = await createPublishedBot(h.db, `eq5d-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  expect((await put({ enabled: true, mode: "record" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  Object.assign(st, {
    emitting: false,
    startCalls: 0,
    stopDown: false,
    state: null,
    relay: null,
    holdStart: null,
    onStart: null,
    holdRecordings: null,
    onRecordings: null,
    beforeStopEffect: null,
  });
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });
});

describe("EQ5d · P2 · desactivar con un start en vuelo", () => {
  it("(a) desactivado durante las comprobaciones previas ⇒ el start vuelve a leer dentro del cerrojo, 409 streaming_disabled y NI SIQUIERA llama al streamer", async () => {
    const hold = deferred();
    const reached = deferred();
    st.holdRecordings = hold.promise;
    st.onRecordings = () => reached.resolve();
    const a = start();
    const pending = a.then((r) => r);
    await reached.promise;
    const off = await put({ enabled: false });
    hold.resolve();
    const ra = await pending;
    expect(off.status).toBe(200);
    expect(off.body.stopped).toBe(false);
    expect({ status: ra.status, error: ra.body.error }).toEqual({ status: 409, error: "streaming_disabled" });
    expect(st.startCalls).toBe(0);
    expect({ emitting: st.emitting, active: (await active()).length }).toEqual({ emitting: false, active: 0 });
  });

  it("(b) desactivado (por otra instancia) con el start YA en el streamer ⇒ recomprobación de enabled: para, marca, audita y 409", async () => {
    const hold = deferred();
    const reached = deferred();
    st.holdStart = hold.promise;
    st.onStart = () => reached.resolve();
    const pending = start().then((r) => r);
    await reached.promise;
    expect((await active()).length).toBe(1);
    // Otra instancia guardó enabled=false cuando aún no había sesión: aquí no la ve nadie más.
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: false });
    hold.resolve();
    const ra = await pending;
    expect({ status: ra.status, error: ra.body.error }).toEqual({ status: 409, error: "streaming_disabled" });
    expect({ emitting: st.emitting, active: (await active()).length }).toEqual({ emitting: false, active: 0 });
    const last = await h.db("streaming_sessions").orderBy("started_at", "desc").first();
    expect({ state: last.state, reason: last.stop_reason }).toEqual({ state: "stopped", reason: "disabled" });
    const audit = await h
      .db("audit_log")
      .where({ action: "streaming.session.start_cancelled", target: `streaming:session:${last.id}` })
      .first();
    expect(audit?.detail).toMatchObject({ reason: "disabled_during_operation", streamerStopped: true });
    expect((await getState()).uxState).toBe("disabled");
  });

  it("(b) restart con el streaming desactivado mientras vuela ⇒ 409 streaming_disabled y nada emitiendo", async () => {
    expect((await start()).status).toBe(201);
    const hold = deferred();
    const reached = deferred();
    st.holdStart = hold.promise;
    st.onStart = () => reached.resolve();
    const pending = request(app)
      .post("/admin/streaming/restart")
      .set(auth())
      .send({})
      .then((r) => r);
    await reached.promise;
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: false });
    hold.resolve();
    const rr = await pending;
    expect({ status: rr.status, error: rr.body.error }).toEqual({ status: 409, error: "streaming_disabled" });
    expect({ emitting: st.emitting, active: (await active()).length }).toEqual({ emitting: false, active: 0 });
  });

  it("(c) entre DOS instancias: el PUT de B lee la sesión DESPUÉS de guardar ⇒ para el start de A que se coló entre su comprobación y su escritura", async () => {
    const appB = createApp({
      db: h.db,
      streamer: st,
      streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
      broadcastBaseUrl: "http://web:3000/broadcast",
    });
    // Un bloqueo de fila REAL retiene el UPDATE del PUT de B justo después de su
    // comprobación previa de sesión (que no ve nada: A aún no ha empezado).
    const trx = await h.db.transaction();
    try {
      await trx("streaming_settings").where({ id: 1 }).forUpdate().first();
      const v = (await getState()).settings.version;
      const offP = request(appB)
        .put("/admin/streaming/settings")
        .set(auth())
        .send({ version: v, enabled: false })
        .then((r) => r);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i++) {
        const r = await h.db.raw(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'update %streaming_settings%'",
        );
        waiting = r.rows[0].n;
        if (!waiting) await new Promise((res) => setTimeout(res, 20));
      }
      expect(waiting).toBe(1);
      // A arranca entero mientras B está retenido: su recomprobación aún ve enabled=true.
      const ra = await start();
      expect(ra.status).toBe(201);
      expect(st.emitting).toBe(true);
      await trx.rollback();
      const off = await offP;
      expect({ status: off.status, stopped: off.body.stopped }).toEqual({ status: 200, stopped: true });
    } finally {
      if (!trx.isCompleted()) await trx.rollback();
    }
    expect({ emitting: st.emitting, active: (await active()).length }).toEqual({ emitting: false, active: 0 });
  });

  it("control: desactivar con una emisión activa y confirmStop la para dentro del cerrojo (stopped=true)", async () => {
    expect((await start()).status).toBe(201);
    const r = await put({ enabled: false, confirmStop: true });
    expect({ status: r.status, stopped: r.body.stopped }).toEqual({ status: 200, stopped: true });
    expect({ emitting: st.emitting, active: (await active()).length }).toEqual({ emitting: false, active: 0 });
  });
});

describe("EQ5d · P3-1 · el stop marca la BD antes de llamar al streamer", () => {
  it("cuando /control/stop llega al streamer, la sesión YA figura parada en BD", async () => {
    expect((await start()).status).toBe(201);
    let seen: string | null = null;
    st.beforeStopEffect = async () => {
      const row = await h.db("streaming_sessions").orderBy("started_at", "desc").first();
      seen = row.state;
    };
    const r = await request(app).post("/admin/streaming/stop").set(auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.wasActive).toBe(true);
    expect(seen).toBe("stopped");
  });

  it("streamer caído sin force ⇒ 503, pero la sesión queda parada (la intención manda) y auditada con streamerOk=false", async () => {
    expect((await start()).status).toBe(201);
    st.stopDown = true;
    const r = await request(app).post("/admin/streaming/stop").set(auth()).send({});
    expect(r.status).toBe(503);
    expect((await active()).length).toBe(0);
    const last = await h.db("streaming_sessions").orderBy("started_at", "desc").first();
    const audit = await h
      .db("audit_log")
      .where({ action: "streaming.session.stop", target: `streaming:session:${last.id}` })
      .first();
    expect(audit?.detail).toMatchObject({ streamerOk: false, forced: false });
  });
});

describe("EQ5d · P3-5 · «En directo» sólo con el relé publicando", () => {
  it.each([
    ["rtmps", "streaming", { state: "publishing" }, "live"],
    ["rtmps", "streaming", { state: "connecting" }, "starting"],
    ["rtmps", "streaming", { state: "closed" }, "starting"],
    ["rtmps", "streaming", { state: null }, "starting"],
    ["rtmps", "streaming", null, "starting"],
    ["rtmps", "retrying", { state: "connecting" }, "retrying"],
    ["rtmps", "failed", { state: "closed" }, "failed"],
    ["record", "streaming", null, "recording"],
  ] as const)("modo %s, estado %s, relé %j ⇒ %s", async (mode, state, relay, expected) => {
    await h.db("streaming_settings").where({ id: 1 }).update({ mode });
    st.state = state;
    st.relay = relay as { state: string | null } | null;
    expect((await getState()).uxState).toBe(expected);
  });
});
