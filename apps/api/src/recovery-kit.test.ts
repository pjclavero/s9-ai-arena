/**
 * V1 ADM-SETUP · D-5 · Kit de recuperación del admin, contra PostgreSQL REAL.
 *
 * El kit permite a un admin ÚNICO sin sesión que perdió su contraseña recuperar el acceso desde la
 * web. Cada caso se pone rojo sin el arreglo; su mutante (`scripts/v1-web-setup-mutants.mjs`) lleva el
 * nombre del caso entre [].
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";
import { hashPassword } from "./auth/passwords.js";
import {
  issueRecoveryKit,
  normalizeRecoveryKit,
  generateRecoveryKit,
  revokeRecoveryKit,
} from "./services/recovery-kit.js";
import { SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { FailedLoginGuard } from "./middleware/rate-limit.js";

const PW = "contrasena-original-larga-01";
const NEW_PW = "contrasena-nueva-y-larga-02";
const allow = { hit: () => true };

let h: TestDbHandle;
let app: Express;
let seq = 0;

async function newAccount(admin: boolean): Promise<{ id: string; email: string; kit: string }> {
  const email = `kit-${++seq}-${Date.now()}@ejemplo.test`;
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: await hashPassword(PW), display_name: `K${seq}` })
    .returning("id");
  const roles = admin ? ["user", "developer", "admin"] : ["user", "developer"];
  await h.db("user_roles").insert(roles.map((role) => ({ user_id: u.id, role })));
  const kit = await issueRecoveryKit(h.db, u.id);
  return { id: u.id, email, kit };
}

async function login(email: string, password: string, totp?: string) {
  return request(app)
    .post("/auth/login")
    .send({ email, password, ...(totp ? { totp } : {}) });
}

function redeem(b: Record<string, unknown>, target: Express = app) {
  return request(target).post("/auth/recovery-kit/redeem").send(b);
}

const strip = (b: Record<string, unknown>) => {
  const { correlationId: _c, ...rest } = b;
  return rest;
};

beforeAll(async () => {
  h = await startTestDb();
  app = createApp({
    db: h.db,
    setup: { tokenSource: () => null },
    recoveryKit: { redeemIpLimiter: allow, redeemGlobalLimiter: allow, regenerateGuard: new FailedLoginGuard(50) },
  });
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("V1 ADM-SETUP · kit de recuperación del admin", () => {
  it("formato: 160 bits en base32 con prefijo; la normalización tolera espacios, guiones y minúsculas", () => {
    const k = generateRecoveryKit();
    expect(k).toMatch(/^S9RK(-[A-Z2-9]{4}){8}$/);
    expect(normalizeRecoveryKit(k)).toBe(normalizeRecoveryKit(` ${k.toLowerCase().replace(/-/g, " ")} `));
    expect(normalizeRecoveryKit("S9RK-XXXX")).toBeNull();
    expect(new Set(Array.from({ length: 50 }, generateRecoveryKit)).size).toBe(50);
  });

  it("[K1-canje-correcto] email+kit ⇒ 204: contraseña nueva, sesiones revocadas, kit consumido y auditoría sin secretos", async () => {
    const a = await newAccount(true);
    const before = await login(a.email, PW);
    expect(before.status).toBe(200);
    const r = await redeem({ email: a.email.toUpperCase(), recoveryKit: a.kit, newPassword: NEW_PW });
    expect(r.status).toBe(204);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await login(a.email, PW)).status).toBe(401);
    expect((await login(a.email, NEW_PW)).status).toBe(200);
    const live = await h.db("sessions").where({ user_id: a.id }).whereNull("revoked_at");
    expect(live).toHaveLength(1); // sólo la del login posterior
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toEqual([]);
    const rows = await h.db("audit_log").where({ action: "auth.recovery_kit.redeemed", target: `user:${a.id}` });
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(NEW_PW);
    expect(dump).not.toContain(normalizeRecoveryKit(a.kit)!);
  });

  it("[K2-un-solo-uso] el mismo kit no vale dos veces", async () => {
    const a = await newAccount(true);
    expect((await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW })).status).toBe(204);
    const again = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: "otra-clave-larga-03" });
    expect(again.status).toBe(401);
    expect((await login(a.email, NEW_PW)).status).toBe(200);
  });

  it("[K3-sin-oraculo] email inexistente, kit erróneo y kit de una cuenta no admin responden IGUAL (401)", async () => {
    const a = await newAccount(true);
    const user = await newAccount(false);
    const wrong = await redeem({ email: a.email, recoveryKit: generateRecoveryKit(), newPassword: NEW_PW });
    const ghost = await redeem({ email: "nadie@ejemplo.test", recoveryKit: a.kit, newPassword: NEW_PW });
    const notAdmin = await redeem({ email: user.email, recoveryKit: user.kit, newPassword: NEW_PW });
    for (const r of [wrong, ghost, notAdmin]) expect(r.status).toBe(401);
    expect(strip(ghost.body)).toEqual(strip(wrong.body));
    expect(strip(notAdmin.body)).toEqual(strip(wrong.body));
    // Nada cambió: ni contraseñas ni kits.
    expect((await login(a.email, PW)).status).toBe(200);
    expect((await login(user.email, PW)).status).toBe(200);
    expect(await h.db("admin_recovery_kits").whereIn("user_id", [a.id, user.id])).toHaveLength(2);
    const rejected = await h.db("audit_log").where({ action: "auth.recovery_kit.rejected" });
    expect(JSON.stringify(rejected)).not.toContain(normalizeRecoveryKit(a.kit)!);
  });

  it("[K4-2fa-segundo-factor] con 2FA exige TOTP o código de recuperación; sin él no consume el kit; la 2FA sigue activa", async () => {
    const a = await newAccount(true);
    const s = await login(a.email, PW);
    const en = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${s.body.accessToken}`).send({});
    expect(en.status).toBe(200);
    const code: string = en.body.recoveryCodes[0];

    const r1 = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW });
    expect(r1.status).toBe(401);
    expect(r1.body.error).toBe("totp_required");
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toHaveLength(1);
    const r2 = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW, totp: "000000" });
    expect(r2.status).toBe(401);
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toHaveLength(1);

    const ok = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW, totp: code });
    expect(ok.status).toBe(204);
    const u = await h.db("users").where({ id: a.id }).first();
    expect(u.totp_secret).not.toBeNull(); // el kit NO resetea la 2FA
    expect((await login(a.email, NEW_PW)).status).toBe(401); // sigue pidiendo TOTP
  });

  it("[K5-regenerar-reauth] regenerar exige reautenticación; el kit nuevo sustituye al viejo", async () => {
    const a = await newAccount(true);
    const s = await login(a.email, PW);
    const auth = { Authorization: `Bearer ${s.body.accessToken}` };
    const st = await request(app).get("/auth/recovery-kit").set(auth);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ active: true });
    expect(JSON.stringify(st.body)).not.toMatch(/S9RK/);

    expect((await request(app).post("/auth/recovery-kit").set(auth).send({})).status).toBe(401);
    expect((await request(app).post("/auth/recovery-kit").set(auth).send({ password: "mala" })).status).toBe(401);
    const g = await request(app).post("/auth/recovery-kit").set(auth).send({ password: PW });
    expect(g.status).toBe(200);
    expect(g.headers["cache-control"]).toBe("no-store");
    expect(g.body.recoveryKit).toMatch(/^S9RK-/);
    expect(g.body.recoveryKit).not.toBe(a.kit);
    const audits = await h.db("audit_log").where({ action: "auth.recovery_kit.generated", target: `user:${a.id}` });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(normalizeRecoveryKit(g.body.recoveryKit)!);

    expect((await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW })).status).toBe(401);
    expect((await redeem({ email: a.email, recoveryKit: g.body.recoveryKit, newPassword: NEW_PW })).status).toBe(204);
  });

  it("[K6-solo-admins] el kit sólo vale para cuentas admin: quitar el rol lo deja sin efecto; un no admin no lo regenera (403)", async () => {
    const a = await newAccount(true);
    await h.db("user_roles").where({ user_id: a.id, role: "admin" }).del();
    expect((await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW })).status).toBe(401);
    expect((await login(a.email, PW)).status).toBe(200);
    const s = await login(a.email, PW);
    const r = await request(app)
      .post("/auth/recovery-kit")
      .set("Authorization", `Bearer ${s.body.accessToken}`)
      .send({ password: PW });
    expect(r.status).toBe(403);
  });

  it("[K7-limite] el canje tiene límite de intentos (429)", async () => {
    const limited = createApp({
      db: h.db,
      setup: { tokenSource: () => null },
      recoveryKit: { redeemIpLimiter: new SlidingWindowLimiter(2, 60_000), redeemGlobalLimiter: allow },
    });
    const a = await newAccount(true);
    const bad = { email: a.email, recoveryKit: generateRecoveryKit(), newPassword: NEW_PW };
    expect((await redeem(bad, limited)).status).toBe(401);
    expect((await redeem(bad, limited)).status).toBe(401);
    expect((await redeem({ ...bad, recoveryKit: a.kit }, limited)).status).toBe(429);
    expect((await login(a.email, PW)).status).toBe(200);
  });

  it("[K8-canje-simultaneo] dos canjes simultáneos del mismo kit ⇒ exactamente uno gana", async () => {
    const a = await newAccount(true);
    const [x, y] = await Promise.all([
      redeem({ email: a.email, recoveryKit: a.kit, newPassword: "ganadora-numero-uno-1" }),
      redeem({ email: a.email, recoveryKit: a.kit, newPassword: "ganadora-numero-dos-2" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([204, 401]);
    const okOne = (await login(a.email, "ganadora-numero-uno-1")).status === 200;
    const okTwo = (await login(a.email, "ganadora-numero-dos-2")).status === 200;
    expect(okOne !== okTwo).toBe(true);
  });

  it("[K9-politica] la contraseña nueva pasa por la política única (corta ⇒ 400) sin tocar el kit", async () => {
    const a = await newAccount(true);
    const r = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: "corta" });
    expect(r.status).toBe(400);
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toHaveLength(1);
  });

  it("[K10-cuenta-bloqueada] una cuenta bloqueada no canjea el kit: la misma 401 genérica y nada cambia", async () => {
    // `users.status` llega con #347 (migración 025). Se simula su columna; con #347 integrado ya existe.
    await h.db.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`);
    const a = await newAccount(true);
    const wrong = await redeem({ email: a.email, recoveryKit: generateRecoveryKit(), newPassword: NEW_PW });
    await h.db("users").where({ id: a.id }).update({ status: "blocked" });
    const r = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW });
    expect(r.status).toBe(401);
    expect(strip(r.body)).toEqual(strip(wrong.body));
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toHaveLength(1);
    await h.db("users").where({ id: a.id }).update({ status: "active" });
    expect((await login(a.email, PW)).status).toBe(200); // la contraseña no cambió
    // Desbloqueada, el kit vuelve a valer (lo invalida `revokeRecoveryKit` al bloquear, con #347).
    expect((await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW })).status).toBe(204);
  });

  it("[K11-revocar-kit] revokeRecoveryKit invalida el kit (auditado) y después el canje da 401", async () => {
    const a = await newAccount(true);
    expect(await revokeRecoveryKit(h.db, a.id, { actorId: null, reason: "account_blocked" })).toBe(true);
    expect(await revokeRecoveryKit(h.db, a.id, { actorId: null, reason: "account_blocked" })).toBe(false);
    const rows = await h.db("audit_log").where({ action: "auth.recovery_kit.revoked", target: `user:${a.id}` });
    expect(rows).toHaveLength(1);
    expect((await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW })).status).toBe(401);
    expect((await login(a.email, PW)).status).toBe(200);
  });

  it("[K12-bloqueo-segundo-factor] 5 códigos erróneos con el kit bloquean el canje de ESA cuenta (429) aunque el código sea bueno", async () => {
    const a = await newAccount(true);
    const s = await login(a.email, PW);
    const en = await request(app).post("/auth/2fa").set("Authorization", `Bearer ${s.body.accessToken}`).send({});
    const code: string = en.body.recoveryCodes[0];
    for (let i = 0; i < 5; i++) {
      const r = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW, totp: "000000" });
      expect(r.status).toBe(401);
    }
    const blocked = await redeem({ email: a.email, recoveryKit: a.kit, newPassword: NEW_PW, totp: code });
    expect(blocked.status).toBe(429);
    expect(await h.db("admin_recovery_kits").where({ user_id: a.id })).toHaveLength(1);
    // Otra cuenta no queda afectada.
    const b = await newAccount(true);
    expect((await redeem({ email: b.email, recoveryKit: b.kit, newPassword: NEW_PW })).status).toBe(204);
  });
});
