/**
 * Revisión independiente · ronda 4 del PR #227 (sobre 25bc372) · API.
 * NO es una suite del autor y NO se mergea.
 *
 *  - `DEFECTO`: hallazgo NUEVO de la ronda 4, en ROJO a propósito sobre 25bc372.
 *  - `CONTROL`: lo que la entrega resiste (verde).
 *  - `OBS`: comportamiento medido que se informa sin pedir cambio (verde).
 *
 * Contra PostgreSQL REAL (embebido). El streamer es falso salvo donde se usa el
 * cliente HTTP real (`HttpStreamerClient`) contra puertos locales o nombres que
 * no resuelven: nada sale de 127.0.0.1.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { reconcileOrphanEmission, startOrphanReconciler } from "./routes/streaming.js";
import {
  HttpStreamerClient,
  StreamerUnavailable,
  streamerClientFromEnv,
  type StreamerCallResult,
  type StreamerClient,
} from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Streamer falso como el de eq5e, con dos retenciones opcionales:
 *  - `holdNextStatus`: el GET /status toma la FOTO al recibirse y la ENTREGA cuando
 *    se suelta (latencia de red / bucle de eventos ocupado);
 *  - `holdNextStop`: el POST /control/stop queda en vuelo y se APLICA al soltarlo.
 */
class Streamer implements StreamerClient {
  configured = true;
  active: string | null = null;
  /** Sin sesión (STREAM_AUTOSTART=1 en el streamer real). */
  autostart = false;
  stops = 0;
  stopThrows = false;
  startFailure: "throw" | 503 | "503-not-applied" | null = null;
  holdNextStatus: Promise<void> | null = null;
  holdNextStop: Promise<void> | null = null;
  statusCalls = 0;
  snapshot() {
    const emitting = !!this.active || this.autostart;
    return {
      state: emitting ? "streaming" : "stopped",
      desired: emitting,
      mode: "record",
      session: this.active ? { sessionId: this.active, mode: "record" } : null,
      relay: { state: null },
      capabilities: { nvenc: false, sealedCredentials: true },
    };
  }
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status") {
      this.statusCalls++;
      const snap = this.snapshot();
      const hold = this.holdNextStatus;
      this.holdNextStatus = null;
      if (hold) await hold;
      return ok(snap);
    }
    if (path === "/control/start") {
      const b = body as { sessionId: string; replace?: boolean };
      if (this.startFailure === "503-not-applied") return { ok: false, status: 503, body: { error: "x" } as T };
      if ((this.active || this.autostart) && b.replace !== true)
        return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.active = b.sessionId;
      this.autostart = false;
      if (this.startFailure === "throw") throw new StreamerUnavailable("el streamer no responde");
      if (this.startFailure === 503) return { ok: false, status: 503, body: { error: "ocupado" } as T };
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      const hold = this.holdNextStop;
      this.holdNextStop = null;
      if (hold) await hold;
      if (this.stopThrows) throw new StreamerUnavailable("el streamer no responde");
      this.stops++;
      const wasActive = !!this.active || this.autostart;
      this.active = null;
      this.autostart = false;
      return ok({ state: "stopped", wasActive });
    }
    if (path === "/recordings") return ok({ files: [], count: 0, totalBytes: 0, disk: { freeBytes: 1e11 } });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let st: Streamer;
let app: Express;
let admin: string;
let battle: string;
const auth = () => ({ Authorization: `Bearer ${admin}` });
const start = () =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth())
    .send({ target: { kind: "battle", id: battle } });
const stop = () => request(app).post("/admin/streaming/stop").set(auth()).send({});
const activeRows = () => h.db("streaming_sessions").where({ state: "active" });
const auditOf = (action: string) => h.db("audit_log").where({ action }).orderBy("id", "desc");

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
  const bot = await createPublishedBot(h.db, `r4-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });
}, 180_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  Object.assign(st, {
    active: null,
    autostart: false,
    stops: 0,
    stopThrows: false,
    startFailure: null,
    holdNextStatus: null,
    holdNextStop: null,
    statusCalls: 0,
  });
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
});

describe("R4 · reconciliador periódico: carrera «leer streamer» → «leer BD» (una sola réplica)", () => {
  it("DEFECTO P2 · foto de /status ANTERIOR a un stop(A)+start(B) del operador ⇒ el reconciliador para B, que es LEGÍTIMA y está activa en BD", async () => {
    // A emite y está activa.
    expect((await start()).status).toBe(201);
    const [a] = await activeRows();
    expect(st.active).toBe(a.id);
    // Tick periódico: la foto de /status (emite A) se toma ya, pero llega tarde.
    let release!: () => void;
    st.holdNextStatus = new Promise<void>((r) => (release = r));
    const tick = reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    while (st.statusCalls === 0) await sleep(1);
    // Mientras, el operador para A y arranca B (dentro del cerrojo de la ruta, que el
    // reconciliador periódico NO toma).
    expect((await stop()).status).toBe(200);
    expect((await start()).status).toBe(201);
    const [b] = await activeRows();
    expect(st.active).toBe(b.id);
    release();
    const outcome = await tick;
    // Lo que debería pasar: B es la sesión activa y la que emite ⇒ nada que hacer.
    expect({ outcome, emitting: st.active, activeInDb: (await activeRows()).map((r) => r.id) }).toEqual({
      outcome: null,
      emitting: b.id,
      activeInDb: [b.id],
    });
  });

  it("DEFECTO P2 · el stop del reconciliador va en vuelo (no condicionado a la sesión) y aterriza tras un start(B) ⇒ corta B", async () => {
    // Huérfana real (sin sesión en BD) que el reconciliador decide parar...
    st.active = randomUUID();
    let release!: () => void;
    st.holdNextStop = new Promise<void>((r) => (release = r));
    const tick = reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    await sleep(20);
    // ...pero antes de que su stop aterrice, el huérfano desaparece (el stop
    // compensatorio de otra petición, o el propio streamer al fallar) y el operador arranca B.
    st.active = null;
    expect((await start()).status).toBe(201);
    const [b] = await activeRows();
    release();
    await tick;
    // Un stop condicionado («para la sesión X») no tocaría B.
    expect({ emitting: st.active, activeInDb: (await activeRows()).map((r) => r.id) }).toEqual({
      emitting: b.id,
      activeInDb: [b.id],
    });
  });

  it("CONTROL · sesión recién creada: el INSERT de start se confirma antes de llamar al streamer (sin transacción abierta), el reconciliador la ve y no la para", async () => {
    // El tick lee /status justo después de que el streamer aplique el start.
    const r = start();
    const p = (async () => {
      while (!st.active) await sleep(0);
      return reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    })();
    expect((await r).status).toBe(201);
    expect(await p).toBeNull();
    expect(st.stops).toBe(0);
  });
});

describe("R4 · reconciliador en PRODUCCIÓN sin perfil `streaming` (Compose fija STREAMER_CONTROL_URL=http://streamer:8090)", () => {
  it("CONTROL · streamerClientFromEnv sin URL ⇒ no configurado ⇒ startOrphanReconciler no arma nada", () => {
    expect(startOrphanReconciler(h.db, streamerClientFromEnv({}))).toBeNull();
  });

  for (const [name, url] of [
    ["nombre que no resuelve", "http://streamer.invalid:8090"],
    ["puerto cerrado", "http://127.0.0.1:1"],
  ] as const) {
    it(`CONTROL · ${name}: el tick es silencioso, no toca la BD y el timer no retiene el proceso`, async () => {
      const queries: string[] = [];
      const onQuery = (q: { sql: string }) => queries.push(q.sql);
      h.db.on("query", onQuery);
      const warn = vi.spyOn(console, "warn");
      const error = vi.spyOn(console, "error");
      const log = vi.spyOn(console, "log");
      try {
        const t = startOrphanReconciler(h.db, new HttpStreamerClient(url, undefined), 40)!;
        expect(t).not.toBeNull();
        expect(t.hasRef()).toBe(false);
        await sleep(400);
        clearInterval(t);
        expect({ warn: warn.mock.calls.length, error: error.mock.calls.length, log: log.mock.calls.length }).toEqual({
          warn: 0,
          error: 0,
          log: 0,
        });
        expect(queries).toEqual([]);
      } finally {
        h.db.removeListener("query", onQuery);
        warn.mockRestore();
        error.mockRestore();
        log.mockRestore();
      }
    });
  }

  it("OBS · coste por tick con streamer que responde: 1 GET /status y, si no emite, 0 consultas a la BD", async () => {
    let hits = 0;
    const srv: Server = createServer((req, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ state: "stopped", desired: false, session: null }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const queries: string[] = [];
    const onQuery = (q: { sql: string }) => queries.push(q.sql);
    h.db.on("query", onQuery);
    try {
      const c = new HttpStreamerClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, undefined);
      for (let i = 0; i < 5; i++) expect(await reconcileOrphanEmission(h.db, c, { trigger: "periodic" })).toBeNull();
      expect({ hits, queries: queries.length }).toEqual({ hits: 5, queries: 0 });
    } finally {
      h.db.removeListener("query", onQuery);
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("R4 · reconciliador: auditoría y bucles", () => {
  it("OBS P3 · streamer que responde a /status pero cuyo stop falla: CADA tick inserta un `orphan_stopped` con streamerStopped=false (sin límite)", async () => {
    st.active = randomUUID();
    st.stopThrows = true;
    const before = (await auditOf("streaming.session.orphan_stopped")).length;
    for (let i = 0; i < 10; i++)
      expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stop_failed");
    const rows = await auditOf("streaming.session.orphan_stopped");
    expect(rows.length - before).toBe(10); // 10 ticks ⇒ 10 filas (≈ 2 880 al día a 30 s)
    expect(rows[0].detail).toMatchObject({ streamerStopped: false, trigger: "periodic" });
  });

  it("OBS P3 · STREAM_AUTOSTART=1 (emisión sin sesión) ⇒ el reconciliador la para en el siguiente tick y lo audita", async () => {
    st.autostart = true;
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stopped");
    expect(st.autostart).toBe(false);
    const [a] = await auditOf("streaming.session.orphan_stopped");
    expect(a.detail).toMatchObject({ emittingSession: null, activeSession: null, streamerStopped: true });
  });

  it("CONTROL · la auditoría `orphan_stopped` no lleva la clave ni el sobre", async () => {
    st.active = randomUUID();
    await reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    const [a] = await auditOf("streaming.session.orphan_stopped");
    expect(JSON.stringify(a)).not.toMatch(/credential|sealed|ciphertext|stream_?key/i);
  });
});

describe("R4 · R3-E · stop compensatorio", () => {
  it("CONTROL · 503 SIN aplicar (nada emitía) ⇒ stop compensatorio inocuo, auditado `start_compensated`", async () => {
    st.startFailure = "503-not-applied";
    const r = await start();
    expect(r.status).toBe(502);
    expect(st.active).toBeNull();
    expect(await activeRows()).toHaveLength(0);
    const [a] = await auditOf("streaming.session.start_compensated");
    expect(a.detail).toMatchObject({ cause: "streamer_503", otherSessionActive: false });
  });

  it("OBS · el `outcome` del compensatorio dice `stopped` aunque el streamer no emitiera nada (no distingue wasActive)", async () => {
    st.startFailure = "503-not-applied";
    await start();
    const [a] = await auditOf("streaming.session.start_compensated");
    expect(a.detail.outcome).toBe("stopped");
  });

  it("CONTROL · tras el compensatorio, un start nuevo arranca y NO lo para ningún resto del anterior", async () => {
    st.startFailure = "throw";
    expect((await start()).status).toBe(503);
    st.startFailure = null;
    expect((await start()).status).toBe(201);
    const [b] = await activeRows();
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBeNull();
    expect(st.active).toBe(b.id);
  });
});
