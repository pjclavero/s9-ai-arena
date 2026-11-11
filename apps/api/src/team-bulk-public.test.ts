/**
 * #255 · B5-B7/B17 · «Hacer públicos los bots administrables» desde Equipo
 * (POST /teams/{teamId}/actions/publish-bots).
 *
 * Expectativas escritas desde la POLÍTICA (no desde el código):
 *  - sólo cambia un bot si quien lo pide es su DUEÑO (la misma regla que PATCH
 *    /bots/{id}); ser capitán NO da autoridad sobre bots ajenos;
 *  - los no autorizados salen como `not_authorized`, intactos y sin revelar su
 *    visibilidad; el resultado parcial se cuenta tal cual;
 *  - `dryRun` no escribe nada;
 *  - el código NUNCA se publica salvo `includeCode: true`, y sólo el de la versión
 *    publicada más reciente; las demás versiones no cambian;
 *  - un no miembro recibe 403; un equipo inexistente, 404; cada cambio queda auditado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;

async function newUser(label: string, role = "developer") {
  const e = `${label}-${randomUUID().slice(0, 8)}@bulk.example.test`;
  const [u] = await h.db("users").insert({ email: e, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role });
  return { id: u.id as string, token: await tokenFor(h.db, e) };
}

async function newBot(ownerId: string, name: string, visibility: string, teamId: string) {
  const b = await createPublishedBot(h.db, name, { ownerId });
  await h.db("bots").where({ id: b.botId }).update({ visibility, team_id: teamId });
  return b.botId as string;
}

const vis = async (botId: string) => (await h.db("bots").where({ id: botId }).first()).visibility;
const codePublic = async (botId: string, version = 1) =>
  (await h.db("bot_versions").where({ bot_id: botId, version }).first()).code_public === true;
const call = (teamId: string, token: string | undefined, body: object) => {
  const r = request(app).post(`/teams/${teamId}/actions/publish-bots`);
  return (token ? r.set("Authorization", `Bearer ${token}`) : r).send(body);
};

let captain: { id: string; token: string };
let member: { id: string; token: string };
let outsider: { id: string; token: string };
let teamId: string;
const B: Record<string, string> = {};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  captain = await newUser("capitana");
  member = await newUser("miembro");
  outsider = await newUser("ajena");
  const [t] = await h
    .db("teams")
    .insert({ name: `bulk-${randomUUID().slice(0, 6)}`, captain_id: captain.id })
    .returning("id");
  teamId = t.id;
  await h.db("team_members").insert([
    { team_id: teamId, user_id: captain.id, role: "captain" },
    { team_id: teamId, user_id: member.id, role: "member" },
  ]);
  B.capPriv = await newBot(captain.id, `cap-priv-${randomUUID().slice(0, 4)}`, "private", teamId);
  B.capTeam = await newBot(captain.id, `cap-team-${randomUUID().slice(0, 4)}`, "team", teamId);
  B.capPub = await newBot(captain.id, `cap-pub-${randomUUID().slice(0, 4)}`, "public", teamId);
  B.memPriv = await newBot(member.id, `mem-priv-${randomUUID().slice(0, 4)}`, "private", teamId);
  B.memTeam = await newBot(member.id, `mem-team-${randomUUID().slice(0, 4)}`, "team", teamId);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

type R = { botId: string; outcome: string; previousVisibility?: string; code?: unknown };
const byBot = (results: R[]) => Object.fromEntries(results.map((x) => [x.botId, x]));

describe("#255 · publishTeamBots", () => {
  it("TEAM_BULK_PERMISSION_DENIED · anónimo 401, no miembro 403, equipo inexistente 404, cuerpo inválido 400; nada cambia", async () => {
    expect((await call(teamId, undefined, {})).status).toBe(401);
    expect((await call(teamId, outsider.token, {})).status).toBe(403);
    expect((await call(randomUUID(), captain.token, {})).status).toBe(404);
    expect((await call(teamId, captain.token, { dryRun: "sí" })).status).toBe(400);
    expect((await call(teamId, captain.token, { includeCode: 1 })).status).toBe(400);
    expect(await vis(B.capPriv)).toBe("private");
    expect(await vis(B.memPriv)).toBe("private");
  });

  it("dryRun · previsualiza con la regla del servidor y NO escribe nada", async () => {
    const r = await call(teamId, captain.token, { dryRun: true });
    expect(r.status).toBe(200);
    const by = byBot(r.body.results);
    expect(by[B.capPriv].outcome).toBe("would_make_public");
    expect(by[B.capTeam].outcome).toBe("would_make_public");
    expect(by[B.capPub].outcome).toBe("already_public");
    expect(by[B.memPriv].outcome).toBe("not_authorized");
    expect(by[B.memTeam].outcome).toBe("not_authorized");
    // De un bot ajeno no se revela la visibilidad.
    expect(by[B.memPriv].previousVisibility).toBeUndefined();
    expect(r.body.summary).toEqual({ changed: 2, alreadyPublic: 1, notAuthorized: 2, retired: 0 });
    expect(await vis(B.capPriv)).toBe("private");
    expect(await vis(B.capTeam)).toBe("team");
  });

  it("miembro SIN bots propios en el equipo · todo not_authorized y nada cambia (aunque no sea dryRun)", async () => {
    const lone = await newUser("solo");
    await h.db("team_members").insert({ team_id: teamId, user_id: lone.id, role: "member" });
    const r = await call(teamId, lone.token, {});
    expect(r.status).toBe(200);
    expect(r.body.summary.changed).toBe(0);
    expect(r.body.results.every((x: R) => x.outcome === "not_authorized")).toBe(true);
    expect(await vis(B.capPriv)).toBe("private");
    expect(await vis(B.memPriv)).toBe("private");
  });

  it("TEAM_BULK_PARTIAL_RESULT · la capitana cambia SÓLO sus bots; los del miembro quedan intactos; código intacto", async () => {
    const r = await call(teamId, captain.token, {});
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.summary).toEqual({ changed: 2, alreadyPublic: 1, notAuthorized: 2, retired: 0 });
    expect(await vis(B.capPriv)).toBe("public");
    expect(await vis(B.capTeam)).toBe("public");
    expect(await vis(B.memPriv)).toBe("private");
    expect(await vis(B.memTeam)).toBe("team");
    // CODE_PUBLIC=UNCHANGED por defecto.
    expect(await codePublic(B.capPriv)).toBe(false);
    expect(await codePublic(B.capTeam)).toBe(false);
    const audits = await h
      .db("audit_log")
      .where({ action: "bot.visibility_changed", actor_id: captain.id })
      .whereIn("target", [`bot:${B.capPriv}`, `bot:${B.capTeam}`]);
    expect(audits).toHaveLength(2);
    expect(await h.db("audit_log").where({ action: "bot.code_visibility_changed", actor_id: captain.id })).toHaveLength(
      0,
    );
  });

  it("includeCode · sólo publica el código de la versión publicada MÁS RECIENTE de los bots propios", async () => {
    const r = await call(teamId, member.token, { includeCode: true });
    expect(r.status).toBe(200);
    const by = byBot(r.body.results);
    expect(by[B.memPriv]).toMatchObject({ outcome: "made_public", code: { version: 1, outcome: "made_public" } });
    expect(by[B.capPriv].outcome).toBe("not_authorized");
    expect(by[B.capPriv].code).toBeUndefined();
    expect(await vis(B.memPriv)).toBe("public");
    expect(await codePublic(B.memPriv)).toBe(true);
    // Los bots de la capitana: código intacto (no son del miembro).
    expect(await codePublic(B.capPriv)).toBe(false);
  });
});

/**
 * #255 · ronda 1 (REVIEWER-B P3-1 y P3-2), escritas desde la política:
 *  - la confirmación va atada a lo previsualizado: si el conjunto de bots del equipo
 *    cambió, 409 `team_bots_changed` y NADA se escribe (un bot que entra después de
 *    la previsualización no se publica sin haberse previsualizado);
 *  - un bot RETIRADO de quien pide no se publica en bloque: sale como `retired`
 *    (distinguible) y queda intacto; uno ajeno, retirado o no, sólo `not_authorized`.
 */
describe("#255 R1 · publishTeamBots: previsualización atada y retirados", () => {
  let owner: { id: string; token: string };
  let other: { id: string; token: string };
  let tId: string;
  const R1: Record<string, string> = {};

  beforeAll(async () => {
    owner = await newUser("r1-duena");
    other = await newUser("r1-otro");
    const [t] = await h
      .db("teams")
      .insert({ name: `bulk-r1-${randomUUID().slice(0, 6)}`, captain_id: owner.id })
      .returning("id");
    tId = t.id;
    await h.db("team_members").insert([
      { team_id: tId, user_id: owner.id, role: "captain" },
      { team_id: tId, user_id: other.id, role: "member" },
    ]);
    R1.live = await newBot(owner.id, `r1-live-${randomUUID().slice(0, 4)}`, "private", tId);
    R1.retired = await newBot(owner.id, `r1-ret-${randomUUID().slice(0, 4)}`, "private", tId);
    await h.db("bots").where({ id: R1.retired }).update({ retired_at: h.db.fn.now() });
    R1.otherRetired = await newBot(other.id, `r1-oret-${randomUUID().slice(0, 4)}`, "private", tId);
    await h.db("bots").where({ id: R1.otherRetired }).update({ retired_at: h.db.fn.now() });
  }, 120_000);

  it("P3-2 · el retirado propio sale como `retired` y no cambia (ni con includeCode); el ajeno retirado, sólo not_authorized", async () => {
    const pre = await call(tId, owner.token, { dryRun: true, includeCode: true });
    expect(pre.status).toBe(200);
    const by = byBot(pre.body.results);
    expect(by[R1.live].outcome).toBe("would_make_public");
    expect(by[R1.retired].outcome).toBe("retired");
    expect(by[R1.retired].code).toBeUndefined();
    expect(by[R1.otherRetired]).toEqual({
      botId: R1.otherRetired,
      name: expect.any(String),
      outcome: "not_authorized",
    });
    expect(pre.body.summary).toEqual({ changed: 1, alreadyPublic: 0, notAuthorized: 1, retired: 1 });
    const ids = pre.body.results.map((x: R) => x.botId);
    const r = await call(tId, owner.token, { includeCode: true, expectBotIds: ids });
    expect(r.status).toBe(200);
    expect(byBot(r.body.results)[R1.retired].outcome).toBe("retired");
    expect(await vis(R1.retired)).toBe("private");
    expect(await codePublic(R1.retired)).toBe(false);
    expect(await vis(R1.live)).toBe("public");
    await h.db("bots").where({ id: R1.live }).update({ visibility: "private" });
    await h.db("bot_versions").where({ bot_id: R1.live }).update({ code_public: false });
  });

  it("P3-1 · un bot que entra tras la previsualización → 409 team_bots_changed y no se escribe nada", async () => {
    const pre = await call(tId, owner.token, { dryRun: true });
    const ids = pre.body.results.map((x: R) => x.botId);
    const intruder = await newBot(owner.id, `r1-new-${randomUUID().slice(0, 4)}`, "private", tId);
    const auditsBefore = (await h.db("audit_log").where({ actor_id: owner.id })).length;
    const r = await call(tId, owner.token, { expectBotIds: ids });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("team_bots_changed");
    expect(await vis(intruder)).toBe("private");
    expect(await vis(R1.live)).toBe("private");
    expect((await h.db("audit_log").where({ actor_id: owner.id })).length).toBe(auditsBefore);
    // Un bot que SALE también invalida la previsualización.
    const pre2 = await call(tId, owner.token, { dryRun: true });
    const ids2 = pre2.body.results.map((x: R) => x.botId);
    await h.db("bots").where({ id: intruder }).update({ team_id: null });
    const r2 = await call(tId, owner.token, { expectBotIds: ids2 });
    expect(r2.status).toBe(409);
    expect(await vis(R1.live)).toBe("private");
    // Con el conjunto vigente, sí.
    const pre3 = await call(tId, owner.token, { dryRun: true });
    const r3 = await call(tId, owner.token, { expectBotIds: pre3.body.results.map((x: R) => x.botId) });
    expect(r3.status).toBe(200);
    expect(await vis(R1.live)).toBe("public");
  });

  it("P3-1 · expectBotIds mal formado → 400 y nada cambia", async () => {
    await h.db("bots").where({ id: R1.live }).update({ visibility: "private" });
    expect((await call(tId, owner.token, { expectBotIds: "todos" })).status).toBe(400);
    expect((await call(tId, owner.token, { expectBotIds: [1, 2] })).status).toBe(400);
    expect(await vis(R1.live)).toBe("private");
  });
});
