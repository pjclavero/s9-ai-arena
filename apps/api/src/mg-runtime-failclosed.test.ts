/**
 * MG · FAIL-CLOSED de los ajustes públicos, torneos con la política real y fallbacks.
 *
 *  - FAILCLOSED_HOT: BD caída en caliente ⇒ último valor sólo durante la ventana de
 *    staleness (3 × refreshMs); pasada, FALSE; al volver la BD, se recupera.
 *  - FAILCLOSED_STARTUP: sin lectura válida en el arranque ⇒ FALSE, nunca el entorno.
 *  - TOURNAMENT_EFFECTIVE: el estado de un torneo usa tournament.broadcast, la visibilidad
 *    de los bots, whereBattleReadable anónimo y el estado.
 *  - ADMIN_GLOBAL_REPLAYS: el estado global de la admin incluye los replays públicos.
 *  - FALLBACK_CLOSED: los defaults que antes leían el entorno cierran en FALSE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import type { Db } from "./db/connection.js";
import { RuntimeSettingsStore } from "./runtime-settings.js";
import { battleRoutes } from "./routes/battles.js";
import { DEFAULT_ANON_QUOTA } from "./middleware/anon-quota.js";
import { SpectateGateway } from "./spectate/gateway.js";
import { tournamentBroadcastState } from "./broadcast-effective.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let adminId: string;

/** Db que puede "caerse": toda consulta lanza mientras `down`. */
function flaky(db: Db) {
  let down = false;
  const f: any = (t: string) => {
    if (down) throw new Error("db down");
    return db(t);
  };
  f.transaction = db.transaction.bind(db);
  f.fn = db.fn;
  return { db: f as Db, setDown: (v: boolean) => (down = v) };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function setRow(spectate: boolean, replays: boolean) {
  await h.db("app_runtime_settings").del();
  await h
    .db("app_runtime_settings")
    .insert({ id: 1, public_spectate_enabled: spectate, public_replays_enabled: replays });
}

async function newBattle(status: string, opts: { privateBot?: boolean; tournamentId?: string } = {}): Promise<string> {
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
  });
  const bot = await createPublishedBot(h.db, `fc-${id.slice(0, 8)}`);
  if (opts.privateBot) await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
  await h.db("participants").insert({ battle_id: id, bot_id: bot.botId, version: 1, team: "red" });
  return id;
}

async function newTournament(state: string, broadcast: boolean): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `Copa FC ${randomUUID().slice(0, 6)}`,
      format: "league",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state,
      broadcast,
      created_by: adminId,
    })
    .returning("id");
  return t.id;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
}, 180_000);

afterEach(() => {
  delete process.env.S9_PUBLIC_SPECTATE_ENABLED;
  delete process.env.S9_PUBLIC_REPLAYS_ENABLED;
});

afterAll(async () => {
  await h.stop();
});

describe("MG · FAILCLOSED_HOT · BD caída en caliente", () => {
  it("conserva el último valor sólo durante la ventana (3 × refreshMs); pasada, FALSE; al volver la BD se recupera", async () => {
    await setRow(true, true);
    const f = flaky(h.db);
    const c = clock();
    const store = new RuntimeSettingsStore(f.db, { refreshMs: 1000, now: c.now, bootstrap: true });
    expect(store.staleMs).toBe(3000);
    await store.refresh();
    expect(store.publicVisibility()).toEqual({ publicSpectate: true, publicReplays: true });
    f.setDown(true);
    c.advance(2000);
    await store.refresh(); // falla, no renueva
    expect(store.publicVisibility()).toEqual({ publicSpectate: true, publicReplays: true }); // dentro de la ventana
    c.advance(1500); // 3500 ms desde la última lectura válida
    await store.refresh();
    expect(store.publicVisibility()).toEqual({ publicSpectate: false, publicReplays: false });
    expect(store.snapshot()).toMatchObject({ publicSpectate: false, source: "unavailable" });
    f.setDown(false);
    await store.refresh();
    expect(store.publicVisibility()).toEqual({ publicSpectate: true, publicReplays: true });
  });

  it("revocación efectiva: tras un PATCH a false con la BD caída, el flag viejo NO se sirve indefinidamente (ruta HTTP)", async () => {
    await setRow(true, false);
    const f = flaky(h.db);
    const c = clock();
    const store = new RuntimeSettingsStore(f.db, { refreshMs: 1000, now: c.now });
    await store.refresh();
    const app: Express = createApp({ db: h.db, runtimeSettings: store });
    const running = await newBattle("running");
    expect((await request(app).get(`/battles/${running}`)).status).toBe(200);
    f.setDown(true);
    c.advance(10_000);
    expect((await request(app).get(`/battles/${running}`)).status).toBe(404);
  });
});

describe("MG · FAILCLOSED_STARTUP · sin lectura válida al arrancar", () => {
  it("BD caída al arrancar con el ENTORNO en true ⇒ FALSE (api con bootstrap y worker sin él)", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    process.env.S9_PUBLIC_REPLAYS_ENABLED = "true";
    for (const bootstrap of [true, false]) {
      const f = flaky(h.db);
      f.setDown(true);
      const store = new RuntimeSettingsStore(f.db, { bootstrap });
      expect(store.defaults).toEqual({ publicSpectate: true, publicReplays: true });
      await store.refresh();
      expect(store.publicVisibility()).toEqual({ publicSpectate: false, publicReplays: false });
      expect(store.snapshot().source).toBe("unavailable");
    }
  });

  it("BD viva pero sin fila: el worker (sin bootstrap) vale FALSE aunque el entorno sea true; la API crea la fila con el entorno", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    await h.db("app_runtime_settings").del();
    const worker = new RuntimeSettingsStore(h.db, { bootstrap: false });
    await worker.refresh();
    expect(worker.publicVisibility()).toEqual({ publicSpectate: false, publicReplays: false });
    expect(await h.db("app_runtime_settings").first()).toBeUndefined();
    const api = new RuntimeSettingsStore(h.db, { bootstrap: true });
    await api.refresh();
    expect(api.publicVisibility().publicSpectate).toBe(true);
    await worker.refresh();
    expect(worker.publicVisibility().publicSpectate).toBe(true);
  });
});

describe("MG · TOURNAMENT_EFFECTIVE · política real", () => {
  const vis = (s: boolean, r: boolean) => ({ publicSpectate: s, publicReplays: r });

  it("en curso, sin broadcast y con un bot privado ⇒ tournament_not_broadcastable aunque el espectador esté ON", async () => {
    const t = await newTournament("running", false);
    await newBattle("running", { tournamentId: t, privateBot: true });
    const s = await tournamentBroadcastState(h.db, t, vis(true, true));
    expect(s).toMatchObject({ broadcastAvailable: false, reason: "tournament_not_broadcastable" });
  });

  it("el mismo torneo CON broadcast autorizado ⇒ disponible; con bots públicos y sin broadcast ⇒ disponible", async () => {
    const t = await newTournament("running", true);
    await newBattle("running", { tournamentId: t, privateBot: true });
    expect(await tournamentBroadcastState(h.db, t, vis(true, false))).toMatchObject({
      broadcastAvailable: true,
      reason: null,
    });
    const t2 = await newTournament("running", false);
    await newBattle("running", { tournamentId: t2 });
    expect(await tournamentBroadcastState(h.db, t2, vis(true, false))).toMatchObject({ broadcastAvailable: true });
  });

  it("espectador OFF en un torneo en curso ⇒ public_spectate_disabled (antes que los bots)", async () => {
    const t = await newTournament("running", false);
    await newBattle("running", { tournamentId: t, privateBot: true });
    expect((await tournamentBroadcastState(h.db, t, vis(false, true)))?.reason).toBe("public_spectate_disabled");
  });

  it("terminado: exige replays públicos y respeta los bots; cancelado ⇒ target_not_available", async () => {
    const t = await newTournament("finished", false);
    await newBattle("finished", { tournamentId: t, privateBot: true });
    expect((await tournamentBroadcastState(h.db, t, vis(true, false)))?.reason).toBe("public_replays_disabled");
    expect((await tournamentBroadcastState(h.db, t, vis(false, true)))?.reason).toBe("tournament_not_broadcastable");
    const ok = await newTournament("finished", false);
    await newBattle("finished", { tournamentId: ok });
    expect(await tournamentBroadcastState(h.db, ok, vis(false, true))).toMatchObject({ broadcastAvailable: true });
    const c = await newTournament("cancelled", true);
    expect((await tournamentBroadcastState(h.db, c, vis(true, true)))?.reason).toBe("target_not_available");
    expect(await tournamentBroadcastState(h.db, randomUUID(), vis(true, true))).toBeNull();
  });

  it("coincide con lo que un anónimo lee de verdad: sin disponible ⇒ la batalla del torneo da 404", async () => {
    await setRow(true, true);
    const store = new RuntimeSettingsStore(h.db, {});
    await store.refresh();
    const app = createApp({ db: h.db, runtimeSettings: store });
    const t = await newTournament("running", false);
    const b = await newBattle("running", { tournamentId: t, privateBot: true });
    expect((await request(app).get(`/battles/${b}`)).status).toBe(404);
    expect((await tournamentBroadcastState(h.db, t, store.publicVisibility()))?.broadcastAvailable).toBe(false);
  });
});

describe("MG · ADMIN_GLOBAL_REPLAYS · estado global de la admin", () => {
  it("incluye si los replays públicos están disponibles y el motivo", async () => {
    await setRow(true, false);
    const store = new RuntimeSettingsStore(h.db, {});
    await store.refresh();
    const app = createApp({ db: h.db, runtimeSettings: store });
    const admin = await tokenFor(h.db, DEV_USERS.admin);
    const off = await request(app)
      .get("/admin/settings/public-access")
      .set({ Authorization: `Bearer ${admin}` });
    expect(off.body.effective).toMatchObject({
      publicReplaysAvailable: false,
      replaysReason: "public_replays_disabled",
    });
    await request(app)
      .patch("/admin/settings/public-access")
      .set({ Authorization: `Bearer ${admin}` })
      .send({ publicReplaysEnabled: true });
    const on = await request(app)
      .get("/admin/settings/public-access")
      .set({ Authorization: `Bearer ${admin}` });
    expect(on.body.effective).toMatchObject({ publicReplaysAvailable: true, replaysReason: null });
  });
});

describe("MG · FALLBACK_CLOSED · sin getter inyectado nadie lee el entorno", () => {
  it("battleRoutes sin getter con el ENTORNO en true: el anónimo no ve el directo ni el replay", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    process.env.S9_PUBLIC_REPLAYS_ENABLED = "true";
    const app = express();
    app.use(battleRoutes(h.db, DEFAULT_ANON_QUOTA));
    const running = await newBattle("running");
    expect((await request(app).get(`/battles/${running}`)).status).toBe(404);
  });

  it("createApp sin flags ni store con el ENTORNO en true: cerrado", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    const app = createApp({ db: h.db });
    const running = await newBattle("running");
    expect((await request(app).get(`/battles/${running}`)).status).toBe(404);
  });

  it("SpectateGateway sin opción con el ENTORNO en true: el espectador público está cerrado", () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    const gw = new SpectateGateway({});
    expect((gw as any).publicSpectateEnabled()).toBe(false);
    void gw.close?.();
  });
});
