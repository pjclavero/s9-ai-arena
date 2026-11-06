/**
 * REVISIÓN INDEPENDIENTE de #242 (STREAMER real) · pruebas de rotura del lado
 * API, con PostgreSQL REAL (embebido) y un streamer falso que imita el contrato
 * de apps/streamer/src/control.ts (estados streaming/failed/stopped, 409
 * already_active sin `replace`, `ifSession` ⇒ 409 session_mismatch) y añade
 * LATENCIA ALEATORIA antes y después de cada efecto, para que las operaciones
 * concurrentes se intercalen de verdad. NO MERGEAR.
 *
 * Invariantes medidos en reposo (sin nada en vuelo):
 *  I1 · si la BD tiene una sesión activa, el streamer emite ESA sesión;
 *  I2 · si el streamer emite, la BD tiene activa ESA sesión (tras un tick del reconciliador);
 *  I3 · nunca hay más de una sesión activa en BD.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { reconcileOrphanEmission } from "./routes/streaming.js";
import { MIGRATIONS, rollbackNamed } from "./db/migrations.js";
import { type StreamerCallResult, type StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number) => randomBytes(4).readUInt32BE(0) % n;

/** Streamer falso fiel al contrato de control.ts, con latencia aleatoria. */
class Streamer implements StreamerClient {
  configured = true;
  state: "idle" | "streaming" | "failed" | "stopped" = "idle";
  session: string | null = null;
  jitter = 0;
  async lag() {
    if (this.jitter) await sleep(rnd(this.jitter));
  }
  get desired() {
    return this.state === "streaming" || this.state === "failed";
  }
  snapshot() {
    return {
      state: this.state,
      desired: this.desired,
      mode: "record",
      session: this.desired ? { sessionId: this.session, mode: "record" } : null,
      lastError: this.state === "failed" ? { message: "emisión abandonada", at: new Date().toISOString() } : null,
      relay: { state: null },
      capabilities: { nvenc: false, sealedCredentials: true },
    };
  }
  async call<T>(_m: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    await this.lag();
    try {
      if (path === "/status") return ok(this.snapshot());
      if (path === "/control/start") {
        const b = body as { sessionId: string; replace?: boolean };
        if (this.state === "streaming" && this.session === b.sessionId && !b.replace)
          return ok({ state: "streaming", alreadyActive: true });
        if (this.state === "streaming" && b.replace !== true)
          return { ok: false, status: 409, body: { error: "already_active" } as T };
        this.state = "streaming";
        this.session = b.sessionId;
        return ok({ state: "streaming", session: { sessionId: b.sessionId } });
      }
      if (path === "/control/stop") {
        const b = (body ?? {}) as { ifSession?: string | null };
        if (Object.prototype.hasOwnProperty.call(b, "ifSession")) {
          const current = this.desired ? this.session : undefined;
          if (current === undefined || current !== b.ifSession)
            return { ok: false, status: 409, body: { error: "session_mismatch", wasActive: this.desired } as T };
        }
        const wasActive = this.desired;
        this.state = "stopped";
        this.session = null;
        return ok({ state: "stopped", wasActive });
      }
      if (path === "/recordings") return ok({ files: [], count: 0, totalBytes: 0, disk: { freeBytes: 1e11 } });
      return { ok: false, status: 404, body: {} as T };
    } finally {
      await this.lag();
    }
  }
}

let h: TestDbHandle;
let st: Streamer;
let app: Express;
let admin: string;
const tokens: Record<string, string> = {};
let battle: string;
let battle2: string;
const auth = (t = admin) => ({ Authorization: `Bearer ${t}` });
const start = (id = battle) =>
  request(app)
    .post("/admin/streaming/start")
    .set(auth())
    .send({ target: { kind: "battle", id } });
const stop = () => request(app).post("/admin/streaming/stop").set(auth()).send({});
const restart = () => request(app).post("/admin/streaming/restart").set(auth()).send({});
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
  const bot = await createPublishedBot(h.db, `r242-${id.slice(0, 8)}`);
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

/** I1/I2/I3 en reposo. Devuelve la lista de violaciones (vacía = consistente). */
async function invariants(): Promise<string[]> {
  const act = await activeRows();
  const v: string[] = [];
  if (act.length > 1) v.push(`I3: ${act.length} activas`);
  const emitting = st.state === "streaming" ? st.session : null;
  if (act.length === 1 && st.state !== "failed" && emitting !== act[0].id)
    v.push(`I1: BD activa ${act[0].id.slice(0, 8)} y el streamer emite ${String(emitting).slice(0, 8)}`);
  if (emitting && (act.length === 0 || act[0].id !== emitting))
    v.push(`I2: el streamer emite ${emitting.slice(0, 8)} sin sesión activa en BD`);
  return v;
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
  for (const role of Object.keys(DEV_USERS) as (keyof typeof DEV_USERS)[]) {
    if (role !== "admin") tokens[role] = await tokenFor(h.db, DEV_USERS[role]);
  }
  battle = await insertBattle();
  battle2 = await insertBattle();
}, 180_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  Object.assign(st, { state: "idle", session: null, jitter: 0 });
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
});

describe("R242 · §36 dos streams a la vez y START/STOP concurrentes (PG real)", () => {
  it("CONTROL · 20 START simultáneos de la MISMA batalla ⇒ un 201 y 19 alreadyActive; una sola sesión y es la que emite", async () => {
    st.jitter = 4;
    const rs = await Promise.all(Array.from({ length: 20 }, () => start()));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200 && r.body.alreadyActive === true)).toHaveLength(19);
    expect(await invariants()).toEqual([]);
  });

  it("CONTROL · 20 START simultáneos de DOS batallas ⇒ un 201; los de la otra batalla 409 already_active; nunca dos emisiones", async () => {
    st.jitter = 4;
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => start(i % 2 ? battle : battle2)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error === "already_active")).toBe(true);
    expect(await invariants()).toEqual([]);
  });

  it("CONTROL · 60 rondas de START‖STOP‖RESTART‖reconciliador con latencia aleatoria: invariantes I1-I3 en reposo", async () => {
    st.jitter = 6;
    const violations: string[] = [];
    for (let round = 0; round < 60; round++) {
      const ops: Promise<unknown>[] = [];
      for (let k = 0; k < 4 + rnd(3); k++) {
        const which = rnd(5);
        if (which === 0) ops.push(start(rnd(2) ? battle : battle2));
        else if (which === 1) ops.push(stop());
        else if (which === 2) ops.push(restart());
        else ops.push(reconcileOrphanEmission(h.db, st, { trigger: "periodic" }));
      }
      await Promise.all(ops);
      // Un tick en reposo recoge una huérfana legítima (I2).
      await reconcileOrphanEmission(h.db, st, { trigger: "periodic" });
      for (const v of await invariants()) violations.push(`ronda ${round}: ${v}`);
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it("CONTROL · RESTART‖STOP × 40: el STOP confirmado gana siempre (nada emite y nada activo al terminar)", async () => {
    st.jitter = 6;
    const bad: string[] = [];
    for (let i = 0; i < 40; i++) {
      expect((await start()).status).toBe(201);
      const [, s] = await Promise.all([restart(), stop()]);
      expect(s.status).toBe(200);
      const act = await activeRows();
      if (act.length || st.state === "streaming") bad.push(`iter ${i}: activas=${act.length} streamer=${st.state}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);
});

describe("R242 · §13 START tras FAILED con peticiones concurrentes", () => {
  it("CONTROL · streamer FAILED con sesión activa en BD + 10 START simultáneos ⇒ 1 `recovered`, 1 sesión nueva que emite", async () => {
    expect((await start()).status).toBe(201);
    const [dead] = await activeRows();
    st.state = "failed"; // reintentos agotados (desired, no emite)
    st.jitter = 4;
    const before = (await auditOf("streaming.session.recovered")).length;
    const rs = await Promise.all(Array.from({ length: 10 }, () => start()));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await auditOf("streaming.session.recovered")).length - before).toBe(1);
    const row = await h.db("streaming_sessions").where({ id: dead.id }).first();
    expect({ state: row.state, reason: row.stop_reason }).toEqual({ state: "failed", reason: "not_emitting" });
    expect(await invariants()).toEqual([]);
  });

  it("CONTROL · el reconciliador NO toca una sesión FAILED activa en BD (no es huérfana) y el estado visible es `failed`, no `live`", async () => {
    expect((await start()).status).toBe(201);
    st.state = "failed";
    expect(await reconcileOrphanEmission(h.db, st, { trigger: "periodic" })).toBeNull();
    const r = await request(app).get("/admin/streaming").set(auth());
    expect(r.body.uxState).toBe("failed");
  });
});

describe("R242 · §17 API_AUTHORIZATION · las 12 operaciones con cada rol no admin y sin token", () => {
  const ops: [string, string, unknown?][] = [
    ["get", "/admin/streaming"],
    ["put", "/admin/streaming/settings", { version: 1 }],
    ["put", "/admin/streaming/credentials/youtube", { streamKey: "abcd-efgh-ijkl-mnop" }],
    ["delete", "/admin/streaming/credentials/youtube"],
    ["get", `/admin/streaming/target?kind=battle&id=${randomUUID()}`],
    ["post", "/admin/streaming/test", {}],
    ["post", "/admin/streaming/start", { target: { kind: "battle", id: randomUUID() } }],
    ["post", "/admin/streaming/restart", {}],
    ["post", "/admin/streaming/stop", {}],
    ["get", "/admin/streaming/recordings"],
    ["post", "/admin/streaming/retention", { dryRun: true }],
    ["get", "/admin/streaming/audit"],
  ];
  it("CONTROL · 12 operaciones × 6 roles ⇒ 403; sin token ⇒ 401; ningún efecto en BD ni en el streamer", async () => {
    expect(ops).toHaveLength(12);
    const bad: string[] = [];
    const auditBefore = (await h.db("audit_log").where("action", "like", "streaming.%")).length;
    for (const [m, p, b] of ops) {
      for (const [role, tok] of Object.entries(tokens)) {
        const r = await (request(app) as unknown as Record<string, (p: string) => request.Test>)
          [m](p)
          .set(auth(tok))
          .send(b as object);
        if (r.status !== 403) bad.push(`${role} ${m.toUpperCase()} ${p} ⇒ ${r.status}`);
      }
      const anon = await (request(app) as unknown as Record<string, (p: string) => request.Test>)
        [m](p)
        .send(b as object);
      if (anon.status !== 401) bad.push(`anónimo ${m.toUpperCase()} ${p} ⇒ ${anon.status}`);
    }
    expect(bad).toEqual([]);
    expect((await h.db("audit_log").where("action", "like", "streaming.%")).length).toBe(auditBefore);
    expect(st.state).toBe("idle");
    expect(await activeRows()).toHaveLength(0);
  }, 60_000);
});

describe("R242 · §36.7 `rollback:name`: la lista cerrada no se salta", () => {
  const variants = [
    "001_identity",
    "016_BATTLE_RULES",
    " 016_battle_rules",
    "016_battle_rules ",
    "016_battle_rules\n",
    "016_battle_rules\u0000",
    "016",
    "016_battle",
    "016_battle_rules_x",
    "../016_battle_rules",
    "０16_battle_rules",
    "016_battle_ruleſ",
  ];
  it("CONTROL · 12 variantes (mayúsculas, espacios, prefijos, NUL, Unicode) y TODAS las migraciones fuera de la lista ⇒ rechazadas sin tocar la BD", async () => {
    const outside = MIGRATIONS.map((m) => m.name).filter(
      (n) => !["016_battle_rules", "017_streaming_admin", "018_battle_reverted"].includes(n),
    );
    expect(outside.length).toBeGreaterThan(10);
    const accepted: string[] = [];
    const before = await h.db("knex_migrations").count<{ count: string }[]>("* as count");
    for (const name of [...variants, ...outside]) {
      try {
        await rollbackNamed(h.db, name);
        accepted.push(JSON.stringify(name));
      } catch {
        /* rechazada */
      }
    }
    expect(accepted).toEqual([]);
    const after = await h.db("knex_migrations").count<{ count: string }[]>("* as count");
    expect(after[0].count).toBe(before[0].count);
    expect(await h.db.schema.hasTable("users")).toBe(true);
  });
});
