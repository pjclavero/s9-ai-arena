/**
 * #291 · Propiedad de las acciones de torneo (TOURNAMENT_ACTION_OWNERSHIP).
 *
 * Regla única (services/tournament-access.ts · canManageTournament): gestiona un torneo
 * quien lo creó (`created_by`) o el staff (moderator+), además del rol mínimo del
 * contrato. Por acción se prueban: dueño, staff, organizador AJENO, user y anónimo.
 * El rechazo no deja efectos (ni estado, ni congelación, ni jobs, ni auditoría).
 * Las acciones del participante (inscribir / retirar su bot) conservan su regla.
 *
 *  - TAO-C  closeEntries
 *  - TAO-D  dryRunTournament
 *  - TAO-X  excludeTournamentEntry (vía organizador y vía dueño del bot)
 *  - TAO-E  enterTournament (regla del participante, sin cambios)
 *  - TAO-V  getTournament.viewerCanManage (lo que usa la web para ocultar)
 *  - TAO-N  torneo sin created_by (creador borrado): sólo staff
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
let botSeq = 0;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newUser(label: string, role: string): Promise<{ token: string; id: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@tao291.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role });
  return { token: await tokenFor(h.db, email), id: u.id as string };
}

async function createTournament(token = tok.owner, name = "Copa 291"): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set(bearer(token))
    .send({ name, format: "single_elimination", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function enterRaw(tournamentId: string, b: TestBot): Promise<string> {
  const [e] = await h
    .db("entries")
    .insert({
      tournament_id: tournamentId,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    })
    .returning("id");
  return e.id as string;
}

async function enterBots(tournamentId: string, n: number): Promise<TestBot[]> {
  const bots: TestBot[] = [];
  for (let i = 0; i < n; i++) {
    const b = await createPublishedBot(h.db, `tao291-${++botSeq}`);
    await enterRaw(tournamentId, b);
    bots.push(b);
  }
  return bots;
}

/** Inscripción con una versión NO elegible (loadout que el validador actual rechaza). */
async function ineligibleEntry(tournamentId: string, ownerId?: string): Promise<{ entryId: string; bot: TestBot }> {
  const b = await createPublishedBot(h.db, `tao291-bad-${++botSeq}`, ownerId ? { ownerId } : {});
  await h
    .db("bot_loadouts")
    .where({ bot_id: b.botId, revision: 1 })
    .update({
      catalog_version: "mvp@1",
      chassis: "chassis.heavy@1",
      modules: JSON.stringify([
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@2" },
        { slot: "sensor_a", moduleId: "sensor.radar@1" },
        { slot: "turret_main", moduleId: "weapon.cannon@1" },
        { slot: "ammo_main", moduleId: "ammo.standard@1" },
        { slot: "radio_a", moduleId: "radio.short@1" },
        { slot: "armor_front", moduleId: "armor.steel_front@1" },
      ]),
    });
  return { entryId: await enterRaw(tournamentId, b), bot: b };
}

const post = (path: string, token?: string, body: Record<string, unknown> = {}) => {
  const r = request(app).post(path);
  return (token ? r.set(bearer(token)) : r).send(body);
};
const close = (id: string, token?: string) => post(`/tournaments/${id}/actions/close-entries`, token);
const dryRun = (id: string, token?: string) => post(`/tournaments/${id}/actions/dry-run`, token);
const exclude = (id: string, entryId: string, token?: string) =>
  post(`/tournaments/${id}/entries/${entryId}/actions/exclude`, token, { reason: "revisión #291" });

/** Huella de TODO lo que closeEntries / dry-run / exclude podrían tocar. */
async function footprint(id: string) {
  const t = await h.db("tournaments").where({ id }).first();
  const entries = await h.db("entries").where({ tournament_id: id }).orderBy("id");
  const versions = await h
    .db("bot_versions")
    .whereIn(
      "bot_id",
      entries.map((e: { bot_id: string }) => e.bot_id),
    )
    .orderBy(["bot_id", "version"])
    .select("bot_id", "version", "state");
  const jobs = await h.db("jobs").whereRaw("payload::jsonb->>'tournamentId' = ?", [id]).select("kind");
  const audits = await h
    .db("audit_log")
    .where({ target: `tournament:${id}` })
    .whereNot({ action: "tournament.created" });
  return {
    state: t.state,
    seeds: t.seeds_revealed ?? null,
    entries: entries.map((e: { id: string; frozen: boolean }) => ({ id: e.id, frozen: e.frozen })),
    versions,
    jobs: jobs.map((j: { kind: string }) => j.kind),
    audits: audits.length,
  };
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  tok.owner = await tokenFor(h.db, DEV_USERS.organizer);
  tok.otherOrganizer = (await newUser("ajeno", "organizer")).token;
  tok.user = await tokenFor(h.db, DEV_USERS.user);
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("TAO-C · closeEntries: dueño o staff", () => {
  it("TAO-C1 el dueño cierra (200, closed, inscripciones y versiones congeladas, calendario encolado)", async () => {
    const id = await createTournament();
    await enterBots(id, 2);
    const r = await close(id, tok.owner);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = await footprint(id);
    expect(f.state).toBe("closed");
    expect(f.entries.every((e) => e.frozen)).toBe(true);
    expect(f.versions.every((v: { state: string }) => v.state === "frozen")).toBe(true);
    expect(f.jobs).toContain("generate_schedule");
  });

  for (const who of ["moderator", "admin"] as const) {
    it(`TAO-C2 staff (${who}) cierra el torneo de otro (200)`, async () => {
      const id = await createTournament();
      await enterBots(id, 2);
      const r = await close(id, tok[who]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await footprint(id)).state).toBe("closed");
    });
  }

  it("TAO-C3 organizador AJENO → 403 y nada cambia (estado, congelación, versiones, semillas, jobs, auditoría)", async () => {
    const id = await createTournament();
    await enterBots(id, 2);
    const before = await footprint(id);
    const r = await close(id, tok.otherOrganizer);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error).toBe("forbidden");
    expect(await footprint(id)).toEqual(before);
    expect(before.state).toBe("open");
    // El dueño sigue pudiendo cerrarlo después.
    expect((await close(id, tok.owner)).status).toBe(200);
  });

  it("TAO-C4 user → 403 · anónimo → 401; nada cambia", async () => {
    const id = await createTournament();
    await enterBots(id, 1);
    const before = await footprint(id);
    expect((await close(id, tok.user)).status).toBe(403);
    expect((await close(id)).status).toBe(401);
    expect(await footprint(id)).toEqual(before);
  });

  it("TAO-C5 el 403 va antes que el 409: un organizador ajeno no averigua el estado", async () => {
    const id = await createTournament();
    await h.db("tournaments").where({ id }).update({ state: "running" });
    expect((await close(id, tok.otherOrganizer)).status).toBe(403);
    expect((await close(id, tok.owner)).status).toBe(409);
  });
});

describe("TAO-D · dryRunTournament: dueño o staff", () => {
  it("TAO-D1 el dueño encola el simulacro (202)", async () => {
    const id = await createTournament();
    const r = await dryRun(id, tok.owner);
    expect(r.status).toBe(202);
    expect((await footprint(id)).jobs).toEqual(["tournament_dry_run"]);
  });

  for (const who of ["moderator", "admin"] as const) {
    it(`TAO-D2 staff (${who}) → 202`, async () => {
      const id = await createTournament();
      expect((await dryRun(id, tok[who])).status).toBe(202);
      expect((await footprint(id)).jobs).toEqual(["tournament_dry_run"]);
    });
  }

  it("TAO-D3 organizador AJENO → 403 y no se encola nada", async () => {
    const id = await createTournament();
    const r = await dryRun(id, tok.otherOrganizer);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((await footprint(id)).jobs).toEqual([]);
  });

  it("TAO-D4 user → 403 · anónimo → 401; no se encola nada", async () => {
    const id = await createTournament();
    expect((await dryRun(id, tok.user)).status).toBe(403);
    expect((await dryRun(id)).status).toBe(401);
    expect((await footprint(id)).jobs).toEqual([]);
  });
});

describe("TAO-X · excludeTournamentEntry", () => {
  it("TAO-X1 el organizador DUEÑO excluye una inscripción no elegible (200, by=organizer)", async () => {
    const id = await createTournament();
    const { entryId } = await ineligibleEntry(id);
    const r = await exclude(id, entryId, tok.owner);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.by).toBe("organizer");
    expect(await h.db("entries").where({ id: entryId }).first()).toBeUndefined();
  });

  for (const who of ["moderator", "admin"] as const) {
    it(`TAO-X2 staff (${who}) excluye una no elegible del torneo de otro (200)`, async () => {
      const id = await createTournament();
      const { entryId } = await ineligibleEntry(id);
      const r = await exclude(id, entryId, tok[who]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.by).toBe("organizer");
    });
  }

  it("TAO-X3 organizador AJENO → 403: la inscripción sigue y no hay auditoría", async () => {
    const id = await createTournament();
    const { entryId } = await ineligibleEntry(id);
    const before = await footprint(id);
    const r = await exclude(id, entryId, tok.otherOrganizer);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await footprint(id)).toEqual(before);
  });

  it("TAO-X4 user ajeno → 403 · anónimo → 401; la inscripción sigue", async () => {
    const id = await createTournament();
    const { entryId } = await ineligibleEntry(id);
    expect((await exclude(id, entryId, tok.user)).status).toBe(403);
    expect((await exclude(id, entryId)).status).toBe(401);
    expect(await h.db("entries").where({ id: entryId }).first()).toBeDefined();
  });

  it("TAO-X5 regla del participante intacta: el dueño del bot retira la suya en un torneo ajeno (200, by=owner)", async () => {
    const id = await createTournament();
    const u = await newUser("participante", "user");
    const b = await createPublishedBot(h.db, `tao291-own-${++botSeq}`, { ownerId: u.id });
    const entryId = await enterRaw(id, b); // elegible: sólo su dueño puede retirarla
    const r = await exclude(id, entryId, u.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.by).toBe("owner");
  });

  it("TAO-X6 un organizador AJENO dueño del bot también retira la suya (regla del participante)", async () => {
    const other = await newUser("ajeno-con-bot", "organizer");
    const id = await createTournament();
    const { entryId } = await ineligibleEntry(id, other.id);
    const r = await exclude(id, entryId, other.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.by).toBe("owner");
  });

  it("TAO-X7 suelo de rol de main intacto: el creador DEGRADADO a user ya no excluye por la vía de organizador (403)", async () => {
    const creator = await newUser("degradado", "organizer");
    const id = await createTournament(creator.token);
    const { entryId } = await ineligibleEntry(id);
    await h.db("user_roles").where({ user_id: creator.id }).del();
    await h.db("user_roles").insert({ user_id: creator.id, role: "user" });
    const r = await exclude(id, entryId, creator.token);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await h.db("entries").where({ id: entryId }).first()).toBeDefined();
  });
});

describe("TAO-E · enterTournament (regla del participante, sin cambios)", () => {
  it("TAO-E1 un user inscribe su bot en un torneo que no es suyo (201); el bot de otro → 403", async () => {
    const id = await createTournament();
    const u = await newUser("inscribe", "user");
    const mine = await createPublishedBot(h.db, `tao291-e-${++botSeq}`, { ownerId: u.id });
    const r = await post(`/tournaments/${id}/entries`, u.token, { botId: mine.botId, version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const foreign = await createPublishedBot(h.db, `tao291-e-${++botSeq}`);
    expect((await post(`/tournaments/${id}/entries`, u.token, { botId: foreign.botId, version: 1 })).status).toBe(403);
  });
});

describe("TAO-V · detalle: viewerCanManage (la web oculta lo que no se puede hacer)", () => {
  it("TAO-V1 dueño y staff true; organizador ajeno, user y anónimo false; sin caché compartida", async () => {
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
    expect((await get(tok.admin)).body.viewerCanManage).toBe(true);
    expect((await get(tok.otherOrganizer)).body.viewerCanManage).toBe(false);
    expect((await get(tok.user)).body.viewerCanManage).toBe(false);
  });
});

describe("TAO-N · torneo sin created_by (creador borrado): sólo staff", () => {
  it("TAO-N1 organizador → 403 en close y dry-run; moderador → 200/202", async () => {
    const id = await createTournament();
    await enterBots(id, 2); // B (0.5.0): close-entries exige >=2 inscritos
    await h.db("tournaments").where({ id }).update({ created_by: null });
    expect((await close(id, tok.owner)).status).toBe(403);
    expect((await dryRun(id, tok.owner)).status).toBe(403);
    expect((await dryRun(id, tok.moderator)).status).toBe(202);
    expect((await close(id, tok.moderator)).status).toBe(200);
  });
});
