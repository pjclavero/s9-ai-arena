/**
 * EQ4 · Retirar un bot (organizativo): PATCH /bots/{id} { retired } marca
 * `retiredAt`, sólo el dueño puede, se puede reactivar y NO toca versiones ni
 * historial. Sin el campo, el comportamiento de PATCH es el de siempre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";

let h: TestDbHandle;
let app: Express;
let dev: string;
let other: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  dev = await tokenFor(h.db, DEV_USERS.developer);
  other = await tokenFor(h.db, DEV_USERS.user);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("EQ4 · bot retirado", () => {
  it("un bot nuevo está activo (retiredAt null) y aparece así en el listado", async () => {
    const bot = await request(app).post("/bots").set(auth(dev)).send({ name: "eq4-activo", visibility: "private" });
    expect(bot.status).toBe(201);
    expect(bot.body.retiredAt).toBeNull();
    const list = await request(app).get(`/bots?ownerId=${bot.body.ownerId}&limit=100`).set(auth(dev));
    const row = list.body.items.find((b: { id: string }) => b.id === bot.body.id);
    expect(row.retiredAt).toBeNull();
  });

  it("el dueño lo retira y lo reactiva; la fecha se conserva si se retira dos veces", async () => {
    const bot = await request(app).post("/bots").set(auth(dev)).send({ name: "eq4-retirable", visibility: "private" });
    const r1 = await request(app).patch(`/bots/${bot.body.id}`).set(auth(dev)).send({ retired: true });
    expect(r1.status).toBe(200);
    expect(typeof r1.body.retiredAt).toBe("string");
    const r2 = await request(app).patch(`/bots/${bot.body.id}`).set(auth(dev)).send({ retired: true });
    expect(r2.body.retiredAt).toBe(r1.body.retiredAt);
    const got = await request(app).get(`/bots/${bot.body.id}`).set(auth(dev));
    expect(got.body.retiredAt).toBe(r1.body.retiredAt);
    // nombre y visibilidad intactos
    expect(got.body.name).toBe("eq4-retirable");
    const back = await request(app).patch(`/bots/${bot.body.id}`).set(auth(dev)).send({ retired: false });
    expect(back.status).toBe(200);
    expect(back.body.retiredAt).toBeNull();
  });

  it("retirar no toca las versiones", async () => {
    const bot = await request(app).post("/bots").set(auth(dev)).send({ name: "eq4-versiones", visibility: "private" });
    const before = await h.db("bot_versions").where({ bot_id: bot.body.id }).orderBy("version");
    await request(app).patch(`/bots/${bot.body.id}`).set(auth(dev)).send({ retired: true });
    const after = await h.db("bot_versions").where({ bot_id: bot.body.id }).orderBy("version");
    expect(after).toEqual(before);
  });

  it("valor no booleano ⇒ 400; otro usuario ⇒ no puede (403/404)", async () => {
    const bot = await request(app).post("/bots").set(auth(dev)).send({ name: "eq4-ajeno", visibility: "public" });
    const bad = await request(app).patch(`/bots/${bot.body.id}`).set(auth(dev)).send({ retired: "sí" });
    expect(bad.status).toBe(400);
    const foreign = await request(app).patch(`/bots/${bot.body.id}`).set(auth(other)).send({ retired: true });
    expect([403, 404]).toContain(foreign.status);
    const got = await request(app).get(`/bots/${bot.body.id}`).set(auth(dev));
    expect(got.body.retiredAt).toBeNull();
  });

  it("rev. EQ6 P2-2 · includeCounts da el recuento REAL de mis bots (no el de la página) y nada de otros", async () => {
    const me = await request(app).get("/users/me").set(auth(dev));
    const ownerId = me.body.id as string;
    const created: string[] = [];
    for (let i = 0; i < 23; i++) {
      const b = await request(app)
        .post("/bots")
        .set(auth(dev))
        .send({ name: `eq4-cnt-${i}`, visibility: "private" });
      created.push(b.body.id);
    }
    for (const id of created.slice(0, 3))
      await request(app).patch(`/bots/${id}`).set(auth(dev)).send({ retired: true });
    const [db] = (await h
      .db("bots")
      .where({ owner_id: ownerId })
      .select(
        h.db.raw("count(*)::int AS total"),
        h.db.raw("count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired"),
      )) as { total: number; retired: number }[];
    const page = await request(app).get(`/bots?ownerId=${ownerId}&includeCounts=true`).set(auth(dev));
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBe(20); // la página por defecto es parcial…
    expect(typeof page.body.nextCursor).toBe("string");
    // …pero el recuento es el de TODOS
    expect(page.body.counts).toEqual({ total: db.total, active: db.total - db.retired, retired: db.retired });
    expect(page.body.counts.total).toBeGreaterThan(20);
    // sin pedirlo, la respuesta es la de siempre
    const plain = await request(app).get(`/bots?ownerId=${ownerId}`).set(auth(dev));
    expect(plain.body.counts).toBeUndefined();
    // otro usuario no obtiene recuentos ajenos
    const foreign = await request(app).get(`/bots?ownerId=${ownerId}&includeCounts=true`).set(auth(other));
    expect(foreign.body.counts).toBeUndefined();
  });
});
