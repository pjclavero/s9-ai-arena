/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) contra PostgreSQL REAL y la API real.
 *
 * Cada `it` lleva una etiqueta TI_* que nombra el script de mutantes
 * (scripts/v1-tournament-invitation-mutants.py):
 *  - TI_LIST_*      un torneo por invitación sale en el listado público, sin token ni hash;
 *  - TI_PUBLIC_*    directos y resultados públicos no dependen de la modalidad;
 *  - TI_NOINVITE_*  sin invitación no hay inscripción (403 coherente, individual y equipo);
 *  - TI_INVITE_*    con un enlace válido se inscribe un bot y un equipo (y NO inscribe solo);
 *  - TI_REVOKE_*    revocado o sustituido al regenerar ⇒ no inscribe; lo previo se mantiene;
 *  - TI_RULES_*     elegibilidad, dueño, duplicados y tamaño de equipo siguen aplicándose;
 *  - TI_TOKEN_*     token: ≥128 bits, sólo sha256 en BD, ausente de respuestas públicas y audit_log;
 *  - TI_MANAGE_*    sólo dueño del torneo o staff generan, consultan, revocan y cambian modalidad;
 *  - TI_OPEN_*      un torneo abierto se comporta como siempre;
 *  - TI_ENROLL_*    modalidad: al crear y en draft/open, nunca después.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { loadContract } from "./openapi.js";
import { createPublishedBot, insertScheduledBattle } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
let seq = 0;
const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function newUser(label: string, role: string): Promise<{ token: string; id: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@ti.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role });
  return { token: await tokenFor(h.db, email), id: u.id as string };
}

async function createTournament(body: Record<string, unknown> = {}, token = tok.owner): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set(as(token))
    .send({
      name: `ti-${++seq}`,
      format: "single_elimination",
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      ...body,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const generate = (t: string, token = tok.owner) =>
  request(app).post(`/tournaments/${t}/invitation`).set(as(token)).send({});
const revoke = (t: string, token = tok.owner) => request(app).delete(`/tournaments/${t}/invitation`).set(as(token));
const setEnrollment = (t: string, enrollment: unknown, token = tok.owner) =>
  request(app).put(`/tournaments/${t}/enrollment`).set(as(token)).send({ enrollment });

async function invitationTournament(body: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const id = await createTournament({ enrollment: "invitation", ...body });
  const g = await generate(id);
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  return { id, token: g.body.invitationToken as string };
}

/** Bot publicado y elegible del usuario `ids.player` (dueño real), versión 1. */
async function playerBot(): Promise<string> {
  const b = await createPublishedBot(h.db, `ti-bot-${++seq}`, { ownerId: ids.player });
  return b.botId;
}

const enter = (t: string, body: Record<string, unknown>, token = tok.player) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(token)).send(body);
const entriesOf = async (t: string) => h.db("entries").where({ tournament_id: t });

const GUNNER = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};

/** Equipo del jugador con `n` bots propios publicados. */
async function playerTeam(n = 2): Promise<{ teamId: string; bots: string[] }> {
  const [team] = await h
    .db("teams")
    .insert({ name: `ti-team-${++seq}`, captain_id: ids.player })
    .returning("*");
  await h.db("team_members").insert({ team_id: team.id, user_id: ids.player, role: "captain" });
  const bots: string[] = [];
  for (let i = 0; i < n; i++) {
    const [bot] = await h
      .db("bots")
      .insert({ name: `ti-tb-${++seq}`, owner_id: ids.player, team_id: team.id, visibility: "private" })
      .returning("*");
    await createLoadoutRevision(h.db, bot.id, GUNNER as never, { massKg: 0, costCredits: 0, energyBalanceEUs: 0 });
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: 1,
      state: "published",
      runtime: "python",
      loadout_revision: 1,
      source: Buffer.from("# ti\n"),
      source_filename: "bot.py",
      artifact_hash: `sha256:ti-${bot.id}`,
      code_public: false,
      published_at: h.db.fn.now(),
    });
    bots.push(bot.id as string);
  }
  return { teamId: team.id as string, bots };
}

const TEAM_T = {
  format: "teams",
  mode: "team_deathmatch",
  rulesetId: "team-deathmatch-mvp",
  rules: { preset: "team_deathmatch", teamSize: 2 },
};
const enterTeam = (t: string, body: Record<string, unknown>, token = tok.player) =>
  request(app).post(`/tournaments/${t}/team-entries`).set(as(token)).send(body);
const members = (bots: string[]) => bots.map((botId) => ({ botId, version: 1 }));

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    botManager: new FakeBotManager(h.db),
    anonQuota: { max: 10_000, windowMs: 3600_000 },
    publicSpectateEnabled: true,
    publicReplaysEnabled: true,
  });
  tok.owner = await tokenFor(h.db, DEV_USERS.organizer);
  ids.owner = (await h.db("users").where({ email: DEV_USERS.organizer }).first()).id;
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.otherOrganizer = (await newUser("ajeno", "organizer")).token;
  const p = await newUser("jugador", "user");
  tok.player = p.token;
  ids.player = p.id;
  tok.user = await tokenFor(h.db, DEV_USERS.user);
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("V1 · torneos por invitación: visibilidad", () => {
  it("TI_LIST_VISIBLE torneo por invitación en el listado público y la ficha, sin token ni hash", async () => {
    const { id, token } = await invitationTournament();
    const list = await request(app).get("/tournaments?limit=100");
    expect(list.status).toBe(200);
    const item = list.body.items.find((t: { id: string }) => t.id === id);
    expect(item, "el torneo por invitación debe salir en el listado público").toBeTruthy();
    expect(item.enrollment).toBe("invitation");
    const detail = await request(app).get(`/tournaments/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.enrollment).toBe("invitation");
    for (const body of [list.body, detail.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(token);
      expect(text).not.toContain(sha(token));
      expect(text).not.toMatch(/invitationToken|token_sha256/);
    }
  });

  it("TI_TOKEN_PUBLIC_SWEEP el token no aparece en NINGUNA lectura pública del torneo (anónimo y usuario)", async () => {
    const { id, token } = await invitationTournament();
    const paths = [
      "/tournaments?limit=100",
      `/tournaments/${id}`,
      `/tournaments/${id}/battles`,
      `/tournaments/${id}/matches`,
      `/tournaments/${id}/team-standings`,
      "/public/battles/live",
    ];
    for (const who of [undefined, tok.user]) {
      for (const p of paths) {
        const r = who ? await request(app).get(p).set(as(who)) : await request(app).get(p);
        const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
        expect(text, `${p} filtra el token`).not.toContain(token);
        expect(text, `${p} filtra el hash`).not.toContain(sha(token));
      }
    }
    // La comprobación del invitado tampoco lo devuelve.
    const chk = await request(app)
      .post(`/tournaments/${id}/invitation/check`)
      .set(as(tok.user))
      .send({ invitationToken: token });
    expect(chk.body).toEqual({ enrollment: "invitation", valid: true, entriesOpen: true });
  });

  it("TI_PUBLIC_SPECTATOR directos y resultados públicos de un torneo por invitación, igual que uno abierto", async () => {
    const out: Record<string, { battles: number; live: boolean; running: number; finished: number }> = {};
    for (const enrollment of ["open", "invitation"]) {
      const id = await createTournament({ enrollment, broadcast: true });
      const a = await createPublishedBot(h.db, `ti-pub-a-${++seq}`);
      const b = await createPublishedBot(h.db, `ti-pub-b-${++seq}`);
      const running = await insertScheduledBattle(h.db, a, b, { tournamentId: id });
      await h.db("battles").where({ id: running }).update({ status: "running" });
      const finished = await insertScheduledBattle(h.db, a, b, { tournamentId: id });
      await h
        .db("battles")
        .where({ id: finished })
        .update({ status: "finished", result: JSON.stringify({ winner: "A" }) });
      const list = await request(app).get(`/tournaments/${id}/battles`); // anónimo, sin invitación
      expect(list.status).toBe(200);
      const live = await request(app).get("/public/battles/live");
      expect(live.status).toBe(200);
      const r1 = await request(app).get(`/battles/${running}`);
      const r2 = await request(app).get(`/battles/${finished}`);
      out[enrollment] = {
        battles: list.body.items.length,
        live: JSON.stringify(live.body).includes(running),
        running: r1.status,
        finished: r2.status,
      };
    }
    expect(out.open.battles).toBe(2);
    expect(out.open.running).toBe(200);
    expect(out.open.finished).toBe(200);
    expect(out.invitation).toEqual(out.open);
  });
});

describe("V1 · torneos por invitación: inscripción", () => {
  it("TI_NOINVITE_INDIVIDUAL sin invitación (o con una inventada) la API responde 403 y no inscribe", async () => {
    const { id } = await invitationTournament();
    const botId = await playerBot();
    const none = await enter(id, { botId, version: 1 });
    expect(none.status, JSON.stringify(none.body)).toBe(403);
    expect(none.body.error).toBe("invitation_required");
    const fake = await enter(id, { botId, version: 1, invitationToken: "A".repeat(43) });
    expect(fake.status).toBe(403);
    expect(fake.body.error).toBe("invitation_invalid");
    const junk = await enter(id, { botId, version: 1, invitationToken: { $ne: null } });
    expect(junk.status).toBe(403);
    expect(await entriesOf(id)).toHaveLength(0);
  });

  it("TI_NOINVITE_TEAM sin invitación un equipo no se inscribe en un torneo por invitación", async () => {
    const { id } = await invitationTournament(TEAM_T);
    const team = await playerTeam(2);
    const r = await enterTeam(id, { teamId: team.teamId, members: members(team.bots) });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error).toBe("invitation_required");
    const bad = await enterTeam(id, {
      teamId: team.teamId,
      members: members(team.bots),
      invitationToken: "B".repeat(43),
    });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("invitation_invalid");
    expect(await entriesOf(id)).toHaveLength(0);
  });

  it("TI_INVITE_BOT con el enlace válido el invitado inscribe SU bot (y el enlace no inscribe solo)", async () => {
    const { id, token } = await invitationTournament();
    const botId = await playerBot();
    const chk = await request(app)
      .post(`/tournaments/${id}/invitation/check`)
      .set(as(tok.player))
      .send({ invitationToken: token });
    expect(chk.body.valid).toBe(true);
    expect(await entriesOf(id)).toHaveLength(0); // comprobar ≠ inscribir
    const r = await enter(id, { botId, version: 1, invitationToken: token });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.botId).toBe(botId);
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(await entriesOf(id)).toHaveLength(1);
  });

  it("TI_INVITE_TEAM con el enlace válido el invitado inscribe su equipo completo", async () => {
    const { id, token } = await invitationTournament(TEAM_T);
    const team = await playerTeam(2);
    const r = await enterTeam(id, { teamId: team.teamId, members: members(team.bots), invitationToken: token });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.entries).toHaveLength(2);
    expect(await entriesOf(id)).toHaveLength(2);
  });

  it("TI_REVOKE_IMMEDIATE revocar invalida el enlace al momento; lo inscrito antes se mantiene", async () => {
    const { id, token } = await invitationTournament();
    const before = await playerBot();
    expect((await enter(id, { botId: before, version: 1, invitationToken: token })).status).toBe(201);
    const rv = await revoke(id);
    expect(rv.status).toBe(200);
    expect(rv.body).toEqual({ active: false, revoked: true });
    const after = await playerBot();
    const r = await enter(id, { botId: after, version: 1, invitationToken: token });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invitation_invalid");
    const chk = await request(app)
      .post(`/tournaments/${id}/invitation/check`)
      .set(as(tok.player))
      .send({ invitationToken: token });
    expect(chk.body.valid).toBe(false);
    const rows = await entriesOf(id);
    expect(rows.map((e: { bot_id: string }) => e.bot_id)).toEqual([before]);
    // Revocar otra vez es idempotente y no inventa un enlace.
    expect((await revoke(id)).body).toEqual({ active: false, revoked: false });
  });

  it("TI_REVOKE_REGENERATE regenerar revoca el enlace anterior: el viejo no inscribe, el nuevo sí", async () => {
    const { id, token: old } = await invitationTournament();
    const g = await generate(id);
    expect(g.status).toBe(201);
    expect(g.body.revokedPrevious).toBe(true);
    const fresh = g.body.invitationToken as string;
    expect(fresh).not.toBe(old);
    const b1 = await playerBot();
    const r1 = await enter(id, { botId: b1, version: 1, invitationToken: old });
    expect(r1.status).toBe(403);
    expect(r1.body.error).toBe("invitation_invalid");
    const r2 = await enter(id, { botId: b1, version: 1, invitationToken: fresh });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const active = await h.db("tournament_invitations").where({ tournament_id: id }).whereNull("revoked_at");
    expect(active).toHaveLength(1);
  });

  it("TI_REVOKE_TEAM un enlace revocado tampoco inscribe equipos", async () => {
    const { id, token } = await invitationTournament(TEAM_T);
    await revoke(id);
    const team = await playerTeam(2);
    const r = await enterTeam(id, { teamId: team.teamId, members: members(team.bots), invitationToken: token });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invitation_invalid");
    expect(await entriesOf(id)).toHaveLength(0);
  });

  it("TI_RULES_ELIGIBILITY con invitación siguen todas las reglas: dueño, publicada, elegible, duplicado y tamaño", async () => {
    const { id, token } = await invitationTournament();
    // Bot ajeno: 403 forbidden (no de invitación).
    const foreign = await createPublishedBot(h.db, `ti-foreign-${++seq}`);
    const f = await enter(id, { botId: foreign.botId, version: 1, invitationToken: token });
    expect(f.status).toBe(403);
    expect(f.body.error).toBe("forbidden");
    // Versión no publicada.
    const botId = await playerBot();
    await h.db("bot_versions").insert({
      bot_id: botId,
      version: 2,
      state: "draft",
      runtime: "node",
      loadout_revision: 1,
    });
    const d = await enter(id, { botId, version: 2, invitationToken: token });
    expect(d.status).toBe(409);
    expect(d.body.error).toBe("bot_not_published");
    // Loadout que el validador actual rechaza.
    const bad = await playerBot();
    await h
      .db("bot_loadouts")
      .where({ bot_id: bad, revision: 1 })
      .update({
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
    const ne = await enter(id, { botId: bad, version: 1, invitationToken: token });
    expect(ne.status).toBe(409);
    expect(ne.body.error).toBe("bot_version_not_eligible");
    // Duplicado.
    expect((await enter(id, { botId, version: 1, invitationToken: token })).status).toBe(201);
    const dup = await enter(id, { botId, version: 1, invitationToken: token });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("already_entered");
  });

  it("TI_RULES_TEAM_SIZE con invitación un equipo incompleto o ya inscrito no entra", async () => {
    const { id, token } = await invitationTournament(TEAM_T);
    const team = await playerTeam(3);
    const short = await enterTeam(id, {
      teamId: team.teamId,
      members: members(team.bots.slice(0, 1)),
      invitationToken: token,
    });
    expect(short.status).toBe(409);
    expect(short.body.error).toBe("rules_team_size");
    expect(
      (await enterTeam(id, { teamId: team.teamId, members: members(team.bots.slice(0, 2)), invitationToken: token }))
        .status,
    ).toBe(201);
    const again = await enterTeam(id, {
      teamId: team.teamId,
      members: members(team.bots.slice(1, 3)),
      invitationToken: token,
    });
    expect(again.status).toBe(409);
    expect(await entriesOf(id)).toHaveLength(2);
  });

  it("TI_RULES_CLOSED con invitación no se inscribe en un torneo cerrado", async () => {
    const { id, token } = await invitationTournament();
    await h.db("tournaments").where({ id }).update({ state: "closed" });
    const r = await enter(id, { botId: await playerBot(), version: 1, invitationToken: token });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("entries_closed");
  });
});

describe("V1 · torneos por invitación: token y gestión", () => {
  it("TI_TOKEN_STORAGE token de 256 bits, único, sólo su sha256 en BD y nunca en audit_log", async () => {
    const { id, token } = await invitationTournament();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url ⇒ 256 bits
    const g = await generate(id);
    expect(g.headers["cache-control"]).toMatch(/no-store/);
    const t2 = g.body.invitationToken as string;
    expect(t2).not.toBe(token);
    const rows = await h.db("tournament_invitations").where({ tournament_id: id }).orderBy("created_at");
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { token_sha256: string }) => r.token_sha256).sort()).toEqual([sha(token), sha(t2)].sort());
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(t2);
    const audits = JSON.stringify(await h.db("audit_log").where({ target: `tournament:${id}` }));
    expect(audits).toContain("tournament.invitation_created");
    for (const s of [token, t2, sha(token), sha(t2)]) expect(audits).not.toContain(s);
    // Leer el estado del enlace nunca devuelve el token.
    const st = await request(app).get(`/tournaments/${id}/invitation`).set(as(tok.owner));
    expect(st.status).toBe(200);
    expect(st.body.active).toBe(true);
    expect(JSON.stringify(st.body)).not.toContain(t2);
    expect(JSON.stringify(st.body)).not.toContain(sha(t2));
  });

  it("TI_TOKEN_OPENAPI el contrato marca el token x-private y documenta la modalidad y los 403", async () => {
    const c = loadContract();
    expect(c.privateFieldNames.has("invitationToken")).toBe(true);
    for (const op of [
      "setTournamentEnrollment",
      "getTournamentInvitation",
      "createTournamentInvitation",
      "revokeTournamentInvitation",
      "checkTournamentInvitation",
    ]) {
      expect(c.byOperationId.get(op), op).toBeTruthy();
    }
    expect(c.byOperationId.get("createTournamentInvitation")!.minRole).toBe("organizer");
    const yaml = (await import("node:fs")).readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
    expect(yaml).toContain("invitation_required");
    expect(yaml).toContain("invitation_invalid");
    expect(yaml).toMatch(/TournamentEnrollment:\n\s+enum: \[open, invitation\]/);
  });

  it("TI_MANAGE_ONLY sólo el dueño del torneo o el staff generan, consultan, revocan y cambian la modalidad", async () => {
    const id = await createTournament({ enrollment: "invitation" });
    for (const [who, token, status] of [
      ["organizador ajeno", tok.otherOrganizer, 403],
      ["usuario", tok.user, 403],
      ["jugador", tok.player, 403],
    ] as const) {
      expect((await generate(id, token)).status, `${who} genera`).toBe(status);
      expect((await revoke(id, token)).status, `${who} revoca`).toBe(status);
      expect((await request(app).get(`/tournaments/${id}/invitation`).set(as(token))).status, `${who} consulta`).toBe(
        status,
      );
      expect((await setEnrollment(id, "open", token)).status, `${who} cambia modalidad`).toBe(status);
    }
    expect((await request(app).post(`/tournaments/${id}/invitation`).send({})).status).toBe(401);
    expect(await h.db("tournament_invitations").where({ tournament_id: id })).toHaveLength(0);
    // Staff (moderator) sí, aunque no lo creó; y el dueño también.
    const byStaff = await generate(id, tok.moderator);
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(201);
    expect((await revoke(id, tok.moderator)).body.revoked).toBe(true);
    expect((await generate(id, tok.owner)).status).toBe(201);
    expect((await setEnrollment(id, "invitation", tok.moderator)).status).toBe(200);
  });

  it("TI_ENROLL_STATES la modalidad se fija al crear y sólo cambia en draft/open; pasar a abierto revoca el enlace", async () => {
    const bad = await request(app)
      .post("/tournaments")
      .set(as(tok.owner))
      .send({
        name: "ti-bad",
        format: "single_elimination",
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        enrollment: "secret",
      });
    expect(bad.status).toBe(400);
    const { id, token } = await invitationTournament();
    expect((await setEnrollment(id, "nope")).status).toBe(400);
    const toOpen = await setEnrollment(id, "open");
    expect(toOpen.status).toBe(200);
    expect(toOpen.body.enrollment).toBe("open");
    expect(await h.db("tournament_invitations").where({ tournament_id: id }).whereNull("revoked_at")).toHaveLength(0);
    const back = await setEnrollment(id, "invitation");
    expect(back.body.enrollment).toBe("invitation");
    // El enlace viejo no revive al volver a «por invitación».
    const r = await enter(id, { botId: await playerBot(), version: 1, invitationToken: token });
    expect(r.status).toBe(403);
    for (const state of ["closed", "running", "finished", "cancelled"]) {
      await h.db("tournaments").where({ id }).update({ state });
      const c = await setEnrollment(id, "open");
      expect(c.status, state).toBe(409);
      expect(c.body.error).toBe("tournament_enrollment_locked");
      expect((await generate(id)).status, `generar en ${state}`).toBe(409);
    }
    await h.db("tournaments").where({ id }).update({ state: "draft" });
    expect((await setEnrollment(id, "open")).status).toBe(200);
  });
});

describe("V1 · torneos por invitación: un torneo abierto no cambia", () => {
  it("TI_OPEN_UNCHANGED abierto: se lista, se inscribe sin token (un token suelto se ignora) y no admite enlaces", async () => {
    const id = await createTournament();
    const detail = await request(app).get(`/tournaments/${id}`);
    expect(detail.body.enrollment).toBe("open");
    const r = await enter(id, { botId: await playerBot(), version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const r2 = await enter(id, { botId: await playerBot(), version: 1, invitationToken: "C".repeat(43) });
    expect(r2.status).toBe(201);
    const g = await generate(id);
    expect(g.status).toBe(409);
    expect(g.body.error).toBe("tournament_not_invitation");
    const team = await createTournament(TEAM_T);
    const tm = await playerTeam(2);
    expect((await enterTeam(team, { teamId: tm.teamId, members: members(tm.bots) })).status).toBe(201);
  });

  it("TI_OPEN_EXISTING los torneos anteriores a la migración quedan abiertos", async () => {
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "ti-legacy",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "open",
      })
      .returning("*");
    expect(t.enrollment).toBe("open");
    const r = await enter(t.id as string, { botId: await playerBot(), version: 1 });
    expect(r.status).toBe(201);
  });
});
