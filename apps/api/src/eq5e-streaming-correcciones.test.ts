/**
 * EQ5e (revisión ronda 3) · regresión propia de R3-B/R3-E contra PostgreSQL REAL:
 * la reconciliación de emisiones huérfanas (`reconcileOrphanEmission`) y el stop
 * compensatorio de un start sin respuesta, con un streamer falso que informa
 * `session.sessionId` como el real (`supervisor.session()`).
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { reconcileOrphanEmission } from "./routes/streaming.js";
import { StreamerUnavailable, type StreamerCallResult, type StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Streamer falso: emite `active` (sessionId) y lo declara en /status como el real. */
class Streamer implements StreamerClient {
  configured = true;
  active: string | null = null;
  stops = 0;
  /** Si está, el start APLICA el efecto y luego falla así (respuesta perdida). */
  startFailure: "throw" | 503 | null = null;
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({
        state: this.active ? "streaming" : "stopped",
        desired: !!this.active,
        mode: "record",
        session: this.active ? { sessionId: this.active, mode: "record" } : null,
        relay: { state: null },
        capabilities: { nvenc: false, sealedCredentials: true },
      });
    if (path === "/control/start") {
      const b = body as { sessionId: string; replace?: boolean };
      if (this.active && b.replace !== true) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.active = b.sessionId;
      if (this.startFailure === "throw") throw new StreamerUnavailable("el streamer no responde");
      if (this.startFailure === 503) return { ok: false, status: 503, body: { error: "ocupado" } as T };
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      this.stops++;
      this.active = null;
      return ok({ state: "stopped" });
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
  const bot = await createPublishedBot(h.db, `eq5e-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });
}, 180_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  st.active = null;
  st.stops = 0;
  st.startFailure = null;
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
});

describe("EQ5e · R3-B · reconcileOrphanEmission", () => {
  it("emitiendo sin sesión activa ⇒ para y audita `orphan_stopped`", async () => {
    st.active = randomUUID();
    const orphan = st.active;
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stopped");
    expect(st.active).toBeNull();
    const [a] = await auditOf("streaming.session.orphan_stopped");
    expect(a.detail).toMatchObject({ trigger: "periodic", emittingSession: orphan, activeSession: null });
  });
  it("emitiendo la sesión ACTIVA ⇒ no toca nada", async () => {
    expect((await start()).status).toBe(201);
    const [row] = await activeRows();
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBeNull();
    expect(st.active).toBe(row.id);
    expect(st.stops).toBe(0);
  });
  it("emitiendo OTRA sesión distinta de la activa ⇒ para (la activa queda «interrumpida», visible)", async () => {
    expect((await start()).status).toBe(201);
    st.active = randomUUID();
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stopped");
    expect(st.active).toBeNull();
    expect(await activeRows()).toHaveLength(1);
    expect((await request(app).get("/admin/streaming").set(auth())).body.uxState).toBe("interrupted");
  });
  it("sin emitir ⇒ no manda stop", async () => {
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBeNull();
    expect(st.stops).toBe(0);
  });
  it("tras un 409 del streamer al start (emite algo huérfano) ⇒ 409 y el huérfano se para", async () => {
    st.active = randomUUID();
    const r = await start();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("streamer_busy");
    expect(st.active).toBeNull();
    expect(await activeRows()).toHaveLength(0);
    const [a] = await auditOf("streaming.session.orphan_stopped");
    expect(a.detail).toMatchObject({ trigger: "start_conflict" });
  });
});

describe("EQ5e · R3-E · stop compensatorio del start sin respuesta", () => {
  for (const failure of ["throw", 503] as const) {
    it(`start aplicado y respuesta perdida (${failure}) ⇒ ${failure === "throw" ? 503 : 502}, sesión failed, nada emitiendo, auditado`, async () => {
      st.startFailure = failure;
      const r = await start();
      expect(r.status).toBe(failure === "throw" ? 503 : 502);
      expect(st.active).toBeNull();
      expect(await activeRows()).toHaveLength(0);
      const [a] = await auditOf("streaming.session.start_compensated");
      expect(a.detail).toMatchObject({
        cause: failure === "throw" ? "streamer_unreachable" : "streamer_503",
        outcome: "stopped",
        otherSessionActive: false,
      });
    });
  }
});
