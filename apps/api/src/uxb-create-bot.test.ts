/**
 * UX-B · B1 — crear un bot: nombre válido, vacío, sólo espacios, demasiado largo,
 * duplicado y DOBLE CLIC (dos POST simultáneos). Mensajes legibles y nunca dos
 * bots con el mismo nombre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";

let h: TestDbHandle;
let app: Express;
let token: string;
const post = (body: object) =>
  request(app)
    .post("/bots")
    .set({ Authorization: `Bearer ${token}` })
    .send(body);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  token = await tokenFor(h.db, DEV_USERS.developer);
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

describe("UX-B · B1 · alta de bot", () => {
  it("nombre válido → 201 (recortado)", async () => {
    const r = await post({ name: "  Valiente  " });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("Valiente");
  });

  it("vacío o sólo espacios → 400 con mensaje legible", async () => {
    for (const name of ["", "   ", undefined]) {
      const r = await post({ name });
      expect(r.status, String(name)).toBe(400);
      expect(r.body.message).toBe("El nombre del bot es obligatorio.");
    }
  });

  it("demasiado largo → 400 diciendo el límite y la longitud", async () => {
    const r = await post({ name: "x".repeat(49) });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("El nombre del bot admite como máximo 48 caracteres (tiene 49).");
  });

  it("duplicado → 409 que nombra el bot", async () => {
    expect((await post({ name: "Gemelo" })).status).toBe(201);
    const r = await post({ name: "Gemelo" });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Ya tienes un bot llamado «Gemelo»/);
  });

  it("doble clic: dos POST simultáneos con el mismo nombre crean UN solo bot", async () => {
    const [a, b] = await Promise.all([post({ name: "Doble" }), post({ name: "Doble" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const owner = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
    expect(await h.db("bots").where({ owner_id: owner, name: "Doble" }).count("* as n")).toEqual([{ n: "1" }]);
  });
});
