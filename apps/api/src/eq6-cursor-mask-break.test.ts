// RESCATE B3 (2026-11) · origen: PR #224 (rama review/eq6-221-r2, commit 7eb5fa44), test de revisión no integrado.
// Verificado contra main 8f380eb; mutante asociado en scripts/rescue-mutants.{json,mjs}.
/**
 * EQ6 · revisión independiente de #221 (R2) · ¿la defensa de PostgreSQL de `runCursorQuery`
 * enmascara errores que NO son del cursor?
 *
 * Caso: un FILTRO mal tipado (ownerId que no es UUID) que llega a SQL. Sin cursor, su error
 * es el que sea (500 si nadie lo valida). Con un cursor VÁLIDO, la respuesta no debe cambiar
 * a «cursor inválido»: el cursor no tiene la culpa.
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
let tok = "";

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  tok = await tokenFor(h.db, DEV_USERS.admin);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const validCursor = Buffer.from(
  JSON.stringify({ v: 2, t: "2026-01-01T00:00:00.123456Z", k: ["00000000-0000-0000-0000-000000000000"] }),
).toString("base64url");

describe("EQ6 · #221 R2 · runCursorQuery no culpa al cursor de un error de filtro", () => {
  // GARANTÍA (V1-B · #305, corregido): `GET /bots?ownerId=no-es-uuid` valida el filtro como uuid y
  // responde 400 «ownerId debe ser un uuid» TANTO sin cursor como con un cursor válido
  // (antes: 500 sin cursor y «cursor inválido» con cursor, porque runCursorQuery culpaba al cursor).
  it("ownerId no-UUID: con y sin cursor válido, MISMA respuesta 400 (y nunca «cursor inválido»)", async () => {
    const sin = await request(app).get("/bots?ownerId=no-es-uuid").set("Authorization", `Bearer ${tok}`);
    const con = await request(app)
      .get(`/bots?ownerId=no-es-uuid&cursor=${validCursor}`)
      .set("Authorization", `Bearer ${tok}`);
    expect(sin.status).toBe(400);
    expect(String(sin.body.message)).toMatch(/ownerId debe ser un uuid/);
    expect(con.status, "el cursor válido cambió la respuesta de un error de filtro").toBe(sin.status);
    expect(JSON.stringify(con.body)).not.toMatch(/[Cc]ursor/);
  });

  it("ownerId vacío o repetido también es 400", async () => {
    for (const q of ["ownerId=", "ownerId=a&ownerId=b"]) {
      const r = await request(app).get(`/bots?${q}`).set("Authorization", `Bearer ${tok}`);
      expect(r.status, q).toBe(400);
    }
  });

  it("ownerId con basura antes o después de un uuid válido es 400 (anclas de la expresión)", async () => {
    const u = "00000000-0000-0000-0000-000000000000";
    for (const v of [`${u}x`, `x${u}`, `${u}-0`, ` ${u}`]) {
      const r = await request(app)
        .get(`/bots?ownerId=${encodeURIComponent(v)}`)
        .set("Authorization", `Bearer ${tok}`);
      expect(r.status, JSON.stringify(v)).toBe(400);
    }
  });

  it("un uuid válido SIGUE filtrando: con bots de dos dueños, sólo salen los del dueño pedido", async () => {
    const mk = async (tag: string) => {
      const [u] = await h
        .db("users")
        .insert({ email: `own-${tag}@eq6.example.internal`, password_hash: "x", display_name: tag })
        .returning("id");
      const [b] = await h
        .db("bots")
        .insert({ name: `bot-${tag}`, owner_id: u.id, visibility: "public" })
        .returning("id");
      return { owner: u.id as string, bot: b.id as string };
    };
    const a = await mk("a");
    const b = await mk("b");
    const r = await request(app).get(`/bots?ownerId=${a.owner}`).set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(a.bot);
    expect(ids).not.toContain(b.bot);
    expect(r.body.items.every((x: { ownerId: string }) => x.ownerId === a.owner)).toBe(true);
  });
});
