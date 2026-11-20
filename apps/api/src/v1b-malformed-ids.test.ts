/**
 * V1-B (#305) · Barrido: ninguna operación GET del contrato responde 5xx ante un identificador
 * mal formado (path o query). Un id que no es uuid es un error del CLIENTE (400/404), nunca un
 * 500 de PostgreSQL («invalid input syntax for type uuid»).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { loadContract } from "./openapi.js";

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

const BAD = "no-es-uuid";
// 503 = capacidad no configurada en el entorno de test. SÓLO se tolera en las operaciones listadas, con su
// motivo; en cualquier otra, un 503 ante un id mal formado es un fallo.
const CAPABILITY_503: Record<string, string> = {
  listStreamingRecordings: "grabaciones de streaming: sin streamer configurado en test, 503 con cualquier parámetro",
};
const isServerError = (status: number, operationId: string) =>
  status >= 500 && !(status === 503 && operationId in CAPABILITY_503);
// Parámetros de query que son identificadores (el resto tiene su propia validación).
const ID_QUERY = ["ownerId", "teamId", "id", "botId", "battleId", "seasonId", "bot", "team", "user"];

describe("V1-B · #305 · ids mal formados nunca dan 5xx", () => {
  const ops = loadContract().operations.filter((o) => o.method === "get");

  it("GET con id de ruta inválido, en TODAS las operaciones GET del contrato", async () => {
    const fails: string[] = [];
    for (const o of ops) {
      const url = o.path.replace(/\{[^}]+\}/g, BAD);
      const res = await request(app).get(url).set("Authorization", `Bearer ${tok}`);
      if (isServerError(res.status, o.operationId)) fails.push(`${o.operationId} ${url} → ${res.status}`);
    }
    expect(fails).toEqual([]);
  });

  it("POST/PUT/PATCH/DELETE con id de ruta inválido y cuerpo vacío: nunca 5xx", async () => {
    const fails: string[] = [];
    const skip = new Set(["logout"]);
    for (const o of loadContract().operations.filter((x) => x.method !== "get" && x.path.includes("{"))) {
      if (skip.has(o.operationId)) continue;
      const url = o.path.replace(/\{[^}]+\}/g, BAD);
      const res = await (request(app) as any)[o.method](url).set("Authorization", `Bearer ${tok}`).send({});
      if (isServerError(res.status, o.operationId)) fails.push(`${o.operationId} ${o.method} ${url} → ${res.status}`);
    }
    expect(fails).toEqual([]);
  });

  it("DELETE /auth/sessions/<no-uuid> es 404 (no el 500 de PostgreSQL)", async () => {
    const res = await request(app).delete(`/auth/sessions/${BAD}`).set("Authorization", `Bearer ${tok}`);
    expect(res.status).toBe(404);
  });

  it.each(ID_QUERY)("GET con ?%s=<no-uuid> en todos los listados", async (name) => {
    const fails: string[] = [];
    for (const o of ops.filter((x) => !x.path.includes("{"))) {
      const res = await request(app).get(`${o.path}?${name}=${BAD}`).set("Authorization", `Bearer ${tok}`);
      if (isServerError(res.status, o.operationId)) fails.push(`${o.operationId} ${o.path}?${name} → ${res.status}`);
    }
    expect(fails).toEqual([]);
  });
});
