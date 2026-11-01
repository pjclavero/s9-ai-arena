/**
 * RULES-REVIEW (FASE 20, 2.ª ronda) · rotura de lo nuevo en `rules/rulesets` @ 4679972:
 * regla de participantes compartida (`services/battle-participants.ts`) con ELIG y uuid
 * canónico en POST /battles/rules-check y POST /battles.
 *
 *  - privado ajeno con versión NO elegible ⇒ 404 (la visibilidad va antes que ELIG: no
 *    se confirma que exista ni se filtra el motivo de no elegibilidad);
 *  - privado ajeno en MAYÚSCULAS o con {llaves} ⇒ 404 idéntico al inexistente;
 *  - el mismo bot dos veces con distinta grafía ⇒ 400 duplicado (no 500 por la PK);
 *  - botId no-uuid / `__proto__` / muy largo ⇒ 404 (nunca 500);
 *  - las dos rutas responden lo mismo para cada caso.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, EXAMPLE_LOADOUT, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
const mine: TestBot[] = [];
let privateStale: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  for (let i = 0; i < 2; i++) mine.push(await createPublishedBot(h.db, `rv2-${i + 1}`, { ownerId: user.id }));
  // Bot PRIVADO AJENO y además NO elegible (cañón con munición embebida, regla RC5.3).
  privateStale = await createPublishedBot(h.db, "rv2-private-stale");
  await h.db("bots").where({ id: privateStale.botId }).update({ visibility: "private" });
  const modules = EXAMPLE_LOADOUT.modules.map((m: any) =>
    m.moduleId === "weapon.cannon@1" ? { ...m, ammo: "ammo.standard@1" } : m,
  );
  await h
    .db("bot_loadouts")
    .where({ bot_id: privateStale.botId, revision: 1 })
    .update({ modules: JSON.stringify(modules) });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const duel = (red: string, blue: string) => ({
  mode: "deathmatch",
  rulesetId: "deathmatch-mvp",
  mapId: "mvp-arena-02",
  participants: [
    { botId: red, version: 1, team: "red" },
    { botId: blue, version: 1, team: "blue" },
  ],
  rules: { preset: "duel", teamSize: 1 },
});
const both = async (b: object) => {
  const [battlesBefore] = await h.db("battles").count({ n: "*" });
  const c = await request(app).post("/battles/rules-check").set("Authorization", `Bearer ${tok}`).send(b);
  const p = await request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(b);
  const [battlesAfter] = await h.db("battles").count({ n: "*" });
  return { c, p, created: Number(battlesAfter.n) - Number(battlesBefore.n) };
};

describe("rules-check y POST /battles · participantes raros", () => {
  it("privado ajeno con versión NO elegible ⇒ 404 en las dos rutas, sin motivo de ELIG", async () => {
    const { c, p, created } = await both(duel(privateStale.botId, mine[0].botId));
    for (const r of [c, p]) {
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.error).toBe("bot_not_found");
      const s = JSON.stringify(r.body);
      expect(s).not.toMatch(/eligib|ammo|cannon|notEligible/i);
    }
    expect(created).toBe(0);
  });

  it("privado ajeno en MAYÚSCULAS o con {llaves} ⇒ 404 idéntico al de un uuid inexistente", async () => {
    const ghost = "0f0f0f0f-0000-4000-8000-000000000000";
    const ref = await both(duel(ghost, mine[0].botId));
    for (const id of [privateStale.botId.toUpperCase(), `{${privateStale.botId}}`, ` ${privateStale.botId} `]) {
      const { c, p, created } = await both(duel(id, mine[0].botId));
      expect(created).toBe(0);
      for (const [r, base] of [
        [c, ref.c],
        [p, ref.p],
      ] as const) {
        expect(r.status).toBe(404);
        expect(r.body.error).toBe(base.body.error);
      }
    }
  });

  it("el mismo bot dos veces con distinta grafía ⇒ 400 duplicado (no 500 por la PK)", async () => {
    const { c, p, created } = await both(duel(mine[0].botId, mine[0].botId.toUpperCase()));
    expect(c.status).toBe(400);
    expect(p.status).toBe(400);
    expect(created).toBe(0);
  });

  it("botId no-uuid, `__proto__` o enorme ⇒ 404 (nunca 500)", async () => {
    for (const id of ["x", "__proto__", "constructor", "a".repeat(5000), "00000000-0000-0000-0000-00000000000g"]) {
      const { c, p, created } = await both(duel(id, mine[0].botId));
      expect([c.status, p.status], id.slice(0, 20)).toEqual([404, 404]);
      expect(created).toBe(0);
    }
  });

  it("bot propio en MAYÚSCULAS ⇒ se crea con el uuid CANÓNICO (participants guarda la forma minúscula)", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${tok}`)
      .send(duel(mine[0].botId.toUpperCase(), mine[1].botId));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const parts = await h.db("participants").where({ battle_id: r.body.id }).select("bot_id");
    expect(parts.map((x: any) => x.bot_id).sort()).toEqual([mine[0].botId, mine[1].botId].sort());
  });
});
