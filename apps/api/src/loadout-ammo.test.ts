/**
 * Munición incompatible en la API (bug de producción RC5.2): un cañón con munición
 * estándar montada como módulo aparte se guardaba, compilaba, publicaba y en batalla no
 * disparaba nunca. Aquí: el 422 con una violación útil, y que una revisión HISTÓRICA que
 * hoy sería inválida se conserva intacta pero no sirve para versiones nuevas por
 * ningún camino de la API (crear, clonar, enviar a build, publicar).
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

let h: TestDbHandle;
let app: Express;
let dev: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  dev = await tokenFor(h.db, DEV_USERS.developer);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const auth = () => ({ Authorization: `Bearer ${dev}` });

/** Defensor de producción (v2 → v3): sólo cambian la munición y el generador. */
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

async function newVersion(botId: string, rev: number) {
  return request(app)
    .post(`/bots/${botId}/versions`)
    .set(auth())
    .field("runtime", "python")
    .field("loadoutRevision", String(rev))
    .attach("source", Buffer.from("print('hola')"), "bot.py.zip");
}

/**
 * Bot con rev 1 válida (cañón + AP) y rev 2 HISTÓRICA (cañón + estándar) guardada
 * saltándose el validador, como quedaron las de antes del fix.
 */
async function botWithHistory(name: string) {
  const bot = (await request(app).post("/bots").set(auth()).send({ name, visibility: "private" })).body;
  const r1 = await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(defender("ammo.ap@1"));
  expect(r1.status).toBe(201);
  await createLoadoutRevision(h.db, bot.id, defender("ammo.standard@1", "power.generator@2"), SUMMARY);
  return bot as { id: string };
}

describe("POST /bots/{id}/loadouts · munición", () => {
  it("cañón + ammo.standard@1 como módulo aparte → 422 incompatible_ammo explicando qué munición usar", async () => {
    const bot = await botWithHistory("ammo-422");
    const before = await h.db("bot_loadouts").where({ bot_id: bot.id }).count("* as n").first();
    const r = await request(app)
      .post(`/bots/${bot.id}/loadouts`)
      .set(auth())
      .send(defender("ammo.standard@1", "power.generator@2"));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("loadout_invalid");
    expect(r.body.violations).toEqual([
      {
        code: "incompatible_ammo",
        slot: "turret_main",
        moduleId: "weapon.cannon",
        ammoId: "ammo.standard@1",
        acceptedAmmo: ["ammo.ap", "ammo.he"],
        message: "El módulo weapon.cannon@1 no admite ammo.standard@1. Municiones compatibles: ammo.ap, ammo.he.",
      },
    ]);
    const after = await h.db("bot_loadouts").where({ bot_id: bot.id }).count("* as n").first();
    expect(after).toEqual(before); // no se guarda nada
  });

  it("cañón + ammo.ap@1 y cañón + ammo.he@1 como módulo aparte → 201", async () => {
    const bot = await botWithHistory("ammo-201");
    // AP = defensor v3 de producción (1000/1000); HE cuesta 10 más: sin radio cabe.
    const he = defender("ammo.he@1");
    he.modules = he.modules.filter((m) => m.slot !== "radio_a");
    for (const body of [defender("ammo.ap@1"), he]) {
      const r = await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  it("cañón sin ninguna munición → 422 (antes pasaba)", async () => {
    const bot = await botWithHistory("ammo-none");
    const body = defender("ammo.ap@1");
    body.modules = body.modules.filter((m) => m.slot !== "ammo_main");
    const r = await request(app).post(`/bots/${bot.id}/loadouts`).set(auth()).send(body);
    expect(r.status).toBe(422);
    expect(r.body.violations.map((v: { code: string }) => v.code)).toEqual(["incompatible_ammo"]);
  });
});

describe("revisión histórica inválida: se conserva, pero no sirve para versiones nuevas", () => {
  it("crear una versión con ella → 422 con el motivo, y no se crea la versión", async () => {
    const bot = await botWithHistory("hist-create");
    const r = await newVersion(bot.id, 2);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("loadout_invalid");
    expect(r.body.message).toContain("weapon.cannon@1 no admite ammo.standard@1");
    expect(r.body.violations[0]).toMatchObject({ code: "incompatible_ammo", ammoId: "ammo.standard@1" });
    expect(await h.db("bot_versions").where({ bot_id: bot.id })).toHaveLength(0);
    // con la revisión válida sí
    expect((await newVersion(bot.id, 1)).status).toBe(201);
  });

  it("clonar hacia ella, o clonar una versión antigua que la usa → 422", async () => {
    const bot = await botWithHistory("hist-clone");
    const v1 = (await newVersion(bot.id, 1)).body.version;
    const toBad = await request(app)
      .post(`/bots/${bot.id}/versions/${v1}/actions/clone`)
      .set(auth())
      .send({ loadoutRevision: 2 });
    expect(toBad.status).toBe(422);
    // versión antigua (de antes del fix) que ya apunta a la rev 2
    await h.db("bot_versions").where({ bot_id: bot.id, version: v1 }).update({ loadout_revision: 2 });
    const fromOld = await request(app).post(`/bots/${bot.id}/versions/${v1}/actions/clone`).set(auth()).send({});
    expect(fromOld.status).toBe(422);
    // pero clonarla cambiando a la revisión corregida sí se permite
    const fixed = await request(app)
      .post(`/bots/${bot.id}/versions/${v1}/actions/clone`)
      .set(auth())
      .send({ loadoutRevision: 1 });
    expect(fixed.status).toBe(201);
  });

  it("enviar a build un draft antiguo con ella → 422 antes del pipeline: ni build ni cambio de estado", async () => {
    const bot = await botWithHistory("hist-submit");
    const v = (await newVersion(bot.id, 1)).body.version;
    await h.db("bot_versions").where({ bot_id: bot.id, version: v }).update({ loadout_revision: 2 });
    const r = await request(app).post(`/bots/${bot.id}/versions/${v}/actions/submit`).set(auth());
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("loadout_invalid");
    expect(await h.db("builds").where({ bot_id: bot.id })).toHaveLength(0);
    expect((await h.db("bot_versions").where({ bot_id: bot.id, version: v }).first()).state).toBe("draft");
  });

  it("publicar una versión validada antes del fix con ella → 422 y sigue validated", async () => {
    const bot = await botWithHistory("hist-publish");
    const v = (await newVersion(bot.id, 1)).body.version;
    // La BD no deja cambiar el loadout de una versión validada (bot_version_immutable):
    // la versión de antes del fix se apunta en draft y se valida a mano.
    await h.db("bot_versions").where({ bot_id: bot.id, version: v }).update({ loadout_revision: 2 });
    await h.db("bot_versions").where({ bot_id: bot.id, version: v }).update({ state: "validated" });
    const r = await request(app).post(`/bots/${bot.id}/versions/${v}/actions/publish`).set(auth()).send({});
    expect(r.status).toBe(422);
    expect((await h.db("bot_versions").where({ bot_id: bot.id, version: v }).first()).state).toBe("validated");
  });

  it("lo ya publicado y la revisión histórica no se reescriben", async () => {
    const bot = await botWithHistory("hist-immutable");
    const rev2 = await h.db("bot_loadouts").where({ bot_id: bot.id, revision: 2 }).first();
    const v = (await newVersion(bot.id, 1)).body.version;
    // Versión publicada antes del fix con la combinación mala (se apunta en draft: la BD no
    // deja cambiar el loadout de una versión validada o publicada).
    await h.db("bot_versions").where({ bot_id: bot.id, version: v }).update({ loadout_revision: 2 });
    await h.db("bot_versions").where({ bot_id: bot.id, version: v }).update({ state: "published" });
    const rewrite = await h
      .db("bot_versions")
      .where({ bot_id: bot.id, version: v })
      .update({ loadout_revision: 1 })
      .then(
        () => "reescrita",
        (e: Error) => e.message,
      );
    expect(rewrite).toContain("bot_version_immutable");

    const list = await request(app).get(`/bots/${bot.id}/loadouts`).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.map((l: { revision: number }) => l.revision)).toEqual([1, 2]);
    expect(await h.db("bot_loadouts").where({ bot_id: bot.id, revision: 2 }).first()).toEqual(rev2);

    const got = await request(app).get(`/bots/${bot.id}/versions/${v}`).set(auth());
    expect(got.status).toBe(200);
    expect(got.body.state).toBe("published");
    expect(got.body.loadoutRevision).toBe(2);
  });
});
