/**
 * R2.4 (ERR-SEC-07/08/11) · Endurecimiento de auth:
 *  - desactivar 2FA exige reautenticación FUERTE (contraseña + TOTP/recovery) y
 *    revoca el resto de sesiones;
 *  - reutilización de refresh tokens por FAMILIAS: presentar un token ya rotado
 *    revoca la familia entera y deja registro de auditoría; vida máxima absoluta
 *    y rate-limit del endpoint;
 *  - anti-enumeración en login: Argon2id se ejecuta SIEMPRE (hash señuelo cuando
 *    el email no existe) → el timing no delata si la cuenta existe.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as otplib from "otplib";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    // Guard holgado: estos tests hacen muchos logins fallidos a propósito.
    loginGuard: new FailedLoginGuard(1000, 60_000),
    // Límite bajo e inyectado para poder probar el 429 del refresh sin 60 peticiones.
    refreshLimiter: new SlidingWindowLimiter(10, 60_000),
  });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function totpFromUri(otpauthUrl: string): Promise<string> {
  const secret = new URL(otpauthUrl).searchParams.get("secret")!;
  const r = (await otplib.generate({ secret })) as unknown;
  return typeof r === "string" ? r : String((r as { otp: string }).otp);
}

async function registerAndLogin(email: string, password: string) {
  await request(app).post("/auth/register").send({ email, password, displayName: "R24" });
  const login = await request(app).post("/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  return login.body as { accessToken: string; refreshToken: string };
}

describe("R2.4 · ERR-SEC-07: desactivar 2FA exige reautenticación fuerte", () => {
  const email = "r24-2fa@test.local";
  const password = "password-r24-2fa-larga";
  let otpauthUrl: string;
  let access: string;

  beforeAll(async () => {
    const s = await registerAndLogin(email, password);
    const enable = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${s.accessToken}`);
    expect(enable.status).toBe(200);
    otpauthUrl = enable.body.otpauthUrl;
    // Tras activar 2FA el login exige TOTP:
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password, totp: await totpFromUri(otpauthUrl) });
    expect(login.status).toBe(200);
    access = login.body.accessToken;
  });

  it("DoD: sin reautenticación (sin cuerpo) ⇒ 401; el 2FA sigue activo", async () => {
    const r = await request(app).delete("/auth/2fa").set("Authorization", `Bearer ${access}`).send({});
    expect(r.status).toBe(401);
    const user = await h.db("users").where({ email }).first();
    expect(user.totp_secret).toBeTruthy();
  });

  it("con contraseña incorrecta ⇒ 401; con contraseña correcta pero TOTP inválido ⇒ 401", async () => {
    const badPass = await request(app)
      .delete("/auth/2fa")
      .set("Authorization", `Bearer ${access}`)
      .send({ password: "incorrecta-del-todo", totp: await totpFromUri(otpauthUrl) });
    expect(badPass.status).toBe(401);

    const badTotp = await request(app)
      .delete("/auth/2fa")
      .set("Authorization", `Bearer ${access}`)
      .send({ password, totp: "000000" });
    expect(badTotp.status).toBe(401);

    const user = await h.db("users").where({ email }).first();
    expect(user.totp_secret).toBeTruthy();
  });

  it("con contraseña + TOTP válidos ⇒ 204, revoca el RESTO de sesiones y audita", async () => {
    // Segunda sesión del mismo usuario, que deberá caer al desactivar el 2FA:
    const other = await request(app)
      .post("/auth/login")
      .send({ email, password, totp: await totpFromUri(otpauthUrl) });
    expect(other.status).toBe(200);

    const ok = await request(app)
      .delete("/auth/2fa")
      .set("Authorization", `Bearer ${access}`)
      .send({ password, totp: await totpFromUri(otpauthUrl) });
    expect(ok.status).toBe(204);

    const user = await h.db("users").where({ email }).first();
    expect(user.totp_secret).toBeNull();
    expect(user.recovery_codes).toBeNull();

    // La OTRA sesión quedó revocada; la que reautenticó sigue viva.
    const otherMe = await request(app).get("/users/me").set("Authorization", `Bearer ${other.body.accessToken}`);
    expect(otherMe.status).toBe(401);
    const me = await request(app).get("/users/me").set("Authorization", `Bearer ${access}`);
    expect(me.status).toBe(200);

    const entry = await h.db("audit_log").where({ action: "auth.2fa.disabled", target: `user:${user.id}` }).first();
    expect(entry).toBeTruthy();
    expect(entry.detail.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
  });

  it("activar 2FA también revoca el resto de sesiones (cambio de estado = invalidar lo previo)", async () => {
    const email2 = "r24-2fa-enable@test.local";
    const password2 = "password-r24-enable-xx";
    const s1 = await registerAndLogin(email2, password2);
    const s2 = await registerAndLogin(email2, password2);

    const enable = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${s2.accessToken}`);
    expect(enable.status).toBe(200);

    const s1Me = await request(app).get("/users/me").set("Authorization", `Bearer ${s1.accessToken}`);
    expect(s1Me.status).toBe(401);
    const s2Me = await request(app).get("/users/me").set("Authorization", `Bearer ${s2.accessToken}`);
    expect(s2Me.status).toBe(200);
  });

  it("desactivar 2FA cuando no está activo ⇒ 409 (no hay estado que cambiar)", async () => {
    const s = await registerAndLogin("r24-no2fa@test.local", "password-r24-no2fa-xx");
    const r = await request(app)
      .delete("/auth/2fa")
      .set("Authorization", `Bearer ${s.accessToken}`)
      .send({ password: "password-r24-no2fa-xx", totp: "000000" });
    expect(r.status).toBe(409);
  });
});

describe("R2.4 · ERR-SEC-08: familias de refresh tokens", () => {
  it("DoD: presentar un refresh YA ROTADO revoca la familia entera y audita", async () => {
    const email = "r24-family@test.local";
    const s = await registerAndLogin(email, "password-r24-familia-x");

    const r1 = await request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post("/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);

    // El atacante presenta el PRIMER token (ya rotado dos generaciones atrás):
    const replay = await request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);

    // La familia ENTERA cae: el token vigente (r2) tampoco vale ya…
    const afterReuse = await request(app).post("/auth/refresh").send({ refreshToken: r2.body.refreshToken });
    expect(afterReuse.status).toBe(401);
    // …ni el access token de la sesión:
    const me = await request(app).get("/users/me").set("Authorization", `Bearer ${r2.body.accessToken}`);
    expect(me.status).toBe(401);

    // Y queda el registro de auditoría de la detección:
    const user = await h.db("users").where({ email }).first();
    const session = await h.db("sessions").where({ user_id: user.id }).first();
    expect(session.revoked_at).toBeTruthy();
    const entry = await h.db("audit_log").where({ action: "auth.refresh.reuse_detected", target: `session:${session.id}` }).first();
    expect(entry).toBeTruthy();
    expect(entry.detail.reason).toBe("rotated_token_replayed");
  });

  it("vida máxima ABSOLUTA: superado el tope, el refresh se rechaza aunque la ventana deslizante siga viva", async () => {
    const email = "r24-absolute@test.local";
    const s = await registerAndLogin(email, "password-r24-absoluta-x");
    const user = await h.db("users").where({ email }).first();

    // Sesión con ventana deslizante vigente pero tope absoluto ya vencido:
    await h.db("sessions").where({ user_id: user.id }).update({ absolute_expires_at: new Date(Date.now() - 1000) });
    const r = await request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(r.status).toBe(401);
  });

  it("la rotación nunca extiende expires_at más allá del tope absoluto", async () => {
    const email = "r24-cap@test.local";
    const s = await registerAndLogin(email, "password-r24-cap-xxxx");
    const user = await h.db("users").where({ email }).first();

    const cap = new Date(Date.now() + 60_000); // tope absoluto a 1 minuto
    await h.db("sessions").where({ user_id: user.id }).update({ absolute_expires_at: cap });
    const r = await request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(r.status).toBe(200);

    const session = await h.db("sessions").where({ user_id: user.id }).first();
    expect(new Date(session.expires_at).getTime()).toBeLessThanOrEqual(cap.getTime());
  });

  it("el endpoint de refresh tiene rate-limit propio ⇒ 429 al superarlo", async () => {
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post("/auth/refresh").send({ refreshToken: "token-invalido-" + i });
      if (r.status === 429) {
        got429 = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(got429).toBe(true);
  });
});

describe("R2.4 · ERR-SEC-11: anti-enumeración de emails en login", () => {
  it("DoD: el coste es el mismo exista o no el email (Argon2id contra hash señuelo)", async () => {
    const existing = "r24-timing@test.local";
    await request(app).post("/auth/register").send({ email: existing, password: "password-timing-real-x", displayName: "T" });

    // Calentamiento (JIT, pool de BD) fuera de la medición:
    await request(app).post("/auth/login").send({ email: existing, password: "incorrecta" });
    await request(app).post("/auth/login").send({ email: "nadie-warm@test.local", password: "incorrecta" });

    async function median(email: string, n = 7): Promise<number> {
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await request(app).post("/auth/login").send({ email, password: "una-password-erronea" });
        times.push(performance.now() - t0);
        expect(r.status).toBe(401);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(n / 2)];
    }

    const withUser = await median(existing);
    const withoutUser = await median("no-existe-jamas@test.local");

    // Argon2id domina el tiempo de ambas rutas (decenas de ms); sin el señuelo, la
    // ruta "email inexistente" costaría ~1 ms. Margen AMPLIO a propósito para que
    // el test no sea flaky: la mediana de la ruta inexistente debe estar al menos
    // en el mismo orden de magnitud (≥ 40%) que la de la existente.
    expect(withoutUser).toBeGreaterThan(withUser * 0.4);
  });

  it("ambas respuestas 401 son idénticas en cuerpo (mismo error y mensaje)", async () => {
    const a = await request(app).post("/auth/login").send({ email: "r24-timing@test.local", password: "mala" });
    const b = await request(app).post("/auth/login").send({ email: "no-existe-jamas-2@test.local", password: "mala" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
    expect(a.body.message).toBe(b.body.message);
  });
});
