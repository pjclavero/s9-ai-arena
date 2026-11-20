/**
 * V1-B · Cambio de contraseña del usuario autenticado (`POST /auth/password`).
 *
 * Antes de este cambio NO existía: un usuario no podía cambiar su contraseña (docs/user/accounts.md
 * lo remitía a «pídeselo a un administrador», que tampoco tenía ruta). Requisitos del encargo:
 *  - exige la contraseña actual (y TOTP/código de recuperación si hay 2FA);
 *  - aplica la política (≥12, distinta de la actual);
 *  - invalida las DEMÁS sesiones y refresh tokens (la actual sigue viva);
 *  - limita los intentos fallidos (429, por usuario);
 *  - un token de recuperación anterior no puede deshacer el cambio.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as otplib from "otplib";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { createPasswordReset } from "./routes/auth.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    // Guard de LOGIN holgado (estos tests hacen logins a propósito) y guard de CAMBIO estricto e inyectado.
    loginGuard: new FailedLoginGuard(1000, 60_000),
    passwordChangeGuard: new FailedLoginGuard(3, 60_000),
  });
}, 120000);

afterAll(async () => {
  await h.stop();
});

const OLD = "password-vieja-larga-1";
const NEW = "password-nueva-larga-2";

async function totpFromUri(otpauthUrl: string): Promise<string> {
  const secret = new URL(otpauthUrl).searchParams.get("secret")!;
  const r = (await otplib.generate({ secret })) as unknown;
  return typeof r === "string" ? r : String((r as { otp: string }).otp);
}

async function newUser(tag: string) {
  const email = `v1b-pw-${tag}@test.local`;
  const reg = await request(app)
    .post("/auth/register")
    .send({ email, password: OLD, displayName: `V1B ${tag}` });
  expect(reg.status).toBe(201);
  const login = async (password = OLD, totp?: string) =>
    request(app).post("/auth/login").send({ email, password, totp });
  const a = await login();
  const b = await login();
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  return { email, userId: reg.body.id as string, a: a.body, b: b.body, login };
}

const change = (token: string, body: Record<string, unknown>) =>
  request(app).post("/auth/password").set("Authorization", `Bearer ${token}`).send(body);

describe("V1-B · cambio de contraseña autenticado", () => {
  it("camino feliz: 204, la contraseña vieja deja de valer, la nueva entra y se audita", async () => {
    const u = await newUser("ok");
    const r = await change(u.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(r.status).toBe(204);
    expect((await u.login(OLD)).status).toBe(401);
    expect((await u.login(NEW)).status).toBe(200);
    const entry = await h
      .db("audit_log")
      .where({ action: "auth.password.changed", target: `user:${u.userId}` })
      .first();
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.detail)).not.toContain(NEW);
  });

  it("invalida las DEMÁS sesiones y sus refresh tokens; la sesión que cambia la contraseña sigue viva", async () => {
    const u = await newUser("sesiones");
    const r = await change(u.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(r.status).toBe(204);
    const meB = await request(app).get("/users/me").set("Authorization", `Bearer ${u.b.accessToken}`);
    expect(meB.status).toBe(401);
    const refreshB = await request(app).post("/auth/refresh").send({ refreshToken: u.b.refreshToken });
    expect(refreshB.status).toBe(401);
    const meA = await request(app).get("/users/me").set("Authorization", `Bearer ${u.a.accessToken}`);
    expect(meA.status).toBe(200);
    const refreshA = await request(app).post("/auth/refresh").send({ refreshToken: u.a.refreshToken });
    expect(refreshA.status).toBe(200);
  });

  it("exige autenticación y la contraseña actual correcta; con la actual mal, nada cambia", async () => {
    const u = await newUser("actual");
    const anon = await request(app).post("/auth/password").send({ currentPassword: OLD, newPassword: NEW });
    expect(anon.status).toBe(401);
    const sinActual = await change(u.a.accessToken, { newPassword: NEW });
    expect(sinActual.status).toBe(400);
    const mala = await change(u.a.accessToken, { currentPassword: "no-es-esta-contraseña", newPassword: NEW });
    expect(mala.status).toBe(401);
    expect((await u.login(OLD)).status).toBe(200); // sigue la vieja
    expect((await u.login(NEW)).status).toBe(401);
    // la otra sesión NO se revocó por un intento fallido
    const meB = await request(app).get("/users/me").set("Authorization", `Bearer ${u.b.accessToken}`);
    expect(meB.status).toBe(200);
  });

  it("política: nueva ≥12 caracteres y distinta de la actual", async () => {
    const u = await newUser("politica");
    const corta = await change(u.a.accessToken, { currentPassword: OLD, newPassword: "corta-11-ch" });
    expect(corta.status).toBe(400);
    const igual = await change(u.a.accessToken, { currentPassword: OLD, newPassword: OLD });
    expect(igual.status).toBe(400);
    const noString = await change(u.a.accessToken, { currentPassword: OLD, newPassword: 123456789012 });
    expect(noString.status).toBe(400);
    expect((await u.login(OLD)).status).toBe(200);
  });

  it("limita los intentos: tras 3 fallos, 429 incluso con la contraseña correcta; nada cambia", async () => {
    const u = await newUser("fuerza");
    for (let i = 0; i < 3; i++) {
      const r = await change(u.a.accessToken, { currentPassword: `incorrecta-${i}-xxxxxx`, newPassword: NEW });
      expect(r.status).toBe(401);
    }
    const bloqueado = await change(u.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(bloqueado.status).toBe(429);
    expect((await u.login(OLD)).status).toBe(200);
    expect((await u.login(NEW)).status).toBe(401);
  });

  it("un cambio correcto reinicia el contador de fallos", async () => {
    const u = await newUser("reset-contador");
    for (let i = 0; i < 2; i++) {
      expect((await change(u.a.accessToken, { currentPassword: `mala-${i}-xxxxxxxx`, newPassword: NEW })).status).toBe(
        401,
      );
    }
    expect((await change(u.a.accessToken, { currentPassword: OLD, newPassword: NEW })).status).toBe(204);
    // 2 fallos más no bloquean (el contador volvió a 0; con 3 fallos acumulados sí lo habría hecho)
    for (let i = 0; i < 2; i++) {
      expect((await change(u.a.accessToken, { currentPassword: `mala-${i}-yyyyyyyy`, newPassword: OLD })).status).toBe(
        401,
      );
    }
  });

  it("un token de recuperación emitido ANTES no puede deshacer el cambio", async () => {
    const u = await newUser("reset-previo");
    const token = await createPasswordReset(h.db, u.userId);
    expect((await change(u.a.accessToken, { currentPassword: OLD, newPassword: NEW })).status).toBe(204);
    const reuse = await request(app).post("/auth/reset").send({ token, newPassword: "otra-password-larga-3" });
    expect(reuse.status).toBe(401);
    expect((await u.login(NEW)).status).toBe(200);
  });

  it("con 2FA exige también el TOTP y NO desactiva el 2FA", async () => {
    const u = await newUser("2fa");
    const enable = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${u.a.accessToken}`);
    expect(enable.status).toBe(200);
    const url = enable.body.otpauthUrl as string;
    const login = await u.login(OLD, await totpFromUri(url));
    expect(login.status).toBe(200);
    const access = login.body.accessToken as string;

    const sinTotp = await change(access, { currentPassword: OLD, newPassword: NEW });
    expect(sinTotp.status).toBe(401);
    expect((await u.login(NEW, await totpFromUri(url))).status).toBe(401);

    const ok = await change(access, { currentPassword: OLD, newPassword: NEW, totp: await totpFromUri(url) });
    expect(ok.status).toBe(204);
    // el 2FA sigue activo: la contraseña nueva sola no basta
    expect((await u.login(NEW)).status).toBe(401);
    expect((await u.login(NEW, await totpFromUri(url))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Ronda de revisión (P2-1, P2-2, P2-3 del informe independiente de #315)
// ---------------------------------------------------------------------------------------------
const changeVia = (a: Express, token: string, body: Record<string, unknown>) =>
  request(a).post("/auth/password").set("Authorization", `Bearer ${token}`).send(body);

describe("V1-B · guard POR DEFECTO de producción (sin passwordChangeGuard inyectado)", () => {
  it("guard por defecto: 5 fallos y luego 429, también con la contraseña correcta, y se audita change_blocked", async () => {
    const prod = createApp({ db: h.db, loginGuard: new FailedLoginGuard(1000, 60_000) });
    const u = await newUser("guard-defecto");
    for (let i = 0; i < 5; i++) {
      const r = await changeVia(prod, u.a.accessToken, { currentPassword: `mala-${i}-zzzzzzzz`, newPassword: NEW });
      expect(r.status, `intento ${i + 1}`).toBe(401);
    }
    const bloqueado = await changeVia(prod, u.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(bloqueado.status).toBe(429);
    expect((await u.login(OLD)).status).toBe(200); // la contraseña no cambió
    const entry = await h
      .db("audit_log")
      .where({ action: "auth.password.change_blocked", target: `user:${u.userId}` })
      .first();
    expect(entry).toBeTruthy();
  });
});

describe("V1-B · límite de la ruta y aislamiento por usuario", () => {
  it("límite de peticiones de /auth/password: el 5.º intento seguido da 429 aunque el guard de fallos no se dispare", async () => {
    const limited = createApp({
      db: h.db,
      loginGuard: new FailedLoginGuard(1000, 60_000),
      passwordChangeGuard: new FailedLoginGuard(1000, 60_000), // el guard NO es quien corta
      loginLimiter: new SlidingWindowLimiter(4, 60_000),
    });
    const u = await newUser("limite-ruta");
    for (let i = 0; i < 4; i++) {
      const r = await changeVia(limited, u.a.accessToken, { currentPassword: `mala-${i}-yyyyyyyy`, newPassword: NEW });
      expect(r.status, `intento ${i + 1}`).toBe(401);
    }
    const r5 = await changeVia(limited, u.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(r5.status).toBe(429);
  });

  it("aislamiento: los fallos de A bloquean a A, no a B (misma IP)", async () => {
    const a = await newUser("aisla-a");
    const b = await newUser("aisla-b");
    for (let i = 0; i < 3; i++) {
      expect((await change(a.a.accessToken, { currentPassword: `mala-${i}-xxxxxxxx`, newPassword: NEW })).status).toBe(
        401,
      );
    }
    expect((await change(a.a.accessToken, { currentPassword: OLD, newPassword: NEW })).status).toBe(429);
    const rb = await change(b.a.accessToken, { currentPassword: OLD, newPassword: NEW });
    expect(rb.status, "B no debe heredar el bloqueo de A").toBe(204);
  });
});

describe("V1-B · con 2FA, una petición rechazada por política NO gasta el código de recuperación", () => {
  it("nueva == actual: 400 y el código de recuperación sigue valiendo para el cambio válido", async () => {
    const u = await newUser("2fa-codigo");
    const enable = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${u.a.accessToken}`);
    expect(enable.status).toBe(200);
    const url = enable.body.otpauthUrl as string;
    const code = (enable.body.recoveryCodes as string[])[0];
    const login = await u.login(OLD, await totpFromUri(url));
    const access = login.body.accessToken as string;

    const rechazada = await change(access, { currentPassword: OLD, newPassword: OLD, totp: code });
    expect(rechazada.status).toBe(400);
    const corta = await change(access, { currentPassword: OLD, newPassword: "corta", totp: code });
    expect(corta.status).toBe(400);
    // el MISMO código aún sirve
    const ok = await change(access, { currentPassword: OLD, newPassword: NEW, totp: code });
    expect(ok.status).toBe(204);
  });
});
