/**
 * FIX-BROADCAST · la emisión no puede arrancar con un destino que no puede producir contenido.
 *
 * Incidente (2026-11-12): se arrancó una emisión con destino un torneo `finished` y los
 * replays públicos apagados. La API la aceptó (`startPrecheck` sólo miraba `broadcastable`)
 * y /broadcast se quedó en «Esperando el inicio del torneo…» para siempre.
 *
 * Garantías (cada una con su mutante en scripts/fix-broadcast-mutants.sh):
 *  - START_REQUIRES_AVAILABLE: `broadcastable=true` + `broadcastAvailable=false` ⇒ 409.
 *  - START_REJECT_REASONS: 409 con motivo ESTABLE en cada caso de rechazo (torneo terminado
 *    sin replays públicos o sin contenido, cancelado, borrador; batalla terminada sin replay
 *    público, fallida, revertida o programada; destino inexistente). Ninguna sesión, ninguna
 *    orden al streamer.
 *  - START_WAITING_VALID: torneo en curso con batallas programadas ⇒ permitido (WAITING_VALID).
 *  - SCHEDULED_BATTLE (R2): batalla programada que será pública al empezar ⇒ permitida
 *    (WAITING_VALID) y la URL del streamer lleva `wait=scheduled`; con bot privado o el
 *    espectador apagado ⇒ rechazada con su motivo real.
 *  - RESTART_REVALIDATES (R2): el reinicio revalida el destino.
 *  - TARGET_INFO: getStreamingTarget dice tipo (batalla suelta o torneo), estado, batallas
 *    por estado y, para una batalla, si pertenece o no a un torneo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { RuntimeSettingsStore } from "./runtime-settings.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";
import type { StreamerCallResult, StreamerClient } from "./services/streamer-client.js";

/** Streamer falso: graba (modo record) con disco de sobra y cuenta las órdenes de arranque. */
class FakeStreamer implements StreamerClient {
  configured = true;
  state = "idle";
  calls: { method: string; path: string; body?: unknown }[] = [];
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    this.calls.push({ method, path, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status") return ok({ state: this.state, capabilities: {}, lastError: null });
    if (path === "/recordings")
      return ok({ dir: "x", files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
    if (path === "/control/start") {
      this.state = "recording";
      return ok({ state: "recording" });
    }
    if (path === "/control/stop") {
      this.state = "stopped";
      return ok({ state: "stopped" });
    }
    return { ok: false, status: 404, body: {} as T };
  }
  starts(): number {
    return this.calls.filter((c) => c.path === "/control/start").length;
  }
  lastStartUrl(): string {
    const c = this.calls.filter((x) => x.path === "/control/start").at(-1);
    return String((c?.body as { broadcastUrl?: string } | undefined)?.broadcastUrl ?? "");
  }
}

let h: TestDbHandle;
let app: Express;
let store: RuntimeSettingsStore;
let fake: FakeStreamer;
let admin: string;
let adminId: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const T: Record<string, string> = {};
const B: Record<string, string> = {};
const T_NAMES: Record<string, string> = {};

async function newTournament(key: string, state: string): Promise<string> {
  const name = `Copa FIX ${key} ${randomUUID().slice(0, 4)}`;
  const [t] = await h
    .db("tournaments")
    .insert({
      name,
      format: "league",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state,
      broadcast: false,
      created_by: adminId,
    })
    .returning("id");
  T_NAMES[key] = name;
  return t.id;
}

async function newBattle(
  status: string,
  opts: { tournamentId?: string; reverted?: boolean; botName?: string; privateBot?: boolean } = {},
): Promise<string> {
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
    replay_ref: status === "finished" ? `/nonexistent/${id}.jsonl.gz` : null,
    tournament_id: opts.tournamentId ?? null,
    reverted_at: opts.reverted ? h.db.fn.now() : null,
  });
  const bot = await createPublishedBot(h.db, opts.botName ?? `fix-${id.slice(0, 8)}`);
  if (opts.privateBot) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

async function setFlags(publicSpectate: boolean, publicReplays: boolean) {
  await h
    .db("app_runtime_settings")
    .where({ id: 1 })
    .update({ public_spectate_enabled: publicSpectate, public_replays_enabled: publicReplays });
  await store.refresh();
  expect(store.publicVisibility()).toEqual({ publicSpectate, publicReplays });
}

const target = (kind: string, id: string) =>
  request(app).get(`/admin/streaming/target?kind=${kind}&id=${id}`).set(auth(admin));
const start = (kind: string, id: string) =>
  request(app).post("/admin/streaming/start").set(auth(admin)).send({ target: { kind, id } });

async function stopAll() {
  await request(app).post("/admin/streaming/stop").set(auth(admin)).send({ force: true });
  await h.db("streaming_sessions").where({ state: "active" }).update({ state: "stopped", stopped_at: h.db.fn.now() });
}

/** Rechazo completo: 409 con el motivo, ninguna sesión creada y ninguna orden al streamer. */
async function expectRejected(kind: string, id: string, reason: string) {
  const sessionsBefore = Number((await h.db("streaming_sessions").count({ n: "*" }).first())?.n ?? 0);
  const startsBefore = fake.starts();
  const r = await start(kind, id);
  expect([r.status, r.body.error], `${kind} ${id}`).toEqual([409, reason]);
  expect(typeof r.body.message).toBe("string");
  expect(Number((await h.db("streaming_sessions").count({ n: "*" }).first())?.n ?? 0)).toBe(sessionsBefore);
  expect(fake.starts()).toBe(startsBefore);
}

async function expectStarted(kind: string, id: string) {
  const r = await start(kind, id);
  expect([r.status, r.body.error ?? null], `${kind} ${id}`).toEqual([201, null]);
  await stopAll();
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  store = new RuntimeSettingsStore(h.db, {
    defaults: { publicSpectate: true, publicReplays: true },
    bootstrap: true,
    refreshMs: 60_000,
  });
  await store.refresh();
  fake = new FakeStreamer();
  app = createApp({ db: h.db, runtimeSettings: store, streamer: fake, broadcastBaseUrl: "http://web:3000/broadcast" });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "record" });

  // Torneo «prueba» del incidente: terminado, con una batalla terminada pública.
  T.prueba = await newTournament("prueba", "finished");
  await newBattle("finished", { tournamentId: T.prueba });
  T.finEmpty = await newTournament("finEmpty", "finished");
  T.finFailed = await newTournament("finFailed", "finished");
  await newBattle("failed", { tournamentId: T.finFailed });
  T.cancelled = await newTournament("cancelled", "cancelled");
  T.draft = await newTournament("draft", "draft");
  T.runSched = await newTournament("runSched", "running");
  await newBattle("scheduled", { tournamentId: T.runSched });
  await newBattle("scheduled", { tournamentId: T.runSched });
  await newBattle("finished", { tournamentId: T.runSched });
  T.runLive = await newTournament("runLive", "running");
  B.inTournament = await newBattle("running", { tournamentId: T.runLive, botName: "fix-torneo" });

  B.loose = await newBattle("running", { botName: "fix-suelta" });
  B.finished = await newBattle("finished");
  B.failed = await newBattle("failed");
  B.reverted = await newBattle("finished", { reverted: true });
  B.scheduled = await newBattle("scheduled");
  B.scheduledPriv = await newBattle("scheduled", { privateBot: true });
  B.restart = await newBattle("running");
}, 180_000);

beforeEach(async () => {
  await stopAll();
  await setFlags(true, true);
});

afterAll(async () => {
  store?.stop();
  await h?.stop();
});

describe("FIX-BROADCAST · START_REQUIRES_AVAILABLE", () => {
  it("el incidente: torneo terminado con replays públicos apagados ⇒ broadcastable=true pero broadcastAvailable=false ⇒ 409", async () => {
    await setFlags(true, false);
    const t = (await target("tournament", T.prueba)).body;
    expect(t).toMatchObject({ broadcastable: true, broadcastAvailable: false, reason: "public_replays_disabled" });
    await expectRejected("tournament", T.prueba, "public_replays_disabled");
  });

  it("batalla autorizada (bots públicos) en curso con el espectador apagado ⇒ 409 public_spectate_disabled", async () => {
    await setFlags(false, true);
    const t = (await target("battle", B.loose)).body;
    expect(t).toMatchObject({ broadcastable: true, broadcastAvailable: false });
    await expectRejected("battle", B.loose, "public_spectate_disabled");
  });

  it("control positivo: con contenido emitible se arranca (el mismo torneo con replays públicos)", async () => {
    expect((await target("tournament", T.prueba)).body).toMatchObject({
      broadcastAvailable: true,
      broadcastPhase: "TARGET_FINISHED",
    });
    await expectStarted("tournament", T.prueba);
    await expectStarted("battle", B.loose);
    await expectStarted("battle", B.finished);
  });
});

describe("FIX-BROADCAST · START_REJECT_REASONS", () => {
  it("torneo terminado SIN ninguna batalla emitible ⇒ tournament_no_content (vacío o sólo fallidas)", async () => {
    await expectRejected("tournament", T.finEmpty, "tournament_no_content");
    await expectRejected("tournament", T.finFailed, "tournament_no_content");
  });

  it("torneo cancelado ⇒ target_not_available; borrador ⇒ tournament_not_started", async () => {
    await expectRejected("tournament", T.cancelled, "target_not_available");
    await expectRejected("tournament", T.draft, "tournament_not_started");
  });

  it("batalla terminada sin replay público ⇒ public_replays_disabled", async () => {
    await setFlags(true, false);
    await expectRejected("battle", B.finished, "public_replays_disabled");
  });

  it("batalla fallida o REVERTIDA ⇒ battle_not_available (la revertida, aunque su replay sea legible)", async () => {
    await expectRejected("battle", B.failed, "battle_not_available");
    expect((await request(app).get(`/battles/${B.reverted}`)).status).toBe(200); // legible como replay
    await expectRejected("battle", B.reverted, "battle_not_available");
  });

  it("destino inexistente ⇒ 409 target_not_found (batalla y torneo)", async () => {
    await expectRejected("battle", randomUUID(), "target_not_found");
    await expectRejected("tournament", randomUUID(), "target_not_found");
  });
});

describe("FIX-BROADCAST · START_WAITING_VALID", () => {
  it("torneo en curso con batallas programadas (ninguna en directo) ⇒ permitido, fase WAITING_VALID", async () => {
    const t = (await target("tournament", T.runSched)).body;
    expect(t).toMatchObject({
      broadcastable: true,
      broadcastAvailable: true,
      reason: null,
      broadcastPhase: "WAITING_VALID",
      battleCounts: { scheduled: 2, running: 0, finished: 1, failed: 0 },
    });
    await expectStarted("tournament", T.runSched);
  });
});

describe("FIX-BROADCAST (R2) · SCHEDULED_BATTLE · se puede empezar a emitir ANTES de la batalla", () => {
  it("batalla suelta programada con bots públicos y espectador ON ⇒ permitida, WAITING_VALID, URL con wait=scheduled", async () => {
    expect((await target("battle", B.scheduled)).body).toMatchObject({
      status: "scheduled",
      broadcastable: true,
      broadcastAvailable: true,
      reason: null,
      broadcastPhase: "WAITING_VALID",
    });
    // El anónimo aún no la lee (404): de ahí la marca para que /broadcast espere.
    expect((await request(app).get(`/battles/${B.scheduled}`)).status).toBe(404);
    const r = await start("battle", B.scheduled);
    expect([r.status, r.body.error ?? null]).toEqual([201, null]);
    expect(new URL(fake.lastStartUrl()).searchParams.get("wait")).toBe("scheduled");
    await stopAll();
    // Una en curso NO lleva la marca.
    await start("battle", B.loose);
    expect(new URL(fake.lastStartUrl()).searchParams.get("wait")).toBeNull();
    await stopAll();
  });

  it("programada con bot privado (sin torneo retransmitido) ⇒ rechazada con battle_not_public", async () => {
    await expectRejected("battle", B.scheduledPriv, "battle_not_public");
  });

  it("programada con el espectador público apagado ⇒ rechazada con public_spectate_disabled", async () => {
    await setFlags(false, true);
    await expectRejected("battle", B.scheduled, "public_spectate_disabled");
  });
});

describe("FIX-BROADCAST (R2) · RESTART_REVALIDATES", () => {
  it("el reinicio revalida: destino que dejó de ser emitible ⇒ 409 con su motivo y sin orden al streamer", async () => {
    const r = await start("battle", B.restart);
    expect(r.status).toBe(201);
    const ok = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
    expect([ok.status, ok.body.restarted]).toEqual([200, true]);
    await h.db("battles").where({ id: B.restart }).update({ status: "failed" });
    try {
      const n = fake.starts();
      const bad = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
      expect([bad.status, bad.body.error]).toEqual([409, "battle_not_available"]);
      expect(fake.starts()).toBe(n);
      await setFlags(false, true);
      await h.db("battles").where({ id: B.restart }).update({ status: "running" });
      const off = await request(app).post("/admin/streaming/restart").set(auth(admin)).send({});
      expect([off.status, off.body.error]).toEqual([409, "public_spectate_disabled"]);
      expect(fake.starts()).toBe(n);
    } finally {
      await h.db("battles").where({ id: B.restart }).update({ status: "running" });
      await stopAll();
    }
  });
});

describe("FIX-BROADCAST · TARGET_INFO", () => {
  it("torneo: tipo, nombre, estado y batallas por estado", async () => {
    const t = (await target("tournament", T.finEmpty)).body;
    expect(t).toMatchObject({
      kind: "tournament",
      targetType: "tournament",
      label: T_NAMES.finEmpty,
      status: "finished",
      tournament: null,
      battleCounts: { scheduled: 0, running: 0, finished: 0, failed: 0 },
      broadcastable: true,
      broadcastAvailable: false,
      reason: "tournament_no_content",
      broadcastPhase: "UNAVAILABLE",
    });
    expect((await target("tournament", T.runLive)).body).toMatchObject({
      broadcastPhase: "LIVE",
      battleCounts: { running: 1 },
    });
  });

  it("batalla suelta ⇒ standalone_battle sin torneo; batalla de torneo ⇒ tournament_battle con su torneo", async () => {
    expect((await target("battle", B.loose)).body).toMatchObject({
      targetType: "standalone_battle",
      tournament: null,
      battleCounts: null,
      status: "running",
      broadcastPhase: "LIVE",
    });
    expect((await target("battle", B.inTournament)).body).toMatchObject({
      targetType: "tournament_battle",
      tournament: { id: T.runLive, name: T_NAMES.runLive, state: "running" },
      broadcastPhase: "LIVE",
    });
  });

  it("inexistente ⇒ 404 en la lectura (sin cambio)", async () => {
    expect((await target("tournament", randomUUID())).status).toBe(404);
  });
});
