/**
 * #288 · Cancelación de torneos (API). Expectativas escritas desde el diseño
 * (.local/288-AUDITORIA.md del autor, resumido en docs/technical/tournaments.md):
 *
 *  - TC-S  estados: `draft`/`open` → `cancelled`; `cancelled` idempotente; `closed`,
 *          `running` y `finished` → 409 tournament_not_cancellable sin tocar nada.
 *  - TC-P  permisos: dueño (quien lo creó) y staff sí; organizador ajeno, usuario y
 *          anónimo no.
 *  - TC-A  auditoría `tournament.cancelled` (una sola, también al repetir).
 *  - TC-D  no se borra nada: inscripciones, versiones y la fila del torneo intactas.
 *  - TC-L  tras cancelar no se inscribe, no se cierra y no se encola calendario.
 *  - TC-R  carrera cancel vs close-entries DE VERDAD concurrente (bloqueos reales de
 *          PostgreSQL): de las dos transiciones gana exactamente una.
 *  - TC-V  el detalle dice a quién pregunta si puede administrarlo (sin caché compartida).
 *  - TC-K  contrato OpenAPI acotado a cancel y close-entries: lo que la implementación
 *          responde está documentado (y al revés), y el rol mínimo del yaml se hace cumplir.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadContract } from "./openapi.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
let ownerId: string;
let botSeq = 0;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newOrganizer(label: string): Promise<string> {
  const email = `${label}-${randomUUID().slice(0, 8)}@tc288.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "organizer" });
  return tokenFor(h.db, email);
}

async function createTournament(token = tok.owner, name = "Copa 288"): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set(bearer(token))
    .send({ name, format: "single_elimination", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function enter(tournamentId: string, n: number): Promise<TestBot[]> {
  const bots: TestBot[] = [];
  for (let i = 0; i < n; i++) {
    const b = await createPublishedBot(h.db, `tc288-${++botSeq}`);
    await h.db("entries").insert({
      tournament_id: tournamentId,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
    bots.push(b);
  }
  return bots;
}

const cancel = (id: string, token?: string, body: Record<string, unknown> = {}) => {
  const r = request(app).post(`/tournaments/${id}/actions/cancel`);
  return (token ? r.set(bearer(token)) : r).send(body);
};
const close = (id: string, token = tok.owner) =>
  request(app).post(`/tournaments/${id}/actions/close-entries`).set(bearer(token)).send({});

const stateOf = async (id: string) => (await h.db("tournaments").where({ id }).first()).state as string;
const cancelAudits = (id: string) =>
  h
    .db("audit_log")
    .where({ action: "tournament.cancelled", target: `tournament:${id}` })
    .orderBy("id");
const scheduleJobs = (id: string) =>
  h.db("jobs").where({ kind: "generate_schedule", dedupe_key: `generate_schedule:${id}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  tok.owner = await tokenFor(h.db, DEV_USERS.organizer);
  tok.otherOrganizer = await newOrganizer("ajeno");
  tok.user = await tokenFor(h.db, DEV_USERS.user);
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);
  ownerId = (await h.db("users").where({ email: DEV_USERS.organizer }).first()).id;
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("TC-S · estados", () => {
  it("TC-S1 open → cancelled (200, Tournament con state=cancelled)", async () => {
    const id = await createTournament();
    const r = await cancel(id, tok.owner);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("cancelled");
    expect(await stateOf(id)).toBe("cancelled");
  });

  it("TC-S2 draft → cancelled", async () => {
    const id = await createTournament();
    await h.db("tournaments").where({ id }).update({ state: "draft" });
    const r = await cancel(id, tok.owner);
    expect(r.status).toBe(200);
    expect(await stateOf(id)).toBe("cancelled");
    expect((await cancelAudits(id))[0].detail.from).toBe("draft");
  });

  it("TC-S3 doble cancelación: 200 idempotente y UNA sola auditoría", async () => {
    const id = await createTournament();
    expect((await cancel(id, tok.owner)).status).toBe(200);
    const again = await cancel(id, tok.owner);
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("cancelled");
    expect((await cancelAudits(id)).length).toBe(1);
  });

  for (const state of ["closed", "running", "finished"]) {
    it(`TC-S4 ${state} → 409 tournament_not_cancellable, sin cambio ni auditoría`, async () => {
      const id = await createTournament();
      await h.db("tournaments").where({ id }).update({ state });
      for (const token of [tok.owner, tok.admin]) {
        const r = await cancel(id, token);
        expect(r.status).toBe(409);
        expect(r.body.error).toBe("tournament_not_cancellable");
        expect(r.body.currentState).toBe(state);
        expect(r.body.allowedTransitions).toEqual([]);
      }
      expect(await stateOf(id)).toBe(state);
      expect((await cancelAudits(id)).length).toBe(0);
    });
  }

  it("TC-S5 torneo inexistente → 404", async () => {
    expect((await cancel(randomUUID(), tok.owner)).status).toBe(404);
    expect((await cancel("no-es-uuid", tok.owner)).status).toBe(404);
  });

  it("TC-S6 reason inválido → 400 sin cancelar", async () => {
    const id = await createTournament();
    expect((await cancel(id, tok.owner, { reason: 42 })).status).toBe(400);
    expect((await cancel(id, tok.owner, { reason: "x".repeat(257) })).status).toBe(400);
    expect(await stateOf(id)).toBe("open");
  });
});

describe("TC-P · permisos (la API autoriza, no la UI)", () => {
  it("TC-P1 anónimo 401 · usuario 403 · organizador ajeno 403; el torneo sigue open", async () => {
    const id = await createTournament();
    expect((await cancel(id)).status).toBe(401);
    expect((await cancel(id, tok.user)).status).toBe(403);
    const ajeno = await cancel(id, tok.otherOrganizer);
    expect(ajeno.status).toBe(403);
    expect(await stateOf(id)).toBe("open");
    expect((await cancelAudits(id)).length).toBe(0);
  });

  it("TC-P2 un ajeno tampoco puede «repetir» la cancelación de un torneo ya cancelado", async () => {
    const id = await createTournament();
    expect((await cancel(id, tok.owner)).status).toBe(200);
    expect((await cancel(id, tok.otherOrganizer)).status).toBe(403);
  });

  it("TC-P3 staff (moderator y admin) cancela torneos ajenos; queda by=staff", async () => {
    for (const token of [tok.moderator, tok.admin]) {
      const id = await createTournament();
      const r = await cancel(id, token);
      expect(r.status).toBe(200);
      const [a] = await cancelAudits(id);
      expect(a.detail.by).toBe("staff");
    }
  });

  it("TC-P5 suelo de rol del contrato: el creador DEGRADADO a user ya no cancela su torneo (403, sin efectos)", async () => {
    const email = `degradado-${randomUUID().slice(0, 8)}@tc288.example.internal`;
    const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: "degradado" }).returning("id");
    await h.db("user_roles").insert({ user_id: u.id, role: "organizer" });
    const token = await tokenFor(h.db, email);
    const id = await createTournament(token);
    await h.db("user_roles").where({ user_id: u.id }).del();
    await h.db("user_roles").insert({ user_id: u.id, role: "user" });
    const r = await cancel(id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await stateOf(id)).toBe("open");
    expect((await cancelAudits(id)).length).toBe(0);
  });

  it("TC-P4 el organizador ajeno sí cancela el SUYO", async () => {
    const id = await createTournament(tok.otherOrganizer);
    expect((await cancel(id, tok.otherOrganizer)).status).toBe(200);
    // Para el otro organizador ESTE torneo es ajeno: el permiso va antes que la idempotencia.
    expect((await cancel(id, tok.owner)).status).toBe(403);
  });
});

describe("TC-A · auditoría", () => {
  it("TC-A1 tournament.cancelled con actor, estado previo, inscritos, motivo y correlación", async () => {
    const id = await createTournament();
    await enter(id, 2);
    const r = await cancel(id, tok.owner, { reason: "falta de inscritos" });
    expect(r.status).toBe(200);
    const audits = await cancelAudits(id);
    expect(audits.length).toBe(1);
    expect(audits[0].actor_id).toBe(ownerId);
    expect(audits[0].detail).toMatchObject({ from: "open", entries: 2, by: "owner", reason: "falta de inscritos" });
    expect(audits[0].correlation_id).toBeTruthy();
  });
});

describe("TC-D · no se borra nada", () => {
  it("TC-D1 inscripciones, versiones y fila del torneo intactas (salvo state)", async () => {
    const id = await createTournament();
    const bots = await enter(id, 3);
    const before = {
      t: await h.db("tournaments").where({ id }).first(),
      entries: await h.db("entries").where({ tournament_id: id }).orderBy("id"),
      versions: await h
        .db("bot_versions")
        .whereIn(
          "bot_id",
          bots.map((b) => b.botId),
        )
        .orderBy("id"),
    };
    expect((await cancel(id, tok.owner)).status).toBe(200);
    const after = {
      t: await h.db("tournaments").where({ id }).first(),
      entries: await h.db("entries").where({ tournament_id: id }).orderBy("id"),
      versions: await h
        .db("bot_versions")
        .whereIn(
          "bot_id",
          bots.map((b) => b.botId),
        )
        .orderBy("id"),
    };
    expect(after.entries).toEqual(before.entries);
    expect(after.entries.length).toBe(3);
    expect(after.versions).toEqual(before.versions); // ni published → frozen ni nada
    expect({ ...after.t, state: "x" }).toEqual({ ...before.t, state: "x" });
    // Sigue en el listado y en el detalle.
    const d = await request(app).get(`/tournaments/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.state).toBe("cancelled");
    expect(d.body.entryCount).toBe(3);
  });
});

describe("TC-L · ciclo tras cancelar", () => {
  it("TC-L1 tras cancelar no se inscribe, no se cierran inscripciones y no se encola calendario", async () => {
    const id = await createTournament();
    await enter(id, 2);
    expect((await cancel(id, tok.owner)).status).toBe(200);
    const c = await close(id);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("illegal_transition");
    expect(c.body.currentState).toBe("cancelled");
    expect((await scheduleJobs(id)).length).toBe(0);
    const entries = await h.db("entries").where({ tournament_id: id });
    expect(entries.every((e: { frozen: boolean }) => e.frozen === false)).toBe(true);
    const b = await createPublishedBot(h.db, `tc288-${++botSeq}`);
    await h.db("user_roles").insert({ user_id: b.ownerId, role: "user" });
    const ownerTok = await tokenFor(h.db, `${b.name.toLowerCase()}@test.local`);
    const e = await request(app)
      .post(`/tournaments/${id}/entries`)
      .set(bearer(ownerTok))
      .send({ botId: b.botId, version: 1 });
    expect(e.status).toBe(409);
    expect(e.body.error).toBe("entries_closed");
  });

  it("TC-L2 regresión: el ciclo normal (open → close-entries → closed + calendario) sigue igual", async () => {
    const id = await createTournament();
    const bots = await enter(id, 2);
    const c = await close(id);
    expect(c.status).toBe(200);
    expect(c.body.state).toBe("closed");
    expect((await scheduleJobs(id)).length).toBe(1);
    const versions = await h.db("bot_versions").whereIn(
      "bot_id",
      bots.map((b) => b.botId),
    );
    expect(versions.every((v: { state: string }) => v.state === "frozen")).toBe(true);
    // Y ahora ya no es cancelable.
    expect((await cancel(id, tok.owner)).status).toBe(409);
  });

  it("TC-L3 un cierre fallido (seeds_required) ya no deja nada congelado a medias", async () => {
    const r = await request(app)
      .post("/tournaments")
      .set(bearer(tok.owner))
      .send({
        name: "Copa 288 compromiso",
        format: "single_elimination",
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        seedCommitment: "a".repeat(64),
      });
    const id = r.body.id as string;
    const bots = await enter(id, 2);
    const c = await close(id);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("seeds_required");
    const entries = await h.db("entries").where({ tournament_id: id });
    expect(entries.every((e: { frozen: boolean }) => e.frozen === false)).toBe(true);
    const versions = await h.db("bot_versions").whereIn(
      "bot_id",
      bots.map((b) => b.botId),
    );
    expect(versions.every((v: { state: string }) => v.state === "published")).toBe(true);
    // Sigue siendo cancelable.
    expect((await cancel(id, tok.owner)).status).toBe(200);
  });
});

/** Espera a que haya al menos `n` sesiones de ESTA base esperando un bloqueo. */
async function waitLockWaiters(n: number, timeoutMs = 10_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const r = await h.db.raw(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    const got = r.rows[0].n as number;
    if (got >= n || Date.now() - t0 > timeoutMs) return got;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("TC-R · carrera cancel vs close-entries (concurrencia real)", () => {
  it("TC-R1 close-entries a medias (bloqueado) + cancel: gana el cierre, cancel 409 y nada se pisa", async () => {
    const id = await createTournament();
    await enter(id, 2);
    // Un tercero retiene las filas de entries: close-entries entra, bloquea la fila del
    // torneo y se queda esperando en `UPDATE entries` (a mitad de su transición).
    const holder = await h.db.transaction();
    await holder.raw(`SELECT id FROM entries WHERE tournament_id = ? FOR UPDATE`, [id]);
    const closeP = close(id).then((r) => r);
    expect(await waitLockWaiters(1)).toBeGreaterThanOrEqual(1);
    // Ahora la cancelación: con el bloqueo de fila espera; sin él, se cuela.
    let cancelDone = false;
    const cancelP = cancel(id, tok.owner).then((r) => {
      cancelDone = true;
      return r;
    });
    const t0 = Date.now();
    while (!cancelDone && (await waitLockWaiters(2, 50)) < 2 && Date.now() - t0 < 5_000) {
      /* espera a que cancel se bloquee o termine */
    }
    await holder.commit();
    const [c, k] = await Promise.all([closeP, cancelP]);
    expect(c.status).toBe(200);
    expect(k.status).toBe(409);
    expect(k.body.error).toBe("tournament_not_cancellable");
    expect(k.body.currentState).toBe("closed");
    expect(await stateOf(id)).toBe("closed");
    expect((await scheduleJobs(id)).length).toBe(1);
    expect((await cancelAudits(id)).length).toBe(0);
  });

  it("TC-R2 cancelación primero: el cierre ve cancelled, 409 y no congela ni encola nada", async () => {
    const id = await createTournament();
    const bots = await enter(id, 2);
    // La cancelación retiene la fila del torneo (transacción abierta del propio test
    // con FOR UPDATE, como hace cancelTournament) mientras llega el cierre.
    const holder = await h.db.transaction();
    await holder.raw(`SELECT id FROM tournaments WHERE id = ? FOR UPDATE`, [id]);
    const closeP = close(id).then((r) => r);
    const waiting = await waitLockWaiters(1);
    await holder("tournaments").where({ id }).update({ state: "cancelled" });
    await holder.commit();
    const c = await closeP;
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect(c.status).toBe(409);
    expect(c.body.currentState).toBe("cancelled");
    expect(await stateOf(id)).toBe("cancelled");
    expect((await scheduleJobs(id)).length).toBe(0);
    const entries = await h.db("entries").where({ tournament_id: id });
    expect(entries.every((e: { frozen: boolean }) => e.frozen === false)).toBe(true);
    const versions = await h.db("bot_versions").whereIn(
      "bot_id",
      bots.map((b) => b.botId),
    );
    expect(versions.every((v: { state: string }) => v.state === "published")).toBe(true);
  });

  it("TC-R3 20 carreras simultáneas: exactamente una transición gana y el estado es coherente", async () => {
    for (let i = 0; i < 20; i++) {
      const id = await createTournament(tok.owner, `Carrera ${i}`);
      await enter(id, 2);
      const [c, k] = await Promise.all([close(id), cancel(id, tok.owner)]);
      const wins = [c.status, k.status].filter((s) => s === 200).length;
      expect(wins, `carrera ${i}: close=${c.status} cancel=${k.status}`).toBe(1);
      const state = await stateOf(id);
      const jobs = (await scheduleJobs(id)).length;
      const audits = (await cancelAudits(id)).length;
      if (k.status === 200) {
        expect([state, jobs, audits]).toEqual(["cancelled", 0, 1]);
        const entries = await h.db("entries").where({ tournament_id: id });
        expect(entries.every((e: { frozen: boolean }) => e.frozen === false)).toBe(true);
      } else {
        expect([state, jobs, audits]).toEqual(["closed", 1, 0]);
      }
    }
  });

  it("TC-R4 dos close-entries simultáneos: uno 200 y otro 409 (nunca 500), un solo calendario", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await createTournament(tok.owner, `Doble cierre ${i}`);
      await enter(id, 2);
      const [a, b] = await Promise.all([close(id), close(id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect((await scheduleJobs(id)).length).toBe(1);
    }
  });
});

describe("TC-F · FROZEN-REUSE con cierres concurrentes (ronda 2, H-1)", () => {
  it("TC-F1 dos close-entries concurrentes de torneos distintos con la MISMA versión: UNA sola auditoría de freeze", async () => {
    // Reproductor REV-1 del revisor independiente: con el cierre en una transacción, el
    // segundo cierre lee la versión `published` (MVCC) mientras el primero ya la congeló
    // sin commit; sin el freeze condicional, al desbloquearse la reaplicaba (frozen → frozen)
    // con una segunda auditoría `bot.version.freeze`, contra el invariante de #283.
    const shared = await createPublishedBot(h.db, `tc288-${++botSeq}`);
    const t1 = await createTournament(tok.owner, "Compartida A");
    const t2 = await createTournament(tok.owner, "Compartida B");
    for (const t of [t1, t2]) {
      await h.db("entries").insert({
        tournament_id: t,
        bot_id: shared.botId,
        version: shared.version,
        loadout_revision: shared.loadoutRevision,
        frozen: false,
      });
    }
    // Retiene el INSERT del job de t1 (dedupe_key única): el cierre 1 queda bloqueado
    // DESPUÉS de congelar la versión y antes de su commit.
    const holder = await h.db.transaction();
    await holder("jobs").insert({ kind: "generate_schedule", payload: "{}", dedupe_key: `generate_schedule:${t1}` });
    const c1 = close(t1).then((r) => r);
    expect(await waitLockWaiters(1)).toBeGreaterThanOrEqual(1);
    const c2 = close(t2).then((r) => r);
    await waitLockWaiters(2, 3000); // el cierre 2 espera a la fila de la versión
    await holder.rollback();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const audits = await h
      .db("audit_log")
      .where({ action: "bot.version.freeze", target: `bot:${shared.botId}@${shared.version}` });
    expect(audits.length).toBe(1);
    expect(audits[0].detail).toEqual({ from: "published", to: "frozen" });
    const v = await h.db("bot_versions").where({ bot_id: shared.botId, version: shared.version }).first();
    expect(v.state).toBe("frozen");
  });
});

describe("TC-V · detalle: viewerCanManage", () => {
  it("TC-V1 dueño y staff true; ajeno, usuario y anónimo false; nunca en caché compartida", async () => {
    const id = await createTournament();
    const get = (token?: string) => {
      const r = request(app).get(`/tournaments/${id}`);
      return token ? r.set(bearer(token)) : r;
    };
    const anon = await get();
    expect(anon.status).toBe(200);
    expect(anon.body.viewerCanManage).toBe(false);
    expect(anon.headers["cache-control"]).toBe("private, no-store");
    expect((await get(tok.owner)).body.viewerCanManage).toBe(true);
    expect((await get(tok.moderator)).body.viewerCanManage).toBe(true);
    expect((await get(tok.otherOrganizer)).body.viewerCanManage).toBe(false);
    expect((await get(tok.user)).body.viewerCanManage).toBe(false);
  });
});

describe("TC-K · contrato OpenAPI de cancel y close-entries (acotado a las rutas de este PR)", () => {
  type Seen = { status: number; error?: string };
  const KEY_STATUSES = ["200", "400", "403", "404", "409"];

  /** Respuestas documentadas de una operación por operationId (sin 401: ver nota P3 en el PR). */
  function documented(operationId: string): Record<string, { description?: string; $ref?: string }> {
    const paths = loadContract().raw.paths as Record<string, Record<string, Record<string, unknown>>>;
    for (const methods of Object.values(paths)) {
      const op = methods.post;
      if (op && op.operationId === operationId) return op.responses as never;
    }
    throw new Error(`operación ${operationId} ausente del contrato`);
  }
  const refDescription = (r: { description?: string; $ref?: string }): string => {
    if (r.description) return r.description;
    const name = String(r.$ref).split("/").pop()!;
    const comps = (loadContract().raw.components as { responses: Record<string, { description: string }> }).responses;
    return comps[name]?.description ?? "";
  };

  function assertDocumented(operationId: string, seen: Seen[]) {
    const doc = documented(operationId);
    for (const s of seen.filter((x) => x.status !== 401)) {
      const entry = doc[String(s.status)];
      expect(entry, `${operationId}: el yaml no documenta el ${s.status} que responde la implementación`).toBeDefined();
      if (s.status === 409 && s.error) {
        expect(
          refDescription(entry),
          `${operationId}: el ${s.status} documentado no menciona el código "${s.error}"`,
        ).toContain(s.error);
      }
    }
    // Al revés (lo razonable): ningún 2xx/4xx clave documentado que los tests no ejerciten.
    const seenCodes = new Set(seen.map((x) => String(x.status)));
    for (const code of Object.keys(doc).filter((c) => KEY_STATUSES.includes(c))) {
      expect(seenCodes.has(code), `${operationId}: el yaml documenta el ${code} pero ningún caso lo provoca`).toBe(true);
    }
  }

  const take = (r: { status: number; body: { error?: string } }): Seen => ({ status: r.status, error: r.body?.error });

  it("TC-K1 cancelTournament: 200/400/403/404/409 observados ⊆ documentados (con su código) y al revés", async () => {
    const seen: Seen[] = [];
    const id = await createTournament();
    seen.push(take(await cancel(id, tok.otherOrganizer))); // 403
    seen.push(take(await cancel(id, tok.owner, { reason: 42 }))); // 400
    seen.push(take(await cancel(randomUUID(), tok.owner))); // 404
    seen.push(take(await cancel(id, tok.owner))); // 200
    const closed = await createTournament();
    await h.db("tournaments").where({ id: closed }).update({ state: "closed" });
    const c409 = await cancel(closed, tok.owner); // 409
    expect(c409.body.error).toBe("tournament_not_cancellable");
    seen.push(take(c409));
    expect(seen.map((s) => s.status).sort()).toEqual([200, 400, 403, 404, 409]);
    assertDocumented("cancelTournament", seen);
  });

  it("TC-K2 closeEntries: 200/403/404/409 observados ⊆ documentados (con su código)", async () => {
    const seen: Seen[] = [];
    const id = await createTournament();
    await enter(id, 2);
    seen.push(take(await close(id, tok.otherOrganizer))); // 403
    seen.push(take(await close(randomUUID(), tok.owner))); // 404
    const ok = await close(id); // 200
    seen.push(take(ok));
    const again = await close(id); // 409 illegal_transition
    expect(again.body.error).toBe("illegal_transition");
    seen.push(take(again));
    expect(seen.map((s) => s.status).sort()).toEqual([200, 403, 404, 409]);
    const doc = documented("closeEntries");
    for (const s of seen) {
      const entry = doc[String(s.status)];
      expect(entry, `closeEntries: el yaml no documenta el ${s.status} que responde la implementación`).toBeDefined();
      if (s.status === 409 && s.error) expect(refDescription(entry)).toContain(s.error);
    }
    for (const code of ["200", "403", "409"]) expect(doc[code], `closeEntries: falta ${code}`).toBeDefined();
  });
});
