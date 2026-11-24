/**
 * V1 · La política de contraseñas se aplica en TODOS los puntos de entrada: registro, cambio,
 * `/auth/reset`, primer administrador (servicio) y CLI `create-admin`. PostgreSQL real embebido.
 *
 * (`reset-password` por CLI no existe en main: no hay punto de entrada que cubrir.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FailedLoginGuard } from "./middleware/rate-limit.js";
import { createPasswordReset } from "./routes/auth.js";
import { createAdmin, CreateAdminError } from "./services/create-admin.js";
import { hashToken } from "./auth/tokens.js";

const CLI = fileURLToPath(new URL("./db/cli.ts", import.meta.url));
const GOOD = "contraseña-larga-de-prueba-77";
const LARGA = "ab".repeat(64) + "c"; // 129
const COMUN = "QWERTYQWERTY"; // blocklist, otra capitalización

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    loginGuard: new FailedLoginGuard(1000, 60_000),
    passwordChangeGuard: new FailedLoginGuard(1000, 60_000),
  });
}, 120000);

afterAll(async () => {
  await h.stop();
});

const reg = (email: string, password: string, displayName = "Pol") =>
  request(app).post("/auth/register").send({ email, password, displayName });

async function usuario(tag: string, displayName = `Pol ${tag}`) {
  const email = `v1pol-${tag}@test.local`;
  const r = await reg(email, GOOD, displayName);
  expect(r.status).toBe(201);
  const login = await request(app).post("/auth/login").send({ email, password: GOOD });
  return { email, userId: r.body.id as string, token: login.body.accessToken as string };
}

describe("V1 política · registro", () => {
  it("registro rechaza 129 caracteres, una común y la derivada del email; acepta 128", async () => {
    expect((await reg("v1pol-r1@test.local", LARGA)).status).toBe(400);
    expect((await reg("v1pol-r2@test.local", COMUN)).status).toBe(400);
    expect((await reg("v1pol-r3@test.local", "v1pol-r3@test.local")).status).toBe(400);
    expect((await reg("v1pol-r4@test.local", "x", "v1pol-r4-nombre-visible")).status).toBe(400);
    expect((await reg("v1pol-r5@test.local", "ab".repeat(64))).status).toBe(201);
    // el rechazo no crea cuenta
    expect(await h.db("users").where({ email: "v1pol-r2@test.local" }).first()).toBeUndefined();
  });
});

describe("V1 política · cambio de contraseña", () => {
  const change = (token: string, newPassword: string) =>
    request(app)
      .post("/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: GOOD, newPassword });

  it("cambio rechaza 129 caracteres, una común y la derivada de la propia cuenta", async () => {
    const u = await usuario("c1", "Nombre Visible Largo");
    expect((await change(u.token, LARGA)).status).toBe(400);
    expect((await change(u.token, COMUN)).status).toBe(400);
    expect((await change(u.token, u.email)).status).toBe(400);
    expect((await change(u.token, "nombrevisiblelargo")).status).toBe(400);
    // y sigue entrando con la contraseña anterior: ninguna se aplicó
    expect((await request(app).post("/auth/login").send({ email: u.email, password: GOOD })).status).toBe(200);
    expect((await change(u.token, "ab".repeat(64))).status).toBe(204);
  });
});

describe("V1 política · /auth/reset", () => {
  const estado = async (token: string) =>
    (
      await h
        .db("password_resets")
        .where({ token_hash: hashToken(token) })
        .first()
    ).used_at;

  it("reset rechaza 129 caracteres, una común y la derivada de la cuenta SIN consumir el token", async () => {
    const u = await usuario("x1");
    const token = await createPasswordReset(h.db, u.userId);
    const reset = (newPassword: string) => request(app).post("/auth/reset").send({ token, newPassword });
    expect((await reset(LARGA)).status).toBe(400);
    expect((await reset(COMUN)).status).toBe(400);
    expect((await reset(u.email)).status).toBe(400);
    expect(await estado(token)).toBeNull();
    expect((await reset("ab".repeat(64))).status).toBe(204);
    expect(await estado(token)).not.toBeNull();
  });
});

describe("V1 política · primer administrador (servicio y CLI)", () => {
  it("createAdmin rechaza 129 caracteres, una común y la derivada del email/nombre (invalid_input)", async () => {
    const casos = [
      { password: LARGA, displayName: "Admin" },
      { password: COMUN, displayName: "Admin" },
      { password: "admin-v1pol@test.local", displayName: "Admin" },
      { password: "nombre-visible-del-admin", displayName: "nombre-visible-del-admin" },
    ];
    for (const c of casos) {
      await expect(createAdmin(h.db, { email: "admin-v1pol@test.local", ...c })).rejects.toSatisfy(
        (e: unknown) => e instanceof CreateAdminError && e.code === "invalid_input",
      );
    }
  });

  it("CLI create-admin: contraseña común o de 129 caracteres por stdin => rc=2", () => {
    for (const pw of [COMUN, LARGA]) {
      const r = spawnSync("npx", ["tsx", CLI, "create-admin", "cli-v1pol@test.local", "CLI", "--password-stdin"], {
        input: `${pw}\n`,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: h.url },
        timeout: 90_000,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain(pw);
    }
  });
});
