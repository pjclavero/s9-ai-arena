/**
 * R8.6/R8.9 · Sistema/ops: estado agregado y matriz RBAC, ambos solo admin y de
 * solo lectura. Se verifica el RBAC (organizer ⇒ 403), la forma de la respuesta y
 * que NUNCA se filtra el valor de un secreto (SMOKE_BOT_DIGEST solo como booleano).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { ROLES } from "./db/migrations.js";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let h: TestDbHandle;
let app: Express;
let admin: string;
let organizer: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
});

afterAll(async () => {
  await h.stop();
});

describe("R8 · GET /system/status", () => {
  it("un organizer NO admin recibe 403", async () => {
    const res = await request(app).get("/system/status").set(auth(organizer));
    expect(res.status).toBe(403);
  });

  it("admin recibe estado agregado con conteos y política de runtime", async () => {
    const res = await request(app).get("/system/status").set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.databaseOk).toBe(true);
    expect(typeof res.body.env).toBe("string");
    expect(typeof res.body.realRunnerEnabled).toBe("boolean");
    expect(typeof res.body.smokeDigestConfigured).toBe("boolean");
    expect(res.body.battlesByStatus).toBeTypeOf("object");
    expect(res.body.buildsByStatus).toBeTypeOf("object");
    expect(typeof res.body.readyBots).toBe("number");
    expect(typeof res.body.publishedMaps).toBe("number");
    // Invariantes de seguridad siempre vigentes.
    expect(res.body.runtimePolicy).toMatchObject({
      privileged: false,
      dockerSocketMounted: false,
      seccompEnforced: true,
      digestRequired: true,
      signatureRequired: true,
    });
  });

  it("NUNCA expone el valor de SMOKE_BOT_DIGEST, solo un booleano", async () => {
    const prev = process.env.SMOKE_BOT_DIGEST;
    process.env.SMOKE_BOT_DIGEST = "sha256:supersecretdigestvalue";
    try {
      const res = await request(app).get("/system/status").set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.body.smokeDigestConfigured).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("supersecretdigestvalue");
    } finally {
      if (prev === undefined) delete process.env.SMOKE_BOT_DIGEST;
      else process.env.SMOKE_BOT_DIGEST = prev;
    }
  });
});

describe("R8 · GET /system/rbac", () => {
  it("un organizer NO admin recibe 403", async () => {
    const res = await request(app).get("/system/rbac").set(auth(organizer));
    expect(res.status).toBe(403);
  });

  it("admin recibe roles y la matriz endpoint→rol mínimo derivada del contrato", async () => {
    const res = await request(app).get("/system/rbac").set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.roles).toHaveLength(ROLES.length);
    expect(res.body.roles[0]).toMatchObject({ name: ROLES[0], rank: 0 });
    const self = res.body.endpoints.find((e: { operationId: string }) => e.operationId === "getSystemStatus");
    expect(self).toMatchObject({ method: "GET", path: "/system/status", minRole: "admin" });
    // No hay datos de usuarios en la respuesta.
    expect(JSON.stringify(res.body)).not.toContain("@dev.arena.local");
  });
});
