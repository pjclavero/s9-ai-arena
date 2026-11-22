/**
 * V1 · B4 · ronda 2 de la revisión de #322 (H1, H2, H4, H9). BD efímera + API real.
 * Etiquetas B4_* para scripts/budget-ammo-mutants.mjs.
 *  - H1 (P1): el cierre usa la revisión FIJADA en la inscripción (no la actual de la versión), en los dos sentidos.
 *  - H2: borde exacto del tope por pieza en un módulo que NO es el chasis.
 *  - H4: se mide con el catálogo de la revisión (un segundo catálogo con otro precio).
 *  - H9: el 409 nombra al bot (sólo a su dueño).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { getCatalog, importCatalogVersion } from "./services/catalog.js";
import { assertWithinTournamentBudget, evaluateTournamentBudget } from "./services/version-eligibility.js";
import { MAX_MODULE_COST_FRACTION } from "../../../packages/game-rules/index.js";

let h: TestDbHandle;
let app: Express;
let userTok: string;
let orgTok: string;
let userId: string;
let seq = 0;
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };

/** 900 cr con la munición embebida (chasis medio 220, sensor lidar360 140). */
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
/** 540 cr con la munición embebida. */
const SCOUT = {
  catalogVersion: "mvp@1",
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

async function mkBot(loadout: object): Promise<string> {
  const [bot] = await h
    .db("bots")
    .insert({ name: `b4r2-${++seq}`, owner_id: userId, visibility: "private" })
    .returning("*");
  await createLoadoutRevision(h.db, bot.id, loadout as never, SUMMARY);
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from("# b4r2\n"),
    source_filename: "bot.py",
    artifact_hash: `sha256:b4r2-${bot.id}`,
    code_public: false,
    published_at: h.db.fn.now(),
  });
  return bot.id as string;
}
async function mkTournament(budgetCredits: number) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({
      name: `b4r2-t-${++seq}`,
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      budgetCredits,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const enter = (t: string, botId: string) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(userTok)).send({ botId, version: 1 });
const close = (t: string) => request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("B4 · H1 · el cierre usa la revisión FIJADA, en los dos sentidos", () => {
  it("B4_CLOSE_PINNED_CHEAP · fijada barata y actual de la versión cara ⇒ el cierre PASA", async () => {
    const a = await mkBot(GUNNER); // la versión apunta a la rev. 1 (900 cr)
    await createLoadoutRevision(h.db, a, SCOUT as never, SUMMARY); // rev. 2 barata (540 cr)
    const b = await mkBot(SCOUT);
    const t = await mkTournament(1000);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    await h.db("entries").where({ tournament_id: t, bot_id: a }).update({ loadout_revision: 2 });
    await h.db("tournaments").where({ id: t }).update({ budget_credits: 600 });
    const c = await close(t);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });

  it("B4_CLOSE_PINNED_EXPENSIVE · fijada cara y actual de la versión barata ⇒ el cierre da 409", async () => {
    const a = await mkBot(SCOUT); // la versión apunta a la rev. 1 (540 cr)
    await createLoadoutRevision(h.db, a, GUNNER as never, SUMMARY); // rev. 2 cara (900 cr)
    const b = await mkBot(SCOUT);
    const t = await mkTournament(600);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    await h.db("entries").where({ tournament_id: t, bot_id: a }).update({ loadout_revision: 2 });
    const c = await close(t);
    expect(c.status, JSON.stringify(c.body)).toBe(409);
    expect(c.body.error).toBe("entries_not_eligible");
  });
});

describe("B4 · H2 · borde exacto del tope por pieza en un módulo que no es el chasis", () => {
  it("B4_CAP_EXACT_MODULE · lidar360 (140): con presupuesto = 140/0,35 permitido; un crédito menos, rechazado", async () => {
    let exact = -1;
    for (let b = 200; b <= 5000; b++) {
      if (b * MAX_MODULE_COST_FRACTION === 140) {
        exact = b;
        break;
      }
    }
    expect(exact, "debe existir un presupuesto entero con tope exactamente 140").toBeGreaterThan(0);
    const bot = await mkBot(GUNNER);
    const capOfLidar = async (budget: number) =>
      [...(await evaluateTournamentBudget(h.db, [{ botId: bot, version: 1 }], budget)).values()][0].violations.filter(
        (v) => v.code === "module_cost_cap_exceeded" && v.message.includes("sensor.lidar360"),
      );
    expect(await capOfLidar(exact)).toEqual([]);
    expect((await capOfLidar(exact - 1)).length).toBe(1);
  });
});

describe("B4 · H9 · el 409 nombra al bot sólo a su dueño", () => {
  it("B4_MSG_BOT_NAME · el dueño ve el nombre y el id; sin visor, el veredicto genérico", async () => {
    const bot = await mkBot(GUNNER);
    const name = (await h.db("bots").where({ id: bot }).first()).name as string;
    const t = await mkTournament(600);
    const r = await enter(t, bot);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain(name);
    expect(r.body.message).toContain(bot);
    await expect(assertWithinTournamentBudget(h.db, [{ botId: bot, version: 1 }], 600)).rejects.toMatchObject({
      message: expect.not.stringContaining(name),
    });
  });
});

describe("B4 · H4 · se mide con el catálogo de la revisión", () => {
  it("B4_CATALOG_PINNED · un catálogo antiguo con otro precio manda sobre el actual", async () => {
    const base = await getCatalog(h.db, "mvp@1");
    const legacy = base.map((m) => (m.id === "weapon.mg" ? ({ ...m, costCredits: 400 } as typeof m) : m));
    await importCatalogVersion(h.db, "mvp-legacy", legacy);
    const bot = await mkBot({ ...SCOUT, catalogVersion: "mvp-legacy" });
    const v = [...(await evaluateTournamentBudget(h.db, [{ botId: bot, version: 1 }], 600)).values()][0];
    expect(v.costCredits).toBe(540 - 90 + 400); // precio del catálogo de la revisión, no el de mvp@1
    expect(v.over).toBe(true);
    const cur = await mkBot(SCOUT);
    const w = [...(await evaluateTournamentBudget(h.db, [{ botId: cur, version: 1 }], 600)).values()][0];
    expect(w.costCredits).toBe(540);
    expect(w.over).toBe(false);
  });
});
