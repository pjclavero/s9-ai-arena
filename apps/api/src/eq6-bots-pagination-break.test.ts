/**
 * EQ6 · revisión independiente de #209 · paginación de «Mis bots» (GET /bots?ownerId=…).
 *
 * «Cargar más» recorre la lista por cursor (created_at, id) de 100 en 100. Se exige:
 *  - con más de 100 bots, el recorrido completo devuelve CADA bot exactamente una vez;
 *  - también cuando varios bots comparten `created_at` (p. ej. una importación o una
 *    semilla en una sola sentencia: `now()` es el mismo para toda la transacción);
 *  - `counts` (includeCounts) coincide con lo recorrido, y no sale para un ownerId ajeno
 *    ni para el staff mirando a otro usuario.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  tok.dev = await tokenFor(h.db, DEV_USERS.developer);
  tok.user = await tokenFor(h.db, DEV_USERS.user);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function walk(ownerId: string, token: string): Promise<{ ids: string[]; pages: number; counts: any }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let counts: any;
  do {
    const r = await request(app)
      .get(
        `/bots?ownerId=${ownerId}&limit=100&includeCounts=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
      .set(auth(token));
    expect(r.status).toBe(200);
    ids.push(...r.body.items.map((b: any) => b.id));
    counts ??= r.body.counts;
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 50);
  return { ids, pages, counts };
}

async function newOwner(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@eq6.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert([
    { user_id: u.id, role: "user" },
    { user_id: u.id, role: "developer" },
  ]);
  return { id: u.id, token: await tokenFor(h.db, email) };
}

describe("EQ6 · #209 · «Mis bots» con más de 100 bots", () => {
  it("bots creados uno a uno por la API (instantes distintos): 230 bots, cada uno una sola vez", async () => {
    const o = await newOwner("eq6-seq");
    const want: string[] = [];
    for (let i = 0; i < 230; i++) {
      const r = await request(app)
        .post("/bots")
        .set(auth(o.token))
        .send({ name: `seq-${i}`, visibility: "private" });
      expect(r.status).toBe(201);
      want.push(r.body.id);
    }
    const got = await walk(o.id, o.token);
    expect(new Set(got.ids).size, "duplicados").toBe(got.ids.length);
    expect([...got.ids].sort()).toEqual([...want].sort());
    expect(got.counts).toEqual({ total: 230, active: 230, retired: 0 });
  }, 180000);

  it("bots con el MISMO created_at (alta en una sentencia): 230 bots, cada uno una sola vez", async () => {
    const o = await newOwner("eq6-bulk");
    const rows = Array.from({ length: 230 }, (_, i) => ({
      id: randomUUID(),
      name: `bulk-${i}`,
      owner_id: o.id,
      visibility: "private",
    }));
    await h.db("bots").insert(rows); // created_at = now() idéntico (µs) para las 230 filas
    const got = await walk(o.id, o.token);
    expect(new Set(got.ids).size, "duplicados").toBe(got.ids.length);
    expect(got.ids.length, `recorridos ${got.ids.length} de 230 en ${got.pages} páginas`).toBe(230);
    expect(got.counts.total).toBe(230);
  }, 180000);

  it("counts no sale para un ownerId ajeno, ni para el admin mirando a otro", async () => {
    const o = await newOwner("eq6-priv");
    await request(app).post("/bots").set(auth(o.token)).send({ name: "secreto", visibility: "private" });
    for (const who of ["user", "admin"]) {
      const r = await request(app).get(`/bots?ownerId=${o.id}&includeCounts=true`).set(auth(tok[who]));
      expect(r.status).toBe(200);
      expect(r.body.counts, `${who} ve recuentos ajenos`).toBeUndefined();
      if (who === "user") expect(r.body.items).toEqual([]);
    }
  });
});
