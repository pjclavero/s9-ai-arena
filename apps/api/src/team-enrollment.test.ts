/**
 * #287 · TOURNAMENT_TEAM_ENROLLMENT · Inscripción de EQUIPOS COMPLETOS en torneos `teams`.
 *
 * BD efímera (embedded-postgres) + la API real. Cada `it` lleva una etiqueta `T287_*` en su
 * nombre: es lo que `scripts/team-enrollment-mutants.mjs` exige que caiga para cada mutante
 * (un rojo por la razón equivocada no cuenta).
 *
 * Escenario: equipos con bots PROPIOS del developer (4 por equipo, v1 publicada y elegible),
 * más bots de borde (de otro dueño, de otro equipo, con loadout no elegible, en borrador,
 * retirado) creados en cada prueba para que ninguna dependa de otra.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { handleGenerateSchedule } from "../../tournament-worker/src/scheduler.js";
import type { JobRow } from "../../tournament-worker/src/queue.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let userTok: string;
let orgTok: string;
let adminTok: string;
let devId: string;
let userId: string;

const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
const L = (chassis: string, modules: { slot: string; moduleId: string; ammo?: string }[]) => ({
  catalogVersion: "mvp@1",
  chassis,
  modules,
});
/** Loadout VÁLIDO hoy (cañón con munición AP). */
const GOOD = L("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);
/** Loadout que hoy NO valida: cañón con munición estándar (INVALID_AMMO). */
const BAD_AMMO = L("chassis.heavy@1", [
  { slot: "drive", moduleId: "movement.tracks@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.standard@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);

let seq = 0;
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });

/** Bot con UNA versión v1 en `state`, anclada a la revisión 1 de `loadout`. */
async function mkBot(
  ownerId: string,
  teamId: string | null,
  opts: { state?: string; loadout?: object; visibility?: string; id?: string; versionId?: string } = {},
): Promise<string> {
  const name = `T287-${++seq}`;
  const [bot] = await h
    .db("bots")
    .insert({
      ...(opts.id ? { id: opts.id } : {}),
      name,
      owner_id: ownerId,
      team_id: teamId,
      visibility: opts.visibility ?? "private",
    })
    .returning("*");
  await createLoadoutRevision(h.db, bot.id, (opts.loadout ?? GOOD) as never, SUMMARY);
  await h.db("bot_versions").insert({
    ...(opts.versionId ? { id: opts.versionId } : {}),
    bot_id: bot.id,
    version: 1,
    state: opts.state ?? "published",
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from(`# ${name} v1\nprint("hola")\n`),
    source_filename: "bot.py",
    artifact_hash: `sha256:${name}-v1`,
    code_public: false,
    published_at: h.db.fn.now(),
  });
  return bot.id as string;
}

/** Equipo del developer (capitán) con `n` bots propios publicados y elegibles. */
async function mkTeam(n = 4, extraMembers: string[] = []): Promise<{ teamId: string; bots: string[] }> {
  const [team] = await h
    .db("teams")
    .insert({ name: `T287-team-${++seq}`, captain_id: devId })
    .returning("*");
  await h.db("team_members").insert({ team_id: team.id, user_id: devId, role: "captain" });
  for (const u of extraMembers) await h.db("team_members").insert({ team_id: team.id, user_id: u, role: "member" });
  const bots: string[] = [];
  for (let i = 0; i < n; i++) bots.push(await mkBot(devId, team.id));
  return { teamId: team.id as string, bots };
}

async function openTeamsTournament(teamSize = 4): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({
      name: `T287-${++seq}`,
      format: "teams",
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      rules: { preset: "team_deathmatch", teamSize },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const members = (bots: string[], version = 1) => bots.map((botId) => ({ botId, version }));
const enterTeam = (tok: string, t: string, teamId: string, ms: { botId: string; version: number }[]) =>
  request(app).post(`/tournaments/${t}/team-entries`).set(as(tok)).send({ teamId, members: ms });
const closeEntries = (t: string) =>
  request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});
const entriesOf = (t: string) => h.db("entries").where({ tournament_id: t }).orderBy("created_at", "asc");
const privacyView = async (ids: string[]) =>
  Promise.all(
    ids.map(async (id) => {
      const b = await h.db("bots").where({ id }).first();
      const vs = await h.db("bot_versions").where({ bot_id: id }).orderBy("version").select("version", "code_public");
      return { id, visibility: b.visibility, owner_id: b.owner_id, versions: vs };
    }),
  );

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  adminTok = await tokenFor(h.db, DEV_USERS.admin);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
}, 180_000);

afterAll(async () => {
  await h.stop();
});

describe("#287 · positivo", () => {
  it("T287_VALID_4V4 · un 4v4 válido entra COMPLETO, con su versión exacta y su equipo", async () => {
    const { teamId, bots } = await mkTeam(4);
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, teamId, members(bots));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.teamId).toBe(teamId);
    expect(r.body.entries.map((e: { botId: string }) => e.botId)).toEqual(bots);
    const rows = await entriesOf(t);
    expect(rows).toHaveLength(4);
    for (const e of rows) {
      expect(e.team_id).toBe(teamId);
      expect(e.version).toBe(1);
      expect(e.loadout_revision).toBe(1);
      expect(e.frozen).toBe(false);
    }
    const audit = await h.db("audit_log").where({ action: "tournament.team_entered", target: `tournament:${t}` });
    expect(audit).toHaveLength(1);
    // El detalle del torneo cuenta las 4 inscripciones.
    expect((await request(app).get(`/tournaments/${t}`)).body.entryCount).toBe(4);
  });

  it("T287_FROZEN_REUSE · una versión frozen de un torneo anterior se reutiliza tal cual (#283)", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t1 = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t1, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t1, B.teamId, members(B.bots))).status).toBe(201);
    const c1 = await closeEntries(t1);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    for (const id of A.bots) expect((await h.db("bot_versions").where({ bot_id: id }).first()).state).toBe("frozen");
    const versionsBefore = await h.db("bot_versions").whereIn("bot_id", A.bots).count({ n: "*" });
    const t2 = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t2, A.teamId, members(A.bots));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await h.db("bot_versions").whereIn("bot_id", A.bots).count({ n: "*" })).toEqual(versionsBefore);
  });
});

describe("#287 · equipo inscrito", () => {
  it("T287_TEAM_IN_USE · un equipo con inscripciones no se borra ⇒ 409 team_in_use (no 500)", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    // Admin (borrar un equipo exige rol team_captain o admin; aquí se mide la FK, no el rol).
    const del = await request(app).delete(`/teams/${A.teamId}`).set(as(adminTok));
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(del.body.error).toBe("team_in_use");
    expect(await entriesOf(t)).toHaveLength(4);
  });
});

describe("#287 · negativos (ninguno inscribe nada)", () => {
  it("T287_SIZE · 3 o 5 bots en un 4v4 ⇒ 409 rules_team_size", async () => {
    const { teamId, bots } = await mkTeam(5);
    const t = await openTeamsTournament(4);
    const three = await enterTeam(devTok, t, teamId, members(bots.slice(0, 3)));
    expect(three.status).toBe(409);
    expect(three.body.error).toBe("rules_team_size");
    expect(three.body).toMatchObject({ teamSize: 4, got: 3 });
    const five = await enterTeam(devTok, t, teamId, members(bots));
    expect(five.status).toBe(409);
    expect(five.body.error).toBe("rules_team_size");
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_MEMBERSHIP · un bot que no es del equipo (aunque sea del mismo dueño) ⇒ 409 team_bot_not_member", async () => {
    const A = await mkTeam(3);
    const other = await mkTeam(1);
    const loose = await mkBot(devId, null);
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, A.teamId, members([...A.bots, other.bots[0]]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_bot_not_member");
    expect(r.body.botIds).toEqual([other.bots[0]]);
    const r2 = await enterTeam(devTok, t, A.teamId, members([...A.bots, loose]));
    expect(r2.body.error).toBe("team_bot_not_member");
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_OWNER · un bot del equipo de OTRO dueño sin su autorización ⇒ 409 team_consent_required", async () => {
    const A = await mkTeam(3, [userId]);
    const theirs = await mkBot(userId, A.teamId);
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, A.teamId, members([...A.bots, theirs]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_consent_required");
    expect(r.body.botIds).toEqual([theirs]);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_NOT_TEAM_MEMBER · quien no es miembro del equipo no lo inscribe ⇒ 403 forbidden (aunque los bots sean suyos)", async () => {
    // Bots del user dentro de un equipo del que NO es miembro (estado alcanzable sólo por BD):
    // la comprobación de miembro es la ÚNICA que lo para (sin sobredeterminar el 403).
    const A = await mkTeam(0);
    const own: string[] = [];
    for (let i = 0; i < 4; i++) own.push(await mkBot(userId, A.teamId));
    const t = await openTeamsTournament(4);
    const r = await enterTeam(userTok, t, A.teamId, members(own));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forbidden");
    expect(r.body.message).toMatch(/miembro del equipo/);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_INELIGIBLE · un miembro con loadout NO elegible ⇒ 409 bot_version_not_eligible", async () => {
    const A = await mkTeam(3);
    const bad = await mkBot(devId, A.teamId, { loadout: BAD_AMMO });
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, A.teamId, members([...A.bots, bad]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.notEligible.map((x: { botId: string }) => x.botId)).toEqual([bad]);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_NOT_PUBLISHED · versión en borrador, suspendida o inexistente ⇒ 409 bot_not_published", async () => {
    const A = await mkTeam(4);
    const draft = await mkBot(devId, A.teamId, { state: "draft" });
    const suspended = await mkBot(devId, A.teamId, { state: "suspended" });
    const t = await openTeamsTournament(4);
    const good3 = members(A.bots.slice(0, 3));
    for (const bad of [
      { botId: draft, version: 1, currentState: "draft" },
      { botId: suspended, version: 1, currentState: "suspended" },
      { botId: A.bots[3], version: 99, currentState: undefined },
    ]) {
      const r = await enterTeam(devTok, t, A.teamId, [...good3, { botId: bad.botId, version: bad.version }]);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toBe("bot_not_published");
      expect(r.body.notPublished).toEqual([
        { botId: bad.botId, version: bad.version, ...(bad.currentState ? { currentState: bad.currentState } : {}) },
      ]);
    }
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_RETIRED · un miembro retirado ⇒ 409 bot_retired", async () => {
    const A = await mkTeam(4);
    await h.db("bots").where({ id: A.bots[2] }).update({ retired_at: h.db.fn.now() });
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_retired");
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_DUPLICATE · el mismo equipo dos veces ⇒ 409 team_already_entered; un bot repetido ⇒ 400", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    const again = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("team_already_entered");
    const rep = await enterTeam(devTok, t, A.teamId, members([A.bots[0], A.bots[0], A.bots[1], A.bots[2]]));
    expect(rep.status).toBe(400);
    expect(await entriesOf(t)).toHaveLength(4);
  });

  it("T287_INDIVIDUAL_BLOCKED · en un torneo teams NvN no se da de alta un bot suelto ⇒ 409 team_enrollment_required", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    const r = await request(app)
      .post(`/tournaments/${t}/entries`)
      .set(as(devTok))
      .send({ botId: A.bots[0], version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_enrollment_required");
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_NOT_TEAMS · en un torneo individual la inscripción por equipo ⇒ 409 not_a_team_tournament", async () => {
    const A = await mkTeam(4);
    const r0 = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({ name: `T287-ind-${++seq}`, format: "round_robin", mode: "deathmatch", rulesetId: "mvp-default" });
    const r = await enterTeam(devTok, r0.body.id, A.teamId, members(A.bots));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_a_team_tournament");
  });
});

describe("#287 · atomicidad", () => {
  it("T287_ATOMIC_MIDWAY · si falla el alta del 3.er miembro, no entra ninguno", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    await h.db.raw(`
      CREATE OR REPLACE FUNCTION t287_fail_entry() RETURNS trigger AS $$
      BEGIN
        IF NEW.bot_id = '${A.bots[2]}'::uuid THEN RAISE EXCEPTION 't287: fallo inyectado'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t287_fail_entry BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION t287_fail_entry();
    `);
    try {
      const r = await enterTeam(devTok, t, A.teamId, members(A.bots));
      expect(r.status).toBe(500);
    } finally {
      await h.db.raw(`DROP TRIGGER t287_fail_entry ON entries; DROP FUNCTION t287_fail_entry();`);
    }
    expect(await entriesOf(t)).toHaveLength(0);
    expect(
      await h.db("audit_log").where({ action: "tournament.team_entered", target: `tournament:${t}` }),
    ).toHaveLength(0);
    // Sin el fallo, el mismo equipo entra completo.
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
  });

  it("T287_ATOMIC_AFTER_INSERT · si falla la auditoría (después de insertar), no queda ninguna inscripción", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    await h.db.raw(`
      CREATE OR REPLACE FUNCTION t287_fail_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'tournament.team_entered' THEN RAISE EXCEPTION 't287: fallo inyectado en auditoría'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t287_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION t287_fail_audit();
    `);
    try {
      const r = await enterTeam(devTok, t, A.teamId, members(A.bots));
      expect(r.status).toBe(500);
    } finally {
      await h.db.raw(`DROP TRIGGER t287_fail_audit ON audit_log; DROP FUNCTION t287_fail_audit();`);
    }
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_CONCURRENT · dos inscripciones simultáneas del mismo equipo: una entra (4 filas) y la otra 409", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    const rs = await Promise.all([1, 2, 3].map(() => enterTeam(devTok, t, A.teamId, members(A.bots))));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await entriesOf(t)).toHaveLength(4);
  });

  it("T287_CONCURRENT_CLOSE · inscribir y cerrar a la vez: nunca queda una inscripción sin congelar en un torneo cerrado", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    const [enr, close] = await Promise.all([enterTeam(devTok, t, B.teamId, members(B.bots)), closeEntries(t)]);
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const rows = await entriesOf(t);
    if (enr.status === 201) expect(rows).toHaveLength(8);
    else {
      expect(enr.body.error).toBe("entries_closed");
      expect(rows).toHaveLength(4);
    }
    expect(rows.every((e: { frozen: boolean }) => e.frozen)).toBe(true);
  });
});

describe("#287 · privacidad", () => {
  it("T287_PRIVACY · inscribir el equipo no cambia visibilidad, code_public ni dueño", async () => {
    const A = await mkTeam(4);
    await h.db("bots").where({ id: A.bots[1] }).update({ visibility: "team" });
    const before = await privacyView(A.bots);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect(await privacyView(A.bots)).toEqual(before);
    // Al cerrar tampoco (sólo cambia el estado de la versión a frozen).
    const B = await mkTeam(4);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    expect((await closeEntries(t)).status).toBe(200);
    expect(await privacyView(A.bots)).toEqual(before);
  });
});

describe("#287 · revalidación al cierre", () => {
  it("T287_CLOSE_BOT_LEFT · un bot que sale del equipo tras inscribirse bloquea el cierre ⇒ 409 team_roster_changed", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const rm = await request(app).delete(`/teams/${A.teamId}/bots/${A.bots[0]}`).set(as(devTok));
    expect(rm.status).toBe(204);
    const c = await closeEntries(t);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("team_roster_changed");
    expect(c.body.changedEntries).toHaveLength(1);
    expect(JSON.stringify(c.body)).not.toContain(A.bots[0]); // sólo ids de inscripción y equipo
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
    expect((await entriesOf(t)).some((e: { frozen: boolean }) => e.frozen)).toBe(false);
  });

  it("T287_CLOSE_SWAP · dos bots intercambiados entre equipos inscritos (tamaños intactos) bloquean el cierre", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    await h.db("bots").where({ id: A.bots[0] }).update({ team_id: B.teamId });
    await h.db("bots").where({ id: B.bots[0] }).update({ team_id: A.teamId });
    const c = await closeEntries(t);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("team_roster_changed");
    expect(c.body.changedEntries).toHaveLength(2);
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
  });

  it("T287_CLOSE_INELIGIBLE · una versión que pasa a no elegible (suspendida) tras inscribirse bloquea el cierre", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    await h.db("bot_versions").where({ bot_id: B.bots[3], version: 1 }).update({ state: "suspended" });
    const c = await closeEntries(t);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("entries_not_eligible");
    expect(c.body.notEligibleEntries).toHaveLength(1);
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
    expect((await h.db("bot_versions").where({ bot_id: A.bots[0] }).first()).state).toBe("published");
  });

  it("T287_CLOSE_ATOMIC · un 409 tardío del cierre (seeds_required) no deja nada congelado", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    await h
      .db("tournaments")
      .where({ id: t })
      .update({ seed_commitment: "a".repeat(64) });
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const c = await closeEntries(t);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("seeds_required");
    expect((await entriesOf(t)).some((e: { frozen: boolean }) => e.frozen)).toBe(false);
    expect((await h.db("bot_versions").where({ bot_id: A.bots[0] }).first()).state).toBe("published");
  });
});

describe("#287 · calendario y clasificación con el equipo inscrito", () => {
  it("T287_SCHEDULE_TEAM · tras el cierre, un cambio de equipo no mueve al bot de bando ni de la tabla", async () => {
    const A = await mkTeam(4);
    const B = await mkTeam(4);
    const t = await openTeamsTournament(4);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    expect((await closeEntries(t)).status).toBe(200);
    // Después del cierre, un bot de A pasa a un equipo C NO inscrito: el torneo juega con el
    // roster INSCRITO (ni C aparece, ni A se queda con 3).
    const C = await mkTeam(0);
    await h.db("bots").where({ id: A.bots[0] }).update({ team_id: C.teamId });
    await handleGenerateSchedule({ payload: { tournamentId: t } } as unknown as JobRow, { db: h.db, workerId: "t287" });
    expect(await h.db("matches").where({ tournament_id: t })).toHaveLength(1);
    const battle = await h.db("battles").where({ tournament_id: t }).orderBy("game_index").first();
    const parts = await h.db("participants").where({ battle_id: battle.id });
    const sideOf = (id: string) => parts.find((p: { bot_id: string }) => p.bot_id === id)?.team;
    expect(parts).toHaveLength(8);
    for (const id of A.bots) expect(sideOf(id)).toBe(sideOf(A.bots[1]));
    for (const id of B.bots) expect(sideOf(id)).not.toBe(sideOf(A.bots[1]));
    // Clasificación por equipos: exactamente los dos equipos inscritos.
    const st = await request(app).get(`/tournaments/${t}/team-standings`);
    expect(st.status).toBe(200);
    expect(st.body.map((r: { teamId: string }) => r.teamId).sort()).toEqual([A.teamId, B.teamId].sort());
  });
});

describe("#287 · torneos individuales sin regresión", () => {
  it("T287_INDIVIDUAL_OK · round_robin: inscribir bot a bot, cerrar y congelar como siempre", async () => {
    const r0 = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({ name: `T287-rr-${++seq}`, format: "round_robin", mode: "deathmatch", rulesetId: "mvp-default" });
    expect(r0.status).toBe(201);
    const t = r0.body.id as string;
    const a = await mkBot(devId, null);
    const b = await mkBot(devId, null);
    for (const id of [a, b]) {
      const e = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: id, version: 1 });
      expect(e.status, JSON.stringify(e.body)).toBe(201);
      expect(e.body.teamId).toBeUndefined();
    }
    const dup = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: a, version: 1 });
    expect(dup.body.error).toBe("already_entered");
    const c = await closeEntries(t);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(
      (await entriesOf(t)).every((e: { frozen: boolean; team_id: string | null }) => e.frozen && e.team_id === null),
    ).toBe(true);
    expect((await h.db("bot_versions").where({ bot_id: a }).first()).state).toBe("frozen");
  });

  it("T287_LEGACY_TEAMS · un torneo teams clásico (sin tamaño) sigue bot a bot y no admite inscripción por equipo", async () => {
    const A = await mkTeam(2);
    const r0 = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({ name: `T287-cl-${++seq}`, format: "teams", mode: "team_deathmatch", rulesetId: "team-deathmatch-mvp" });
    expect(r0.status).toBe(201);
    const t = r0.body.id as string;
    const team = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(team.status).toBe(409);
    expect(team.body.error).toBe("team_size_undefined");
    const e = await request(app)
      .post(`/tournaments/${t}/entries`)
      .set(as(devTok))
      .send({ botId: A.bots[0], version: 1 });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
  });
});

// ------------------------------------------------------------------ ronda 2 (revisión)

const indTournament = async (format = "round_robin") => {
  const r0 = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({ name: `T287-ind-${++seq}`, format, mode: "deathmatch", rulesetId: "mvp-default" });
  expect(r0.status).toBe(201);
  return r0.body.id as string;
};
const enterOne = (tok: string, t: string, botId: string, version = 1) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(tok)).send({ botId, version });
const exclude = (tok: string, t: string, entryId: string) =>
  request(app).post(`/tournaments/${t}/entries/${entryId}/actions/exclude`).set(as(tok)).send({ reason: "t287" });
const consent = (tok: string, t: string, teamId: string, botId: string, version = 1) =>
  request(app).put(`/tournaments/${t}/team-consents/${botId}`).set(as(tok)).send({ teamId, version });
const revoke = (tok: string, t: string, botId: string) =>
  request(app).delete(`/tournaments/${t}/team-consents/${botId}`).set(as(tok));
const addV2 = async (botId: string) => {
  await h.db("bot_versions").insert({
    bot_id: botId,
    version: 2,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from("# v2\n"),
    source_filename: "bot.py",
    artifact_hash: `sha256:${botId}-v2`,
    code_public: false,
    published_at: h.db.fn.now(),
  });
};
/** Equipo de DOS dueños: capitán = developer (bot propio), miembro = user (bot propio). */
async function mkMultiOwnerTeam(): Promise<{ teamId: string; mine: string; theirs: string }> {
  const A = await mkTeam(1, [userId]);
  const theirs = await mkBot(userId, A.teamId);
  return { teamId: A.teamId, mine: A.bots[0], theirs };
}

describe("#287 ronda 2 · H1 · alta individual concurrente con el cierre", () => {
  it("T287_RACE_IND · la inscripción que espera al cierre ve el torneo cerrado (409) y no queda nada sin congelar", async () => {
    const t = await indTournament();
    const a = await mkBot(devId, null);
    const b = await mkBot(devId, null);
    const c = await mkBot(devId, null);
    for (const id of [a, b]) expect((await enterOne(devTok, t, id)).status).toBe(201);
    await h.db.raw(`
      CREATE OR REPLACE FUNCTION t287_slow() RETURNS trigger AS $$
      BEGIN IF NEW.kind = 'generate_schedule' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t287_slow BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION t287_slow();`);
    try {
      const pClose = closeEntries(t).then((r) => r);
      await new Promise((r) => setTimeout(r, 700));
      const enr = await enterOne(devTok, t, c);
      const cl = await pClose;
      expect(cl.status).toBe(200);
      expect(enr.status).toBe(409);
      expect(enr.body.error).toBe("entries_closed");
      const rows = await entriesOf(t);
      expect(rows).toHaveLength(2);
      expect(rows.every((e: { frozen: boolean }) => e.frozen)).toBe(true);
    } finally {
      await h.db.raw(`DROP TRIGGER t287_slow ON jobs; DROP FUNCTION t287_slow();`);
    }
  });
});

describe("#287 ronda 2 · H3 · freeze condicional (REV-1 de #289)", () => {
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

  it("T287_FREEZE_ONCE · dos cierres concurrentes con la misma versión: UNA sola auditoría de freeze", async () => {
    const shared = await mkBot(devId, null);
    const t1 = await indTournament("single_elimination");
    const t2 = await indTournament("single_elimination");
    for (const t of [t1, t2]) {
      await h
        .db("entries")
        .insert({ tournament_id: t, bot_id: shared, version: 1, loadout_revision: 1, frozen: false });
    }
    // Retiene el INSERT del job de t1 (dedupe_key única): el cierre 1 queda bloqueado DESPUÉS
    // de congelar la versión, sin commit.
    const holder = await h.db.transaction();
    await holder("jobs").insert({ kind: "generate_schedule", payload: "{}", dedupe_key: `generate_schedule:${t1}` });
    const c1 = closeEntries(t1).then((r) => r);
    expect(await waitLockWaiters(1)).toBeGreaterThanOrEqual(1);
    const c2 = closeEntries(t2).then((r) => r);
    await waitLockWaiters(2, 3000);
    await holder.rollback();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const audits = await h.db("audit_log").where({ action: "bot.version.freeze", target: `bot:${shared}@1` });
    expect(audits).toHaveLength(1);
  });
});

describe("#287 ronda 2 · H2/H4 · lo que bloquea el cierre siempre se puede desbloquear", () => {
  it("T287_UNBLOCK_RETIRED_IND · versión retirada tras inscribirse (individual): el organizador la excluye y el torneo cierra", async () => {
    const t = await indTournament();
    const a = await mkBot(devId, null);
    const b = await mkBot(devId, null);
    const ea = await enterOne(devTok, t, a);
    expect(ea.status).toBe(201);
    expect((await enterOne(devTok, t, b)).status).toBe(201);
    expect((await request(app).post(`/bots/${a}/versions/1/actions/retire`).set(as(devTok)).send({})).status).toBe(200);
    const c1 = await closeEntries(t);
    expect(c1.status).toBe(409);
    expect(c1.body.error).toBe("entries_not_eligible");
    expect(c1.body.message).toMatch(/organizador puede excluirlas/);
    const ex = await exclude(orgTok, t, ea.body.id);
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect((await closeEntries(t)).status).toBe(200);
  });

  it("T287_UNBLOCK_REPLACE_IND · …o su dueño la sustituye por otra versión válida", async () => {
    const t = await indTournament();
    const a = await mkBot(devId, null);
    const b = await mkBot(devId, null);
    expect((await enterOne(devTok, t, a)).status).toBe(201);
    expect((await enterOne(devTok, t, b)).status).toBe(201);
    expect((await request(app).post(`/bots/${a}/versions/1/actions/retire`).set(as(devTok)).send({})).status).toBe(200);
    await addV2(a);
    const re = await enterOne(devTok, t, a, 2);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.replacedVersion).toBe(1);
    expect((await closeEntries(t)).status).toBe(200);
  });

  it("T287_UNBLOCK_SUSPENDED_TEAM · un miembro suspendido: el organizador excluye ese y luego el resto del equipo (a medias), y cierra", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const ra = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(ra.status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const sus = await request(app)
      .post(`/bots/${A.bots[0]}/versions/1/actions/suspend`)
      .set(as(adminTok))
      .send({ reason: "t287" });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    const c1 = await closeEntries(t);
    expect(c1.status).toBe(409);
    expect(c1.body.error).toBe("entries_not_eligible");
    const statuses: number[] = [];
    for (const e of ra.body.entries) statuses.push((await exclude(orgTok, t, e.id)).status);
    expect(statuses).toEqual([200, 200]);
    // Un miembro de un equipo COMPLETO y válido no lo excluye el organizador.
    const okEntry = (await entriesOf(t))[0];
    expect((await exclude(orgTok, t, okEntry.id)).body.error).toBe("entry_eligible");
    expect((await closeEntries(t)).status).toBe(200);
  });

  it("T287_CLOSE_RETIRED · un bot retirado tras inscribirse con su equipo bloquea el cierre (team_roster_changed) y se puede excluir", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const ra = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(ra.status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    await h.db("bots").where({ id: A.bots[1] }).update({ retired_at: h.db.fn.now() });
    const c1 = await closeEntries(t);
    expect(c1.status).toBe(409);
    expect(c1.body.error).toBe("team_roster_changed");
    expect(c1.body.notEligibleEntries).toEqual([{ entryId: ra.body.entries[1].id }]);
    expect((await exclude(orgTok, t, ra.body.entries[1].id)).status).toBe(200);
  });

  it("T287_TEAMLESS_LEGACY · inscripción sin equipo (anterior a la 022) en un NvN: bloquea el cierre, el organizador la excluye (auditada) y cierra", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const lone = await mkBot(userId, null);
    const [e] = await h
      .db("entries")
      .insert({ tournament_id: t, bot_id: lone, version: 1, loadout_revision: 1, frozen: false })
      .returning("*");
    const c1 = await closeEntries(t);
    expect(c1.status).toBe(409);
    expect(c1.body.error).toBe("team_roster_changed");
    expect(c1.body.notEligibleEntries).toEqual([{ entryId: e.id }]);
    expect((await exclude(orgTok, t, e.id)).status).toBe(200);
    // No se pierde nada: la inscripción excluida queda entera en audit_log.
    const a = await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` });
    expect(a).toHaveLength(1);
    expect(a[0].detail.botId).toBe(lone);
    expect((await closeEntries(t)).status).toBe(200);
  });

  it("T287_LEGACY_NVN · inscripciones antiguas (team_id NULL) con bots en equipo: cierran como antes", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    for (const id of [...A.bots, ...B.bots]) {
      await h.db("entries").insert({ tournament_id: t, bot_id: id, version: 1, loadout_revision: 1, frozen: false });
    }
    const c = await closeEntries(t);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });

  it("T287_REPLACE_TEAM · el dueño sustituye la versión de un miembro que ya no compite: conserva el equipo y renueva la autorización", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    expect((await enterTeam(devTok, t, A.teamId, members(A.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    await h.db("bot_versions").where({ bot_id: A.bots[0], version: 1 }).update({ state: "suspended" });
    await addV2(A.bots[0]);
    const re = await enterOne(devTok, t, A.bots[0], 2);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    const row = await h.db("entries").where({ tournament_id: t, bot_id: A.bots[0] }).first();
    expect(row.team_id).toBe(A.teamId);
    expect(row.version).toBe(2);
    expect((await h.db("team_entry_consents").where({ tournament_id: t, bot_id: A.bots[0] }).first()).version).toBe(2);
    expect((await closeEntries(t)).status).toBe(200);
  });
});

describe("#287 ronda 2 · H5 · equipos de varios dueños con autorización explícita", () => {
  it("T287_MO_FULL · con la autorización del otro dueño, el equipo multi-dueño entra completo y cierra", async () => {
    const M = await mkMultiOwnerTeam();
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const g = await consent(userTok, t, M.teamId, M.theirs);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const r = await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rows = await h.db("entries").where({ tournament_id: t, team_id: M.teamId });
    expect(rows).toHaveLength(2);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    expect((await closeEntries(t)).status).toBe(200);
  });

  it("T287_MO_NO_CONSENT · sin la autorización de un dueño no entra nadie (ni el capitán ni el otro miembro)", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    const r1 = await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]));
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe("team_consent_required");
    expect(r1.body.botIds).toEqual([M.theirs]);
    const r2 = await enterTeam(userTok, t, M.teamId, members([M.mine, M.theirs]));
    expect(r2.body.error).toBe("team_consent_required");
    expect(r2.body.botIds).toEqual([M.mine]);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_MO_WRONG_VERSION · el capitán no puede usar una versión ajena distinta de la autorizada", async () => {
    const M = await mkMultiOwnerTeam();
    await addV2(M.theirs);
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs, 1)).status).toBe(200);
    const r = await enterTeam(devTok, t, M.teamId, [
      { botId: M.mine, version: 1 },
      { botId: M.theirs, version: 2 },
    ]);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_consent_required");
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_MO_FOREIGN_CONSENT · nadie autoriza un bot ajeno, y sólo los miembros ven las autorizaciones", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    const g = await consent(devTok, t, M.teamId, M.theirs);
    expect(g.status).toBe(404);
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(0);
    const outsider = await request(app).get(`/tournaments/${t}/team-consents?teamId=${M.teamId}`).set(as(orgTok));
    expect(outsider.status).toBe(403);
  });

  it("T287_MO_REVOKED · retirar la autorización antes del cierre saca al equipo ENTERO (y el cierre no lo congela)", async () => {
    const M = await mkMultiOwnerTeam();
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    expect((await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const rv = await revoke(userTok, t, M.theirs);
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.withdrawnEntries).toBe(2);
    expect(await h.db("entries").where({ tournament_id: t, team_id: M.teamId })).toHaveLength(0);
    expect((await closeEntries(t)).status).toBe(200);
    expect((await h.db("bot_versions").where({ bot_id: M.theirs }).first()).state).toBe("published");
  });

  it("T289X_CANCEL_CONSENTS · cancelar un torneo con equipos y autorizaciones: se conserva todo (historial) y ya nada se puede alterar", async () => {
    const M = await mkMultiOwnerTeam();
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    expect((await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const c = await request(app).post(`/tournaments/${t}/actions/cancel`).set(as(orgTok)).send({});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.state).toBe("cancelled");
    // No se borra nada: inscripciones (4) y autorizaciones (4: las propias implícitas + la del otro dueño) quedan como historial.
    expect(await entriesOf(t)).toHaveLength(4);
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(4);
    expect((await h.db("bot_versions").where({ bot_id: M.theirs }).first()).state).toBe("published");
    // Las autorizaciones siguen siendo legibles por los miembros.
    const l = await request(app).get(`/tournaments/${t}/team-consents?teamId=${M.teamId}`).set(as(devTok));
    expect(l.status).toBe(200);
    expect(l.body.items).toHaveLength(2);
    // Pero ya no se pueden dar, retirar ni inscribir: el torneo no está abierto (409 entries_closed).
    const put = await consent(userTok, t, M.teamId, M.theirs);
    expect(put.status).toBe(409);
    expect(put.body.error).toBe("entries_closed");
    const rv = await revoke(userTok, t, M.theirs);
    expect(rv.status).toBe(409);
    expect(rv.body.error).toBe("entries_closed");
    const C = await mkTeam(2);
    expect((await enterTeam(devTok, t, C.teamId, members(C.bots))).body.error).toBe("entries_closed");
    // P2-3 · excluir una inscripción de un torneo cancelado tampoco se permite (ni el dueño ni el organizador).
    const [firstEntry] = await entriesOf(t);
    for (const tok of [devTok, orgTok]) {
      const ex = await exclude(tok, t, firstEntry.id);
      expect(ex.status, JSON.stringify(ex.body)).toBe(409);
      expect(ex.body.error).toBe("entries_closed");
    }
    expect(await entriesOf(t)).toHaveLength(4);
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(4);
    // Y el cierre ya no es posible.
    const cl = await closeEntries(t);
    expect(cl.status).toBe(409);
    expect(cl.body.error).toBe("illegal_transition");
  });

  it("T287_MO_CLOSE_CONSENT_GONE · una inscripción de equipo sin autorización vigente no compite al cerrar", async () => {
    const M = await mkMultiOwnerTeam();
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    expect((await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]))).status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    await h.db("team_entry_consents").where({ tournament_id: t, bot_id: M.theirs }).del();
    const c = await closeEntries(t);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("team_roster_changed");
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
  });

  it("T287_MO_PRIVACY · autorizar e inscribir no cambia visibilidad, code_public ni dueño; la lista sólo da bot y versión", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    const before = await privacyView([M.mine, M.theirs]);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    expect((await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]))).status).toBe(201);
    expect(await privacyView([M.mine, M.theirs])).toEqual(before);
    const list = await request(app).get(`/tournaments/${t}/team-consents?teamId=${M.teamId}`).set(as(devTok));
    expect(list.status).toBe(200);
    for (const c of list.body.items) expect(Object.keys(c).sort()).toEqual(["botId", "mine", "version"]);
    expect(list.body.items.find((c: { botId: string }) => c.botId === M.theirs).mine).toBe(false);
  });
});

describe("#287 ronda 2 · H7", () => {
  it("T287_UPPER_UUID · un teamId en MAYÚSCULAS se normaliza", async () => {
    const A = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const r = await enterTeam(devTok, t, A.teamId.toUpperCase(), members(A.bots));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.teamId).toBe(A.teamId);
  });
});

// ------------------------------------------------------------------ ronda 3 (revisión R2)

async function lockWaiters(n: number, timeoutMs = 10_000): Promise<number> {
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
const teamCounts = async (t: string) =>
  (await h.db("entries").where({ tournament_id: t }).select("team_id").count("* as n").groupBy("team_id")).map(
    (r: { n: string | number }) => Number(r.n),
  );
const auditId = async (action: string, target: string) =>
  Number((await h.db("audit_log").where({ action, target }).orderBy("id", "desc").first())?.id ?? 0);

/**
 * Deja el cierre de `t` PARADO a mitad (después de validar, en el UPDATE que congela las
 * inscripciones): una transacción auxiliar bloquea una de sus filas. Devuelve la promesa del
 * cierre y la función que libera el bloqueo.
 */
async function closeStuck(t: string, entryId: string) {
  const holder = await h.db.transaction();
  await holder("entries").where({ id: entryId }).forUpdate();
  const pClose = closeEntries(t).then((r) => r);
  expect(await lockWaiters(1)).toBeGreaterThanOrEqual(1);
  return { pClose, release: () => holder.rollback() };
}

describe("#287 ronda 3 · R2-1 · exclusión concurrente con el cierre", () => {
  it("T287_EXCLUDE_RACE · el dueño se excluye mientras el cierre está en curso: espera y ve el torneo cerrado; ningún equipo a medias", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const C = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const ea = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(ea.status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    expect((await enterTeam(devTok, t, C.teamId, members(C.bots))).status).toBe(201);
    const { pClose, release } = await closeStuck(t, ea.body.entries[0].id);
    const pEx = exclude(devTok, t, ea.body.entries[1].id).then((r) => r);
    // La exclusión queda esperando al torneo (o al menos no termina antes de liberar el cierre).
    await lockWaiters(2, 1500);
    await release();
    const [cl, ex] = await Promise.all([pClose, pEx]);
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    expect(ex.status).toBe(409);
    expect(ex.body.error).toBe("entries_closed");
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("closed");
    expect((await teamCounts(t)).sort()).toEqual([2, 2, 2]);
    const rows = await entriesOf(t);
    expect(rows.every((e: { frozen: boolean }) => e.frozen)).toBe(true);
  });
});

describe("#287 ronda 3 · R2-2 · autorizaciones (tests del revisor)", () => {
  it("T287_THIRD_PARTY · ni el capitán ni el admin ni el organizador autorizan un bot ajeno; ni retiran una autorización ajena", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    const st = [
      await consent(devTok, t, M.teamId, M.theirs),
      await consent(adminTok, t, M.teamId, M.theirs),
      await consent(orgTok, t, M.teamId, M.theirs),
    ].map((r) => r.status);
    expect(st).toEqual([404, 404, 404]);
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(0);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    const rv = [await revoke(devTok, t, M.theirs), await revoke(adminTok, t, M.theirs)].map((r) => r.status);
    expect(rv).toEqual([404, 404]);
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(1);
  });

  it("T287_CONSENT_OTHER_TEAM · la autorización dada para el equipo X no vale para el equipo Y", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    const Y = await mkTeam(1, [userId]);
    await h.db("bots").where({ id: M.theirs }).update({ team_id: Y.teamId });
    const r = await enterTeam(devTok, t, Y.teamId, members([Y.bots[0], M.theirs]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_consent_required");
    expect(await entriesOf(t)).toHaveLength(0);
  });
});

describe("#287 ronda 3 · R2-3 · cambios de equipo o de versión durante el cierre", () => {
  it("T287_CLOSE_REMOVE_RACE · un removeTeamBot durante el cierre espera a que termine (lo validado es lo que se cierra)", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const ea = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(ea.status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const { pClose, release } = await closeStuck(t, ea.body.entries[1].id);
    const pRm = request(app)
      .delete(`/teams/${A.teamId}/bots/${A.bots[0]}`)
      .set(as(devTok))
      .then((r) => r);
    await lockWaiters(2, 1500);
    await release();
    const [cl, rm] = await Promise.all([pClose, pRm]);
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    expect(rm.status).toBe(204);
    // La salida del bot se aplicó DESPUÉS del cierre (su auditoría es posterior).
    expect(await auditId("team.bot_removed", `team:${A.teamId}`)).toBeGreaterThan(
      await auditId("tournament.entries_closed", `tournament:${t}`),
    );
  });

  it("T287_CLOSE_SUSPEND_RACE · un suspend durante el cierre espera y, como la versión ya es otra (frozen), da 409; reintentado, frozen→suspended", async () => {
    const A = await mkTeam(2);
    const B = await mkTeam(2);
    const t = await openTeamsTournament(2);
    const ea = await enterTeam(devTok, t, A.teamId, members(A.bots));
    expect(ea.status).toBe(201);
    expect((await enterTeam(devTok, t, B.teamId, members(B.bots))).status).toBe(201);
    const { pClose, release } = await closeStuck(t, ea.body.entries[1].id);
    const pSus = request(app)
      .post(`/bots/${A.bots[0]}/versions/1/actions/suspend`)
      .set(as(adminTok))
      .send({ reason: "t287" })
      .then((r) => r);
    await lockWaiters(2, 1500);
    await release();
    const [cl, sus] = await Promise.all([pClose, pSus]);
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    // R3-1 · la suspensión se validó contra `published`; al desbloquearse la versión es
    // `frozen`: transición condicional ⇒ 409 con el estado real, sin tocar nada.
    expect(sus.status).toBe(409);
    expect(sus.body.error).toBe("illegal_transition");
    expect(sus.body.currentState).toBe("frozen");
    const target = `bot:${A.bots[0]}@1`;
    expect(await auditId("bot.version.freeze", target)).toBeGreaterThan(0);
    expect(await auditId("bot.version.suspend", target)).toBe(0);
    expect((await h.db("bot_versions").where({ bot_id: A.bots[0], version: 1 }).first()).state).toBe("frozen");
    // Reintentada sobre el estado real, frozen→suspended es legal.
    const again = await request(app)
      .post(`/bots/${A.bots[0]}/versions/1/actions/suspend`)
      .set(as(adminTok))
      .send({ reason: "t287" });
    expect(again.status).toBe(200);
  });

  it("T287_CLOSE_RETIRE_RACE · un retire durante el cierre espera y da 409: la versión queda frozen (nunca frozen→retired)", async () => {
    const t = await indTournament();
    const a = await mkBot(devId, null);
    const b = await mkBot(devId, null);
    const ea = await enterOne(devTok, t, a);
    expect(ea.status).toBe(201);
    const eb = await enterOne(devTok, t, b);
    expect(eb.status).toBe(201);
    const { pClose, release } = await closeStuck(t, eb.body.id);
    const pRet = request(app)
      .post(`/bots/${a}/versions/1/actions/retire`)
      .set(as(devTok))
      .send({})
      .then((r) => r);
    await lockWaiters(2, 1500);
    await release();
    const [cl, ret] = await Promise.all([pClose, pRet]);
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    expect(ret.status).toBe(409);
    expect(ret.body.error).toBe("illegal_transition");
    expect(ret.body.currentState).toBe("frozen");
    expect((await h.db("bot_versions").where({ bot_id: a, version: 1 }).first()).state).toBe("frozen");
    expect(await h.db("audit_log").where({ action: "bot.version.freeze", target: `bot:${a}@1` })).toHaveLength(1);
    expect(await h.db("audit_log").where({ action: "bot.version.retire", target: `bot:${a}@1` })).toHaveLength(0);
  });

  it("T287_PUBLISH_SUSPEND_RACE · publish y suspend concurrentes sobre la misma versión validada: gana uno, el otro 409, una sola auditoría", async () => {
    const a = await mkBot(devId, null, { state: "validated" });
    // Retiene el primer UPDATE de esa versión (la publicación) con su bloqueo de fila.
    await h.db.raw(`
      CREATE OR REPLACE FUNCTION t287_hold_pub() RETURNS trigger AS $$
      BEGIN IF NEW.bot_id = '${a}'::uuid AND NEW.state = 'published' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t287_hold_pub BEFORE UPDATE ON bot_versions FOR EACH ROW EXECUTE FUNCTION t287_hold_pub();`);
    try {
      const pPub = request(app)
        .post(`/bots/${a}/versions/1/actions/publish`)
        .set(as(devTok))
        .send({})
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      const pSus = request(app)
        .post(`/bots/${a}/versions/1/actions/suspend`)
        .set(as(adminTok))
        .send({ reason: "t287" })
        .then((r) => r);
      const [pub, sus] = await Promise.all([pPub, pSus]);
      expect(pub.status, JSON.stringify(pub.body)).toBe(200);
      expect(sus.status).toBe(409);
      expect(sus.body.error).toBe("illegal_transition");
      expect(sus.body.currentState).toBe("published");
    } finally {
      await h.db.raw(`DROP TRIGGER IF EXISTS t287_hold_pub ON bot_versions; DROP FUNCTION IF EXISTS t287_hold_pub();`);
    }
    expect((await h.db("bot_versions").where({ bot_id: a, version: 1 }).first()).state).toBe("published");
    expect(await h.db("audit_log").where({ action: "bot.version.suspend", target: `bot:${a}@1` })).toHaveLength(0);
    expect(await h.db("audit_log").where({ action: "bot.version.publish", target: `bot:${a}@1` })).toHaveLength(1);
  });
});

describe("#287 ronda 4 · R3-2 · orden común de bloqueo de bots", () => {
  it("T287_DEADLOCK_RTM · removeTeamMember (2 bots, orden físico inverso al de id) contra el cierre: sin deadlock ni 500", async () => {
    // bFirst (insertado antes) con id MAYOR que bSecond: el UPDATE recorre (bFirst, bSecond)
    // en orden físico y el cierre bloquea por id (bSecond, bFirst).
    let teamId = "";
    let bFirst = "";
    let bSecond = "";
    for (let k = 0; k < 40; k++) {
      const [team] = await h
        .db("teams")
        .insert({ name: `T287-dl-${++seq}`, captain_id: userId })
        .returning("*");
      await h.db("team_members").insert([
        { team_id: team.id, user_id: userId, role: "captain" },
        { team_id: team.id, user_id: devId, role: "member" },
      ]);
      teamId = team.id as string;
      bFirst = await mkBot(devId, teamId);
      bSecond = await mkBot(devId, teamId);
      if (bFirst > bSecond) break;
    }
    expect(bFirst > bSecond).toBe(true);
    const t = await indTournament();
    for (const id of [bFirst, bSecond]) expect((await enterOne(devTok, t, id)).status).toBe(201);
    await h.db.raw(`
      CREATE OR REPLACE FUNCTION t287_hold_bot() RETURNS trigger AS $$
      BEGIN IF NEW.id = '${bFirst}'::uuid AND NEW.team_id IS NULL THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t287_hold_bot BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION t287_hold_bot();`);
    try {
      const pRm = request(app)
        .delete(`/teams/${teamId}/members/${devId}`)
        .set(as(adminTok))
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 400));
      const pClose = closeEntries(t).then((r) => r);
      const [rm, cl] = await Promise.all([pRm, pClose]);
      expect(rm.status, JSON.stringify(rm.body)).toBe(204);
      expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    } finally {
      await h.db.raw(`DROP TRIGGER IF EXISTS t287_hold_bot ON bots; DROP FUNCTION IF EXISTS t287_hold_bot();`);
    }
  });
});

// ------------------------------------------------------------------ ronda corta de corrección de #290

/** ¿Está bloqueada la fila por otra transacción? (FOR UPDATE NOWAIT: 55P03 si hay un cerrojo en conflicto). */
async function rowLocked(table: "bots" | "bot_versions", id: string): Promise<boolean> {
  const trx = await h.db.transaction();
  try {
    await trx.raw(`SELECT 1 FROM ${table} WHERE id = ? FOR UPDATE NOWAIT`, [id]);
    return false;
  } catch (e) {
    if ((e as { code?: string }).code === "55P03") return true;
    throw e;
  } finally {
    await trx.rollback().catch(() => undefined);
  }
}
/** Dos uuid ordenados: lo < hi (el orden de bloqueo común es el de id ascendente). */
const idPair = (): { lo: string; hi: string } => {
  const [lo, hi] = [randomUUID(), randomUUID()].sort();
  return { lo, hi };
};

describe("#290 corrección · P2-1 · viewer de enterTournamentTeam ({userId, staff:false})", () => {
  it("T290_TEAM_VIEWER · un bot AJENO autorizado que deja de ser elegible da un 409 genérico; uno PROPIO, el detalle", async () => {
    const M = await mkMultiOwnerTeam();
    const t = await openTeamsTournament(2);
    expect((await consent(userTok, t, M.teamId, M.theirs)).status).toBe(200);
    // Tras la autorización, el loadout del bot ajeno deja de ser elegible (p. ej. cambia el catálogo).
    const rev = await createLoadoutRevision(h.db, M.theirs, BAD_AMMO as never, SUMMARY);
    await h.db("bot_versions").where({ bot_id: M.theirs, version: 1 }).update({ loadout_revision: rev.revision });
    const r = await enterTeam(devTok, t, M.teamId, members([M.mine, M.theirs]));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.notEligible).toHaveLength(1);
    expect(r.body.notEligible[0].botId).toBe(M.theirs);
    expect(r.body.notEligible[0].violations).toEqual([]); // sin el detalle del loadout ajeno
    expect(r.body.notEligible[0].message).toBeUndefined();
    expect(r.body.notEligible[0].suggestedAction).toBeUndefined();
    expect(r.body.message).toContain("la versión no es elegible");
    expect(JSON.stringify(r.body)).not.toMatch(/ammo|munici/i);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T290_TEAM_VIEWER_OWN · el dueño que inscribe su propio bot no elegible SÍ recibe el motivo real", async () => {
    const A = await mkTeam(1);
    const bad = await mkBot(devId, A.teamId, { loadout: BAD_AMMO });
    const t = await openTeamsTournament(2);
    const r = await enterTeam(devTok, t, A.teamId, members([A.bots[0], bad]));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.notEligible[0].botId).toBe(bad);
    expect(r.body.notEligible[0].violations.length).toBeGreaterThan(0);
    expect(r.body.notEligible[0].message).toBeTruthy();
    expect(await entriesOf(t)).toHaveLength(0);
  });
});

describe("#290 corrección · P2-2 · orden de id de los cerrojos (las dos orientaciones)", () => {
  // Técnica: otra transacción H retiene la fila de MAYOR id; la operación espera en ella. Si
  // bloquea en orden de id ascendente, ya posee la de MENOR id y una prueba NOWAIT la ve
  // bloqueada; si bloquea en otro orden (físico, created_at, descendente) llega a la de
  // mayor id sin haber tomado la otra y el interbloqueo con quien sí ordena por id es posible.
  // `loFirst`: la fila de menor id se inserta antes (orden físico = orden de id) o después.
  for (const loFirst of [true, false]) {
    const tag = loFirst ? "FISICO=ID" : "FISICO=INVERSO";

    it(`T287_LOCK_ORDER_CLOSE_BOTS · closeEntries bloquea los bots por id ascendente (${tag})`, async () => {
      const { lo, hi } = idPair();
      const ids = loFirst ? [lo, hi] : [hi, lo];
      const bots: string[] = [];
      for (const id of ids) bots.push(await mkBot(devId, null, { id }));
      const t = await indTournament();
      for (const b of bots) expect((await enterOne(devTok, t, b)).status).toBe(201);
      const holder = await h.db.transaction();
      await holder.raw("SELECT 1 FROM bots WHERE id = ? FOR UPDATE", [hi]);
      const pClose = closeEntries(t).then((r) => r);
      expect(await lockWaiters(1)).toBeGreaterThanOrEqual(1);
      const loHeld = await rowLocked("bots", lo);
      await holder.rollback();
      const cl = await pClose;
      expect(loHeld, "el cierre debe tener ya el bot de menor id mientras espera al de mayor id").toBe(true);
      expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    });

    it(`T287_LOCK_ORDER_CLOSE_VERSIONS · closeEntries bloquea las versiones por id ascendente (${tag})`, async () => {
      const { lo, hi } = idPair();
      const vids = loFirst ? [lo, hi] : [hi, lo];
      const bots: string[] = [];
      for (const versionId of vids) bots.push(await mkBot(devId, null, { versionId }));
      const t = await indTournament();
      for (const b of bots) expect((await enterOne(devTok, t, b)).status).toBe(201);
      const holder = await h.db.transaction();
      await holder.raw("SELECT 1 FROM bot_versions WHERE id = ? FOR UPDATE", [hi]);
      const pClose = closeEntries(t).then((r) => r);
      expect(await lockWaiters(1)).toBeGreaterThanOrEqual(1);
      const loHeld = await rowLocked("bot_versions", lo);
      await holder.rollback();
      const cl = await pClose;
      expect(loHeld, "el cierre debe tener ya la versión de menor id mientras espera a la de mayor id").toBe(true);
      expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    });

    it(`T287_LOCK_ORDER_ENTER_TEAM · enterTournamentTeam bloquea los bots por id ascendente (${tag})`, async () => {
      const { lo, hi } = idPair();
      const [team] = await h
        .db("teams")
        .insert({ name: `T287-lo-${++seq}`, captain_id: devId })
        .returning("*");
      await h.db("team_members").insert({ team_id: team.id, user_id: devId, role: "captain" });
      for (const id of loFirst ? [lo, hi] : [hi, lo]) await mkBot(devId, team.id as string, { id });
      const t = await openTeamsTournament(2);
      const holder = await h.db.transaction();
      await holder.raw("SELECT 1 FROM bots WHERE id = ? FOR UPDATE", [hi]);
      const pEnter = enterTeam(devTok, t, team.id as string, members([lo, hi])).then((r) => r);
      expect(await lockWaiters(1)).toBeGreaterThanOrEqual(1);
      const loHeld = await rowLocked("bots", lo);
      await holder.rollback();
      const en = await pEnter;
      expect(loHeld, "la inscripción debe tener ya el bot de menor id mientras espera al de mayor id").toBe(true);
      expect(en.status, JSON.stringify(en.body)).toBe(201);
    });
  }
});
