/**
 * ACC-2FA · Verificación en dos pasos gestionable desde la web (contrato 0.28.0).
 *
 *  - alta en dos fases: setup NO activa; confirm activa sólo con un código válido para ESE secreto;
 *  - el token de alta va sellado y atado al usuario y a la sesión;
 *  - límite de intentos en la confirmación y en la reautenticación de 2FA (429, persistente);
 *  - regenerar códigos de recuperación: reautenticación fuerte, invalida los anteriores, auditado sin códigos;
 *  - ningún código vale dos veces: TOTP por paso, recuperación en una sola sentencia (también en paralelo);
 *  - el secreto y los códigos nunca se cachean (Cache-Control: no-store);
 *  - el login acepta un código de recuperación (con espacios, guiones o mayúsculas).
 *
 * Cada test lleva una ETIQUETA en mayúsculas: scripts/acc-2fa-mutants.mjs la usa para comprobar que el
 * mutante correspondiente lo pone en rojo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { freshTotp } from "./testing/totp-codes.js";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FailedLoginGuard } from "./middleware/rate-limit.js";
import { openTotpEnrollment, sealTotpEnrollment, TOTP_ENROLLMENT_TTL_S } from "./auth/totp-enrollment.js";
import { verifySecondFactor } from "./routes/auth.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  // Guard de LOGIN holgado (aquí se inicia sesión muchas veces); el de 2FA es el de producción (5 fallos).
  app = createApp({ db: h.db, loginGuard: new FailedLoginGuard(1000, 60_000) });
}, 120000);

afterAll(async () => {
  await h.stop();
});

const PASSWORD = "password-acc-2fa-larga";

async function newUser(tag: string) {
  const email = `acc2fa-${tag}@test.local`;
  const reg = await request(app)
    .post("/auth/register")
    .send({ email, password: PASSWORD, displayName: `ACC ${tag}` });
  expect(reg.status).toBe(201);
  const login = (totp?: string) => request(app).post("/auth/login").send({ email, password: PASSWORD, totp });
  const s = await login();
  expect(s.status).toBe(200);
  return { email, userId: reg.body.id as string, access: s.body.accessToken as string, login };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setup(access: string) {
  const r = await request(app).post("/auth/2fa/setup").set(auth(access)).send({ password: PASSWORD });
  expect(r.status).toBe(200);
  return r;
}

/** Usuario con la 2FA ya activada por el flujo nuevo. */
async function enabledUser(tag: string) {
  const u = await newUser(tag);
  const s = await setup(u.access);
  const secret = s.body.secret as string;
  const c = await request(app)
    .post("/auth/2fa/confirm")
    .set(auth(u.access))
    .send({ enrollmentToken: s.body.enrollmentToken, totp: await freshTotp(secret) });
  expect(c.status).toBe(200);
  return { ...u, secret, recoveryCodes: c.body.recoveryCodes as string[] };
}

describe("ACC-2FA · alta en dos fases", () => {
  it("SETUP_NO_ACTIVA: setup devuelve QR, secreto y token, pero la cuenta sigue sin 2FA", async () => {
    const u = await newUser("setup");
    const r = await setup(u.access);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(new URL(r.body.otpauthUrl).searchParams.get("secret")).toBe(r.body.secret);
    expect(typeof r.body.enrollmentToken).toBe("string");
    expect(r.body.enrollmentToken).not.toContain(r.body.secret); // sellado, no en claro
    expect(r.body.expiresIn).toBe(TOTP_ENROLLMENT_TTL_S);
    const row = await h.db("users").where({ id: u.userId }).first();
    expect(row.totp_secret).toBeNull();
    expect((await u.login()).status).toBe(200); // el login sigue sin pedir código
    const me = await request(app).get("/users/me").set(auth(u.access));
    expect(me.body.twoFactorEnabled).toBe(false);
    expect(me.body.recoveryCodesRemaining).toBeUndefined();
  });

  it("SETUP_EXIGE_PASSWORD: sin contraseña o con una mala ⇒ 401 y sin secreto; el token robado no basta", async () => {
    const u = await newUser("setup-pw");
    const sin = await request(app).post("/auth/2fa/setup").set(auth(u.access)).send({});
    expect(sin.status).toBe(401);
    expect(sin.body.secret).toBeUndefined();
    const mala = await request(app).post("/auth/2fa/setup").set(auth(u.access)).send({ password: "no-es-la-buena-xx" });
    expect(mala.status).toBe(401);
    expect(mala.body.enrollmentToken).toBeUndefined();
    expect((await h.db("users").where({ id: u.userId }).first()).totp_secret).toBeNull();
    const ok = await request(app).post("/auth/2fa/setup").set(auth(u.access)).send({ password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("ALTA_DIRECTA_RETIRADA: POST /auth/2fa responde 410 y no activa nada", async () => {
    const u = await newUser("retirada");
    const r = await request(app).post("/auth/2fa").set(auth(u.access)).send({});
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("enable2fa_removed");
    expect(r.body.otpauthUrl).toBeUndefined();
    expect(r.body.recoveryCodes).toBeUndefined();
    const row = await h.db("users").where({ id: u.userId }).first();
    expect(row.totp_secret).toBeNull();
    expect(row.recovery_codes).toBeNull();
    expect((await u.login()).status).toBe(200);
  });

  it("CONFIRMA_CON_CODIGO: un código incorrecto no activa; el correcto activa, da 8 códigos y revoca otras sesiones", async () => {
    const u = await newUser("confirm");
    const other = await u.login();
    const s = await setup(u.access);
    const bad = await request(app)
      .post("/auth/2fa/confirm")
      .set(auth(u.access))
      .send({ enrollmentToken: s.body.enrollmentToken, totp: "000000" });
    expect(bad.status).toBe(401);
    expect((await h.db("users").where({ id: u.userId }).first()).totp_secret).toBeNull();

    const ok = await request(app)
      .post("/auth/2fa/confirm")
      .set(auth(u.access))
      .send({ enrollmentToken: s.body.enrollmentToken, totp: await freshTotp(s.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body.recoveryCodes).toHaveLength(8);
    const row = await h.db("users").where({ id: u.userId }).first();
    expect(row.totp_secret).toBe(s.body.secret);
    expect(row.recovery_codes).toHaveLength(8);
    expect(JSON.stringify(row.recovery_codes)).not.toContain(ok.body.recoveryCodes[0]); // hasheados
    // la otra sesión cae; la que confirmó sigue
    expect((await request(app).get("/users/me").set(auth(other.body.accessToken))).status).toBe(401);
    expect((await request(app).get("/users/me").set(auth(u.access))).status).toBe(200);
    // el login ya exige el segundo factor
    expect((await u.login()).status).toBe(401);
    expect((await u.login(await freshTotp(s.body.secret))).status).toBe(200);

    const entry = await h
      .db("audit_log")
      .where({ action: "auth.2fa.enabled", target: `user:${u.userId}` })
      .first();
    expect(entry.detail.method).toBe("confirmed");
    const detail = JSON.stringify(entry.detail);
    for (const c of ok.body.recoveryCodes as string[]) expect(detail).not.toContain(c);
    expect(detail).not.toContain(s.body.secret);
  });

  it("TOKEN_ATADO: token manipulado, de otro usuario o de otra sesión ⇒ 400 y sin activar", async () => {
    const a = await newUser("token-a");
    const b = await newUser("token-b");
    const sa = await setup(a.access);
    const code = await freshTotp(sa.body.secret);

    const ajeno = await request(app)
      .post("/auth/2fa/confirm")
      .set(auth(b.access))
      .send({ enrollmentToken: sa.body.enrollmentToken, totp: code });
    expect(ajeno.status).toBe(400);

    const otraSesion = await a.login();
    const deOtraSesion = await request(app)
      .post("/auth/2fa/confirm")
      .set(auth(otraSesion.body.accessToken))
      .send({ enrollmentToken: sa.body.enrollmentToken, totp: code });
    expect(deOtraSesion.status).toBe(400);

    const t = String(sa.body.enrollmentToken);
    const parts = t.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    const manipulado = await request(app)
      .post("/auth/2fa/confirm")
      .set(auth(a.access))
      .send({ enrollmentToken: parts.join("."), totp: code });
    expect(manipulado.status).toBe(400);

    for (const id of [a.userId, b.userId]) {
      expect((await h.db("users").where({ id }).first()).totp_secret).toBeNull();
    }
  });

  it("TOKEN_CADUCA: el token de alta deja de abrirse pasados 10 minutos", () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    const ctx = { userId: "u1", sessionId: "s1" };
    const t = sealTotpEnrollment({ ...ctx, secret: "JBSWY3DPEHPK3PXP" }, now);
    expect(openTotpEnrollment(t, ctx, now + (TOTP_ENROLLMENT_TTL_S - 1) * 1000)).toBe("JBSWY3DPEHPK3PXP");
    expect(openTotpEnrollment(t, ctx, now + TOTP_ENROLLMENT_TTL_S * 1000)).toBeNull();
    expect(openTotpEnrollment(t, { ...ctx, sessionId: "s2" }, now)).toBeNull();
    expect(openTotpEnrollment(t, { ...ctx, userId: "u2" }, now)).toBeNull();
    expect(openTotpEnrollment(123, ctx, now)).toBeNull();
  });

  it("CONFIRMA_LIMITE: 5 códigos fallidos ⇒ 429, también con el código bueno, y queda auditado", async () => {
    const u = await newUser("limite");
    const s = await setup(u.access);
    const send = (totp: string) =>
      request(app)
        .post("/auth/2fa/confirm")
        .set(auth(u.access))
        .send({ enrollmentToken: s.body.enrollmentToken, totp });
    for (let i = 0; i < 5; i++) expect((await send("000000")).status).toBe(401);
    expect((await send(await freshTotp(s.body.secret))).status).toBe(429);
    expect((await h.db("users").where({ id: u.userId }).first()).totp_secret).toBeNull();
    const blocked = await h
      .db("audit_log")
      .where({ action: "auth.2fa.blocked", target: `user:${u.userId}` })
      .first();
    expect(blocked.detail.op).toBe("confirm");
  });

  it("CONFIRMA_UNA_VEZ: dos confirmaciones simultáneas con códigos válidos ⇒ una activa y la otra 409", async () => {
    const u = await newUser("doble");
    const s = await setup(u.access);
    const send = async () =>
      request(app)
        .post("/auth/2fa/confirm")
        .set(auth(u.access))
        .send({ enrollmentToken: s.body.enrollmentToken, totp: await freshTotp(s.body.secret) });
    const [r1, r2] = await Promise.all([send(), send()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const enabled = await h.db("audit_log").where({ action: "auth.2fa.enabled", target: `user:${u.userId}` });
    expect(enabled).toHaveLength(1);
    // y después de activar, el mismo token ya no sirve para nada
    const again = await send();
    expect(again.status).toBe(409);
  });

  it("SETUP_CON_2FA_ACTIVA: setup con la 2FA ya activa ⇒ 409", async () => {
    const u = await enabledUser("setup-409");
    const r = await request(app).post("/auth/2fa/setup").set(auth(u.access)).send({ password: PASSWORD });
    expect(r.status).toBe(409);
  });
});

describe("ACC-2FA · ningún código vale dos veces", () => {
  it("TOTP_UN_USO: el mismo código TOTP no inicia sesión dos veces", async () => {
    const u = await enabledUser("replay");
    const code = await freshTotp(u.secret);
    expect((await u.login(code)).status).toBe(200);
    expect((await u.login(code)).status).toBe(401);
  });

  it("RECUPERACION_PARALELO: el mismo código de recuperación en dos logins simultáneos ⇒ sólo uno entra", async () => {
    const u = await enabledUser("paralelo");
    const code = u.recoveryCodes[0];
    const rs = await Promise.all([u.login(code), u.login(code), u.login(code)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    const row = await h.db("users").where({ id: u.userId }).first();
    expect(row.recovery_codes).toHaveLength(7);
  });

  it("RECUPERACION_RANCIO: dos peticiones que cargaron la misma fila de usuario no gastan dos veces un código", async () => {
    // Es lo que pasa con dos logins simultáneos: cada uno leyó `users` ANTES de que el otro consumiera el
    // código. Con leer-filtrar-escribir sobre esa copia, ambos lo aceptaban. Determinista: la misma copia rancia.
    const u = await enabledUser("rancio");
    const stale = await h.db("users").where({ id: u.userId }).first();
    const code = u.recoveryCodes[5];
    expect(await verifySecondFactor(h.db, stale, code)).toBe("recovery");
    expect(await verifySecondFactor(h.db, stale, code)).toBeNull();
    expect((await h.db("users").where({ id: u.userId }).first()).recovery_codes).toHaveLength(7);
  });

  it("RECUPERACION_FORMATO: el login acepta el código con mayúsculas, espacios y guion; luego ya no", async () => {
    const u = await enabledUser("formato");
    const code = u.recoveryCodes[1];
    const tecleado = ` ${code.slice(0, 6).toUpperCase()}-${code.slice(6)} `;
    expect((await u.login(tecleado)).status).toBe(200);
    expect((await u.login(code)).status).toBe(401);
  });
});

describe("ACC-2FA · regenerar los códigos de recuperación", () => {
  it("REGENERA_REAUTH: sin contraseña o sin código ⇒ 401 y los códigos no cambian", async () => {
    const u = await enabledUser("regen-reauth");
    const before = (await h.db("users").where({ id: u.userId }).first()).recovery_codes;
    const r1 = await request(app).post("/auth/2fa/recovery-codes").set(auth(u.access)).send({});
    expect(r1.status).toBe(401);
    const r2 = await request(app)
      .post("/auth/2fa/recovery-codes")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: "000000" });
    expect(r2.status).toBe(401);
    const r3 = await request(app)
      .post("/auth/2fa/recovery-codes")
      .set(auth(u.access))
      .send({ password: "no-es-la-password", totp: await freshTotp(u.secret) });
    expect(r3.status).toBe(401);
    expect((await h.db("users").where({ id: u.userId }).first()).recovery_codes).toEqual(before);
  });

  it("REGENERA_INVALIDA: los nuevos sirven una vez, los anteriores ya no, auditado sin códigos y sin caché", async () => {
    const u = await enabledUser("regen");
    const r = await request(app)
      .post("/auth/2fa/recovery-codes")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: await freshTotp(u.secret) });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const fresh = r.body.recoveryCodes as string[];
    expect(fresh).toHaveLength(8);
    for (const c of fresh) expect(u.recoveryCodes).not.toContain(c);

    expect((await u.login(u.recoveryCodes[2])).status).toBe(401); // anterior: inválido
    expect((await u.login(fresh[0])).status).toBe(200); // nuevo: vale
    expect((await u.login(fresh[0])).status).toBe(401); // y sólo una vez

    const entry = await h
      .db("audit_log")
      .where({ action: "auth.2fa.recovery_codes_regenerated", target: `user:${u.userId}` })
      .first();
    expect(entry.detail).toEqual({ count: 8 });
    const detail = JSON.stringify(entry.detail);
    for (const c of [...fresh, ...u.recoveryCodes]) expect(detail).not.toContain(c);
  });

  it("REGENERA_CON_RECUPERACION: se puede regenerar usando un código de recuperación (móvil perdido)", async () => {
    const u = await enabledUser("regen-rec");
    const r = await request(app)
      .post("/auth/2fa/recovery-codes")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: u.recoveryCodes[0] });
    expect(r.status).toBe(200);
    expect((await u.login(r.body.recoveryCodes[0])).status).toBe(200);
  });

  it("REGENERA_SIN_2FA: sin 2FA activa ⇒ 409", async () => {
    const u = await newUser("regen-409");
    const r = await request(app)
      .post("/auth/2fa/recovery-codes")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: "000000" });
    expect(r.status).toBe(409);
  });

  it("REAUTH_LIMITE: 5 reautenticaciones fallidas (regenerar o desactivar) ⇒ 429 aunque luego acierte", async () => {
    const u = await enabledUser("reauth-limite");
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post("/auth/2fa/recovery-codes")
        .set(auth(u.access))
        .send({ password: PASSWORD, totp: "000000" });
      expect(r.status).toBe(401);
    }
    for (let i = 0; i < 2; i++) {
      const r = await request(app).delete("/auth/2fa").set(auth(u.access)).send({ password: "mala", totp: "000000" });
      expect(r.status).toBe(401);
    }
    const r = await request(app)
      .delete("/auth/2fa")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: await freshTotp(u.secret) });
    expect(r.status).toBe(429);
    expect((await h.db("users").where({ id: u.userId }).first()).totp_secret).toBe(u.secret);
  });
});

describe("ACC-2FA · estado en getMe", () => {
  it("RECUENTO_ME: getMe dice cuántos códigos quedan (no cuáles) y no se cachea", async () => {
    const u = await enabledUser("recuento");
    const me1 = await request(app).get("/users/me").set(auth(u.access));
    expect(me1.headers["cache-control"]).toBe("private, no-store");
    expect(me1.body.twoFactorEnabled).toBe(true);
    expect(me1.body.recoveryCodesRemaining).toBe(8);
    const s = await u.login(u.recoveryCodes[3]);
    expect(s.status).toBe(200);
    const me2 = await request(app).get("/users/me").set(auth(u.access));
    expect(me2.body.recoveryCodesRemaining).toBe(7);
    expect(JSON.stringify(me2.body)).not.toContain(u.recoveryCodes[4]);
  });

  it("DESACTIVA_Y_VUELVE: desactivar con contraseña + código de recuperación deja la cuenta sin 2FA", async () => {
    const u = await enabledUser("desactiva");
    const r = await request(app)
      .delete("/auth/2fa")
      .set(auth(u.access))
      .send({ password: PASSWORD, totp: u.recoveryCodes[0] });
    expect(r.status).toBe(204);
    const me = await request(app).get("/users/me").set(auth(u.access));
    expect(me.body.twoFactorEnabled).toBe(false);
    expect((await u.login()).status).toBe(200);
  });
});
