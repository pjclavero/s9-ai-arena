/**
 * EQ6b · Revisión adversarial del PR #227 (API de Administración → Streaming)
 * contra PostgreSQL REAL y un streamer FALSO que imita al real (409 si ya emite
 * y no se pide `replace`; latencia configurable en el arranque).
 *
 * Las pruebas `DEFECTO` están en rojo contra eb0f858 a propósito (cada una
 * demuestra un hallazgo del informe EQ6b); las `CONTROL` son ataques que la
 * entrega resiste y deben seguir en verde.
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
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `yt-${randomBytes(12).toString("hex")}-WXYZ`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streamer falso con la semántica del real (control.ts) y latencia de arranque. */
class SlowStreamer implements StreamerClient {
  configured = true;
  calls: { path: string; body: unknown }[] = [];
  emitting = false;
  startDelayMs = 0;
  disk: { totalBytes: number; freeBytes: number } | null = { totalBytes: 1e12, freeBytes: 1e11 };
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    this.calls.push({ path, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status")
      return ok({
        state: this.emitting ? "streaming" : "stopped",
        desired: this.emitting,
        capabilities: { nvenc: false, sealedCredentials: true },
        lastError: null,
      });
    if (path === "/control/start") {
      const replace = (body as { replace?: boolean }).replace === true;
      if (this.startDelayMs) await sleep(this.startDelayMs);
      if (this.emitting && !replace) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.emitting = true;
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      this.emitting = false;
      return ok({ state: "stopped" });
    }
    if (path === "/recordings")
      return ok({ dir: "arena_replays/video", files: [], count: 0, totalBytes: 0, disk: this.disk });
    if (path === "/recordings/retention")
      return ok({ dryRun: false, deleted: [], errors: [], keptCount: 0, keptBytes: 0 });
    if (path === "/control/test") return ok({ ok: true });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let app: Express;
let st: SlowStreamer;
let admin: string;
const tokens: Record<string, string> = {};
let publicBattle: string;
let otherPublicBattle: string;
let privateBattle: string;

async function newBattle(privateBot = false): Promise<string> {
  const id = randomUUID();
  await h
    .db("battles")
    .insert({
      id,
      status: "running",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
    });
  const bot = await createPublishedBot(h.db, `eq6b-${id.slice(0, 8)}`);
  if (privateBot) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}
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
async function activeRows() {
  return h.db("streaming_sessions").where({ state: "active" });
}
async function resetAll() {
  st.emitting = false;
  st.startDelayMs = 0;
  st.disk = { totalBytes: 1e12, freeBytes: 1e11 };
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  st = new SlowStreamer();
  app = createApp({
    db: h.db,
    streamer: st,
    streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
    broadcastBaseUrl: "http://web:3000/broadcast",
  });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  for (const role of ["visitor", "user", "developer", "team_captain", "organizer", "moderator"] as const) {
    tokens[role] = await tokenFor(h.db, DEV_USERS[role]);
  }
  publicBattle = await newBattle();
  otherPublicBattle = await newBattle();
  privateBattle = await newBattle(true);
  // Modo record activado (sin credencial) para las carreras; se sobrescribe donde haga falta.
  expect((await put({ enabled: true, mode: "record" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await resetAll();
});

describe("EQ6b · RBAC de las 12 operaciones", () => {
  const ops = (): [string, string, unknown?][] => [
    ["get", "/admin/streaming"],
    ["put", "/admin/streaming/settings", { version: 1, enabled: false }],
    ["put", "/admin/streaming/credentials/youtube", { streamKey: "x".repeat(20) }],
    ["delete", "/admin/streaming/credentials/youtube"],
    ["get", `/admin/streaming/target?kind=battle&id=${publicBattle}`],
    ["post", "/admin/streaming/test", {}],
    ["post", "/admin/streaming/start", { target: { kind: "battle", id: publicBattle } }],
    ["post", "/admin/streaming/restart", {}],
    ["post", "/admin/streaming/stop", { force: true }],
    ["get", "/admin/streaming/recordings"],
    ["post", "/admin/streaming/retention", { dryRun: false }],
    ["get", "/admin/streaming/audit"],
  ];

  it("CONTROL · anónimo, token basura y TODOS los roles por debajo de admin (incl. capitán, organizador, moderador) ⇒ 401/403 y el streamer no recibe nada", async () => {
    const before = st.calls.length;
    const auditBefore = await h.db("audit_log").where("action", "like", "streaming.%").count("* as n").first();
    for (const [m, p, body] of ops()) {
      const anon = await (request(app) as any)[m](p).send(body ?? undefined);
      expect(anon.status, `${m} ${p} anónimo`).toBe(401);
      const junk = await (request(app) as any)
        [m](p)
        .set({ Authorization: "Bearer eyJhbGciOiJub25lIn0.e30." })
        .send(body ?? undefined);
      expect(junk.status, `${m} ${p} token alg=none`).toBe(401);
      for (const [role, tok] of Object.entries(tokens)) {
        const r = await (request(app) as any)
          [m](p)
          .set(auth(tok))
          .send(body ?? undefined);
        expect(r.status, `${m} ${p} ${role}`).toBe(403);
      }
    }
    expect(st.calls.length).toBe(before);
    const auditAfter = await h.db("audit_log").where("action", "like", "streaming.%").count("* as n").first();
    expect(Number(auditAfter!.n)).toBe(Number(auditBefore!.n));
  });
});

describe("EQ6b · dos emisiones / operaciones cruzadas", () => {
  it("CONTROL · 8 starts simultáneos a destinos distintos ⇒ como mucho una sesión activa", async () => {
    st.startDelayMs = 50;
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "battle", id: i % 2 ? publicBattle : otherPublicBattle } }),
      ),
    );
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect((await activeRows()).length).toBe(1);
  });

  it("DEFECTO P2 · start ‖ stop: un stop durante el arranque deja al streamer EMITIENDO sin sesión activa en la BD (emisión zombi)", async () => {
    st.startDelayMs = 400;
    const start = request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } })
      .then((r) => r);
    await sleep(120); // la sesión ya está insertada y la orden al streamer en vuelo
    const stop = await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    expect(stop.status).toBe(200);
    const s = await start;
    expect(s.status).toBe(201);
    const active = await activeRows();
    // Invariante: el streamer emite ⇔ hay UNA sesión activa en la BD.
    expect({ emitting: st.emitting, activeSessions: active.length }).toEqual({ emitting: false, activeSessions: 0 });
  });

  it("DEFECTO P2 · restart ‖ stop: el reinicio en vuelo resucita la emisión que el operador acaba de parar", async () => {
    const s0 = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(s0.status).toBe(201);
    st.startDelayMs = 400;
    const restart = request(app)
      .post("/admin/streaming/restart")
      .set(auth(admin))
      .send({})
      .then((r) => r);
    await sleep(120);
    const stop = await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    expect(stop.status).toBe(200);
    await restart;
    const active = await activeRows();
    expect({ emitting: st.emitting, activeSessions: active.length }).toEqual({ emitting: false, activeSessions: 0 });
  });

  it("CONTROL · stop idempotente y start idempotente (mismo destino y configuración ⇒ misma sesión)", async () => {
    const a = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    const b = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.session.id).toBe(a.body.session.id);
    const c = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: otherPublicBattle } });
    expect(c.status).toBe(409);
    for (let i = 0; i < 3; i++)
      expect((await request(app).post("/admin/streaming/stop").set(auth(admin)).send({})).status).toBe(200);
    expect((await activeRows()).length).toBe(0);
  });
});

describe("EQ6b · destino e IDs ajenos", () => {
  it("CONTROL · batalla con bot privado de otro usuario ⇒ 409 target_not_public; id inexistente ⇒ 404; id no UUID ⇒ 400", async () => {
    const p = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: privateBattle } });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe("target_not_public");
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "battle", id: randomUUID() } })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "battle", id: "../../etc" } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "replay", id: publicBattle } })
      ).status,
    ).toBe(400);
    expect((await activeRows()).length).toBe(0);
  });

  it("CONTROL · el retardo no se puede forzar: start no admite delay y la orden al streamer no lleva ningún campo de retardo", async () => {
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle }, delaySeconds: 0 });
    // Puede ignorar o rechazar el campo extra, pero nunca propagarlo.
    expect([201, 400, 422]).toContain(r.status);
    const last = st.calls.filter((c) => c.path === "/control/start").pop();
    if (last) {
      expect(JSON.stringify(last.body)).not.toMatch(/delay/i);
    }
  });
});

describe("EQ6b · configuraciones inválidas", () => {
  it("CONTROL · bitrate absurdo, fps/preset arbitrarios, NVENC sin GPU, 60 FPS sin confirmar, file:/rtmp:/credenciales en la ingesta, branding con inyección ⇒ 422", async () => {
    const bad: Record<string, unknown>[] = [
      { videoBitrateKbps: 0 },
      { videoBitrateKbps: 999999 },
      { videoBitrateKbps: 4500.5 },
      { videoBitrateKbps: "4500" },
      { fps: 59 },
      { fps: 60 },
      { preset: "4k" },
      { preset: "1920x1080" },
      { encoder: "nvenc" },
      { encoder: "libx265" },
      { mode: "rtmps", platform: "custom", ingestUrl: "file:///etc/passwd" },
      { mode: "rtmps", platform: "custom", ingestUrl: "rtmp://ingest.example/live" },
      { mode: "rtmps", platform: "custom", ingestUrl: "rtmps://u:p@ingest.example/live" },
      { mode: "rtmps", platform: "custom", ingestUrl: "rtmps://ingest.example/live?key=1" },
      { branding: { eventName: "<script>alert(1)</script>\u0000" } },
      { branding: { logoUrl: "javascript:alert(1)" } },
      { branding: { logoUrl: "//evil.example/x.png" } },
      { branding: { logoUrl: 'https://evil.example/x.png"onerror=alert(1)' } },
      { branding: { primaryColor: "red;background:url(x)" } },
      { foo: 1 },
    ];
    for (const patch of bad) {
      const r = await put(patch);
      expect(r.status, JSON.stringify(patch)).toBe(422);
    }
    // `__proto__` en el JSON CRUDO (un literal JS lo convertiría en prototipo y no viajaría).
    const v = (await settings()).settings.version;
    const raw = await request(app)
      .put("/admin/streaming/settings")
      .set(auth(admin))
      .set("content-type", "application/json")
      .send(`{"version":${v},"branding":{"__proto__":{"polluted":true}}}`);
    expect(raw.status).toBe(422);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("DEFECTO P3 · SSRF de la prueba de ingesta: se aceptan hosts internos de la red Docker, loopback y metadatos", async () => {
    const internal = [
      "rtmps://postgres:5432/live",
      "rtmps://api:3000/live",
      "rtmps://127.0.0.1:8090/live",
      "rtmps://169.254.169.254/live",
      "rtmps://[::1]/live",
    ];
    const accepted: string[] = [];
    for (const u of internal) {
      const r = await put({ mode: "rtmps", platform: "custom", ingestUrl: u });
      if (r.status === 200) accepted.push(u);
    }
    await put({ mode: "record" });
    expect(accepted).toEqual([]);
  });
});

describe("EQ6b · llenar el disco", () => {
  it("CONTROL · menos de 2 GiB libres ⇒ no se empieza a grabar", async () => {
    st.disk = { totalBytes: 1e12, freeBytes: 2 * 1024 ** 3 - 1 };
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("disk_low");
    st.disk = { totalBytes: 1e12, freeBytes: 2 * 1024 ** 3 };
    const ok = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(ok.status).toBe(201);
  });

  it("DEFECTO P3 · fail-open: si el streamer no puede medir el disco (disk: null) se empieza a grabar igualmente", async () => {
    st.disk = null;
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(r.status).not.toBe(201);
  });
});

describe("EQ6b · la clave no sale por la API", () => {
  it("CONTROL · ni en la respuesta del PUT, ni en GET, auditoría, errores o BD en claro", async () => {
    const r = await request(app).put("/admin/streaming/credentials/youtube").set(auth(admin)).send({ streamKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body.masked).toBe("****WXYZ");
    const bad = await request(app)
      .put("/admin/streaming/credentials/youtube")
      .set(auth(admin))
      .send({ streamKey: `${KEY} con espacio` });
    expect(bad.status).toBe(400);
    const surfaces = [
      JSON.stringify(r.body),
      JSON.stringify(bad.body),
      JSON.stringify((await request(app).get("/admin/streaming").set(auth(admin))).body),
      JSON.stringify((await request(app).get("/admin/streaming/audit?limit=200").set(auth(admin))).body),
    ];
    for (const t of ["streaming_settings", "streaming_credentials", "streaming_sessions", "audit_log"]) {
      const rows = await h.db.raw(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
      surfaces.push(...rows.rows.map((x: { j: string }) => x.j));
    }
    const all = surfaces.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(3, 27)); // ni un fragmento largo
  });
});
