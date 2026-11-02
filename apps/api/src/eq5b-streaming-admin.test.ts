/**
 * EQ5b · Administración → Streaming: integración de la API contra PostgreSQL REAL
 * con un streamer FALSO (cliente inyectado que registra lo que recibe).
 *
 * Cubre: RBAC real (sólo admin), la clave entra y no sale (respuesta, estado,
 * BD en claro, auditoría), sellado abrible SÓLO con la privada, validaciones,
 * concurrencia optimista, una sola emisión a la vez (también con peticiones
 * simultáneas), idempotencia, ningún reinicio silencioso, parada al desactivar,
 * destino privado o inexistente, retardo leído de la copia de reglas, y
 * retención con cada borrado auditado.
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
const KEY = `yt-${randomBytes(10).toString("hex")}-ABCD`;

class FakeStreamer implements StreamerClient {
  configured = true;
  calls: { method: string; path: string; body: unknown }[] = [];
  state = "idle";
  nvenc: boolean | null = false;
  retention: Record<string, unknown> = { dryRun: false, deleted: [], errors: [], keptCount: 0, keptBytes: 0 };
  down = false;
  freeBytes = 1e11;
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    this.calls.push({ method, path, body });
    if (this.down) {
      const { StreamerUnavailable } = await import("./services/streamer-client.js");
      throw new StreamerUnavailable("el streamer no responde");
    }
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status") {
      return ok({
        state: this.state,
        desired: this.state === "streaming",
        capabilities: { nvenc: this.nvenc, sealedCredentials: true },
        lastError: null,
        stats: { frames: 1 },
      });
    }
    if (path === "/control/start") {
      this.state = "streaming";
      return ok({ state: "streaming", session: { sessionId: (body as { sessionId: string }).sessionId } });
    }
    if (path === "/control/stop") {
      this.state = "stopped";
      return ok({ state: "stopped" });
    }
    if (path === "/control/test") return ok({ ok: true, tlsVerified: true, keyValidated: false });
    if (path === "/recordings/retention") return ok(this.retention);
    if (path === "/recordings") {
      return ok({
        dir: "arena_replays/video",
        files: [],
        count: 0,
        totalBytes: 0,
        disk: { totalBytes: 1e12, freeBytes: this.freeBytes },
      });
    }
    return { ok: false, status: 404, body: {} as T };
  }
  starts() {
    return this.calls.filter((c) => c.path === "/control/start");
  }
}

let h: TestDbHandle;
let app: Express;
let fake: FakeStreamer;
let admin: string;
let user: string;
let moderator: string;
let publicBattle: string;
let privateBattle: string;
let tournament: string;

async function newBattle(opts: { privateBot?: boolean; rules?: unknown } = {}): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: "running",
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    rules: opts.rules ? JSON.stringify(opts.rules) : null,
  });
  const bot = await createPublishedBot(h.db, `eq5b-${id.slice(0, 8)}`);
  if (opts.privateBot) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function state() {
  return (await request(app).get("/admin/streaming").set(auth(admin))).body;
}
async function put(patch: Record<string, unknown>) {
  const v = (await state()).settings.version;
  return request(app)
    .put("/admin/streaming/settings")
    .set(auth(admin))
    .send({ version: v, ...patch });
}
/** Volcado en TEXTO de todo lo que la BD guarda de streaming + auditoría. */
async function dbText(): Promise<string> {
  const parts: string[] = [];
  for (const t of ["streaming_settings", "streaming_credentials", "streaming_sessions", "audit_log"]) {
    const r = await h.db.raw(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
    parts.push(...r.rows.map((x: { j: string }) => x.j));
  }
  return parts.join("\n");
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
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
  publicBattle = await newBattle({
    rules: { schema: 2, source: "preset", engineRuleset: { spectator: { delaySeconds: 30 } } },
  });
  privateBattle = await newBattle({ privateBot: true });
  const adminRow = await h.db("users").where({ email: DEV_USERS.admin }).first();
  const [t] = await h
    .db("tournaments")
    .insert({
      name: "Copa EQ5b",
      format: "league",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
      created_by: adminRow.id,
    })
    .returning("id");
  tournament = t.id;
}, 180_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(() => {
  fake.down = false;
});

describe("EQ5b · RBAC real", () => {
  const ops: [string, string, unknown?][] = [
    ["get", "/admin/streaming"],
    ["put", "/admin/streaming/settings", { version: 1 }],
    ["put", "/admin/streaming/credentials/youtube", { streamKey: "x".repeat(20) }],
    ["delete", "/admin/streaming/credentials/youtube"],
    ["get", `/admin/streaming/target?kind=battle&id=${randomUUID()}`],
    ["post", "/admin/streaming/test", {}],
    ["post", "/admin/streaming/start", { target: { kind: "battle", id: randomUUID() } }],
    ["post", "/admin/streaming/restart", {}],
    ["post", "/admin/streaming/stop", {}],
    ["get", "/admin/streaming/recordings"],
    ["post", "/admin/streaming/retention", {}],
    ["get", "/admin/streaming/audit"],
  ];
  it("anónimo 401 y usuario normal / moderador 403 en TODAS; el streamer no recibe nada", async () => {
    const before = fake.calls.length;
    for (const [m, p, body] of ops) {
      const r0 = await (request(app) as any)[m](p).send(body ?? undefined);
      expect(r0.status, `${m} ${p} anónimo`).toBe(401);
      for (const tok of [user, moderator]) {
        const r = await (request(app) as any)
          [m](p)
          .set(auth(tok))
          .send(body ?? undefined);
        expect(r.status, `${m} ${p}`).toBe(403);
      }
    }
    expect(fake.calls.length).toBe(before);
  });
});

describe("EQ5b · la clave entra y no sale", () => {
  it("PUT credencial: sólo ****ABCD; sellada (abrible SÓLO con la privada); nunca en claro en la BD", async () => {
    const r = await request(app).put("/admin/streaming/credentials/youtube").set(auth(admin)).send({ streamKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ platform: "youtube", configured: true, masked: "****ABCD" });
    expect(JSON.stringify(r.body)).not.toContain(KEY);

    const row = await h.db("streaming_credentials").where({ platform: "youtube" }).first();
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(openSecret(row.sealed, PRIV)).toBe(KEY); // sólo con la PRIVADA (que la API no tiene)

    const st = await state();
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(JSON.stringify(st)).not.toContain(row.sealed.ct); // ni el sobre sale al navegador
    expect(st.credentials.find((c: { platform: string }) => c.platform === "youtube")).toMatchObject({
      configured: true,
      masked: "****ABCD",
      compatible: true,
    });
    expect(await dbText()).not.toContain(KEY);
    const audit = await request(app).get("/admin/streaming/audit").set(auth(admin));
    expect(audit.body.some((a: { action: string }) => a.action === "streaming.credential.set")).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain(KEY);
  });

  it("clave inválida 400 y plataforma desconocida 404 (sin eco de la clave)", async () => {
    const bad = await request(app)
      .put("/admin/streaming/credentials/youtube")
      .set(auth(admin))
      .send({ streamKey: "con espacios dentro" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("con espacios");
    expect(
      (await request(app).put("/admin/streaming/credentials/__proto__").set(auth(admin)).send({ streamKey: KEY }))
        .status,
    ).toBe(404);
  });

  it("sin almacén sellado (sin clave pública) NO se guarda nada: 503", async () => {
    const app2 = createApp({ db: h.db, streamer: fake, streamingPublicKey: () => null });
    const r = await request(app2)
      .put("/admin/streaming/credentials/custom")
      .set(auth(admin))
      .send({ streamKey: "otra-clave-1234" });
    expect(r.status).toBe(503);
    expect(await h.db("streaming_credentials").where({ platform: "custom" }).first()).toBeUndefined();
  });
});

describe("EQ5b · configuración", () => {
  it("validaciones: bitrate, fps 60 con confirmación, NVENC no confirmado, ingest, branding hostil", async () => {
    expect((await put({ videoBitrateKbps: 50 })).status).toBe(422);
    expect((await put({ fps: 60 })).status).toBe(422);
    expect((await put({ encoder: "nvenc" })).status).toBe(422);
    expect((await put({ branding: { logoUrl: "javascript:alert(1)" } })).status).toBe(422);
    expect((await put({ branding: { primaryColor: "red;background:url(x)" } })).status).toBe(422);
    expect((await put({ branding: { eventName: "a\u0000b" } })).status).toBe(422);
    expect((await put({ platform: "custom", mode: "rtmps", ingestUrl: "rtmp://sin-tls/live" })).status).toBe(422);
    expect((await put({ platform: "custom", mode: "rtmps", ingestUrl: "rtmps://u:p@x/live" })).status).toBe(422);
    expect((await put({ retention: { enabled: true, maxAgeDays: null, maxTotalBytes: null } })).status).toBe(422);
    const v0 = (await state()).settings.version;
    const proto = await request(app)
      .put("/admin/streaming/settings")
      .set(auth(admin))
      .set("content-type", "application/json")
      .send(`{"version":${v0},"__proto__":{"enabled":true}}`);
    expect(proto.status).toBe(422); // clave no admitida, no contamina
    expect((await state()).settings.enabled).toBe(false);
    const ok = await put({ fps: 60, confirmHighFps: true, videoBitrateKbps: 6000 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ fps: 60, videoBitrateKbps: 6000 });
    expect((await put({ fps: 30, videoBitrateKbps: 4500 })).status).toBe(200);
  });

  it("concurrencia optimista: versión vieja ⇒ 409", async () => {
    const v = (await state()).settings.version;
    expect(
      (
        await request(app)
          .put("/admin/streaming/settings")
          .set(auth(admin))
          .send({ version: v, videoBitrateKbps: 5000 })
      ).status,
    ).toBe(200);
    const stale = await request(app)
      .put("/admin/streaming/settings")
      .set(auth(admin))
      .send({ version: v, videoBitrateKbps: 5500 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("version_conflict");
  });
});

describe("EQ5b · destino y retardo", () => {
  it("el retardo sale de la copia de reglas; destino privado y ajeno se distinguen", async () => {
    const t = await request(app).get(`/admin/streaming/target?kind=battle&id=${publicBattle}`).set(auth(admin));
    expect(t.body).toMatchObject({ publicBroadcastable: true, delaySeconds: 30, delaySource: "snapshot" });
    const p = await request(app).get(`/admin/streaming/target?kind=battle&id=${privateBattle}`).set(auth(admin));
    expect(p.body.publicBroadcastable).toBe(false);
    expect(
      (await request(app).get(`/admin/streaming/target?kind=battle&id=${randomUUID()}`).set(auth(admin))).status,
    ).toBe(404);
    expect((await request(app).get(`/admin/streaming/target?kind=battle&id=1;drop`).set(auth(admin))).status).toBe(400);
    expect(
      (await request(app).get(`/admin/streaming/target?kind=tournament&id=${tournament}`).set(auth(admin))).status,
    ).toBe(200);
  });
});

describe("EQ5b · controles", () => {
  it("con el streaming desactivado no se emite (409) y el streamer no recibe start", async () => {
    const n = fake.starts().length;
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("streaming_disabled");
    expect(fake.starts().length).toBe(n);
  });

  it("start: credencial SELLADA al streamer, branding en la URL; idempotente; otra ⇒ 409; simultáneas ⇒ una", async () => {
    expect(
      (
        await put({
          enabled: true,
          mode: "rtmps",
          platform: "youtube",
          branding: { eventName: "Copa EQ5b", accentColor: "#00ff88" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "battle", id: privateBattle } })
      ).body.error,
    ).toBe("target_not_public");
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth(admin))
          .send({ target: { kind: "battle", id: randomUUID() } })
      ).status,
    ).toBe(404);

    // Dos peticiones a la vez: sólo una sesión.
    const [a, b] = await Promise.all([
      request(app)
        .post("/admin/streaming/start")
        .set(auth(admin))
        .send({ target: { kind: "battle", id: publicBattle } }),
      request(app)
        .post("/admin/streaming/start")
        .set(auth(admin))
        .send({ target: { kind: "tournament", id: tournament } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await h.db("streaming_sessions").where({ state: "active" })).toHaveLength(1);
    const winner = a.status === 201 ? { kind: "battle", id: publicBattle } : { kind: "tournament", id: tournament };

    const body = fake.starts().at(-1)!.body as Record<string, any>;
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(openSecret(body.credential, PRIV)).toBe(KEY);
    expect(body.ingestUrl).toBe("rtmps://a.rtmps.youtube.com/live2");
    const u = new URL(body.broadcastUrl);
    expect(u.origin + u.pathname).toBe("http://web:3000/broadcast");
    expect(u.searchParams.get(winner.kind)).toBe(winner.id);
    expect(u.searchParams.get("event")).toBe("Copa EQ5b");
    expect(u.searchParams.get("accent")).toBe("#00ff88");

    const n = fake.starts().length;
    const again = await request(app).post("/admin/streaming/start").set(auth(admin)).send({ target: winner });
    expect(again.status).toBe(200);
    expect(again.body.alreadyActive).toBe(true);
    expect(fake.starts().length).toBe(n); // idempotente: no se reenvía la orden
    expect((await state()).uxState).toBe("live");
  });

  it("guardar con emisión activa NO reinicia en silencio: pendingRestart; «Reiniciar» aplica con replace", async () => {
    const n = fake.starts().length;
    const r = await put({ videoBitrateKbps: 3500 });
    expect(r.status).toBe(200);
    expect(r.body.pendingRestart).toBe(true);
    expect(r.body.impact).toEqual({ videoBitrateKbps: "restart" });
    expect(fake.starts().length).toBe(n);
    expect((await state()).pendingRestart).toBe(true);
    const rs = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
    expect(rs.status).toBe(200);
    const last = fake.starts().at(-1)!.body as Record<string, unknown>;
    expect(last.replace).toBe(true);
    expect(last.videoBitrateKbps).toBe(3500);
    expect((await state()).pendingRestart).toBe(false);
    // Retención: cambio en caliente (no pide reinicio).
    const hot = await put({ retention: { enabled: true, maxAgeDays: 7 } });
    expect(hot.body.impact).toEqual({ retention: "hot" });
    expect(hot.body.pendingRestart).toBe(false);
  });

  it("desactivar con emisión activa exige confirmStop y la para", async () => {
    const r = await put({ enabled: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stop_required");
    const ok = await put({ enabled: false, confirmStop: true });
    expect(ok.status).toBe(200);
    expect(ok.body.stopped).toBe(true);
    expect(fake.calls.at(-2)?.path === "/control/stop" || fake.calls.some((c) => c.path === "/control/stop")).toBe(
      true,
    );
    expect(await h.db("streaming_sessions").where({ state: "active" })).toHaveLength(0);
    expect((await state()).uxState).toBe("disabled");
  });

  it("stop es idempotente; streamer caído ⇒ 503 salvo force", async () => {
    const r1 = await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.wasActive).toBe(false);
    fake.down = true;
    expect((await request(app).post("/admin/streaming/stop").set(auth(admin)).send({})).status).toBe(503);
    expect((await request(app).post("/admin/streaming/stop").set(auth(admin)).send({ force: true })).status).toBe(200);
    expect((await state()).capabilities.streamerReachable).toBe(false);
  });

  it("start con el streamer caído: 503 y la sesión queda failed (no bloquea la siguiente)", async () => {
    await put({ enabled: true });
    fake.down = true;
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(r.status).toBe(503);
    expect(await h.db("streaming_sessions").where({ state: "active" })).toHaveLength(0);
    fake.down = false;
  });

  it("prueba de configuración (sin emisión): manda la credencial SELLADA al streamer", async () => {
    const r = await request(app).post("/admin/streaming/test").set(auth(admin)).send({});
    expect(r.status).toBe(200);
    const body = fake.calls.filter((c) => c.path === "/control/test").at(-1)!.body as Record<string, any>;
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(openSecret(body.credential, PRIV)).toBe(KEY);
  });
});

describe("EQ5b · disco", () => {
  it("no se empieza a grabar con el disco casi lleno (409 disk_low)", async () => {
    await request(app).post("/admin/streaming/stop").set(auth(admin)).send({ force: true });
    expect((await put({ enabled: true, mode: "record" })).status).toBe(200);
    fake.freeBytes = 100 * 1024 * 1024;
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("disk_low");
    fake.freeBytes = 1e11;
    const ok = await request(app)
      .post("/admin/streaming/start")
      .set(auth(admin))
      .send({ target: { kind: "battle", id: publicBattle } });
    expect(ok.status).toBe(201);
    await request(app).post("/admin/streaming/stop").set(auth(admin)).send({});
    expect((await put({ mode: "rtmps" })).status).toBe(200);
  });
});

describe("EQ5b · retención auditada", () => {
  it("cada MP4 borrado queda en audit_log; dryRun no audita borrados", async () => {
    fake.retention = {
      dryRun: false,
      deleted: [
        {
          name: "broadcast-2026-10-01T10-00-00-000Z.mp4",
          sizeBytes: 1000,
          modifiedAt: "2026-10-01T10:00:00.000Z",
          reason: "age",
        },
        {
          name: "broadcast-2026-10-02T10-00-00-000Z.mp4",
          sizeBytes: 2000,
          modifiedAt: "2026-10-02T10:00:00.000Z",
          reason: "age",
        },
      ],
      errors: [],
      keptCount: 1,
      keptBytes: 10,
    };
    const before = await h.db("audit_log").where({ action: "streaming.recording.deleted" }).count("* as n").first();
    await request(app).post("/admin/streaming/retention").set(auth(admin)).send({ dryRun: true });
    const mid = await h.db("audit_log").where({ action: "streaming.recording.deleted" }).count("* as n").first();
    expect(Number(mid!.n)).toBe(Number(before!.n));
    const r = await request(app).post("/admin/streaming/retention").set(auth(admin)).send({});
    expect(r.status).toBe(200);
    const rows = await h.db("audit_log").where({ action: "streaming.recording.deleted" }).orderBy("id");
    expect(rows.length - Number(before!.n)).toBe(2);
    expect(rows.at(-1).target).toBe("recording:broadcast-2026-10-02T10-00-00-000Z.mp4");
    expect(rows.at(-1).detail).toMatchObject({ reason: "age", trigger: "manual", sizeBytes: 2000 });
    const call = fake.calls.filter((c) => c.path === "/recordings/retention").at(-1)!.body as Record<string, any>;
    expect(call.policy).toEqual({ maxAgeDays: 7, maxTotalBytes: null });
  });

  it("al final, nada de la BD ni de la auditoría contiene la clave en claro", async () => {
    expect(await dbText()).not.toContain(KEY);
  });
});
