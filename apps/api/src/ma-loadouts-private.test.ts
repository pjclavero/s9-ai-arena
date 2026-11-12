/**
 * OLA 2 · MA · EQUIPMENT_PRIVATE en la API de bots (hallazgo P2-4 de la revisión):
 * `GET /bots/{id}/loadouts` es privado TAMBIÉN para un bot público. Sólo dueño y staff;
 * cualquier otro recibe el mismo 404 que un id inexistente.
 * Mutante: volver a `getVisibleBot` a secas (visible ⇒ lista) ⇒ rojo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);

let h: TestDbHandle;
let app: Express;
let owner: string;
let other: string;
let moderator: string;
let admin: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  owner = await tokenFor(h.db, DEV_USERS.developer);
  other = await tokenFor(h.db, DEV_USERS.user);
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
  admin = await tokenFor(h.db, DEV_USERS.admin);
}, 120000);
afterAll(async () => {
  await h.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("GET /bots/{id}/loadouts · loadout privado también con bot público", () => {
  it("dueño y staff lo reciben; un tercero con sesión recibe 404 idéntico al de un id inexistente", async () => {
    for (const visibility of ["public", "private"]) {
      const bot = await request(app)
        .post("/bots")
        .set(auth(owner))
        .send({ name: `ma-${visibility}`, visibility });
      expect(bot.status).toBe(201);
      const l = await request(app)
        .post(`/bots/${bot.body.id}/loadouts`)
        .set(auth(owner))
        .send({ ...GOOD_LOADOUT, loadoutId: undefined, revision: undefined });
      expect(l.status).toBe(201);

      const own = await request(app).get(`/bots/${bot.body.id}/loadouts`).set(auth(owner));
      expect(own.status).toBe(200);
      expect(own.body.length).toBe(1);
      for (const staff of [moderator, admin]) {
        expect((await request(app).get(`/bots/${bot.body.id}/loadouts`).set(auth(staff))).status).toBe(200);
      }
      const third = await request(app).get(`/bots/${bot.body.id}/loadouts`).set(auth(other));
      const missing = await request(app).get(`/bots/00000000-0000-4000-8000-000000000000/loadouts`).set(auth(other));
      expect(third.status, `bot ${visibility}`).toBe(404);
      expect(third.body).toEqual(missing.body); // uniforme: no revela que existe
      expect(JSON.stringify(third.body)).not.toMatch(/chassis|moduleId|modules/);
      // control: la ficha del bot público SÍ es visible para el tercero (sólo el loadout es privado)
      const ficha = await request(app).get(`/bots/${bot.body.id}`).set(auth(other));
      expect(ficha.status).toBe(visibility === "public" ? 200 : 404);
    }
  });
});
