/**
 * STREAMER · cierre para producción (lado API). PostgreSQL REAL (embebido) y un
 * streamer falso que respeta el contrato de `/control/stop` (incluido `ifSession`).
 * Rojo → verde:
 *  - #241 R4-1 · RECONCILER_START_RACE / RECONCILER_STOP_RACE: el reconciliador
 *    ya no para una sesión legítima con una foto vieja de /status ni con un stop
 *    en vuelo; y no audita en bucle un stop que falla;
 *  - #241 R4-2 · `rollbackNamed` sólo admite la lista cerrada 016/017/018;
 *  - #241 (obs.) · el compensatorio distingue `nothing_to_stop` de `stopped`;
 *  - §13/§31 RESTART_RECOVERY: START tras FAILED o tras reiniciar el streamer emite
 *    de nuevo (antes respondía `alreadyActive` sin emitir nada);
 *  - §3 · `lastSession` con stoppedAt/stopReason, sin secretos;
 *  - §17 · los códigos de error estables (tabla de docs/operations/streaming.md).
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { reconcileOrphanEmission, type ReconcileMemo } from "./routes/streaming.js";
import { NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./db/migrations.js";
import { StreamerUnavailable, type StreamerCallResult, type StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streamer falso con el contrato REAL de stop (`ifSession` ⇒ 409 session_mismatch). */
class Streamer implements StreamerClient {
  configured = true;
  active: string | null = null;
  autostart = false;
  /** «failed»: reintentos agotados (desired, no emite). «idle»: streamer recién reiniciado. */
  forced: "failed" | "idle" | null = null;
  stops = 0;
  stopThrows = false;
  holdNextStatus: Promise<void> | null = null;
  holdNextStop: Promise<void> | null = null;
  statusCalls = 0;
  unreachable = false;
  snapshot() {
    if (this.forced === "idle") return { state: "idle", desired: false, session: null, relay: { state: null } };
    if (this.forced === "failed")
      return {
        state: "failed",
        desired: true,
        session: this.active ? { sessionId: this.active, mode: "record" } : null,
        lastError: { message: "emisión abandonada", at: new Date().toISOString() },
        relay: { state: null },
      };
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
    if (this.unreachable) throw new StreamerUnavailable("el streamer no responde");
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
      const emitting = (!!this.active || this.autostart) && this.forced === null;
      if (emitting && b.replace !== true) return { ok: false, status: 409, body: { error: "already_active" } as T };
      this.active = b.sessionId;
      this.autostart = false;
      this.forced = null;
      return ok({ state: "streaming" });
    }
    if (path === "/control/stop") {
      const hold = this.holdNextStop;
      this.holdNextStop = null;
      if (hold) await hold;
      if (this.stopThrows) throw new StreamerUnavailable("el streamer no responde");
      const b = (body ?? {}) as { ifSession?: string | null };
      const desired = !!this.active || this.autostart || this.forced === "failed";
      if (Object.prototype.hasOwnProperty.call(b, "ifSession")) {
        const current = desired ? (this.active ?? null) : undefined;
        if (current === undefined || current !== b.ifSession)
          return { ok: false, status: 409, body: { error: "session_mismatch", wasActive: desired } as T };
      }
      this.stops++;
      this.active = null;
      this.autostart = false;
      if (this.forced === "failed") this.forced = null;
      return ok({ state: "stopped", wasActive: desired });
    }
    if (path === "/recordings") return ok({ files: [], count: 0, totalBytes: 0, disk: { freeBytes: 1e11 } });
    return { ok: false, status: 404, body: {} as T };
  }
}

let h: TestDbHandle;
let st: Streamer;
let app: Express;
let admin: string;
let user: string;
let battle: string;
let battle2: string;
const auth = (t = admin) => ({ Authorization: `Bearer ${t}` });
const start = (id = battle, t = admin) =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth(t))
    .send({ target: { kind: "battle", id } });
const stop = (t = admin) => request(app).post("/admin/streaming/stop").set(auth(t)).send({});
const activeRows = () => h.db("streaming_sessions").where({ state: "active" });
const auditOf = (action: string) => h.db("audit_log").where({ action }).orderBy("id", "desc");

async function insertBattle(): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: "running",
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
  });
  const bot = await createPublishedBot(h.db, `str-${id.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

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
  user = await tokenFor(h.db, DEV_USERS.user);
  battle = await insertBattle();
  battle2 = await insertBattle();
}, 180_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  Object.assign(st, {
    active: null,
    autostart: false,
    forced: null,
    stops: 0,
    stopThrows: false,
    holdNextStatus: null,
    holdNextStop: null,
    statusCalls: 0,
    unreachable: false,
  });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
});

describe("STREAMER · #241 R4-1 · reconciliador sin carreras", () => {
  it("RECONCILER_START_RACE · foto de /status ANTERIOR a stop(A)+start(B): B (legítima) NO se para", async () => {
    expect((await start()).status).toBe(201);
    let release!: () => void;
    st.holdNextStatus = new Promise<void>((r) => (release = r));
    const tick = reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    for (let i = 0; i < 200 && st.statusCalls === 0; i++) await sleep(5);
    expect((await stop()).status).toBe(200);
    expect((await start()).status).toBe(201);
    const [b] = await activeRows();
    release();
    expect(await tick).toBeNull();
    expect(st.active).toBe(b.id);
    expect((await activeRows()).map((r) => r.id)).toEqual([b.id]);
  });

  it("RECONCILER_STOP_RACE · el stop del reconciliador en vuelo aterriza tras un start(B): no corta B (stop condicionado)", async () => {
    st.active = randomUUID(); // huérfana real
    let release!: () => void;
    st.holdNextStop = new Promise<void>((r) => (release = r));
    const tick = reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
    // Acotado: sin la segunda lectura (main) falla rápido en vez de colgarse.
    for (let i = 0; i < 200 && st.statusCalls < 2; i++) await sleep(5);
    expect(st.statusCalls).toBe(2);
    await sleep(10);
    st.active = null; // el huérfano desaparece
    expect((await start()).status).toBe(201);
    const [b] = await activeRows();
    release();
    expect(await tick).toBeNull();
    expect(st.active).toBe(b.id);
  });

  it("CONTROL · una huérfana real se sigue parando (y se audita una vez)", async () => {
    const orphan = randomUUID();
    st.active = orphan;
    const before = (await auditOf("streaming.session.orphan_stopped")).length;
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stopped");
    expect(st.active).toBeNull();
    expect((await auditOf("streaming.session.orphan_stopped")).length).toBe(before + 1);
  });

  it("AUTOSTART (emisión sin sesión) se para con `ifSession: null` (comportamiento documentado)", async () => {
    st.autostart = true;
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBe("stopped");
    expect(st.autostart).toBe(false);
  });

  it("#241 (obs.) · un stop que falla en cada tick se audita UNA vez por emisión, no en cada tick", async () => {
    st.active = randomUUID();
    st.stopThrows = true;
    const memo: ReconcileMemo = {};
    const before = (await auditOf("streaming.session.orphan_stopped")).length;
    for (let i = 0; i < 5; i++)
      expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic", memo })).toBe("stop_failed");
    expect((await auditOf("streaming.session.orphan_stopped")).length).toBe(before + 1);
    st.active = randomUUID(); // otra emisión distinta: sí se audita
    await reconcileOrphanEmission(h.db, st, { trigger: "periodic", memo });
    expect((await auditOf("streaming.session.orphan_stopped")).length).toBe(before + 2);
  });

  it("200 ticks intercalados con start/stop reales: nunca se para una sesión activa en BD que emite", async () => {
    let wrongStops = 0;
    for (let i = 0; i < 200; i++) {
      const tick = reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
      if (i % 2 === 0) await start(i % 4 === 0 ? battle : battle2);
      else await stop();
      await tick;
      const act = await activeRows();
      if (act.length === 1 && st.active !== act[0].id) wrongStops++;
    }
    expect(wrongStops).toBe(0);
  });
});

describe("STREAMER · #241 (obs.) · compensatorio con resultado fiel", () => {
  it("start sin respuesta y nada emitiendo ⇒ outcome `nothing_to_stop`, no `stopped`", async () => {
    const orig = st.call.bind(st);
    st.call = (async (m: "GET" | "POST", p: string, b?: unknown) => {
      if (p === "/control/start") throw new StreamerUnavailable("plazo vencido");
      return orig(m, p, b);
    }) as typeof st.call;
    try {
      expect((await start()).status).toBe(503);
    } finally {
      st.call = orig;
    }
    const [row] = await auditOf("streaming.session.start_compensated");
    expect(row.detail.outcome).toBe("nothing_to_stop");
  });
});

describe("STREAMER · §13 RESTART_RECOVERY · START tras FAILED o tras reiniciar el streamer", () => {
  for (const forced of ["failed", "idle"] as const) {
    it(`streamer ${forced === "failed" ? "con reintentos agotados" : "reiniciado (idle)"} y sesión activa en BD ⇒ START emite de nuevo (no «alreadyActive»)`, async () => {
      expect((await start()).status).toBe(201);
      const [old] = await activeRows();
      st.forced = forced;
      if (forced === "idle") st.active = null;
      const r = await start();
      expect(r.status).toBe(201);
      expect(r.body.alreadyActive).toBe(false);
      const [now] = await activeRows();
      expect(now.id).not.toBe(old.id);
      expect(st.active).toBe(now.id);
      const closed = await h.db("streaming_sessions").where({ id: old.id }).first();
      expect(closed).toMatchObject({ state: "failed", stop_reason: "not_emitting" });
      const [audit] = await auditOf("streaming.session.recovered");
      expect(audit.target).toBe(`streaming:session:${old.id}`);
    });
  }

  it("CONTROL · streamer emitiendo de verdad ⇒ el mismo START sigue siendo idempotente", async () => {
    expect((await start()).status).toBe(201);
    const r = await start();
    expect(r.status).toBe(200);
    expect(r.body.alreadyActive).toBe(true);
  });

  it("CONTROL · streamer inalcanzable ⇒ no se toca la sesión (no se sabe si emite)", async () => {
    expect((await start()).status).toBe(201);
    const [old] = await activeRows();
    st.unreachable = true;
    const r = await start();
    // Modo record: la medida del disco ya falla (503, fail-closed) y la sesión sigue intacta.
    expect(r.status).toBe(503);
    expect((await activeRows()).map((x) => x.id)).toEqual([old.id]);
    expect(await auditOf("streaming.session.recovered").where({ target: `streaming:session:${old.id}` })).toHaveLength(
      0,
    );
  });
});

describe("STREAMER · §3 · lastSession sin secretos", () => {
  it("tras STOP la API expone la última sesión con stoppedAt y stopReason", async () => {
    expect((await start()).status).toBe(201);
    const [s] = await activeRows();
    expect((await stop()).status).toBe(200);
    const r = await request(app).get("/admin/streaming").set(auth());
    expect(r.status).toBe(200);
    expect(r.body.session).toBeNull();
    expect(r.body.lastSession).toMatchObject({
      id: s.id,
      state: "stopped",
      mode: "record",
      target: { kind: "battle", id: battle },
      stopReason: "operator",
    });
    expect(typeof r.body.lastSession.stoppedAt).toBe("string");
    expect(JSON.stringify(r.body.lastSession)).not.toMatch(/sealed|credential|config/);
  });
});

describe("STREAMER · §17 · errores estables y §31 PERMISSION_DENIED / INVALID_BATTLE", () => {
  it("STREAM_ALREADY_ACTIVE ⇒ 409 `already_active` y la emisión activa NO se toca", async () => {
    expect((await start(battle)).status).toBe(201);
    const [a] = await activeRows();
    const r = await start(battle2);
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBe("already_active");
    expect(st.active).toBe(a.id);
  });

  it("STREAM_NOT_ACTIVE ⇒ reiniciar sin emisión: 409 `not_active`; STOP sin emisión: 200 idempotente", async () => {
    const r = await request(app).post("/admin/streaming/restart").set(auth()).send({});
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBe("not_active");
    expect((await stop()).body).toMatchObject({ wasActive: false });
    expect((await stop()).body).toMatchObject({ wasActive: false });
  });

  it("STREAM_NOT_CONFIGURED ⇒ desactivado: 409 `streaming_disabled`; rtmps sin clave: 409 `credential_missing`", async () => {
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: false });
    let r = await start();
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBe("streaming_disabled");
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "rtmps", platform: "youtube" });
    await h.db("streaming_credentials").del();
    r = await start();
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBe("credential_missing");
    expect(await activeRows()).toHaveLength(0);
  });

  it("STREAM_START_FAILED ⇒ streamer caído: 503 `streamer_unavailable`, sesión `failed`, nada activo", async () => {
    st.unreachable = true;
    const r = await start();
    expect(r.status).toBe(503);
    expect(r.body.code ?? r.body.error).toBe("streamer_unavailable");
    expect(await activeRows()).toHaveLength(0);
  });

  it("STREAM_STOP_FAILED ⇒ stop con el streamer caído: 503 `streamer_unavailable` y la sesión queda parada en BD", async () => {
    expect((await start()).status).toBe(201);
    st.unreachable = true;
    const r = await stop();
    expect(r.status).toBe(503);
    expect(r.body.code ?? r.body.error).toBe("streamer_unavailable");
    expect(await activeRows()).toHaveLength(0);
  });

  it("INVALID_BATTLE ⇒ 404 si no existe, 400 si no es UUID; PERMISSION_DENIED ⇒ un usuario normal: 403 en start/stop/estado/credencial", async () => {
    expect((await start(randomUUID())).status).toBe(404);
    expect(
      (
        await request(app)
          .post("/admin/streaming/start")
          .set(auth())
          .send({ target: { kind: "battle", id: "no-uuid" } })
      ).status,
    ).toBe(400);
    expect((await start(battle, user)).status).toBe(403);
    expect((await stop(user)).status).toBe(403);
    expect((await request(app).get("/admin/streaming").set(auth(user))).status).toBe(403);
    expect(
      (
        await request(app)
          .put("/admin/streaming/credentials/youtube")
          .set(auth(user))
          .send({ streamKey: "abcd-efgh-ijkl" })
      ).status,
    ).toBe(403);
    expect(await activeRows()).toHaveLength(0);
  });
});

describe("STREAMER · #241 R4-2 · `rollback:name` con lista cerrada", () => {
  it("la lista es exactamente 016/017/018", () => {
    expect([...NAMED_ROLLBACK_ALLOWED]).toEqual(["016_battle_rules", "017_streaming_admin", "018_battle_reverted"]);
  });
  it("`rollbackNamed('001_identity')` se RECHAZA y la tabla users sigue ahí; 002..015 también", async () => {
    for (const n of ["001_identity", "002_content", "006_operations", "015_bot_retired"]) {
      await expect(rollbackNamed(h.db, n)).rejects.toThrow(/no se puede revertir por nombre/);
    }
    const t = (await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(
      (r: { tablename: string }) => r.tablename,
    );
    expect(t).toContain("users");
    expect(t).toContain("streaming_sessions");
  });
});
