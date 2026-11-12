/**
 * OLA 2 (EQUIPMENT_PRIVATE) · P2-C de la revisión 3: el 409 `loadout_unavailable` del cálculo de
 * composición no filtra moduleId/ranura de un bot AJENO (ni de uno público). Dueño y staff, detalle.
 *
 * Montaje: el loadout del bot sigue siendo elegible con SU catálogo (mvp@1), pero el catálogo de
 * práctica (el último importado) ya no incluye el cañón ⇒ resolveVehicle falla al calcular masa.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let ownerTok: string;
let thirdTok: string;
let staffTok: string;
let mine: TestBot;
let foreign: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  ownerTok = await tokenFor(h.db, DEV_USERS.user);
  thirdTok = await tokenFor(h.db, DEV_USERS.developer);
  staffTok = await tokenFor(h.db, DEV_USERS.moderator);
  mine = await createPublishedBot(h.db, "malu-mine", { ownerId: user.id });
  foreign = await createPublishedBot(h.db, "malu-foreign");
  // Catálogo de práctica más reciente SIN el cañón del loadout de ejemplo.
  const base = await h.db("catalog_versions").first();
  await h
    .db("catalog_versions")
    .insert({ catalog_version: "malu-newer@1", module_count: 0, imported_at: new Date(Date.now() + 60_000) });
  const defs = await h.db("module_definitions").where({ catalog_version: base.catalog_version });
  for (const d of defs) {
    if (d.module_id === "weapon.cannon") continue;
    const { id: _id, ...rest } = d;
    await h.db("module_definitions").insert({ ...rest, catalog_version: "malu-newer@1" });
  }
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const body = (red: TestBot, blue: TestBot) => ({
  mode: "deathmatch",
  rulesetId: "deathmatch-mvp",
  mapId: "mvp-arena-02",
  participants: [
    { botId: red.botId, version: 1, team: "red" },
    { botId: blue.botId, version: 1, team: "blue" },
  ],
  rules: {
    preset: "custom",
    teamSize: 1,
    params: {
      respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 },
      victory: "elimination",
      timeLimitMinutes: 10,
      botCredits: 5000,
      botMassKg: 10000,
    },
  },
});
const check = (b: object, t: string) =>
  request(app).post("/battles/rules-check").set("Authorization", `Bearer ${t}`).send(b);
const create = (b: object, t: string) => request(app).post("/battles").set("Authorization", `Bearer ${t}`).send(b);

const LEAK = /cannon|turret_main|weapon\.|ranura|slot|catálogo/i;

describe("409 loadout_unavailable: detalle sólo para dueño y staff", () => {
  it("tercero (bot PÚBLICO ajeno): mensaje genérico, sin moduleId ni ranura (rules-check y POST /battles)", async () => {
    for (const f of [check, create]) {
      const r = await f(body(foreign, mine), thirdTok);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toBe("loadout_unavailable");
      expect(JSON.stringify(r.body)).not.toMatch(LEAK);
      expect(r.body.message).toContain("no se puede calcular su composición");
    }
  });

  it("dueño del bot: detalle del módulo y la ranura", async () => {
    const r = await check(body(mine, foreign), ownerTok);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("loadout_unavailable");
    expect(r.body.message).toMatch(/weapon\.cannon/);
  });

  it("staff: detalle", async () => {
    const r = await check(body(foreign, mine), staffTok);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.message).toMatch(/weapon\.cannon/);
  });

  it("sin dueño en el bando pero dueño de OTRO bot: no ve el detalle del ajeno", async () => {
    const r = await check(body(foreign, mine), ownerTok);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });
});
