/**
 * [AMMO-REVIEW] Sondas contra la API real (Postgres embebido) del fix de munición.
 *
 * 1. El 422 de las cuatro rutas guardadas y el de POST /loadouts cumplen el esquema
 *    `components.responses.LoadoutInvalid` del contrato y no sacan campos internos.
 * 2. Orden directo por API (sin UI): versión válida → submit → publish sigue funcionando.
 * 3. El seed de equipos demo (camino fuera de las 4 rutas) ya no reutiliza una revisión
 *    histórica inválida (corregido en 09e2936).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv from "ajv";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { seedDemoTeams } from "./db/seeds/demo-teams.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";

const here = dirname(fileURLToPath(import.meta.url));
const contract = parse(readFileSync(join(here, "..", "openapi.yaml"), "utf8"));
const schema = contract.components.responses.LoadoutInvalid.content["application/json"].schema;
const ajv = new Ajv({ strict: false });
const conforms = ajv.compile(schema);
const ALLOWED_KEYS = new Set(["error", "message", "violations", "correlationId"]);

let h: TestDbHandle;
let app: Express;
let dev: string;
const auth = () => ({ Authorization: `Bearer ${dev}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  dev = await tokenFor(h.db, DEV_USERS.developer);
}, 120000);
afterAll(async () => {
  await h.stop();
});

const defender = (ammo: string, power = "power.generator@1") => ({
  catalogVersion: "mvp@1",
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: power },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
});
const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
const newVersion = (botId: string, rev: number) =>
  request(app)
    .post(`/bots/${botId}/versions`)
    .set(auth())
    .field("runtime", "python")
    .field("loadoutRevision", String(rev))
    .attach("source", Buffer.from("print('hola')"), "bot.py.zip");

function expectContract422(r: request.Response) {
  expect(r.status).toBe(422);
  expect(conforms(r.body), JSON.stringify(ajv.errors)).toBe(true);
  for (const k of Object.keys(r.body)) expect(ALLOWED_KEYS.has(k), `clave inesperada ${k}`).toBe(true);
  expect(JSON.stringify(r.body)).not.toMatch(/stack|at .*\.ts:|SELECT|knex|postgres/i);
}

describe("422 conforme al contrato en las 5 rutas", () => {
  it("POST /loadouts, crear, clonar, submit y publish", async () => {
    const bot = (await request(app).post("/bots").set(auth()).send({ name: "rv-422", visibility: "private" })).body;
    expect((await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(defender("ammo.ap@1"))).status).toBe(
      201,
    );
    await createLoadoutRevision(h.db, bot.id, defender("ammo.standard@1", "power.generator@2"), SUMMARY);

    const bodies: request.Response[] = [];
    bodies.push(await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(defender("ammo.standard@1")));
    bodies.push(await newVersion(bot.id, 2));
    const v1 = (await newVersion(bot.id, 1)).body.version;
    bodies.push(
      await request(app).post(`/bots/${bot.id}/versions/${v1}/actions/clone`).set(auth()).send({ loadoutRevision: 2 }),
    );
    await h.db("bot_versions").where({ bot_id: bot.id, version: v1 }).update({ loadout_revision: 2 });
    bodies.push(await request(app).post(`/bots/${bot.id}/versions/${v1}/actions/submit`).set(auth()));
    await h.db("bot_versions").where({ bot_id: bot.id, version: v1 }).update({ state: "validated" });
    bodies.push(await request(app).post(`/bots/${bot.id}/versions/${v1}/actions/publish`).set(auth()).send({}));
    for (const r of bodies) expectContract422(r);
    // P3 corregido en 09e2936: POST /loadouts también trae `message`
    expect(bodies[0]!.body.message).toContain("ammo.standard@1");
    expect(bodies[1]!.body.message).toContain("no admite ammo.standard@1");
  });
});

describe("orden directo por API, sin UI", () => {
  it("válida: crear → submit → publish = published; repetir publish → 409, no 422", async () => {
    const bot = (await request(app).post("/bots").set(auth()).send({ name: "rv-direct", visibility: "private" })).body;
    expect((await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(defender("ammo.he@1"))).status).toBe(
      422, // HE es 10 créditos más cara que AP: con radio no cabe en 1000 (budget, no munición)
    );
    expect((await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(defender("ammo.ap@1"))).status).toBe(
      201,
    );
    const v = (await newVersion(bot.id, 1)).body.version;
    expect((await request(app).post(`/bots/${bot.id}/versions/${v}/actions/submit`).set(auth())).status).toBe(202);
    const pub = await request(app).post(`/bots/${bot.id}/versions/${v}/actions/publish`).set(auth()).send({});
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const again = await request(app).post(`/bots/${bot.id}/versions/${v}/actions/publish`).set(auth()).send({});
    expect(again.status).toBe(409);
  });
});

describe("seed de equipos demo: camino fuera de las 4 rutas", () => {
  it("no reutiliza una revisión histórica inválida: crea una revisión nueva del arquetipo y conserva la mala", async () => {
    await seedDemoTeams(h.db, DEV_USERS.developer, ["Rv Rojo"]);
    const owner = await h.db("users").where({ email: DEV_USERS.developer }).first();
    const bot = await h.db("bots").where({ owner_id: owner.id, name: "Rv Rojo · Defensor" }).first();
    expect(bot).toBeTruthy();
    // Historia: la última revisión es la mala (de antes del fix) y la última versión quedó rechazada.
    const bad = await createLoadoutRevision(h.db, bot.id, defender("ammo.standard@1", "power.generator@2"), SUMMARY);
    const badRow = await h.db("bot_loadouts").where({ bot_id: bot.id, revision: bad.revision }).first();
    await h.db("bot_versions").where({ bot_id: bot.id }).update({ state: "rejected" });
    await seedDemoTeams(h.db, DEV_USERS.developer, ["Rv Rojo"]);
    const latest = await h.db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "desc").first();
    expect(latest.version).toBe(2);
    expect(latest.loadout_revision).not.toBe(bad.revision);
    expect(latest.loadout_revision).toBeGreaterThan(bad.revision);
    // la histórica sigue intacta
    expect(await h.db("bot_loadouts").where({ bot_id: bot.id, revision: bad.revision }).first()).toEqual(badRow);
    // y la versión nueva sí pasa la puerta de submit
    const tok = await tokenFor(h.db, DEV_USERS.developer);
    const r = await request(app)
      .post(`/bots/${bot.id}/versions/2/actions/submit`)
      .set({ Authorization: `Bearer ${tok}` });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    // re-ejecutar el seed reutiliza ya la revisión buena (no crea revisiones en bucle)
    const nRev = (await h.db("bot_loadouts").where({ bot_id: bot.id })).length;
    await h.db("bot_versions").where({ bot_id: bot.id }).update({ state: "rejected" });
    await seedDemoTeams(h.db, DEV_USERS.developer, ["Rv Rojo"]);
    expect((await h.db("bot_loadouts").where({ bot_id: bot.id })).length).toBe(nRev);
  });
});
