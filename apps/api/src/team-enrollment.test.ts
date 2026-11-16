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
  opts: { state?: string; loadout?: object; visibility?: string } = {},
): Promise<string> {
  const name = `T287-${++seq}`;
  const [bot] = await h
    .db("bots")
    .insert({ name, owner_id: ownerId, team_id: teamId, visibility: opts.visibility ?? "private" })
    .returning("*");
  await createLoadoutRevision(h.db, bot.id, (opts.loadout ?? GOOD) as never, SUMMARY);
  await h.db("bot_versions").insert({
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

  it("T287_OWNER · un bot del equipo de OTRO dueño ⇒ 403 team_bot_not_owned", async () => {
    const A = await mkTeam(3, [userId]);
    const theirs = await mkBot(userId, A.teamId);
    const t = await openTeamsTournament(4);
    const r = await enterTeam(devTok, t, A.teamId, members([...A.bots, theirs]));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("team_bot_not_owned");
    expect(r.body.botIds).toEqual([theirs]);
    expect(await entriesOf(t)).toHaveLength(0);
  });

  it("T287_NOT_TEAM_MEMBER · quien no es miembro del equipo no lo inscribe ⇒ 403", async () => {
    const A = await mkTeam(4);
    const t = await openTeamsTournament(4);
    const r = await enterTeam(userTok, t, A.teamId, members(A.bots));
    expect(r.status).toBe(403);
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
