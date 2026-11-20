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
  // DEFECTO VIGENTE (issue #305) en main 8f380eb (medido en VM de pruebas): `GET /bots?ownerId=no-es-uuid` da 500 sin
  // cursor y, con un cursor válido, un 400 «Cursor de paginación inválido» (runCursorQuery culpa al cursor
  // de un error de filtro). `it.fails` fija el defecto: se pone ROJO cuando se corrija (validar ownerId
  // como uuid → 400 en ambos casos); entonces basta con quitar `.fails`.
  it.fails("ownerId no-UUID: con y sin cursor válido, MISMA respuesta (y nunca «cursor inválido»)", async () => {
    const sin = await request(app).get("/bots?ownerId=no-es-uuid").set("Authorization", `Bearer ${tok}`);
    const con = await request(app)
      .get(`/bots?ownerId=no-es-uuid&cursor=${validCursor}`)
      .set("Authorization", `Bearer ${tok}`);
    expect(con.status, "el cursor válido cambió la respuesta de un error de filtro").toBe(sin.status);
    expect(JSON.stringify(con.body)).not.toMatch(/[Cc]ursor/);
  });
});
