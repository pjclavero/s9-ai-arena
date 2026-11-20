/**
 * V1-B · TD-068 · `GET /bots` con muchos bots AJENOS privados intercalados.
 *
 * La visibilidad se filtra en memoria; antes se leía UN bloque de 200 filas, de modo que si todas eran
 * invisibles para el solicitante la página salía vacía y SIN `nextCursor`: los bots visibles que había
 * detrás eran inalcanzables. Ahora se leen bloques hasta completar la página; y si se agota el tope de
 * bloques por petición, la página puede ser corta pero lleva `nextCursor` (nunca se pierde el final).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@v1b.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert([
    { user_id: u.id, role: "user" },
    { user_id: u.id, role: "developer" },
  ]);
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function seed(viewerBots: number, foreignPrivate: number) {
  const viewer = await newUser("viewer");
  const other = await newUser("otro");
  const base = Date.now();
  // Los bots públicos del solicitante son los MÁS ANTIGUOS: quedan tras todos los ajenos.
  const mine = Array.from({ length: viewerBots }, (_, i) => ({
    id: randomUUID(),
    name: `mio-${i}`,
    owner_id: viewer.id,
    visibility: "public",
    created_at: new Date(base - 86_400_000 - i * 1000),
  }));
  await h.db("bots").insert(mine);
  const foreign = Array.from({ length: foreignPrivate }, (_, i) => ({
    id: randomUUID(),
    name: `ajeno-${i}`,
    owner_id: other.id,
    visibility: "private",
    created_at: new Date(base - i * 1000),
  }));
  for (let i = 0; i < foreign.length; i += 500) await h.db("bots").insert(foreign.slice(i, i + 500));
  return { viewer, mineIds: mine.map((b) => b.id) };
}

async function walk(token: string, limit: number, ownerId: string) {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await request(app)
      .get(`/bots?ownerId=${ownerId}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    ids.push(...r.body.items.map((b: { id: string }) => b.id));
    sizes.push(r.body.items.length);
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 30);
  return { ids, sizes, pages };
}

describe("V1-B · TD-068 · listBots con >200 bots ajenos privados delante", () => {
  it("la primera página sale COMPLETA (antes: vacía y sin nextCursor)", async () => {
    const { viewer, mineIds } = await seed(3, 450);
    // Sin ownerId: el listado general debe alcanzar los 3 bots visibles que hay detrás de los 450 ajenos.
    const r = await request(app).get("/bots?limit=100").set("Authorization", `Bearer ${viewer.token}`);
    expect(r.status).toBe(200);
    const got = r.body.items.map((b: { id: string }) => b.id);
    expect(got.filter((id: string) => mineIds.includes(id)).length).toBe(3);
  }, 120000);

  it("el recorrido por cursor devuelve cada bot visible una sola vez, con páginas llenas salvo la última", async () => {
    const { viewer, mineIds } = await seed(5, 450);
    const w = await walk(viewer.token, 2, viewer.id);
    expect(new Set(w.ids).size, "duplicados").toBe(w.ids.length);
    expect([...w.ids].sort()).toEqual([...mineIds].sort());
    expect(
      w.sizes.slice(0, -1).every((n) => n === 2),
      `tamaños ${w.sizes}`,
    ).toBe(true);
  }, 120000);

  it("con más filas ajenas que el tope de bloques: página corta pero CON nextCursor, y el recorrido llega al final", async () => {
    const { viewer, mineIds } = await seed(3, 2300); // > 10 bloques de 200
    const first = await request(app).get("/bots?limit=3").set("Authorization", `Bearer ${viewer.token}`);
    expect(first.status).toBe(200);
    if (first.body.items.length < 3)
      expect(first.body.nextCursor, "página corta SIN cursor = lista truncada").toBeTruthy();
    // Recorrido SIN filtrar por dueño: ve sus 3 bots y, antes o después, termina.
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await request(app)
        .get(`/bots?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        .set("Authorization", `Bearer ${viewer.token}`);
      expect(r.status).toBe(200);
      ids.push(...r.body.items.map((b: { id: string }) => b.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 60);
    expect(cursor, "el recorrido debe terminar").toBeUndefined();
    const mine = ids.filter((id) => mineIds.includes(id));
    expect([...mine].sort()).toEqual([...mineIds].sort());
  }, 180000);
});
