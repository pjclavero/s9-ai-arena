/**
 * T7.2 · DoD: revocación/expiración de tokens, bloqueo de fuerza bruta,
 * 2FA E2E y recuperación de cuenta que NO elude el 2FA.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as otplib from "otplib";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEV_PASSWORD } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { createPasswordReset } from "./routes/auth.js";
import { FailedLoginGuard } from "./middleware/rate-limit.js";
import { hashToken } from "./auth/tokens.js";

let h: TestDbHandle;
let app: Express;
let loginGuard: FailedLoginGuard;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  loginGuard = new FailedLoginGuard(20, 60 * 1000);
  app = createApp({ db: h.db, loginGuard });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function totpFromUri(otpauthUrl: string): Promise<string> {
  const secret = new URL(otpauthUrl).searchParams.get("secret")!;
  const r = (await otplib.generate({ secret })) as unknown;
  return typeof r === "string" ? r : String((r as { otp: string }).otp);
}

describe("T7.2 registro y login", () => {
  it("registro → login → getMe (con campos privados solo para el propio usuario)", async () => {
    const reg = await request(app)
      .post("/auth/register")
      .send({ email: "nueva@test.local", password: "una-password-larga", displayName: "Nueva" });
    expect(reg.status).toBe(201);
    expect(reg.body.email).toBe("nueva@test.local");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "nueva@test.local", password: "una-password-larga" });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    expect(login.body.expiresIn).toBe(900);

    const me = await request(app).get("/users/me").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(["user", "developer"]);

    // Perfil público de otro usuario: sin email ni roles
    const pub = await request(app).get(`/users/${me.body.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.email).toBeUndefined();
    expect(pub.body.roles).toBeUndefined();
  });

  it("email duplicado ⇒ 409; contraseña corta ⇒ 400", async () => {
    const dup = await request(app)
      .post("/auth/register")
      .send({ email: DEV_USERS.user, password: "una-password-larga", displayName: "X" });
    expect(dup.status).toBe(409);
    const short = await request(app)
      .post("/auth/register")
      .send({ email: "corta@test.local", password: "corta", displayName: "X" });
    expect(short.status).toBe(400);
  });
});

describe("T7.2 revocación y expiración (DoD: rechazado en todos los endpoints)", () => {
  it("un token revocado es rechazado en todos los endpoints autenticados", async () => {
    const login = await request(app).post("/auth/login").send({ email: DEV_USERS.admin, password: DEV_PASSWORD });
    const token = login.body.accessToken;

    const sessions = await request(app).get("/auth/sessions").set("Authorization", `Bearer ${token}`);
    expect(sessions.status).toBe(200);
    const revoke = await request(app)
      .delete(`/auth/sessions/${sessions.body[0].id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(revoke.status).toBe(204);

    for (const [method, path] of [
      ["get", "/users/me"],
      ["patch", "/users/me"],
      ["get", "/auth/sessions"],
      ["post", "/auth/2fa"],
      ["post", "/teams"],
    ] as const) {
      const r = await (request(app) as any)[method](path).set("Authorization", `Bearer ${token}`).send({});
      expect(r.status, `${method} ${path} con token revocado`).toBe(401);
    }
  });

  it("una sesión expirada rechaza el token y el refresh", async () => {
    const login = await request(app).post("/auth/login").send({ email: DEV_USERS.moderator, password: DEV_PASSWORD });
    // Expira la sesión por detrás
    const user = await h.db("users").where({ email: DEV_USERS.moderator }).first();
    await h
      .db("sessions")
      .where({ user_id: user.id })
      .update({ expires_at: new Date(Date.now() - 1000) });

    const me = await request(app).get("/users/me").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(401);
    const refresh = await request(app).post("/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("el refresh rota; reutilizar el anterior revoca la FAMILIA entera (R2.4 · ERR-SEC-08)", async () => {
    const login = await request(app).post("/auth/login").send({ email: DEV_USERS.organizer, password: DEV_PASSWORD });
    const r1 = await request(app).post("/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    // Reutilizar el token YA ROTADO = robo detectado → 401 y familia revocada:
    const replay = await request(app).post("/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(replay.status).toBe(401);
    // …así que el token "bueno" de la rotación también queda inservible.
    const r2 = await request(app).post("/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });
});

describe("T7.2 fuerza bruta (DoD: 20 fallos ⇒ bloqueo temporal y registro)", () => {
  it("bloquea tras 20 intentos fallidos y lo registra en audit_log", async () => {
    const email = "bruteforce@test.local";
    await request(app).post("/auth/register").send({ email, password: "password-legitima-1", displayName: "BF" });

    for (let i = 0; i < 20; i++) {
      const r = await request(app).post("/auth/login").send({ email, password: "incorrecta-xxxxx" });
      expect(r.status).toBe(401);
    }
    // Con la contraseña CORRECTA: bloqueado igualmente
    const blocked = await request(app).post("/auth/login").send({ email, password: "password-legitima-1" });
    expect(blocked.status).toBe(429);

    const entry = await h.db("audit_log").where({ action: "auth.login.blocked" }).first();
    expect(entry).toBeTruthy();
    expect(entry.target).toBe(`email:${email}`);
  });
});

describe("T7.2 2FA TOTP (DoD: activación y uso E2E; la recuperación no lo elude)", () => {
  const email = "totp@test.local";
  const password = "password-con-2fa-1";
  let otpauthUrl: string;
  let recoveryCodes: string[];

  it("activación: secreto + códigos de recuperación una sola vez; login exige TOTP", async () => {
    await request(app).post("/auth/register").send({ email, password, displayName: "T" });
    const login = await request(app).post("/auth/login").send({ email, password });
    const enable = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(enable.status).toBe(200);
    otpauthUrl = enable.body.otpauthUrl;
    recoveryCodes = enable.body.recoveryCodes;
    expect(otpauthUrl).toContain("otpauth://");
    expect(recoveryCodes.length).toBeGreaterThan(0);

    // Sin TOTP ⇒ 401; con TOTP válido ⇒ 200
    const without = await request(app).post("/auth/login").send({ email, password });
    expect(without.status).toBe(401);
    const withTotp = await request(app)
      .post("/auth/login")
      .send({ email, password, totp: await totpFromUri(otpauthUrl) });
    expect(withTotp.status).toBe(200);
  });

  it("un código de recuperación sirve UNA vez", async () => {
    const code = recoveryCodes[0];
    const first = await request(app).post("/auth/login").send({ email, password, totp: code });
    expect(first.status).toBe(200);
    const replay = await request(app).post("/auth/login").send({ email, password, totp: code });
    expect(replay.status).toBe(401);
  });

  it("la recuperación de cuenta cambia la contraseña pero NO elude el 2FA", async () => {
    const user = await h.db("users").where({ email }).first();
    const token = await createPasswordReset(h.db, user.id);

    const reset = await request(app).post("/auth/reset").send({ token, newPassword: "password-nueva-123" });
    expect(reset.status).toBe(204);

    // Las sesiones anteriores quedan revocadas
    const live = await h.db("sessions").where({ user_id: user.id }).whereNull("revoked_at");
    expect(live.length).toBe(0);

    // Nueva contraseña sin TOTP ⇒ sigue exigiendo 2FA
    const without = await request(app).post("/auth/login").send({ email, password: "password-nueva-123" });
    expect(without.status).toBe(401);
    const withTotp = await request(app)
      .post("/auth/login")
      .send({ email, password: "password-nueva-123", totp: await totpFromUri(otpauthUrl) });
    expect(withTotp.status).toBe(200);

    // El token de reset es de un solo uso
    const reuse = await request(app).post("/auth/reset").send({ token, newPassword: "password-nueva-456" });
    expect(reuse.status).toBe(401);
    // y está almacenado hasheado, nunca en claro
    const stored = await h.db("password_resets").where({ user_id: user.id }).first();
    expect(stored.token_hash).toBe(hashToken(token));
  });
});

describe("T7.2 cabeceras de seguridad y CORS restrictivo", () => {
  it("aplica cabeceras y solo refleja el origen permitido", async () => {
    const r = await request(app).get("/teams");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    // R2.6 (ERR-SEC-16): HSTS lo emite el gateway (terminador TLS), NO la API.
    expect(r.headers["strict-transport-security"]).toBeUndefined();

    const evil = await request(app).get("/teams").set("Origin", "https://evil.example");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const good = await request(app).get("/teams").set("Origin", "http://localhost:5173");
    expect(good.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
