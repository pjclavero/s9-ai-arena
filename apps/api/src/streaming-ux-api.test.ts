/**
 * STREAMING-UX · API de las ingestas principal y de respaldo, de «Probar ingesta» y del
 * selector de destinos sin UUID. Se ejecuta contra PostgreSQL REAL y con un streamer
 * FALSO que registra todo lo que recibe.
 *
 * Nombres del encargo (V2):
 *  - YOUTUBE_PRIMARY_INGEST_ACCEPTED, YOUTUBE_BACKUP_INGEST_ACCEPTED,
 *    YOUTUBE_BACKUP_QUERY_ALLOWLIST y ARBITRARY_QUERY_REJECTED;
 *  - PRIMARY_TEST_WORKS y BACKUP_TEST_WORKS, por separado;
 *  - RECENT_BATTLE_SELECTOR, TOURNAMENT_SELECTOR y BLOCKED_DESTINATION_EXPLAINS_REASON
 *    (motivo en el modelo);
 *  - KEY_NEVER_RETURNED: la clave ni vuelve en las respuestas ni se guarda en claro, y
 *    cada sobre (principal y respaldo) sólo abre para SU ingesta.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import type { StreamerCallResult, StreamerClient } from "./services/streamer-client.js";
import { canonicalIngestUrl, keyIdOf, openSecret } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";
import { PLATFORMS, battleLabel, validateIngestsPatch, validIngestUrl } from "./services/streaming.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `yt-${randomBytes(10).toString("hex")}-WXYZ`;
const A = "rtmps://a.rtmps.youtube.com/live2";
const B = "rtmps://b.rtmps.youtube.com/live2?backup=1";
const YT = PLATFORMS.find((p) => p.id === "youtube")!;
const CUSTOM = PLATFORMS.find((p) => p.id === "custom")!;

class FakeStreamer implements StreamerClient {
  configured = true;
  calls: { method: string; path: string; body: any }[] = [];
  state = "idle";
  /** Resultado de /control/test por URL de ingesta. */
  testResult: (url: string) => Record<string, unknown> = () => ({ ok: true, connectMs: 12, tlsVerified: true });
  async call<T>(method: "GET" | "POST", path: string, body?: any): Promise<StreamerCallResult<T>> {
    this.calls.push({ method, path, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status") {
      return ok({
        state: this.state,
        desired: this.state === "streaming",
        capabilities: { nvenc: false, sealedCredentials: true },
        lastError: null,
        relay: { state: this.state === "streaming" ? "publishing" : null, bytesOut: 0 },
        stats: { frames: 1 },
      });
    }
    if (path === "/control/start") {
      this.state = "streaming";
      return ok({ state: "streaming", session: { sessionId: body.sessionId } });
    }
    if (path === "/control/stop") {
      this.state = "stopped";
      return ok({ state: "stopped" });
    }
    if (path === "/control/test") return ok(this.testResult(String(body.ingestUrl)));
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let app: Express;
let fake: FakeStreamer;
let admin: string;
let user: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const state = async () => (await request(app).get("/admin/streaming").set(auth(admin))).body;
const putIngests = (platform: string, body: object, token = admin) =>
  request(app).put(`/admin/streaming/ingests/${platform}`).set(auth(token)).send(body);

async function battle(o: { status: string; privateBot?: boolean; finishedAt?: Date; names: [string, string] }) {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: o.status,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    started_at: new Date(Date.now() - 3_600_000),
    finished_at: o.finishedAt ?? null,
  });
  for (const [i, n] of o.names.entries()) {
    const bot = await createPublishedBot(h.db, `${n}-${id.slice(0, 6)}`);
    if (o.privateBot && i === 0) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
    await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: i === 0 ? "red" : "blue" });
  }
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  fake = new FakeStreamer();
  app = createApp({
    db: h.db,
    streamer: fake,
    streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
    broadcastBaseUrl: "http://web:3000/broadcast",
  });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  user = await tokenFor(h.db, DEV_USERS.user);
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("STREAMING-UX · validador de ingestas (puro)", () => {
  it("capa 2 · la forma canónica que se SELLA conserva `?backup=1` y rechaza cualquier otra query", () => {
    expect(canonicalIngestUrl(B)).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1");
    expect(canonicalIngestUrl(A)).toBe("rtmps://a.rtmps.youtube.com:443/live2");
    for (const q of ["?foo=bar", "?backup=2", "?backup=1&foo=bar", "?token=abc", "?redirect=https://evil.example"]) {
      expect(() => canonicalIngestUrl(`rtmps://b.rtmps.youtube.com/live2${q}`), q).toThrow();
    }
  });

  it("YOUTUBE_PRIMARY_INGEST_ACCEPTED y YOUTUBE_BACKUP_INGEST_ACCEPTED · las dos de YouTube, tal cual", () => {
    const r = validateIngestsPatch(YT, { primaryIngestUrl: A, backupIngestUrl: B });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ primaryIngestUrl: A, backupIngestUrl: B });
  });

  it("YOUTUBE_BACKUP_QUERY_ALLOWLIST · `?backup=1` sólo en el respaldo de YouTube", () => {
    expect(validIngestUrl(B, { allowBackupQuery: true })).toBe(B);
    expect(validIngestUrl(B)).toBeNull(); // sin permiso explícito: rechazada
    expect(validateIngestsPatch(YT, { primaryIngestUrl: B }).errors).not.toEqual([]); // en la principal, no
    expect(
      validateIngestsPatch(CUSTOM, {
        primaryIngestUrl: "rtmps://x.example.com/live",
        backupIngestUrl: "rtmps://y.example.com/live?backup=1",
      }).errors,
    ).not.toEqual([]); // fuera de YouTube, no
  });

  it("ARBITRARY_QUERY_REJECTED · ninguna otra query, ni variantes de la permitida", () => {
    for (const q of [
      "?foo=bar",
      "?redirect=https://evil.example",
      "?token=abc",
      "?backup=2",
      "?backup=1&x=1",
      "?x=1&backup=1",
      "?",
      "?backup=1?",
      "?BACKUP=1",
      "?backup=1#f",
      "?backup",
    ]) {
      expect(validIngestUrl(`rtmps://b.rtmps.youtube.com/live2${q}`, { allowBackupQuery: true }), q).toBeNull();
    }
  });

  it("no se deriva el respaldo de la principal ni se aceptan iguales; respaldo opcional", () => {
    expect(
      validateIngestsPatch(YT, {
        primaryIngestUrl: A,
        backupIngestUrl: "rtmps://A.rtmps.youtube.com:443/live2",
      }).errors.join(),
    ).toMatch(/mismo/);
    expect(validateIngestsPatch(YT, { primaryIngestUrl: A, backupIngestUrl: null })).toMatchObject({
      errors: [],
      backupIngestUrl: null,
    });
    expect(validateIngestsPatch(YT, { primaryIngestUrl: A, otro: 1 }).errors.join()).toMatch(/no admitido/);
  });

  it("nombre legible del destino", () => {
    expect(
      battleLabel([
        { team: "red", botName: "Team A" },
        { team: "blue", botName: "Team B" },
      ]),
    ).toBe("Team A vs Team B");
    expect(
      battleLabel([
        { team: "red", botName: "a" },
        { team: "red", botName: "b" },
        { team: "blue", botName: "c" },
        { team: "blue", botName: "d" },
      ]),
    ).toBe("red vs blue (2v2)");
  });
});

describe("STREAMING-UX · ingestas desde la web", () => {
  it("por defecto: las del catálogo (a.rtmps y b.rtmps ?backup=1); sólo admin puede cambiarlas", async () => {
    const s = await state();
    expect(s.ingests.find((i: { platform: string }) => i.platform === "youtube")).toMatchObject({
      primaryIngestUrl: A,
      backupIngestUrl: B,
      source: "default",
      backupQueryAllowed: true,
    });
    expect((await putIngests("youtube", { primaryIngestUrl: A, backupIngestUrl: B }, user)).status).toBe(403);
    expect((await request(app).get("/admin/streaming/destinations").set(auth(user))).status).toBe(403);
  });

  it("guardar: 422 con query arbitraria; con las válidas se guarda TAL CUAL y se audita", async () => {
    const bad = await putIngests("youtube", {
      primaryIngestUrl: A,
      backupIngestUrl: "rtmps://b.rtmps.youtube.com/live2?token=abc",
    });
    expect(bad.status).toBe(422);
    const custom = "rtmps://b.rtmps.youtube.com/live2?backup=1";
    const r = await putIngests("youtube", {
      primaryIngestUrl: "rtmps://a.rtmps.youtube.com:443/live2",
      backupIngestUrl: custom,
    });
    expect(r.status).toBe(200);
    const row = await h.db("streaming_ingests").where({ platform: "youtube" }).first();
    expect(row.primary_ingest_url).toBe("rtmps://a.rtmps.youtube.com:443/live2");
    expect(row.backup_ingest_url).toBe(custom);
    const a = await h.db("audit_log").where({ action: "streaming.ingests.update" }).orderBy("id", "desc").first();
    expect(a).toBeTruthy();
    // vuelta a los valores del catálogo para el resto
    expect((await putIngests("youtube", { primaryIngestUrl: A, backupIngestUrl: B })).status).toBe(200);
  });

  it("KEY_NEVER_RETURNED · la clave se sella DOS veces, cada sobre sólo para su ingesta, y nunca vuelve", async () => {
    await request(app)
      .put("/admin/streaming/settings")
      .set(auth(admin))
      .send({ version: (await state()).settings.version, enabled: true, mode: "rtmps", platform: "youtube" });
    const r = await request(app).put("/admin/streaming/credentials/youtube").set(auth(admin)).send({ streamKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ masked: "****WXYZ", backup: "ready" });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    const s = await state();
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(s.credentials.find((c: { platform: string }) => c.platform === "youtube")).toMatchObject({
      backup: "ready",
      compatible: true,
    });
    const row = await h.db("streaming_credentials").where({ platform: "youtube" }).first();
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(openSecret(row.sealed, PRIV, { platform: "youtube", ingest: A })).toBe(KEY);
    expect(openSecret(row.sealed_backup, PRIV, { platform: "youtube", ingest: B })).toBe(KEY);
    expect(() => openSecret(row.sealed, PRIV, { platform: "youtube", ingest: B })).toThrow(/otro destino/);
    expect(() => openSecret(row.sealed_backup, PRIV, { platform: "youtube", ingest: A })).toThrow(/otro destino/);
    expect(() =>
      openSecret(row.sealed_backup, PRIV, { platform: "youtube", ingest: "rtmps://evil.example/live2?backup=1" }),
    ).toThrow(/otro destino/);
  });

  it("PRIMARY_TEST_WORKS y BACKUP_TEST_WORKS · se prueban por separado, cada una con su URL y su sobre", async () => {
    fake.calls = [];
    fake.testResult = (url) =>
      url.startsWith("rtmps://b.")
        ? { ok: false, error: "la ingesta no respondió a la conexión (IPv4: ETIMEDOUT)" }
        : { ok: true, connectMs: 40 };
    const r = await request(app).post("/admin/streaming/test").set(auth(admin)).send({});
    expect(r.status).toBe(200);
    expect(r.body.primary).toMatchObject({ ok: true });
    expect(r.body.backup).toMatchObject({ ok: false, error: expect.stringContaining("ETIMEDOUT") });
    const tests = fake.calls.filter((c) => c.path === "/control/test");
    expect(tests.map((c) => c.body.ingestUrl)).toEqual([A, B]);
    expect(tests[0].body.credential.bind.ingest).toBe("rtmps://a.rtmps.youtube.com:443/live2");
    expect(tests[1].body.credential.bind.ingest).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1");
    expect(JSON.stringify(fake.calls)).not.toContain(KEY);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    fake.testResult = () => ({ ok: true, connectMs: 9 });
  });

  it("la orden de arranque lleva las dos ingestas TAL CUAL y los dos sobres; cambiar el respaldo pide reintroducir la clave", async () => {
    const id = await battle({ status: "running", names: ["Uno", "Dos"] });
    fake.calls = [];
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id } });
    expect(r.status).toBe(201);
    const start = fake.calls.find((c) => c.path === "/control/start")!.body;
    expect(start).toMatchObject({ ingestUrl: A, backupIngestUrl: B, platform: "youtube" });
    expect(start.backupCredential.bind.ingest).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1");
    expect(JSON.stringify(start)).not.toContain(KEY);
    await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    // otro respaldo ⇒ el sobre ya no vale para él: needs_key y la orden sale SIN respaldo
    const other = "rtmps://c.rtmps.youtube.com/live2?backup=1";
    const p = await putIngests("youtube", { primaryIngestUrl: A, backupIngestUrl: other });
    expect(p.body.credential.backup).toBe("needs_key");
    expect(p.body.warnings.join()).toMatch(/respaldo/);
    fake.calls = [];
    await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id } });
    const start2 = fake.calls.find((c) => c.path === "/control/start")!.body;
    expect(start2.backupIngestUrl).toBeUndefined();
    expect(start2.backupCredential).toBeUndefined();
    await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    await putIngests("youtube", { primaryIngestUrl: A, backupIngestUrl: B });
  });
});

describe("STREAMING-UX · selector de destinos sin UUID", () => {
  it("RECENT_BATTLE_SELECTOR, TOURNAMENT_SELECTOR y BLOCKED_DESTINATION_EXPLAINS_REASON", async () => {
    const old = await battle({
      status: "finished",
      names: ["Viejo", "Rival"],
      finishedAt: new Date(Date.now() - 86_400_000),
    });
    const recent = await battle({
      status: "finished",
      names: ["Team A", "Team B"],
      finishedAt: new Date(Date.now() - 12 * 60_000),
    });
    const live = await battle({ status: "running", names: ["Vivo", "Otro"] });
    const blocked = await battle({
      status: "finished",
      names: ["Privado", "Público"],
      privateBot: true,
      finishedAt: new Date(Date.now() - 60_000),
    });
    const adminRow = await h.db("users").where({ email: DEV_USERS.admin }).first();
    await h.db("tournaments").insert({
      name: "Copa UX",
      format: "league",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
      created_by: adminRow.id,
      broadcast: true,
    });
    const r = await request(app).get("/admin/streaming/destinations?limit=50").set(auth(admin));
    expect(r.status).toBe(200);
    const ids = r.body.battles.map((b: { id: string }) => b.id);
    expect(ids.indexOf(live)).toBeLessThan(ids.indexOf(blocked)); // en curso primero
    expect(ids.indexOf(blocked)).toBeLessThan(ids.indexOf(recent)); // luego por recencia
    expect(ids.indexOf(recent)).toBeLessThan(ids.indexOf(old));
    const rec = r.body.battles.find((b: { id: string }) => b.id === recent);
    expect(rec).toMatchObject({
      label: expect.stringMatching(/^Team [AB]-\w+ vs Team [AB]-\w+$/),
      status: "finished",
      broadcastable: true,
    });
    expect(rec.finishedAt).toBeTruthy();
    expect(r.body.battles.find((b: { id: string }) => b.id === blocked)).toMatchObject({
      broadcastable: false,
      broadcastBlockedReason: "battle_not_public",
    });
    expect(r.body.tournaments.find((t: { label: string }) => t.label === "Copa UX")).toMatchObject({
      kind: "tournament",
      broadcastable: true,
      tournamentBroadcast: true,
    });
  });
});

// ── Ronda 1 de correcciones ─────────────────────────────────────────────────
describe("Ronda 1 · Q-H1 · sin «cambios pendientes» falsos con las ingestas de YouTube configuradas desde la web", () => {
  it("start y restart guardan la ingesta configurada: pendingRestart=false; cambiarla de verdad ⇒ true", async () => {
    const P2 = "rtmps://a.rtmps.youtube.com:443/live2";
    const B2 = "rtmps://c.rtmps.youtube.com/live2?backup=1";
    expect((await putIngests("youtube", { primaryIngestUrl: P2, backupIngestUrl: B2 })).status).toBe(200);
    await request(app)
      .put("/admin/streaming/settings")
      .set(auth(admin))
      .send({ version: (await state()).settings.version, enabled: true, mode: "rtmps", platform: "youtube" });
    expect(
      (await request(app).put("/admin/streaming/credentials/youtube").set(auth(admin)).send({ streamKey: KEY })).status,
    ).toBe(200);
    const id = await battle({ status: "running", names: ["Pend", "Ing"] });
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id } });
    expect(r.status).toBe(201);
    expect((await state()).pendingRestart).toBe(false);
    const rr = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
    expect(rr.status).toBe(200);
    expect((await state()).pendingRestart).toBe(false);
    // control positivo: un cambio REAL del respaldo sí deja la emisión pendiente de reinicio
    const p = await putIngests("youtube", {
      primaryIngestUrl: P2,
      backupIngestUrl: "rtmps://d.rtmps.youtube.com/live2?backup=1",
    });
    expect(p.body.pendingRestart).toBe(true);
    expect((await state()).pendingRestart).toBe(true);
    await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    await putIngests("youtube", { primaryIngestUrl: A, backupIngestUrl: B });
  });
});
