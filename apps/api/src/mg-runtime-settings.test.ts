/**
 * MG · Ajustes de runtime (espectador / replays públicos) y estado efectivo del broadcast.
 *
 * Garantías (cada una con su mutante en scripts/mg-runtime-settings-mutants.sh):
 *  - ADMIN_RUNTIME_SETTINGS: sólo admin lee y cambia; booleanos estrictos; auditoría.
 *  - PUBLIC_SPECTATE_TOGGLE / PUBLIC_REPLAYS_TOGGLE: el flag persistido decide el acceso
 *    anónimo EN CALIENTE (misma app, sin reiniciar) y en el gateway de otro proceso.
 *  - BROADCAST_EFFECTIVE_STATE: broadcastAvailable/reason coinciden con lo que un anónimo
 *    puede leer DE VERDAD por la ruta que usa /broadcast.
 *  - RUNTIME_CONFIG_PERSISTENCE: bootstrap desde el entorno, persistencia tras reinicio
 *    (otra instancia de la app sobre la misma BD) y propagación a otro proceso.
 *  - NO_SECRET_LEAK: la clave de emisión no sale por API, logs, métricas ni argv.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { WebSocket } from "ws";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { RuntimeSettingsStore, publicVisibilityFromEnv, AUDIT_ACTION } from "./runtime-settings.js";
import { SpectateGateway, spectateProtocols, type SpectatableBattle } from "./spectate/gateway.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";
import type { StreamerCallResult, StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";

class FakeStreamer implements StreamerClient {
  constructor(public configured = true) {}
  async call<T>(_m: "GET" | "POST", path: string): Promise<StreamerCallResult<T>> {
    if (path === "/status") return { ok: true, status: 200, body: { state: "idle", capabilities: {} } as T };
    return { ok: false, status: 404, body: {} as T };
  }
}

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let h: TestDbHandle;
let store: RuntimeSettingsStore;
let app: Express;
let admin: string;
let adminId: string;
let user: string;
const B: Record<string, string> = {};
const PATH = "/admin/settings/public-access";
const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {});

async function newBattle(status: string, opts: { privateBot?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    started_at: status === "scheduled" ? null : h.db.fn.now(),
    finished_at: status === "finished" ? h.db.fn.now() : null,
    result: status === "finished" ? JSON.stringify({ score: { red: 1 }, ticks: 9 }) : null,
    // getPublicReplay sólo mira la fila (no abre el fichero).
    replay_ref: status === "finished" ? `/nonexistent/${id}.jsonl.gz` : null,
  });
  const bot = await createPublishedBot(h.db, `mg-${id.slice(0, 8)}`);
  if (opts.privateBot) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

/** `who`: "anon" = sin cabecera (OJO: `undefined` NO sirve, activaría el valor por defecto). */
async function patch(body: unknown, who: string = admin) {
  return request(app)
    .patch(PATH)
    .set(auth(who === "anon" ? undefined : who))
    .send(body as object);
}

async function setFlags(publicSpectateEnabled: boolean, publicReplaysEnabled: boolean) {
  const r = await patch({ publicSpectateEnabled, publicReplaysEnabled });
  expect(r.status).toBe(200);
}

const anonGet = (p: string) => request(app).get(p);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  // Igual que server.ts: bootstrap desde el "entorno" (aquí, los dos apagados) y cargado.
  store = new RuntimeSettingsStore(h.db, {
    defaults: { publicSpectate: false, publicReplays: false },
    bootstrap: true,
    refreshMs: 100,
  });
  await store.refresh();
  app = createApp({
    db: h.db,
    runtimeSettings: store,
    streamer: new FakeStreamer(true),
    streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
  });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  user = await tokenFor(h.db, DEV_USERS.user);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  B.running = await newBattle("running");
  B.finished = await newBattle("finished");
  B.scheduled = await newBattle("scheduled");
  B.failed = await newBattle("failed");
  B.runningPriv = await newBattle("running", { privateBot: true });
  B.finishedPriv = await newBattle("finished", { privateBot: true });
}, 180_000);

afterAll(async () => {
  store.stop();
  await h.stop();
});

describe("MG · ADMIN_RUNTIME_SETTINGS · RBAC, booleanos estrictos y auditoría", () => {
  it("anónimo ⇒ 401 y usuario normal ⇒ 403 en GET y PATCH; nada cambia", async () => {
    const before = await h.db("app_runtime_settings").first();
    expect((await anonGet(PATH)).status).toBe(401);
    expect((await request(app).get(PATH).set(auth(user))).status).toBe(403);
    expect((await patch({ publicSpectateEnabled: true }, "anon")).status).toBe(401);
    expect((await patch({ publicSpectateEnabled: true }, user)).status).toBe(403);
    expect(await h.db("app_runtime_settings").first()).toEqual(before);
    expect(store.publicVisibility().publicSpectate).toBe(false);
  });

  it("admin lee el valor vigente con su origen y la latencia máxima", async () => {
    const r = await request(app).get(PATH).set(auth(admin));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(r.body).toMatchObject({
      publicSpectateEnabled: false,
      publicReplaysEnabled: false,
      source: "database",
      propagationMaxMs: 100,
      effective: { publicSpectate: false, broadcastLiveAvailable: false, reason: "public_spectate_disabled" },
    });
  });

  it.each([
    [{ publicSpectateEnabled: "true" }],
    [{ publicSpectateEnabled: 1 }],
    [{ publicReplaysEnabled: null }],
    [{ publicSpectateEnabled: true, jwtSecret: "x" }],
    [{}],
    [[true]],
  ])("cuerpo no estricto %j ⇒ 400 y no se guarda", async (body) => {
    const r = await patch(body);
    expect(r.status).toBe(400);
    expect((await h.db("app_runtime_settings").first()).public_spectate_enabled).toBe(false);
  });

  it("admin cambia y queda auditado (actor, instante, anterior y nuevo); un PATCH sin cambio no audita", async () => {
    const n0 = Number((await h.db("audit_log").where({ action: AUDIT_ACTION }).count("* as n").first())!.n);
    const r = await patch({ publicReplaysEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      publicReplaysEnabled: true,
      publicSpectateEnabled: false,
      changed: true,
      before: { publicReplaysEnabled: false, publicSpectateEnabled: false },
      updatedBy: adminId,
    });
    const rows = await h.db("audit_log").where({ action: AUDIT_ACTION }).orderBy("id");
    expect(rows.length).toBe(n0 + 1);
    const last = rows.at(-1);
    expect(last.actor_id).toBe(adminId);
    expect(last.at).toBeInstanceOf(Date);
    expect(Date.now() - new Date(last.at).getTime()).toBeLessThan(60_000);
    expect(last.detail).toEqual({
      before: { publicSpectate: false, publicReplays: false },
      after: { publicSpectate: false, publicReplays: true },
    });
    const again = await patch({ publicReplaysEnabled: true });
    expect(again.body.changed).toBe(false);
    expect(await h.db("audit_log").where({ action: AUDIT_ACTION }).count("* as n").first()).toEqual({
      n: String(n0 + 1),
    });
    await setFlags(false, false);
  });
});

describe("MG · PUBLIC_SPECTATE_TOGGLE · en caliente, sin reiniciar", () => {
  it("OFF ⇒ batalla running denegada a anónimo (detalle, ticket y listado); ON ⇒ permitida", async () => {
    await setFlags(false, false);
    expect((await anonGet(`/battles/${B.running}`)).status).toBe(404);
    expect((await request(app).post(`/battles/${B.running}/spectate-ticket`)).status).toBe(404);
    expect((await anonGet("/public/battles/live")).body).toEqual({ enabled: false, battles: [] });
    expect((await anonGet(`/public/battles/${B.running}`)).status).toBe(404);

    await setFlags(true, false); // misma app, misma instancia: cambio en caliente
    expect((await anonGet(`/battles/${B.running}`)).status).toBe(200);
    expect((await request(app).post(`/battles/${B.running}/spectate-ticket`)).status).toBe(201);
    const live = (await anonGet("/public/battles/live")).body;
    expect(live.enabled).toBe(true);
    expect(live.battles.map((b: { id: string }) => b.id)).toContain(B.running);
    // «cuando corresponde»: una batalla con bots privados sigue denegada.
    expect((await anonGet(`/battles/${B.runningPriv}`)).status).toBe(404);
    // El espectador NO abre las terminadas.
    expect((await anonGet(`/battles/${B.finished}`)).status).toBe(404);
    expect((await request(app).get("/system/status").set(auth(admin))).body.publicSpectateEnabled).toBe(true);

    await setFlags(false, false);
    expect((await anonGet(`/battles/${B.running}`)).status).toBe(404);
  });
});

describe("MG · PUBLIC_REPLAYS_TOGGLE · en caliente, sin reiniciar", () => {
  it("OFF ⇒ replay público denegado; ON ⇒ permitido (y la privada sigue denegada)", async () => {
    await setFlags(false, false);
    expect((await anonGet(`/public/replays/${B.finished}`)).status).toBe(404);
    expect((await anonGet("/public/replays")).body).toEqual({ enabled: false, items: [] });
    expect((await anonGet(`/battles/${B.finished}`)).status).toBe(404);
    expect((await anonGet("/replays")).body.items ?? []).toEqual([]);

    await setFlags(false, true);
    expect((await anonGet(`/public/replays/${B.finished}`)).status).toBe(200);
    expect((await anonGet(`/battles/${B.finished}`)).status).toBe(200);
    const list = (await anonGet("/public/replays")).body;
    expect(list.enabled).toBe(true);
    expect(list.items.map((b: { id: string }) => b.id)).toContain(B.finished);
    expect((await anonGet(`/public/replays/${B.finishedPriv}`)).status).toBe(404);
    // Los replays NO abren el directo.
    expect((await anonGet(`/battles/${B.running}`)).status).toBe(404);
    await setFlags(false, false);
    expect((await anonGet(`/public/replays/${B.finished}`)).status).toBe(404);
  });
});

describe("MG · BROADCAST_EFFECTIVE_STATE · lo que /broadcast puede leer de verdad", () => {
  const target = (kind: string, id: string) =>
    request(app).get(`/admin/streaming/target?kind=${kind}&id=${id}`).set(auth(admin));

  it("running pública con SPECTATE=false ⇒ broadcastAvailable=false con motivo; con SPECTATE=true ⇒ true", async () => {
    await setFlags(false, false);
    const off = (await target("battle", B.running)).body;
    expect(off).toMatchObject({
      broadcastAvailable: false,
      reason: "public_spectate_disabled",
      publicBroadcastable: false,
      publicSpectateEffective: false,
      // `broadcastable` sigue siendo la AUTORIZACIÓN por visibilidad (bots públicos).
      broadcastable: true,
    });
    await setFlags(true, false);
    const on = (await target("battle", B.running)).body;
    expect(on).toMatchObject({
      broadcastAvailable: true,
      reason: null,
      publicBroadcastable: true,
      publicSpectateEffective: true,
    });
    await setFlags(false, false);
  });

  it("terminada con REPLAYS=false ⇒ public_replays_disabled; privada ⇒ battle_not_public; programada y fallida", async () => {
    await setFlags(true, false);
    expect((await target("battle", B.finished)).body).toMatchObject({
      broadcastAvailable: false,
      reason: "public_replays_disabled",
    });
    expect((await target("battle", B.runningPriv)).body).toMatchObject({
      broadcastAvailable: false,
      reason: "battle_not_public",
    });
    expect((await target("battle", B.scheduled)).body).toMatchObject({
      broadcastAvailable: false,
      reason: "battle_not_started",
    });
    expect((await target("battle", B.failed)).body).toMatchObject({
      broadcastAvailable: false,
      reason: "battle_not_available",
    });
    await setFlags(false, false);
    expect((await target("battle", B.scheduled)).body.reason).toBe("public_spectate_disabled");
  });

  it("NUNCA «disponible» si la ruta anónima del broadcast no la deja leer (todas las combinaciones)", async () => {
    for (const [s, r] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      await setFlags(s, r);
      for (const id of Object.values(B)) {
        const t = (await target("battle", id)).body;
        const readable = (await anonGet(`/battles/${id}`)).status === 200;
        expect(t.broadcastAvailable, `battle ${id} con spectate=${s} replays=${r}`).toBe(readable);
        if (!t.broadcastAvailable) expect(t.reason).toEqual(expect.any(String));
      }
      const dest = (await request(app).get("/admin/streaming/destinations").set(auth(admin))).body;
      for (const d of dest.battles) {
        expect(d.broadcastAvailable).toBe((await anonGet(`/battles/${d.id}`)).status === 200);
      }
    }
    await setFlags(false, false);
  });

  it("sin streamer configurado ⇒ streaming_not_configured aunque /broadcast pudiera leerla", async () => {
    await setFlags(true, false);
    const noStreamer = createApp({ db: h.db, runtimeSettings: store, streamer: new FakeStreamer(false) });
    const t = (await request(noStreamer).get(`/admin/streaming/target?kind=battle&id=${B.running}`).set(auth(admin)))
      .body;
    expect(t).toMatchObject({ broadcastAvailable: false, reason: "streaming_not_configured" });
    await setFlags(false, false);
  });

  it("torneo: en curso exige espectador público; terminado exige replays públicos", async () => {
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "Copa MG",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "running",
        created_by: adminId,
      })
      .returning("id");
    await setFlags(false, true);
    expect((await target("tournament", t.id)).body).toMatchObject({
      broadcastAvailable: false,
      reason: "public_spectate_disabled",
    });
    await setFlags(true, false);
    expect((await target("tournament", t.id)).body).toMatchObject({ broadcastAvailable: true, reason: null });
    await h.db("tournaments").where({ id: t.id }).update({ state: "finished" });
    expect((await target("tournament", t.id)).body.reason).toBe("public_replays_disabled");
    await setFlags(false, false);
  });
});

describe("MG · RUNTIME_CONFIG_PERSISTENCE", () => {
  it("el entorno es el bootstrap: S9_PUBLIC_SPECTATE_ENABLED=true sin fila ⇒ fila con spectate=true", async () => {
    const h2 = await startTestDb();
    try {
      const env = publicVisibilityFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "true" } as NodeJS.ProcessEnv);
      expect(env).toEqual({ publicSpectate: true, publicReplays: false });
      // El worker (bootstrap:false) NO crea la fila: sigue con su entorno.
      const worker = new RuntimeSettingsStore(h2.db, { defaults: { publicSpectate: false, publicReplays: true } });
      await worker.refresh();
      expect(await h2.db("app_runtime_settings").first()).toBeUndefined();
      expect(worker.snapshot().source).toBe("environment");
      // La API sí: adopta SU entorno.
      const api = new RuntimeSettingsStore(h2.db, { defaults: env, bootstrap: true });
      await api.refresh();
      expect(await h2.db("app_runtime_settings").first()).toMatchObject({
        public_spectate_enabled: true,
        public_replays_enabled: false,
      });
      expect(api.snapshot()).toMatchObject({ publicSpectate: true, source: "database" });
      // Y desde entonces manda lo persistido, aunque el entorno de otro proceso diga otra cosa.
      await worker.refresh();
      expect(worker.publicVisibility()).toEqual({ publicSpectate: true, publicReplays: false });
      const otherEnv = new RuntimeSettingsStore(h2.db, {
        defaults: { publicSpectate: false, publicReplays: true },
        bootstrap: true,
      });
      await otherEnv.refresh();
      expect(otherEnv.publicVisibility()).toEqual({ publicSpectate: true, publicReplays: false });
    } finally {
      await h2.stop();
    }
  }, 120_000);

  it("persistencia tras reinicio: una NUEVA instancia de la app sobre la misma BD usa lo guardado, no el entorno", async () => {
    await setFlags(true, true);
    const fresh = new RuntimeSettingsStore(h.db, {
      defaults: { publicSpectate: false, publicReplays: false }, // «entorno» apagado
      bootstrap: true,
    });
    expect(fresh.publicVisibility()).toEqual({ publicSpectate: false, publicReplays: false });
    await fresh.refresh(); // arranque (server.ts)
    const app2 = createApp({ db: h.db, runtimeSettings: fresh, streamer: new FakeStreamer(true) });
    expect((await request(app2).get(PATH).set(auth(admin))).body).toMatchObject({
      publicSpectateEnabled: true,
      publicReplaysEnabled: true,
      source: "database",
    });
    expect((await request(app2).get(`/battles/${B.running}`)).status).toBe(200);
    expect((await request(app2).get(`/public/replays/${B.finished}`)).status).toBe(200);
    await setFlags(false, false);
  });

  it("cambio en caliente en OTRO proceso (otra réplica / worker) en ≤ refreshMs, sin reiniciarlo", async () => {
    await setFlags(false, false);
    const other = new RuntimeSettingsStore(h.db, {
      defaults: { publicSpectate: false, publicReplays: false },
      refreshMs: 100,
    });
    await other.refresh();
    other.start();
    try {
      const app3 = createApp({ db: h.db, runtimeSettings: other, streamer: new FakeStreamer(true) });
      expect((await request(app3).get(`/battles/${B.running}`)).status).toBe(404);
      const t0 = Date.now();
      await setFlags(true, false); // por la app 1
      while (!other.publicVisibility().publicSpectate && Date.now() - t0 < 3_000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(other.publicVisibility().publicSpectate).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect((await request(app3).get(`/battles/${B.running}`)).status).toBe(200);
    } finally {
      other.stop();
      await setFlags(false, false);
    }
  });

  it("gateway del worker con el getter: el ticket anónimo se acepta o se rechaza según el valor vigente", async () => {
    await setFlags(false, false);
    // «Entorno» del worker ON, pero la fila dice OFF: manda la fila.
    const worker = new RuntimeSettingsStore(h.db, { defaults: { publicSpectate: true, publicReplays: false } });
    await worker.refresh();
    expect(worker.publicVisibility().publicSpectate).toBe(false);
    const gw = new SpectateGateway({ publicSpectateEnabled: () => worker.publicVisibility().publicSpectate });
    const live: SpectatableBattle = {
      snapshots: [{ tick: 1, vehicles: [], projectiles: [], score: {}, objectives: [] }],
      publicEvents: [],
      isFinished: () => false,
      getResult: () => null,
    };
    gw.attachBattle(B.running, live);
    // El ticket anónimo lo emite la API (que necesita el directo ON en SU copia).
    const anonTicket = async (): Promise<string> => {
      await setFlags(true, false);
      const r = await request(app).post(`/battles/${B.running}/spectate-ticket`);
      expect(r.status).toBe(201);
      return r.body.ticket as string;
    };
    const connectWith = (ticket: string) =>
      new Promise<{ served: boolean; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${B.running}`, spectateProtocols(ticket));
        ws.once("message", () => {
          ws.terminate();
          resolve({ served: true });
        });
        ws.once("close", (code) => resolve({ served: false, code }));
        ws.once("error", () => resolve({ served: false, code: -1 }));
      });
    try {
      const t1 = await anonTicket();
      await setFlags(false, false);
      await worker.refresh(); // relectura periódica del worker
      expect(await connectWith(t1)).toEqual({ served: false, code: 4403 });
      const t2 = await anonTicket(); // la admin lo activa
      await worker.refresh();
      expect(await connectWith(t2)).toEqual({ served: true });
    } finally {
      gw.close();
      await setFlags(false, false);
    }
  });
});

describe("MG · NO_SECRET_LEAK · la clave de emisión no sale tras guardarla", () => {
  const KEY = `mg-${randomBytes(12).toString("hex")}-WXYZ`;
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("ni respuestas de la API (admin incluida), ni logs, ni métricas, ni argv, ni auditoría", async () => {
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))),
      );
    }
    const appM = createApp({
      db: h.db,
      runtimeSettings: store,
      streamer: new FakeStreamer(true),
      streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
      metricsEnabled: true,
    });
    const put = await request(appM)
      .put("/admin/streaming/credentials/youtube")
      .set(auth(admin))
      .send({ streamKey: KEY });
    expect(put.status).toBe(200);
    const bodies: string[] = [JSON.stringify(put.body)];
    for (const p of [
      "/admin/streaming",
      `/admin/streaming/target?kind=battle&id=${B.running}`,
      "/admin/streaming/destinations",
      "/admin/streaming/audit",
      PATH,
      "/system/status",
      "/admin/audit-log",
    ]) {
      const r = await request(appM).get(p).set(auth(admin));
      expect(r.status, p).toBe(200);
      bodies.push(JSON.stringify(r.body));
    }
    const pa = await request(appM).patch(PATH).set(auth(admin)).send({ publicSpectateEnabled: false });
    bodies.push(JSON.stringify(pa.body));
    const metrics = await request(appM).get("/metrics");
    expect(metrics.status).toBe(200);
    const audit = (await h.db.raw(`SELECT row_to_json(x)::text AS j FROM audit_log x`)).rows.map((x: any) => x.j);
    const settingsRow = JSON.stringify(await h.db("app_runtime_settings").first());
    const haystack = [...bodies, metrics.text, ...logged, process.argv.join(" "), ...audit, settingsRow].join("\n");
    // Control positivo: la masca (****WXYZ) sí aparece; la clave completa, no.
    expect(haystack).toContain("****WXYZ");
    expect(haystack).not.toContain(KEY);
    expect(haystack).not.toContain(KEY.slice(0, 20));
  });
});
