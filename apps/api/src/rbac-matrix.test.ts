/**
 * T7.2 · DoD: test de matriz rol×endpoint GENERADO desde el OpenAPI de E1.
 *
 * Para cada operación implementada (x-min-role del contrato):
 *  - con un rol INSUFICIENTE espera 401 (anónimo) o 403 (rol menor);
 *  - con el rol MÍNIMO espera "éxito de autorización": cualquier estado
 *    excepto 401/403 (404/400/422 son aceptables con parámetros sintéticos).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { implementedOperations } from "./registry.js";
import { ROLE_RANK } from "./openapi.js";
import { ROLES, type RoleName } from "./db/migrations.js";

let h: TestDbHandle;
let app: Express;
const tokens = new Map<RoleName, string>();

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  for (const role of ROLES) {
    if (role === "visitor") continue;
    tokens.set(role, await tokenFor(h.db, DEV_USERS[role]));
  }
}, 120000);

afterAll(async () => {
  await h.stop();
});

function substitutedPath(openapiPath: string): string {
  return openapiPath.replace(/\{([^}]+)\}/g, (_, name: string) =>
    name === "version" ? "1" : name === "catalogVersion" ? "mvp@1" : randomUUID(),
  );
}

async function call(method: string, path: string, token?: string) {
  let r = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path);
  if (token) r = r.set("Authorization", `Bearer ${token}`);
  if (["post", "patch", "put"].includes(method)) r = r.send({});
  return r;
}

describe("T7.2 matriz rol×endpoint desde el contrato", () => {
  it("hay operaciones del contrato implementadas", () => {
    expect(implementedOperations.filter((o) => !o.extension).length).toBeGreaterThan(10);
  });

  it("cada operación implementada respeta x-min-role", async () => {
    for (const op of implementedOperations) {
      const path = substitutedPath(op.path);
      const required = ROLE_RANK[op.minRole];

      if (required > ROLE_RANK.visitor) {
        // Anónimo ⇒ 401 siempre
        const anon = await call(op.method, path);
        expect(anon.status, `${op.operationId} anónimo`).toBe(401);

        // Rol inmediatamente inferior (si existe usuario con él) ⇒ 403
        const lowerRole = ROLES[required - 1];
        if (lowerRole !== "visitor") {
          const lower = await call(op.method, path, tokens.get(lowerRole));
          expect(lower.status, `${op.operationId} con rol ${lowerRole}`).toBe(403);
        }

        // Rol mínimo ⇒ autorizado (nunca 401/403 por ROL con recursos sintéticos
        // propios; un 403 de autorización de objeto no aplica con UUIDs inexistentes,
        // que devuelven 404 antes)
        const min = await call(op.method, path, tokens.get(op.minRole));
        expect([401, 403], `${op.operationId} con rol mínimo ${op.minRole} ⇒ ${min.status}`).not.toContain(min.status);
      } else {
        const anon = await call(op.method, path);
        expect([401, 403], `${op.operationId} anónimo (visitor) ⇒ ${anon.status}`).not.toContain(anon.status);
      }
    }
  });

  it("la jerarquía es acumulativa: admin puede lo que puede un developer", async () => {
    const r = await call("get", "/users/me", tokens.get("admin"));
    expect(r.status).toBe(200);
  });
});
