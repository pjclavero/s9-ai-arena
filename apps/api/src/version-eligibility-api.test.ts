/**
 * ELIG · Elegibilidad histórica en la API, sobre BD efímera con datos EQUIVALENTES a
 * la cuenta de producción (H6): A-DEF y B-DEF con v1/v2 en la revisión 1 (cañón +
 * ammo.standard@1, guardada antes de RC5.3) y v3 en la revisión 2 (cañón + ammo.ap@1),
 * más ATK, SCOUT y prueba1 válidos.
 *
 * HISTÓRICO ≠ ELEGIBLE: v1/v2 siguen `published`, consultables y en sus batallas
 * antiguas; sólo no entran en batallas ni torneos nuevos. Nada se reescribe.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let userTok: string;
let adminTok: string;
let orgTok: string;
let devId: string;
let userId: string;

const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
type M = { slot: string; moduleId: string; ammo?: string };
const L = (chassis: string, modules: M[]) => ({ catalogVersion: "mvp@1", chassis, modules });

const defender = (ammo: string, power: string) =>
  L("chassis.heavy@1", [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: power },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ]);
const ATK = L("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);
const SCOUT = L("chassis.light@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.mg@2" },
  { slot: "ammo_main", moduleId: "ammo.standard@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
]);
const PRUEBA1 = L("chassis.heavy@1", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);

/**
 * Bot con revisiones guardadas SIN pasar por el validador actual (como quedaron las de
 * antes de RC5.3) y versiones publicadas: `[rev, rev, …]` = revisión de cada versión.
 */
async function histBot(
  name: string,
  ownerId: string,
  revs: ReturnType<typeof L>[],
  versionRevs: number[],
  visibility = "private",
) {
  const [bot] = await h.db("bots").insert({ name, owner_id: ownerId, visibility }).returning("*");
  for (const r of revs) await createLoadoutRevision(h.db, bot.id, r, SUMMARY);
  for (const [i, rev] of versionRevs.entries()) {
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: i + 1,
      state: "published",
      runtime: "python",
      loadout_revision: rev,
      artifact_hash: `hash-${name}-${i + 1}`,
      published_at: h.db.fn.now(),
    });
  }
  return bot.id as string;
}

let aDef: string;
let bDef: string;
let atk: string;
let scout: string;
let prueba1: string;
let alienPriv: string;
let alienPub: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  adminTok = await tokenFor(h.db, DEV_USERS.admin);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  const bad = defender("ammo.standard@1", "power.generator@2");
  const good = defender("ammo.ap@1", "power.generator@1");
  aDef = await histBot("A-DEF", devId, [bad, good], [1, 1, 2]);
  bDef = await histBot("B-DEF", devId, [bad, good], [1, 1, 2]);
  atk = await histBot("A-ATK-1", devId, [ATK], [1, 1]);
  scout = await histBot("A-SCOUT", devId, [SCOUT], [1, 1]);
  prueba1 = await histBot("prueba1", devId, [PRUEBA1], [1]);
  // Bots de OTRO usuario con la misma combinación inválida.
  alienPriv = await histBot("alien-priv", userId, [bad], [1], "private");
  alienPub = await histBot("alien-pub", userId, [bad, good], [1, 2], "public");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const battle = (ps: { botId: string; version: number; team: string }[]) => ({
  mode: "deathmatch",
  rulesetId: DEFAULT_RULESET_ID,
  mapId: "mvp-arena-02",
  participants: ps,
});

async function counts() {
  const n = async (t: string) => Number((await h.db(t).count({ n: "*" }))[0].n);
  return { battles: await n("battles"), jobs: await n("jobs"), entries: await n("entries") };
}

describe("H6 · la cuenta: histórico conservado, elegibilidad calculada", () => {
  it("A/B-DEF v1/v2 publicadas y NO elegibles (INVALID_AMMO); v3 elegible", async () => {
    for (const id of [aDef, bDef]) {
      const r = await request(app).get(`/bots/${id}/versions`).set(as(devTok));
      expect(r.status).toBe(200);
      const by = new Map(r.body.map((v: { version: number }) => [v.version, v]));
      for (const n of [1, 2]) {
        const v = by.get(n) as Record<string, any>;
        expect(v.state).toBe("published"); // H11: el estado histórico no cambia
        expect(v.battleEligibility).toMatchObject({
          eligible: false,
          reason: "loadout_no_longer_valid",
          category: "INVALID_AMMO",
        });
        expect(v.battleEligibility.message).toContain("weapon.cannon@1 no admite ammo.standard@1");
        expect(v.battleEligibility.suggestedAction).toBeTruthy();
      }
      expect((by.get(3) as Record<string, any>).battleEligibility).toMatchObject({ eligible: true, category: "VALID" });
    }
  });

  it("ATK, SCOUT y prueba1 siguen elegibles", async () => {
    for (const id of [atk, scout, prueba1]) {
      const r = await request(app).get(`/bots/${id}/versions`).set(as(devTok));
      for (const v of r.body) expect(v.battleEligibility, `${id} v${v.version}`).toMatchObject({ eligible: true });
    }
  });

  it("el detalle de la versión también lleva battleEligibility", async () => {
    const r = await request(app).get(`/bots/${aDef}/versions/2`).set(as(devTok));
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("published");
    expect(r.body.battleEligibility.eligible).toBe(false);
  });
});

describe("H7 · batallas nuevas (la API es la autoridad)", () => {
  it("1v1 con A-DEF v2 → 409 bot_version_not_eligible con motivo; no se crea batalla ni trabajo", async () => {
    const before = await counts();
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef, version: 2, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.message).toContain("se conserva para el histórico");
    expect(r.body.notEligible).toEqual([
      expect.objectContaining({ botId: aDef, version: 2, eligible: false, category: "INVALID_AMMO" }),
    ]);
    expect(await counts()).toEqual(before);
  });

  it("A-DEF v1 y B-DEF v1/v2 también se rechazan; A-DEF v3 y B-DEF v3 → 202", async () => {
    for (const [id, v] of [
      [aDef, 1],
      [bDef, 1],
      [bDef, 2],
    ] as const) {
      const r = await request(app)
        .post("/battles")
        .set(as(devTok))
        .send(
          battle([
            { botId: id, version: v, team: "red" },
            { botId: atk, version: 1, team: "blue" },
          ]),
        );
      expect(r.status, `${id} v${v}`).toBe(409);
    }
    const ok = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef, version: 3, team: "red" },
          { botId: bDef, version: 3, team: "blue" },
        ]),
      );
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
  });

  it("4v4 por equipos con UN solo bot no elegible → 409 (todo o nada)", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send({
        mode: "team_deathmatch",
        rulesetId: "team-deathmatch-mvp",
        mapId: "mvp-arena-01",
        participants: [
          { botId: aDef, version: 3, team: "red" },
          { botId: atk, version: 1, team: "red" },
          { botId: bDef, version: 1, team: "blue" },
          { botId: scout, version: 2, team: "blue" },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.notEligible.map((x: { botId: string }) => x.botId)).toEqual([bDef]);
  });
});

describe("H14.10 · autorización", () => {
  it("bot PRIVADO ajeno con versión no elegible → 404 bot_not_found (no se revela ni existencia ni motivo)", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: atk, version: 1, team: "red" },
          { botId: alienPriv, version: 1, team: "blue" },
        ]),
      );
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("bot_not_found");
    expect(JSON.stringify(r.body)).not.toMatch(/ammo|elegib|eligible/i);
    const vs = await request(app).get(`/bots/${alienPriv}/versions`).set(as(devTok));
    expect(vs.status).toBe(404);
  });

  it("bot PÚBLICO ajeno: el motivo sólo repite lo que ya es legible (su loadout)", async () => {
    const vs = await request(app).get(`/bots/${alienPub}/versions`).set(as(devTok));
    expect(vs.status).toBe(200);
    expect(vs.body[0].battleEligibility.eligible).toBe(false);
    const loadouts = await request(app).get(`/bots/${alienPub}/loadouts`).set(as(devTok));
    expect(loadouts.status).toBe(200);
    expect(JSON.stringify(loadouts.body)).toContain("ammo.standard@1");
  });

  it("el inventario es sólo admin: anónimo 401, usuario/organizador 403", async () => {
    expect((await request(app).get("/admin/bot-version-eligibility")).status).toBe(401);
    expect((await request(app).get("/admin/bot-version-eligibility").set(as(userTok))).status).toBe(403);
    expect((await request(app).get("/admin/bot-version-eligibility").set(as(orgTok))).status).toBe(403);
  });
});

describe("H8 · torneos", () => {
  async function openTournament(name: string) {
    const r = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({ name, format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  it("inscribir A-DEF v2 → 409 bot_version_not_eligible; v3 → 201", async () => {
    const t = await openTournament("elig-inscripcion");
    const bad = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: aDef, version: 2 });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("bot_version_not_eligible");
    expect(await h.db("entries").where({ tournament_id: t })).toHaveLength(0);
    const ok = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: aDef, version: 3 });
    expect(ok.status).toBe(201);
  });

  it("inscripción PENDIENTE de antes del fix con v1: el cierre se niega (nada se congela) hasta que el dueño elige v3", async () => {
    const t = await openTournament("elig-pendiente");
    // Inscripción hecha antes de RC5.3 (la API de hoy ya no la admitiría).
    await h.db("entries").insert({ tournament_id: t, bot_id: bDef, version: 1, loadout_revision: 1, frozen: false });
    await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: atk, version: 1 });

    const close = await request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});
    expect(close.status).toBe(409);
    expect(close.body.error).toBe("entries_not_eligible");
    expect(close.body.notEligibleEntries).toHaveLength(1);
    expect(JSON.stringify(close.body)).not.toMatch(/ammo/); // el organizador no ve el loadout
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
    expect(await h.db("entries").where({ tournament_id: t, frozen: true })).toHaveLength(0);
    expect((await h.db("bot_versions").where({ bot_id: bDef, version: 1 }).first()).state).toBe("published");
    expect(
      await h.db("jobs").where({ kind: "generate_schedule" }).whereRaw("payload->>'tournamentId' = ?", [t]),
    ).toHaveLength(0);

    // No se sustituye sola: sigue en v1 hasta que el dueño elige.
    expect((await h.db("entries").where({ tournament_id: t, bot_id: bDef }).first()).version).toBe(1);
    // Otra versión NO elegible tampoco vale.
    const worse = await request(app)
      .post(`/tournaments/${t}/entries`)
      .set(as(devTok))
      .send({ botId: bDef, version: 2 });
    expect(worse.status).toBe(409);
    const fix = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: bDef, version: 3 });
    expect(fix.status).toBe(200);
    expect(fix.body).toMatchObject({ botId: bDef, version: 3, loadoutRevision: 2, replacedVersion: 1 });
    const trail = await h
      .db("audit_log")
      .where({ action: "tournament.entry.version_replaced", target: `tournament:${t}` });
    expect(trail).toHaveLength(1);

    const close2 = await request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});
    expect(close2.status, JSON.stringify(close2.body)).toBe(200);
  });

  it("re-inscribir con una inscripción VÁLIDA sigue siendo already_entered (no se cambia libremente)", async () => {
    const t = await openTournament("elig-ya-inscrito");
    expect(
      (await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: scout, version: 1 })).status,
    ).toBe(201);
    const again = await request(app)
      .post(`/tournaments/${t}/entries`)
      .set(as(devTok))
      .send({ botId: scout, version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_entered");
  });
});

describe("H10/H11 · el histórico no se toca", () => {
  it("una batalla antigua terminada con A-DEF v2 sigue legible, con su bot, versión y resultado", async () => {
    const [b] = await h
      .db("battles")
      .insert({
        status: "finished",
        official: false,
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        map_id: "mvp-arena-02",
        map_version: 1,
        seed: "hist",
        result: JSON.stringify({ winner: "blue", endReason: "elimination" }),
        engine_versions: JSON.stringify({ engine: "historico-1" }),
        finished_at: h.db.fn.now(),
      })
      .returning("*");
    await h.db("participants").insert([
      { battle_id: b.id, bot_id: aDef, version: 2, team: "red", outcome: "loss" },
      { battle_id: b.id, bot_id: atk, version: 1, team: "blue", outcome: "win" },
    ]);
    const before = await h.db("battles").where({ id: b.id }).first();
    const r = await request(app).get(`/battles/${b.id}`).set(as(devTok));
    expect(r.status).toBe(200);
    const p = r.body.participants.find((x: { botId: string }) => x.botId === aDef);
    expect(p).toMatchObject({ version: 2 });
    expect(await h.db("battles").where({ id: b.id }).first()).toEqual(before);
  });

  it("la versión no elegible no se puede reescribir (bot_version_immutable) y su loadout sigue igual", async () => {
    const rev1 = await h.db("bot_loadouts").where({ bot_id: aDef, revision: 1 }).first();
    const err = await h
      .db("bot_versions")
      .where({ bot_id: aDef, version: 2 })
      .update({ loadout_revision: 2 })
      .then(
        () => "reescrita",
        (e: Error) => e.message,
      );
    expect(err).toContain("bot_version_immutable");
    expect(await h.db("bot_loadouts").where({ bot_id: aDef, revision: 1 }).first()).toEqual(rev1);
  });
});

describe("H5/H15 · inventario admin de SOLO LECTURA", () => {
  it("cifras correctas, sin escribir NADA (ni audit_log) y sin datos de contacto", async () => {
    const tables = ["bot_versions", "bot_loadouts", "audit_log", "entries", "battles", "jobs"];
    const snap = async () =>
      Object.fromEntries(
        await Promise.all(tables.map(async (t) => [t, Number((await h.db(t).count({ n: "*" }))[0].n)])),
      );
    const before = await snap();
    const r = await request(app).get("/admin/bot-version-eligibility").set(as(adminTok));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(await snap()).toEqual(before);
    expect(r.body.readOnly).toBe(true);
    const mine = r.body.items.filter((i: { botId: string }) =>
      [aDef, bDef, atk, scout, prueba1, alienPriv, alienPub].includes(i.botId),
    );
    // 3+3+2+2+1+1+2 = 14 versiones publicadas; inválidas: A/B-DEF v1,v2 + alien-priv v1 + alien-pub v1 = 6
    expect(mine).toHaveLength(14);
    expect(mine.filter((i: { eligible: boolean }) => !i.eligible)).toHaveLength(6);
    const row = mine.find((i: { botId: string; version: number }) => i.botId === aDef && i.version === 2);
    expect(row).toMatchObject({
      botName: "A-DEF",
      ownerId: devId,
      loadoutRevision: 1,
      state: "published",
      currentValidation: "INVALID_AMMO",
      eligible: false,
      reason: "loadout_no_longer_valid",
    });
    expect(JSON.stringify(r.body)).not.toMatch(/@dev\.arena|email|password/i);
    const s = r.body.summary;
    expect(s.totalPublishedVersions).toBe(r.body.items.length);
    expect(s.currentlyValid + s.currentlyInvalid).toBe(s.totalPublishedVersions);
    expect(s.invalidByReason.INVALID_AMMO).toBeGreaterThanOrEqual(6);
    expect(s.usersAffected).toBeGreaterThanOrEqual(2);

    const only = await request(app).get("/admin/bot-version-eligibility?summaryOnly=true").set(as(adminTok));
    expect(only.body.items).toBeUndefined();
    expect(only.body.summary).toEqual(s);
  });
});
