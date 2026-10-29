/**
 * ELIG-REVIEW · Intentos de ROMPER la elegibilidad histórica (PR #199). BD efímera.
 * Cada `it` documenta el ataque; los que fallan son hallazgos del revisor.
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
import { clearEligibilityCache } from "./services/version-eligibility.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let userTok: string;
let orgTok: string;
let devId: string;
let userId: string;

const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
type M = { slot: string; moduleId: string; ammo?: unknown };
const L = (chassis: string, modules: M[], catalogVersion = "mvp@1") => ({ catalogVersion, chassis, modules });
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

async function histBot(name: string, ownerId: string, revs: object[], versionRevs: number[], visibility = "private") {
  const [bot] = await h.db("bots").insert({ name, owner_id: ownerId, visibility }).returning("*");
  for (const r of revs) await createLoadoutRevision(h.db, bot.id, r as never, SUMMARY);
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

/** Bot cuya revisión 1 se inserta en crudo (loadouts imposibles por la API). */
async function rawBot(name: string, row: { catalog_version: string; chassis: string; modules: unknown }) {
  const [bot] = await h.db("bots").insert({ name, owner_id: devId, visibility: "private" }).returning("*");
  await h.db("bot_loadouts").insert({
    bot_id: bot.id,
    revision: 1,
    catalog_version: row.catalog_version,
    chassis: row.chassis,
    modules: typeof row.modules === "string" ? row.modules : JSON.stringify(row.modules),
  });
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: `hash-${name}`,
    published_at: h.db.fn.now(),
  });
  return bot.id as string;
}

let aDef: string;
let atk: string;
let atk2: string;
let alienPub: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  const bad = defender("ammo.standard@1", "power.generator@2");
  const good = defender("ammo.ap@1", "power.generator@1");
  aDef = await histBot("A-DEF", devId, [bad, good], [1, 1, 2]);
  atk = await histBot("A-ATK-1", devId, [ATK], [1]);
  atk2 = await histBot("A-ATK-2", devId, [ATK], [1]);
  alienPub = await histBot("alien-pub", userId, [bad, good], [1, 2], "public");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const battle = (ps: { botId: string; version: unknown; team: string }[]) => ({
  mode: "deathmatch",
  rulesetId: DEFAULT_RULESET_ID,
  mapId: "mvp-arena-02",
  participants: ps,
});
const nBattles = async () => Number((await h.db("battles").count({ n: "*" }))[0].n);

describe("R1 · forma del participante en POST /battles", () => {
  it("botId en MAYÚSCULAS (uuid case-insensitive en PG) no esquiva la elegibilidad", async () => {
    const before = await nBattles();
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef.toUpperCase(), version: 2, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(await nBattles()).toBe(before);
  });

  it("botId con espacios/llaves (forma uuid alternativa de PG) tampoco", async () => {
    const before = await nBattles();
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: `{${aDef}}`, version: 2, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect([404, 409, 400]).toContain(r.status);
    expect(await nBattles()).toBe(before);
  });

  it("versión como string '2' → 400 (no llega a crearse)", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef, version: "2", team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(r.status).toBe(400);
  });

  it("8 participantes mezclando válidas/no válidas → 409 con TODAS las no válidas", async () => {
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) extra.push(await histBot(`fill-${i}`, devId, [ATK], [1]));
    const bad2 = await histBot("C-DEF", devId, [defender("ammo.standard@1", "power.generator@2")], [1]);
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send({
        mode: "team_deathmatch",
        rulesetId: "team-deathmatch-mvp",
        mapId: "mvp-arena-01",
        participants: [
          { botId: aDef, version: 1, team: "red" },
          { botId: atk, version: 1, team: "red" },
          { botId: extra[0], version: 1, team: "red" },
          { botId: extra[1], version: 1, team: "red" },
          { botId: bad2, version: 1, team: "blue" },
          { botId: atk2, version: 1, team: "blue" },
          { botId: extra[2], version: 1, team: "blue" },
          { botId: extra[3], version: 1, team: "blue" },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.notEligible.map((x: { botId: string }) => x.botId).sort()).toEqual([aDef, bad2].sort());
  });

  it("versión inexistente → 409 bot_not_published (no 202)", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef, version: 99, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_not_published");
  });
});

describe("R3 · catálogo / loadout malformado: falla cerrado", () => {
  const ok = (id: string) =>
    request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: id, version: 1, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );

  it("catálogo del loadout inexistente → UNKNOWN y 409", async () => {
    const id = await rawBot("ghost-cat", {
      catalog_version: "ghost@9",
      chassis: "chassis.heavy@1",
      modules: ATK.modules,
    }).catch((e: Error) => `FK:${e.message}`);
    if (id.startsWith("FK:")) return; // la FK ya lo impide: aceptable
    const vs = await request(app).get(`/bots/${id}/versions`).set(as(devTok));
    expect(vs.body[0].battleEligibility).toMatchObject({ eligible: false, category: "UNKNOWN" });
    expect((await ok(id)).status).toBe(409);
  });

  for (const [name, modules, chassis] of [
    ["modules objeto", { slot: "drive" }, "chassis.medium@2"],
    ["modules con slot numérico", [{ slot: 5, moduleId: "movement.wheels@1" }], "chassis.medium@2"],
    [
      "ammo embebida como objeto",
      [{ slot: "turret_main", moduleId: "weapon.cannon@1", ammo: { x: 1 } }],
      "chassis.medium@2",
    ],
    ["moduleId __proto__", [{ slot: "drive", moduleId: "__proto__" }], "chassis.medium@2"],
    ["chasis vacío", ATK.modules, ""],
    ["chasis de otra categoría", ATK.modules, "weapon.cannon@1"],
    ["elemento null", [null], "chassis.medium@2"],
  ] as const) {
    it(`${name} → no elegible (409), nunca 500 ni 202`, async () => {
      const id = await rawBot(`mal-${name}`, { catalog_version: "mvp@1", chassis, modules });
      const vs = await request(app).get(`/bots/${id}/versions`).set(as(devTok));
      expect(vs.status).toBe(200);
      expect(vs.body[0].battleEligibility?.eligible, JSON.stringify(vs.body[0])).toBe(false);
      const r = await ok(id);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    });
  }

  it("OBSERVACIÓN (P3): loadout vacío es elegible — igual que el validador acepta hoy uno nuevo", async () => {
    const id = await rawBot("vacio", { catalog_version: "mvp@1", chassis: "chassis.medium@2", modules: [] });
    const vs = await request(app).get(`/bots/${id}/versions`).set(as(devTok));
    expect(vs.body[0].battleEligibility).toMatchObject({ eligible: true, category: "VALID" });
  });

  it("la caché no hace pasar por elegible un loadout tras clearEligibilityCache (determinista)", async () => {
    clearEligibilityCache();
    const a = await request(app).get(`/bots/${aDef}/versions`).set(as(devTok));
    const b = await request(app).get(`/bots/${aDef}/versions`).set(as(devTok));
    expect(a.body.map((v: any) => v.battleEligibility)).toEqual(b.body.map((v: any) => v.battleEligibility));
  });
});

describe("R6 · torneos: terceros", () => {
  it("un tercero no puede sustituir la inscripción no elegible de otro (403) ni se audita nada", async () => {
    const t = (
      await request(app)
        .post("/tournaments")
        .set(as(orgTok))
        .send({ name: "elig-tercero", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID })
    ).body.id as string;
    await h.db("entries").insert({ tournament_id: t, bot_id: aDef, version: 1, loadout_revision: 1, frozen: false });
    const r = await request(app).post(`/tournaments/${t}/entries`).set(as(userTok)).send({ botId: aDef, version: 3 });
    expect(r.status).toBe(403);
    expect((await h.db("entries").where({ tournament_id: t, bot_id: aDef }).first()).version).toBe(1);
    expect(
      await h.db("audit_log").where({ action: "tournament.entry.version_replaced", target: `tournament:${t}` }),
    ).toHaveLength(0);
    // Mayúsculas en la inscripción: tampoco esquiva.
    const up = await request(app)
      .post(`/tournaments/${t}/entries`)
      .set(as(devTok))
      .send({ botId: aDef.toUpperCase(), version: 2 });
    expect(up.status).toBe(409);
  });

  it("organizador: closeEntries no filtra motivo ni loadout ni botId del bot privado", async () => {
    const t = (
      await request(app)
        .post("/tournaments")
        .set(as(orgTok))
        .send({ name: "elig-org", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID })
    ).body.id as string;
    await h.db("entries").insert({ tournament_id: t, bot_id: aDef, version: 1, loadout_revision: 1, frozen: false });
    await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: atk, version: 1 });
    const c = await request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});
    expect(c.status).toBe(409);
    expect(JSON.stringify(c.body)).not.toMatch(/ammo|cannon|weapon/);
  });
});

describe("R2 · fuga a terceros", () => {
  it("bot público ajeno: el 409 sólo expone lo legible en /loadouts", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: alienPub, version: 1, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(r.status).toBe(409);
    const lo = await request(app).get(`/bots/${alienPub}/loadouts`).set(as(devTok));
    expect(lo.status).toBe(200);
  });

  it("anónimo: GET versiones de bot público sin sesión no expone más que con sesión", async () => {
    const anon = await request(app).get(`/bots/${alienPub}/versions`);
    const lo = await request(app).get(`/bots/${alienPub}/loadouts`);
    expect(anon.status).toBe(200);
    // Si el anónimo no puede leer /loadouts (401), battleEligibility no debe revelar sus módulos.
    if (lo.status !== 200) expect(JSON.stringify(anon.body)).not.toMatch(/weapon\.|ammo\.|chassis\./);
  });
});

describe("R8 · contrato 0.10.0 contra respuestas reales (ajv)", () => {
  it("BotVersion[], Error 409, Entry 200 e inventario validan contra openapi.yaml", async () => {
    const { readFileSync } = await import("node:fs");
    const { parse } = await import("yaml");
    const Ajv2020 = (await import("ajv/dist/2020.js")).default;
    const addFormats = (await import("ajv-formats")).default;
    const doc = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(doc, "api");
    const v = (name: string, body: unknown) => {
      const ok = ajv.validate({ $ref: `api#/components/schemas/${name}` }, body);
      expect(ok, `${name}: ${JSON.stringify(ajv.errors)}`).toBe(true);
    };
    const vs = await request(app).get(`/bots/${aDef}/versions`).set(as(devTok));
    for (const x of vs.body) v("BotVersion", x);
    const e = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: aDef, version: 2, team: "red" },
          { botId: atk, version: 1, team: "blue" },
        ]),
      );
    expect(e.status).toBe(409);
    v("Error", e.body);
    const adminTok = await tokenFor(h.db, DEV_USERS.admin);
    const inv = await request(app).get("/admin/bot-version-eligibility").set(as(adminTok));
    v("EligibilityInventory", inv.body);
    const t = (
      await request(app)
        .post("/tournaments")
        .set(as(orgTok))
        .send({ name: "elig-contrato", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID })
    ).body.id as string;
    await h.db("entries").insert({ tournament_id: t, bot_id: aDef, version: 1, loadout_revision: 1, frozen: false });
    const rep = await request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: aDef, version: 3 });
    expect(rep.status).toBe(200);
    v("Entry", rep.body);
  });
});
