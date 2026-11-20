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

  it("ownerId vacío o repetido también es 400; un uuid válido sigue filtrando", async () => {
    for (const q of ["ownerId=", "ownerId=a&ownerId=b"]) {
      const r = await request(app).get(`/bots?${q}`).set("Authorization", `Bearer ${tok}`);
      expect(r.status, q).toBe(400);
    }
    const ok = await request(app)
      .get("/bots?ownerId=00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${tok}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items).toEqual([]);
  });
});
