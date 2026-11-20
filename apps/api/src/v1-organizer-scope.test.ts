/**
 * V1-A · #306 · El rol `organizer` es GLOBAL, pero lo que concede sobre datos ajenos no
 * puede serlo. Política DOCUMENTADA (docs/user/visibility.md:46,58,60; battles.md:94):
 *  - la organización de un torneo ve las batallas y el NOMBRE de los bots de SU torneo
 *    (el que creó), aunque no se retransmita; no ve ficha ni código;
 *  - en batallas de práctica, en torneos de OTROS y en la clasificación de temporada es un
 *    usuario más (un bot privado ajeno sale como «Bot privado», la batalla es 404);
 *  - el diagnóstico y la CPU son del dueño del bot y de moderator/admin, NUNCA del organizer.
 * moderator y admin NO cambian: leen todo.
 *
 * Calibración (mutantes): scripts/v1-organizer-scope-mutants.sh.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { hiddenBotIds, whereBotIdentifiable } from "./battle-access.js";
import { ROLE_RANK } from "./openapi.js";

type Actor = "anon" | "stranger" | "owner" | "orgA" | "orgB" | "moderator" | "admin";
const ACTORS: Actor[] = ["anon", "stranger", "owner", "orgA", "orgB", "moderator", "admin"];

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
const T: Record<string, string> = {}; // torneos
const B: Record<string, string> = {}; // batallas
let privA: string; // bot privado jugando en el torneo de orgA
let privB: string; // bot privado jugando en el torneo de orgB
let privP: string; // bot privado sólo en práctica
const SECRET_NAMES: Record<string, string> = {};

const auth = (a: Actor): Record<string, string> => (a === "anon" ? {} : { Authorization: `Bearer ${tok[a]}` });
const get = (a: Actor, path: string) => request(app).get(path).set(auth(a));

async function newUser(label: string, roles: string[]): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@v1a.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  for (const role of roles) await h.db("user_roles").insert({ user_id: u.id, role });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newBot(ownerId: string, tag: string): Promise<string> {
  const id = randomUUID();
  const name = `SECRETO-${tag}-${id.slice(0, 6)}`;
  await h.db("bots").insert({ id, name, owner_id: ownerId, visibility: "private" });
  SECRET_NAMES[id] = name;
  const cv = (await h.db("catalog_versions").first()).catalog_version;
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: cv,
    chassis: "chassis.scout@1",
    modules: JSON.stringify([]),
  });
  await h
    .db("bot_versions")
    .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
  return id;
}

async function newBattle(botIds: string[], tournamentId: string | null): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: "finished",
    official: tournamentId !== null,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "v1a-seed",
    tournament_id: tournamentId,
    replay_ref: `/nonexistent/${id}.jsonl.gz`,
    replay_hash: "0".repeat(64),
    final_state_hash: "0".repeat(64),
    result: JSON.stringify({ winner: "A", ticks: 10 }),
    finished_at: h.db.fn.now(),
  });
  let i = 0;
  for (const botId of botIds) {
    await h
      .db("participants")
      .insert({ battle_id: id, bot_id: botId, version: 1, team: i++ % 2 ? "B" : "A", cpu_ms: 4242 });
  }
  return id;
}

async function newTournament(token: string, name: string): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${token}`)
    .send({ name, format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function newMatch(tournamentId: string, a: string, b: string, winner: string): Promise<void> {
  await h.db("matches").insert({
    tournament_id: tournamentId,
    round: 1,
    slot: "r1m1",
    pairing: JSON.stringify({ home: a, away: b }),
    state: "finished",
    winner_bot_id: winner,
    final: true,
  });
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 }, publicReplaysEnabled: false });
  const owner = await newUser("v1a-owner", ["user"]);
  const stranger = await newUser("v1a-stranger", ["user"]);
  const orgA = await newUser("v1a-org-a", ["user", "organizer"]);
  const orgB = await newUser("v1a-org-b", ["user", "organizer"]);
  Object.assign(tok, { owner: owner.token, stranger: stranger.token, orgA: orgA.token, orgB: orgB.token });
  Object.assign(uid, { owner: owner.id, orgA: orgA.id, orgB: orgB.id });
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);

  T.A = await newTournament(orgA.token, "v1a-torneo-de-orgA");
  T.B = await newTournament(orgB.token, "v1a-torneo-de-orgB");
  privA = await newBot(owner.id, "A");
  privB = await newBot(owner.id, "B");
  privP = await newBot(owner.id, "P");
  const other = await newBot(owner.id, "X");
  B.practice = await newBattle([privP, other], null);
  B.ta = await newBattle([privA, other], T.A);
  B.tb = await newBattle([privB, other], T.B);
  await newMatch(T.A, privA, other, privA);
  await newMatch(T.B, privB, other, privB);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

// Quién LEE cada batalla (publicReplays y publicSpectate desactivados).
const READ: Record<"practice" | "ta" | "tb", Actor[]> = {
  practice: ["owner", "moderator", "admin"], // #306: orgA y orgB ya NO
  ta: ["owner", "orgA", "moderator", "admin"], // orgA SÍ: es su torneo
  tb: ["owner", "orgB", "moderator", "admin"],
};

describe("#306 · lectura de batallas por rol", () => {
  for (const name of ["practice", "ta", "tb"] as const) {
    for (const actor of ACTORS) {
      const allowed = READ[name].includes(actor);
      it(`GET /battles/{id} · ${name} · ${actor} ⇒ ${allowed ? 200 : 404}`, async () => {
        const r = await get(actor, `/battles/${B[name]}`);
        expect(r.status).toBe(allowed ? 200 : 404);
      });
    }
  }

  it("GET /battles (listado): cada rol ve exactamente sus batallas", async () => {
    for (const actor of ACTORS) {
      const r = await get(actor, "/battles?limit=100");
      expect(r.status).toBe(200);
      const ids = new Set((r.body.items as { id: string }[]).map((b) => b.id));
      for (const name of ["practice", "ta", "tb"] as const) {
        expect(ids.has(B[name]), `${actor} / ${name}`).toBe(READ[name].includes(actor));
      }
    }
  });

  it("GET /replays (listado): misma política que la lectura de batallas", async () => {
    for (const actor of ACTORS) {
      const r = await get(actor, "/replays?limit=100");
      if (actor === "anon") {
        expect(r.status).toBe(401); // el listado exige sesión
        continue;
      }
      expect(r.status).toBe(200);
      const ids = new Set((r.body.items as { battleId: string }[]).map((b) => b.battleId));
      for (const name of ["practice", "ta", "tb"] as const) {
        expect(ids.has(B[name]), `${actor} / ${name}`).toBe(READ[name].includes(actor));
      }
    }
  });

  it("GET /tournaments/{id}/battles: el organizador ve las de SU torneo y no las del ajeno", async () => {
    const own = await get("orgA", `/tournaments/${T.A}/battles`);
    expect((own.body.items as { id: string }[]).map((b) => b.id)).toEqual([B.ta]);
    const foreign = await get("orgA", `/tournaments/${T.B}/battles`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toEqual([]);
  });

  it("estadísticas y auditoría: 404 al organizador ajeno, 200 al creador y a moderator/admin", async () => {
    for (const path of ["stats", "audit"]) {
      for (const actor of ACTORS) {
        const r = await get(actor, `/battles/${B.ta}/${path}`);
        expect(r.status === 200, `${path} · ${actor} (${r.status})`).toBe(READ.ta.includes(actor));
      }
    }
  });
});

describe("#306 · diagnóstico y CPU: dueño y moderator/admin, nunca el organizer", () => {
  const DIAG: Actor[] = ["owner", "moderator", "admin"];
  for (const actor of ["orgA", "owner", "moderator", "admin"] as const) {
    it(`GET /battles/{id} · torneo de orgA · ${actor}: diagnosticsVisible/cpuMs`, async () => {
      const r = await get(actor, `/battles/${B.ta}`);
      expect(r.status).toBe(200);
      const mine = (r.body.participants as { botId: string; diagnosticsVisible: boolean; cpuMs: number | null }[]).find(
        (p) => p.botId === privA,
      )!;
      const visible = DIAG.includes(actor);
      expect(mine.diagnosticsVisible).toBe(visible);
      expect(mine.cpuMs).toBe(visible ? 4242 : null);
    });
  }
  it("el creador SIGUE viendo el nombre de los bots de su torneo (permitido)", async () => {
    const r = await get("orgA", `/battles/${B.ta}`);
    const p = (r.body.participants as { botId: string; botName?: string }[]).find((x) => x.botId === privA)!;
    expect(p.botName).toBe(SECRET_NAMES[privA]);
  });
});

describe("#306 · cuadro del torneo: nombre sólo para el creador (o dueño, moderator, admin)", () => {
  const sees = (actor: Actor, t: "A" | "B") =>
    actor === "moderator" || actor === "admin" || actor === "owner" || actor === (t === "A" ? "orgA" : "orgB");
  for (const t of ["A", "B"] as const) {
    for (const actor of ACTORS) {
      it(`GET /tournaments/{T.${t}}/matches · ${actor}: ${sees(actor, t) ? "nombre" : "«Bot privado»"}`, async () => {
        const r = await get(actor, `/tournaments/${T[t]}/matches`);
        expect(r.status).toBe(200);
        const m = (r.body.matches as Record<string, unknown>[])[0];
        const text = JSON.stringify(r.body);
        if (sees(actor, t)) {
          expect(m.winnerBotName).toBe(SECRET_NAMES[t === "A" ? privA : privB]);
        } else {
          expect(m).not.toHaveProperty("winnerBotName");
          expect(m.winnerPrivate).toBe(true);
          expect(text).not.toContain("SECRETO-");
        }
      });
    }
  }
});

describe("#306 · hiddenBotIds / whereBotIdentifiable (capa de política)", () => {
  const authOf = (id: string, rank: number) => ({ userId: id, sessionId: "s", roles: [], rank }) as never;
  it("sin contexto de torneo (clasificación de temporada) el organizer es un usuario más", async () => {
    const hidden = await hiddenBotIds(h.db, authOf(uid.orgA, ROLE_RANK.organizer), [privA, privB, privP]);
    expect([...hidden].sort()).toEqual([privA, privB, privP].sort());
  });
  it("con el torneo propio como contexto no oculta nada; con el ajeno oculta todo", async () => {
    const a = authOf(uid.orgA, ROLE_RANK.organizer);
    expect((await hiddenBotIds(h.db, a, [privA], { tournamentId: T.A })).size).toBe(0);
    expect((await hiddenBotIds(h.db, a, [privB], { tournamentId: T.B })).has(privB)).toBe(true);
  });
  it("moderator y admin no ocultan nada, con o sin contexto", async () => {
    for (const rank of [ROLE_RANK.moderator, ROLE_RANK.admin]) {
      expect((await hiddenBotIds(h.db, authOf(randomUUID(), rank), [privA, privB, privP])).size).toBe(0);
    }
  });
  it("whereBotIdentifiable: el organizer identifica los bots de sus torneos y no los de otros", async () => {
    const ids = async (id: string, rank: number) =>
      new Set(
        (await whereBotIdentifiable(h.db, h.db("bots").whereIn("id", [privA, privB, privP]), authOf(id, rank))).map(
          (r: { id: string }) => r.id,
        ),
      );
    expect(await ids(uid.orgA, ROLE_RANK.organizer)).toEqual(new Set([privA]));
    expect(await ids(uid.orgB, ROLE_RANK.organizer)).toEqual(new Set([privB]));
    expect((await ids(randomUUID(), ROLE_RANK.moderator)).size).toBe(3);
  });
});

describe("V1-A · ajustes de acceso público (migración 021): sólo admin, y persisten en la BD", () => {
  const patch = (a: Actor, body: Record<string, unknown>) =>
    request(app).patch("/admin/settings/public-access").set(auth(a)).send(body);

  it("anónimo ⇒ 401; usuario, organizer y moderator ⇒ 403 en GET y PATCH, y la fila no cambia", async () => {
    const before = await h.db("app_runtime_settings").where({ id: 1 }).first();
    for (const [actor, code] of [
      ["anon", 401],
      ["stranger", 403],
      ["orgA", 403],
      ["moderator", 403],
    ] as const) {
      expect((await get(actor, "/admin/settings/public-access")).status, `GET ${actor}`).toBe(code);
      expect((await patch(actor, { publicReplaysEnabled: true })).status, `PATCH ${actor}`).toBe(code);
    }
    const after = await h.db("app_runtime_settings").where({ id: 1 }).first();
    expect(after?.public_replays_enabled ?? false).toBe(before?.public_replays_enabled ?? false);
  });

  it("admin cambia el ajuste, queda en la fila `app_runtime_settings` y en la auditoría; la fila manda", async () => {
    const r = await patch("admin", { publicReplaysEnabled: true, publicSpectateEnabled: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await h.db("app_runtime_settings").where({ id: 1 }).first();
    expect([row.public_replays_enabled, row.public_spectate_enabled]).toEqual([true, true]);
    const log = await h.db("audit_log").where({ action: "settings.public_access.update" });
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect((await patch("admin", { publicReplaysEnabled: false, publicSpectateEnabled: false })).status).toBe(200);
    const off = await h.db("app_runtime_settings").where({ id: 1 }).first();
    expect([off.public_replays_enabled, off.public_spectate_enabled]).toEqual([false, false]);
  });
});
