/**
 * EQ5c · Regresión de las correcciones de la revisión EQ6b (PR #227) en la API,
 * contra PostgreSQL REAL y un streamer falso. Complementa a
 * eq6b-streaming-break.test.ts (las pruebas de rotura del revisor):
 *
 *  - P2-2 · la clave queda atada a su destino de extremo a extremo: sin ingesta
 *    no se puede guardar; si la ingesta cambia, la UI lo dice, se avisa al
 *    guardar y no se arranca (409 credential_unbound); la orden lleva `platform`;
 *  - P2-4 · recomprobación ENTRE instancias: si otra instancia de la API (que no
 *    comparte el cerrojo de proceso) para la sesión mientras el streamer
 *    arranca o reinicia, se para el streamer de verdad y queda auditado;
 *  - P3 · SSRF: formas no canónicas de IPv4, sufijos internos (control positivo:
 *    un host público sí se admite).
 */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import type { StreamerCallResult, StreamerClient } from "./services/streamer-client.js";
import { keyIdOf, openSecret } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `eq5c-${randomBytes(12).toString("hex")}-WXYZ`;

/** Streamer falso; `duringStart` simula lo que hace OTRA instancia mientras arranca. */
class FakeStreamer implements StreamerClient {
  configured = true;
  calls: { path: string; body: unknown }[] = [];
  emitting = false;
  duringStart: (() => Promise<void>) | null = null;
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    this.calls.push({ path, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({ state: this.emitting ? "streaming" : "stopped", capabilities: { nvenc: false }, lastError: null });
    if (path === "/control/start") {
      if (this.duringStart) await this.duringStart();
      this.emitting = true;
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      this.emitting = false;
      return ok({ state: "stopped" });
    }
    if (path === "/control/test") return ok({ ok: true });
    if (path === "/recordings")
      return ok({ files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let app: Express;
let st: FakeStreamer;
let admin: string;
let battle: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function settings() {
  return (await request(app).get("/admin/streaming").set(auth(admin))).body;
}
async function put(patch: Record<string, unknown>) {
  const v = (await settings()).settings.version;
  return request(app)
    .put("/admin/streaming/settings")
    .set(auth(admin))
    .send({ version: v, ...patch });
}
const startReq = () =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth(admin))
    .send({ target: { kind: "battle", id: battle } });
/** Lo que haría un stop en OTRA instancia de la API: marcar la sesión como parada en BD. */
const stopFromOtherInstance = async () => {
  await h
    .db("streaming_sessions")
    .where({ state: "active" })
    .update({ state: "stopped", stopped_at: h.db.fn.now(), stop_reason: "operator" });
};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  st = new FakeStreamer();
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
  const bot = await createPublishedBot(h.db, `eq5c-${battle.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: battle, bot_id: bot.botId, version: 1, team: "red" });
  expect((await put({ enabled: true, mode: "record" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  st.emitting = false;
  st.duringStart = null;
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
});

describe("EQ5c · P2-2 · la clave atada a su destino, de extremo a extremo", () => {
  it("custom sin ingesta ⇒ 409 ingest_missing; con ingesta se sella para ella; cambiarla la invalida (UI, aviso y 409 al arrancar)", async () => {
    expect((await put({ platform: "custom", ingestUrl: null })).status).toBe(200);
    const none = await request(app)
      .put("/admin/streaming/credentials/custom")
      .set(auth(admin))
      .send({ streamKey: KEY });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("ingest_missing");

    expect((await put({ ingestUrl: "rtmps://ingest-a.example.com/live2" })).status).toBe(200);
    const set = await request(app).put("/admin/streaming/credentials/custom").set(auth(admin)).send({ streamKey: KEY });
    expect(set.status).toBe(200);
    const row = await h.db("streaming_credentials").where({ platform: "custom" }).first();
    expect(row.sealed.bind).toEqual({ platform: "custom", ingest: "rtmps://ingest-a.example.com:443/live2" });
    expect(openSecret(row.sealed, PRIV, { platform: "custom", ingest: "rtmps://ingest-a.example.com/live2" })).toBe(
      KEY,
    );

    // Con la ingesta correcta: la orden lleva platform, ingesta y el sobre.
    expect((await put({ mode: "rtmps" })).status).toBe(200);
    const meta = (await settings()).credentials.find((c: { platform: string }) => c.platform === "custom");
    expect(meta).toMatchObject({ compatible: true, incompatibleReason: null });
    const s1 = await startReq();
    expect(s1.status).toBe(201);
    const body = st.calls.filter((c) => c.path === "/control/start").at(-1)!.body as Record<string, unknown>;
    expect(body.platform).toBe("custom");
    expect(body.ingestUrl).toBe("rtmps://ingest-a.example.com/live2");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((await request(app).post("/admin/streaming/stop").set(auth(admin)).send({})).status).toBe(200);

    // Cambia la ingesta: la clave ya no vale para ella.
    const moved = await put({ ingestUrl: "rtmps://ingest-b.example.com/live2" });
    expect(moved.status).toBe(200);
    expect(moved.body.warnings.join(" ")).toMatch(/sellada para otra URL de ingesta/);
    const meta2 = (await settings()).credentials.find((c: { platform: string }) => c.platform === "custom");
    expect(meta2).toMatchObject({ configured: true, compatible: false, incompatibleReason: "ingest_changed" });
    const n = st.calls.filter((c) => c.path === "/control/start").length;
    const s2 = await startReq();
    expect(s2.status).toBe(409);
    expect(s2.body.error).toBe("credential_unbound");
    expect(st.calls.filter((c) => c.path === "/control/start").length).toBe(n); // no se manda nada
    const t = await request(app).post("/admin/streaming/test").set(auth(admin)).send({});
    expect(t.status).toBe(409);
    expect((await h.db("streaming_sessions").where({ state: "active" })).length).toBe(0);
    await put({ mode: "record" });
  });
});

describe("EQ5c · P2-4 · recomprobación entre instancias (sin cerrojo compartido)", () => {
  it("start: otra instancia para la sesión mientras el streamer arranca ⇒ 409 start_cancelled, streamer parado y auditado", async () => {
    st.duringStart = stopFromOtherInstance;
    const r = await startReq();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("start_cancelled");
    expect(st.emitting).toBe(false);
    expect(st.calls.at(-1)!.path).toBe("/control/stop");
    expect((await h.db("streaming_sessions").where({ state: "active" })).length).toBe(0);
    const a = await h
      .db("audit_log")
      .where({ action: "streaming.session.start_cancelled" })
      .orderBy("id", "desc")
      .first();
    expect(a.detail).toMatchObject({ reason: "stopped_during_operation", streamerStopped: true });
  });

  it("restart: otra instancia para la sesión mientras el streamer reinicia ⇒ 409 not_active, streamer parado y auditado", async () => {
    expect((await startReq()).status).toBe(201);
    st.duringStart = stopFromOtherInstance;
    const r = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_active");
    expect(st.emitting).toBe(false);
    expect((await h.db("streaming_sessions").where({ state: "active" })).length).toBe(0);
    expect(await h.db("audit_log").where({ action: "streaming.session.restart_cancelled" }).first()).toBeTruthy();
  });
});

describe("EQ5c · P3 · SSRF de la ingesta", () => {
  it("IPv4 no canónica, sufijos internos e IPv6 internas ⇒ 422; host público ⇒ 200 (control positivo)", async () => {
    for (const u of [
      "rtmps://0x7f.1/live",
      "rtmps://127.1/live",
      "rtmps://2130706433/live",
      "rtmps://10.0.0.5/live",
      "rtmps://192.168.0.10/live",
      "rtmps://172.20.0.3/live",
      "rtmps://100.64.0.1/live",
      "rtmps://[fd00::1]/live",
      "rtmps://[fe80::1]/live",
      "rtmps://[::ffff:127.0.0.1]/live",
      "rtmps://LOCALHOST/live",
      "rtmps://db.internal/live",
      "rtmps://nas.local/live",
      "rtmps://router.home.arpa/live",
      "rtmps://in%67est.example.com/live",
    ]) {
      const r = await put({ mode: "rtmps", platform: "custom", ingestUrl: u });
      expect(r.status, u).toBe(422);
    }
    expect(
      (await put({ mode: "rtmps", platform: "custom", ingestUrl: "rtmps://ingest.example.com/live" })).status,
    ).toBe(200);
    expect((await put({ mode: "rtmps", platform: "custom", ingestUrl: "rtmps://203.0.113.7:443/live" })).status).toBe(
      200,
    );
    await put({ mode: "record" });
  });
});
