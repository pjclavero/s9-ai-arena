/**
 * V1 ADM-3 · MODELO DE UN ADMINISTRADOR (contrato del operador) contra PostgreSQL REAL.
 *
 * UN solo administrador gestiona TODA la plataforma desde la web; puede haber 1 o N admins con permisos idénticos y
 * ninguna operación exige un segundo admin (ni linajes, ni jerarquías, ni aprobaciones cruzadas). Cada operación
 * sensible exige reautenticación (contraseña + TOTP si lo tiene) y queda en `audit_log`; nunca puede quedar 0 admins
 * activos. Cada caso lleva su mutante en `scripts/adm3-mutants.py`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import * as otplib from "otplib";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { hashPassword, passwordPolicyViolation } from "./auth/passwords.js";
import { generateTotpSecret } from "./auth/totp.js";
import { mapDeadlock, userActionPhrase, type UserActionKind } from "./services/account-recovery.js";

let h: TestDbHandle;
let app: Express;
const PW = "password-larga-adm3-1";
const NEWPW = "contrasena-nueva-adm3-2";

beforeAll(async () => {
  h = await startTestDb();
  app = createApp({
    db: h.db,
    loginGuard: new FailedLoginGuard(1000, 60_000),
    loginLimiter: new SlidingWindowLimiter(1000, 60_000),
    registerLimiter: new SlidingWindowLimiter(1000, 60_000),
    refreshLimiter: new SlidingWindowLimiter(1000, 60_000),
    adminConfirmLimiter: new SlidingWindowLimiter(1000, 60_000),
    resetLimiter: new SlidingWindowLimiter(1000, 60_000),
    adminUsersLimiter: new SlidingWindowLimiter(1000, 60_000),
  });
}, 120_000);
afterAll(async () => {
  await h.stop();
});

let tagN = 0;
let auditFloor = 0;
beforeEach(async () => {
  // Cada caso parte sin administradores y sin órdenes: los crea él.
  await h.db("user_roles").where({ role: "admin" }).delete();
  await h.db("admin_operations").delete();
  auditFloor = Number((await h.db("audit_log").max({ m: "id" }).first())?.m ?? 0);
});

interface TUser {
  id: string;
  email: string;
}
async function mkUser(label: string, roles: string[] = ["user", "developer"]): Promise<TUser> {
  const email = `oa-${label}-${++tagN}@test.local`.toLowerCase();
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: await hashPassword(PW), display_name: `OA ${label} ${tagN}` })
    .returning("id");
  await h.db("user_roles").insert(roles.map((role) => ({ user_id: u.id, role })));
  return { id: u.id, email };
}
const mkAdmin = (label: string) => mkUser(label, ["user", "developer", "admin"]);
async function tokenOf(u: TUser, totp?: string): Promise<string> {
  const r = await request(app).post("/auth/login").send({ email: u.email, password: PW, totp });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
/** Añade la frase de confirmación EXPLÍCITA (P3-5) salvo que el caso la ponga (o la quite) a propósito. */
async function withPhrase(id: string, kind: UserActionKind, body: Record<string, unknown>) {
  if ("confirmPhrase" in body) return body;
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  const u = isId ? await h.db("users").where({ id }).first("email") : undefined;
  return { ...body, confirmPhrase: userActionPhrase(kind, (u?.email as string | undefined) ?? "") };
}
const putRoles = async (t: string, id: string, body: Record<string, unknown>) =>
  request(app)
    .put(`/users/${id}/roles`)
    .set(auth(t))
    .send(await withPhrase(id, "roles", body));
const issue = async (t: string, id: string, body: Record<string, unknown> = { password: PW }) =>
  request(app)
    .post(`/admin/users/${id}/recovery-token`)
    .set(auth(t))
    .send(await withPhrase(id, body.resetTwoFactor === true ? "recover_2fa" : "recover", body));
const reset = (token: string, newPassword = NEWPW) => request(app).post("/auth/reset").send({ token, newPassword });
const setStatus = async (t: string, id: string, status: string, body: Record<string, unknown> = { password: PW }) =>
  request(app)
    .put(`/admin/users/${id}/status`)
    .set(auth(t))
    .send(await withPhrase(id, status === "blocked" ? "block" : "unblock", { status, ...body }));
const hasAdmin = async (id: string) => !!(await h.db("user_roles").where({ user_id: id, role: "admin" }).first());
const statusOf = async (id: string) => (await h.db("users").where({ id }).first()).status as string;
const activeAdmins = async () =>
  Number(
    (
      (await h
        .db("user_roles as r")
        .join("users as u", "u.id", "r.user_id")
        .where({ "r.role": "admin", "u.status": "active" })
        .countDistinct({ n: "r.user_id" })
        .first()) as { n: string }
    ).n,
  );
const audits = async (action: string) =>
  (await h.db("audit_log").where({ action }).where("id", ">", auditFloor).orderBy("id")) as {
    action: string;
    target: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
  }[];
const auditOf = async (action: string, target: string) =>
  (await audits(action)).filter((a) => a.target === `user:${target}`);

describe("ADM-3 · UN admin hace TODO de principio a fin", () => {
  it("UN_ADMIN_TODO: con UN único admin activo, conceder y quitar admin, bloquear y desbloquear, y recuperar la cuenta funcionan, auditados", async () => {
    const a = await mkAdmin("todo-a");
    const u = await mkUser("todo-u");
    const ta = await tokenOf(a);
    expect(await activeAdmins()).toBe(1);

    // conceder admin (reautenticado, sin aprobación de nadie)
    const g = await putRoles(ta, u.id, { roles: ["user", "developer", "admin"], password: PW });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(await hasAdmin(u.id)).toBe(true);
    // quitar admin a OTRA cuenta (hay otro admin: ya no es el último)
    const r = await putRoles(ta, u.id, { roles: ["user", "developer"], password: PW });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await hasAdmin(u.id)).toBe(false);
    // bloquear y desbloquear
    expect((await setStatus(ta, u.id, "blocked")).status).toBe(200);
    expect(await statusOf(u.id)).toBe("blocked");
    expect((await setStatus(ta, u.id, "active")).status).toBe(200);
    expect(await statusOf(u.id)).toBe("active");
    // recuperar: token → canje → entra con la contraseña nueva
    const t = await issue(ta, u.id);
    expect(t.status).toBe(201);
    expect((await reset(t.body.token)).status).toBe(204);
    const l = await request(app).post("/auth/login").send({ email: u.email, password: NEWPW });
    expect(l.status).toBe(200);

    // todo auditado con el actor
    const rolesAudit = await auditOf("admin.user.roles_set", u.id);
    expect(rolesAudit).toHaveLength(2);
    expect(rolesAudit.every((x) => x.actor_id === a.id)).toBe(true);
    expect((await auditOf("admin.user.blocked", u.id))[0]).toMatchObject({ actor_id: a.id });
    expect((await auditOf("admin.user.unblocked", u.id))[0]).toMatchObject({ actor_id: a.id });
    expect((await auditOf("admin.user.recovery_token_issued", u.id))[0]).toMatchObject({ actor_id: a.id });
    expect((await auditOf("auth.password.reset", u.id))[0]).toMatchObject({ actor_id: u.id });
    expect(await activeAdmins()).toBe(1);
  });

  it("ADMIN_GESTIONA_ADMIN: un admin gestiona a OTRO admin (conceder, quitar, bloquear, desbloquear, recuperar) sin segundo admin", async () => {
    const a = await mkAdmin("ga-a");
    const b = await mkAdmin("ga-b");
    const ta = await tokenOf(a);
    // recuperar la cuenta de otro admin: token de UN solo uso que el propio B canjea
    const t = await issue(ta, b.id);
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect((await reset(t.body.token)).status).toBe(204);
    expect((await auditOf("admin.user.recovery_token_issued", b.id))[0]).toMatchObject({ actor_id: a.id });
    // bloquearlo y desbloquearlo
    expect((await setStatus(ta, b.id, "blocked")).status).toBe(200);
    expect((await setStatus(ta, b.id, "active")).status).toBe(200);
    // quitarle el rol admin y volver a dárselo
    expect((await putRoles(ta, b.id, { roles: ["user", "developer"], password: PW })).status).toBe(200);
    expect(await hasAdmin(b.id)).toBe(false);
    expect((await putRoles(ta, b.id, { roles: ["user", "developer", "admin"], password: PW })).status).toBe(200);
    expect(await hasAdmin(b.id)).toBe(true);
    // y no se creó ninguna orden de aprobación
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it("SIN_BOOTSTRAP_NI_LINAJE: dar admin a una cuenta nueva no exige nada especial aunque existan otros admins (bloqueados o no)", async () => {
    const a = await mkAdmin("sb-a");
    const b = await mkAdmin("sb-b");
    await h.db("users").where({ id: b.id }).update({ status: "blocked", blocked_at: new Date() });
    const ta = await tokenOf(a);
    const reg = await request(app)
      .post("/auth/register")
      .send({ email: `oa-reg-${++tagN}@test.local`, password: PW, displayName: "Nueva" });
    expect(reg.status).toBe(201);
    const g = await putRoles(ta, reg.body.id, { roles: ["user", "developer", "admin"], password: PW });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    // el nuevo admin hace lo mismo que cualquier otro: puede recuperar a A
    const x = { id: reg.body.id as string, email: reg.body.email as string };
    expect((await issue(await tokenOf(x), a.id)).status).toBe(201);
  });
});

describe("ADM-3 · reautenticación obligatoria en CADA operación sensible", () => {
  it("REAUTH_CADA_OPERACION: sin contraseña o con una errónea, 401 y NADA cambia (conceder, quitar, bloquear, desbloquear, token)", async () => {
    const a = await mkAdmin("re-a");
    const b = await mkAdmin("re-b");
    const u = await mkUser("re-u");
    const ta = await tokenOf(a);
    const bad = [{}, { password: "mala-contraseña-larga" }];
    for (const body of bad) {
      expect((await putRoles(ta, u.id, { roles: ["user", "admin"], ...body })).status).toBe(401);
      expect((await putRoles(ta, b.id, { roles: ["user"], ...body })).status).toBe(401);
      expect((await setStatus(ta, u.id, "blocked", body)).status).toBe(401);
      expect((await issue(ta, u.id, body)).status).toBe(401);
    }
    await h.db("users").where({ id: u.id }).update({ status: "blocked", blocked_at: new Date() });
    for (const body of bad) expect((await setStatus(ta, u.id, "active", body)).status).toBe(401);
    expect(await hasAdmin(u.id)).toBe(false);
    expect(await hasAdmin(b.id)).toBe(true);
    expect(await statusOf(u.id)).toBe("blocked");
    expect(await h.db("password_resets").where({ user_id: u.id }).count({ n: "*" }).first()).toMatchObject({ n: "0" });
    for (const act of [
      "admin.user.roles_set",
      "admin.user.blocked",
      "admin.user.unblocked",
      "admin.user.recovery_token_issued",
    ]) {
      expect(await audits(act), act).toHaveLength(0);
    }
  });

  it("REAUTH_CON_2FA: un admin con 2FA necesita además su TOTP (contraseña sola = 401); con él, funciona", async () => {
    const a = await mkAdmin("2fa-a");
    const u = await mkUser("2fa-u");
    const secret = generateTotpSecret();
    await h.db("users").where({ id: a.id }).update({ totp_secret: secret });
    const code = async () => {
      const r = (await otplib.generate({ secret })) as unknown;
      return typeof r === "string" ? r : String((r as { otp: string }).otp);
    };
    const ta = await tokenOf(a, await code());
    expect((await setStatus(ta, u.id, "blocked", { password: PW })).status).toBe(401);
    expect((await issue(ta, u.id, { password: PW })).status).toBe(401);
    expect(await statusOf(u.id)).toBe("active");
    const ok = await setStatus(ta, u.id, "blocked", { password: PW, totp: await code() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("ROLES_SIN_ADMIN_NO_PIDEN_CONTRASENA: un cambio de roles que no toca «admin» no exige reautenticación", async () => {
    const a = await mkAdmin("rsa-a");
    const u = await mkUser("rsa-u");
    expect((await putRoles(await tokenOf(a), u.id, { roles: ["user", "organizer"] })).status).toBe(200);
  });
});

describe("ADM-3 · último admin protegido, bajo cerrojo y sin carreras", () => {
  it("ULTIMO_ADMIN: quitarse el rol o bloquearse siendo el ÚLTIMO admin activo (incluido uno mismo) da 409 last_admin y no cambia nada", async () => {
    const a = await mkAdmin("ua-a");
    const ta = await tokenOf(a);
    const selfDemote = await putRoles(ta, a.id, { roles: ["user", "developer"], password: PW });
    expect(selfDemote.status).toBe(409);
    expect(selfDemote.body.error).toBe("last_admin");
    const selfBlock = await setStatus(ta, a.id, "blocked");
    expect(selfBlock.status).toBe(409);
    expect(selfBlock.body.error).toBe("last_admin");
    expect(await hasAdmin(a.id)).toBe(true);
    expect(await statusOf(a.id)).toBe("active");
    expect(await audits("admin.user.blocked")).toHaveLength(0);
    // también cuando los demás admins están BLOQUEADOS (no cuentan como activos)
    const b = await mkAdmin("ua-b");
    await h.db("users").where({ id: b.id }).update({ status: "blocked", blocked_at: new Date() });
    expect((await putRoles(ta, a.id, { roles: ["user"], password: PW })).body.error).toBe("last_admin");
    // con otro admin activo, sí se puede
    await h.db("users").where({ id: b.id }).update({ status: "active", blocked_at: null });
    expect((await putRoles(ta, a.id, { roles: ["user", "developer"], password: PW })).status).toBe(200);
  });

  it("ULTIMO_ADMIN_OTRO: un admin no puede dejar a la plataforma sin admins activos bloqueando o degradando al ÚLTIMO otro", async () => {
    const a = await mkAdmin("uo-a");
    const b = await mkAdmin("uo-b");
    const ta = await tokenOf(a);
    // a bloquea a b (hay otro: a) y ahora a es el último
    expect((await setStatus(ta, b.id, "blocked")).status).toBe(200);
    const { setUserStatus, setUserRoles } = await import("./services/account-recovery.js");
    // b (ya bloqueado) ya no es un administrador activo: no puede actuar (P3-4), tampoco para tocar al último
    await expect(setUserStatus(h.db, { actorId: b.id }, a.id, "blocked")).rejects.toMatchObject({ status: 403 });
    await expect(setUserRoles(h.db, { actorId: b.id }, a.id, ["user"], { reauthed: true })).rejects.toMatchObject({
      status: 403,
    });
    // y el último admin activo no puede bloquearse ni degradarse a sí mismo
    await expect(setUserStatus(h.db, { actorId: a.id }, a.id, "blocked")).rejects.toMatchObject({
      status: 409,
      code: "last_admin",
    });
    await expect(setUserRoles(h.db, { actorId: a.id }, a.id, ["user"], { reauthed: true })).rejects.toMatchObject({
      status: 409,
      code: "last_admin",
    });
    expect(await activeAdmins()).toBe(1);
  });

  it("CARRERA_ROLES: dos admins que se quitan el rol a la vez nunca dejan 0 admins (5 rondas)", async () => {
    for (let round = 0; round < 5; round++) {
      await h.db("user_roles").where({ role: "admin" }).delete();
      const a = await mkAdmin(`cr-r${round}-a`);
      const b = await mkAdmin(`cr-r${round}-b`);
      const [ta, tb] = [await tokenOf(a), await tokenOf(b)];
      const [r1, r2] = await Promise.all([
        putRoles(ta, a.id, { roles: ["user"], password: PW }),
        putRoles(tb, b.id, { roles: ["user"], password: PW }),
      ]);
      expect([r1.status, r2.status].sort(), `ronda ${round}`).toEqual([200, 409]);
      expect(await activeAdmins(), `ronda ${round}`).toBe(1);
    }
  });

  it("CARRERA_BLOQUEO: dos admins que se bloquean a la vez nunca dejan 0 admins activos (5 rondas)", async () => {
    for (let round = 0; round < 5; round++) {
      await h.db("user_roles").where({ role: "admin" }).delete();
      await h.db("users").where({ status: "blocked" }).update({ status: "active", blocked_at: null });
      const a = await mkAdmin(`cb-r${round}-a`);
      const b = await mkAdmin(`cb-r${round}-b`);
      const [ta, tb] = [await tokenOf(a), await tokenOf(b)];
      const [r1, r2] = await Promise.all([setStatus(ta, b.id, "blocked"), setStatus(tb, a.id, "blocked")]);
      // el que llega segundo ya está bloqueado: su acción se rechaza (P3-4), nunca se llega a 0 admins activos
      expect([r1.status, r2.status].sort(), `ronda ${round}`).toEqual([200, 403]);
      expect(await activeAdmins(), `ronda ${round}`).toBe(1);
    }
  });

  /** Mientras otra transacción sostiene el cerrojo del último admin, la operación debe ESPERAR. */
  async function holdsWhile(run: () => Promise<unknown>): Promise<{ doneWhileHeld: boolean; error: unknown }> {
    const { lockAdminChanges } = await import("./services/account-recovery.js");
    let done = false;
    let error: unknown = null;
    let pending: Promise<void> = Promise.resolve();
    await h.db.transaction(async (trx) => {
      await lockAdminChanges(trx as never);
      pending = run().then(
        () => {
          done = true;
        },
        (e) => {
          done = true;
          error = e;
        },
      );
      await new Promise((r) => setTimeout(r, 600));
    });
    const doneWhileHeld = done;
    await pending;
    return { doneWhileHeld, error };
  }

  it("CERROJO_BLOQUEO: bloquear a un admin espera al cerrojo del último admin (determinista)", async () => {
    const { setUserStatus } = await import("./services/account-recovery.js");
    const a = await mkAdmin("ck-a");
    const b = await mkAdmin("ck-b");
    const r = await holdsWhile(() => setUserStatus(h.db, { actorId: a.id }, b.id, "blocked"));
    expect(r.doneWhileHeld).toBe(false);
    expect(r.error).toBeNull();
    expect(await statusOf(b.id)).toBe("blocked");
  });

  it("CERROJO_ROLES: quitarse el rol admin espera al cerrojo del último admin (determinista)", async () => {
    const { setUserRoles } = await import("./services/account-recovery.js");
    const a = await mkAdmin("ckr-a");
    await mkAdmin("ckr-b");
    const r = await holdsWhile(() => setUserRoles(h.db, { actorId: a.id }, a.id, ["user"], { reauthed: true }));
    expect(r.doneWhileHeld).toBe(false);
    expect(r.error).toBeNull();
    expect(await hasAdmin(a.id)).toBe(false);
  });
});

describe("ADM-3 · tokens: anulación por cambio de rol o de estado, y revalidación en el canje", () => {
  it("ROLES_ANULA_TOKENS: cualquier cambio del conjunto de roles anula los tokens abiertos; el mismo conjunto no", async () => {
    const a = await mkAdmin("ra-a");
    const u = await mkUser("ra-u");
    const ta = await tokenOf(a);
    const t1 = (await issue(ta, u.id)).body.token as string;
    expect((await putRoles(ta, u.id, { roles: ["developer", "user"] })).status).toBe(200); // mismo conjunto
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "1" });
    expect((await putRoles(ta, u.id, { roles: ["user", "developer", "organizer"] })).status).toBe(200);
    expect((await reset(t1)).status).toBe(401);
    const aud = (await auditOf("admin.user.roles_set", u.id)).pop();
    expect(aud!.detail).toMatchObject({ changed: true, recoveryTokensVoided: 1 });
  });

  it("ESTADO_ANULA_TOKENS: bloquear y desbloquear anulan los tokens abiertos de la cuenta", async () => {
    const a = await mkAdmin("ea-a");
    const u = await mkUser("ea-u");
    const ta = await tokenOf(a);
    const t1 = (await issue(ta, u.id)).body.token as string;
    await setStatus(ta, u.id, "blocked");
    // bloquear anula por sí mismo los tokens abiertos (antes de cualquier desbloqueo)
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "0" });
    // token emitido «a mano» mientras está bloqueada y desbloqueo: el desbloqueo también anula
    const manual = "token-manual-de-prueba-" + "x".repeat(24);
    const { hashToken } = await import("./auth/tokens.js");
    await h.db("password_resets").insert({
      user_id: u.id,
      token_hash: hashToken(manual),
      expires_at: new Date(Date.now() + 600_000),
    });
    await setStatus(ta, u.id, "active");
    expect((await reset(manual)).status).toBe(401);
    expect((await reset(t1)).status).toBe(401);
  });

  it("CANJE_REVALIDA_ESTADO: el token de una cuenta que pasó a bloqueada (sin anularlo) no se canjea y NO se consume", async () => {
    const a = await mkAdmin("cre-a");
    const u = await mkUser("cre-u");
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    await h.db("users").where({ id: u.id }).update({ status: "blocked", blocked_at: new Date() });
    expect((await reset(token)).status).toBe(401);
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "1" });
    await h.db("users").where({ id: u.id }).update({ status: "active", blocked_at: null });
    expect((await reset(token)).status).toBe(204);
  });

  it("TOKEN_ADMIN_UN_SOLO_USO: el token de una cuenta ADMIN es de un solo uso, caduca y sólo guarda el hash", async () => {
    const a = await mkAdmin("tau-a");
    const b = await mkAdmin("tau-b");
    const r = await issue(await tokenOf(a), b.id);
    expect(r.status).toBe(201);
    const { hashToken } = await import("./auth/tokens.js");
    const row = await h.db("password_resets").where({ user_id: b.id }).first();
    expect(row.token_hash).toBe(hashToken(r.body.token));
    expect(JSON.stringify(row)).not.toContain(r.body.token);
    const [x, y] = await Promise.all([reset(r.body.token), reset(r.body.token, "otra-contrasena-nueva-3")]);
    expect([x.status, y.status].sort()).toEqual([204, 401]);
    const r2 = await issue(await tokenOf(a), b.id);
    await h
      .db("password_resets")
      .where({ user_id: b.id })
      .whereNull("used_at")
      .update({ expires_at: new Date(Date.now() - 1000) });
    expect((await reset(r2.body.token)).status).toBe(401);
  });
});

describe("ADM-3 · cancelar y límites", () => {
  const noop = (t: string, impactClass = "destructive") =>
    request(app).post("/admin/operations").set(auth(t)).send({ kind: "system.noop", params: { impactClass } });
  const cancel = (t: string, id: string, body: Record<string, unknown> = {}) =>
    request(app).post(`/admin/operations/${id}/cancel`).set(auth(t)).send(body);

  it("CANCELAR_AJENA: cancelar la orden de OTRO admin exige reautenticación y se audita con quién; la propia no", async () => {
    const a = await mkAdmin("ca-a");
    const m = await mkAdmin("ca-m");
    const ta = await tokenOf(a);
    const tm = await tokenOf(m);
    const o1 = await noop(ta);
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    expect((await cancel(tm, o1.body.operation.id)).status).toBe(401);
    expect((await h.db("admin_operations").where({ id: o1.body.operation.id }).first()).status).toBe(
      "awaiting_confirmation",
    );
    expect((await cancel(tm, o1.body.operation.id, { password: PW })).status).toBe(200);
    const aud = (await audits("admin.op.cancelled")).find((x) => x.target === `operation:${o1.body.operation.id}`);
    expect(aud).toMatchObject({ actor_id: m.id });
    expect(aud!.detail).toMatchObject({ byRequester: false, requestedBy: a.id });
    // la propia no pide contraseña
    const o2 = await noop(ta);
    expect((await cancel(ta, o2.body.operation.id)).status).toBe(200);
  });

  it("LIMITE_ACCIONES: las acciones con reautenticación tienen límite por admin (429) y no afectan a otro admin", async () => {
    const limited = createApp({
      db: h.db,
      loginGuard: new FailedLoginGuard(1000, 60_000),
      loginLimiter: new SlidingWindowLimiter(1000, 60_000),
      registerLimiter: new SlidingWindowLimiter(1000, 60_000),
      adminUsersLimiter: new SlidingWindowLimiter(3, 60_000),
    });
    const a = await mkAdmin("la-a");
    const b = await mkAdmin("la-b");
    const u = await mkUser("la-u");
    const login = async (x: TUser) =>
      (await request(limited).post("/auth/login").send({ email: x.email, password: PW })).body.accessToken as string;
    const [ta, tb] = [await login(a), await login(b)];
    const call = (t: string, password: string) =>
      request(limited)
        .put(`/admin/users/${u.id}/status`)
        .set(auth(t))
        .send({ status: "blocked", password, confirmPhrase: userActionPhrase("block", u.email) });
    for (let i = 0; i < 3; i++) expect((await call(ta, "mala-contraseña-larga")).status).toBe(401);
    expect((await call(ta, PW)).status).toBe(429);
    expect(await statusOf(u.id)).toBe("active");
    expect((await call(tb, PW)).status).toBe(200);
  });
});

describe("ADM-3 · lectura por id, interbloqueos y política", () => {
  it("GET_ADMIN_USER: devuelve los roles ACTUALES por id (sin secretos), 404 si no existe y sólo para admin", async () => {
    const a = await mkAdmin("gau-a");
    const u = await mkUser("gau-u", ["user", "organizer"]);
    const ta = await tokenOf(a);
    const r = await request(app).get(`/admin/users/${u.id}`).set(auth(ta));
    expect(r.status).toBe(200);
    expect(r.body.roles).toEqual(["organizer", "user"]);
    expect(JSON.stringify(r.body)).not.toMatch(/argon2|password_hash|totp_secret/);
    expect((await request(app).get(`/admin/users/00000000-0000-4000-8000-000000000000`).set(auth(ta))).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .get(`/admin/users/${u.id}`)
          .set(auth(await tokenOf(u)))
      ).status,
    ).toBe(403);
  });

  it("INTERBLOQUEO_409: un interbloqueo de PostgreSQL (40P01) sale como 409 controlado y reintentable, nunca 500", async () => {
    const e = await mapDeadlock(Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).catch(
      (x) => x,
    );
    expect(e).toMatchObject({ status: 409, code: "concurrent_change" });
    await expect(mapDeadlock(Promise.reject(new Error("otro")))).rejects.toThrow("otro");
  });

  it("CANJE_Y_BLOQUEO_SIMULTANEOS: canjear y bloquear a la vez nunca da 500 (10 rondas)", async () => {
    const a = await mkAdmin("cs-a");
    await mkAdmin("cs-b");
    const ta = await tokenOf(a);
    for (let i = 0; i < 10; i++) {
      const u = await mkUser(`cs-u${i}`);
      const token = (await issue(ta, u.id)).body.token as string;
      const [r1, r2] = await Promise.all([reset(token), setStatus(ta, u.id, "blocked")]);
      expect(r1.status, `canje ${i}`).toBeLessThan(500);
      expect(r2.status, `bloqueo ${i}`).toBeLessThan(500);
    }
  });

  it("POLITICA_MENSAJE_DERIVADO: el mensaje de política del canje sale de la función única, no de una copia", async () => {
    const r = await reset("token-cualquiera-no-importa-1234567890", "corta");
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(passwordPolicyViolation("corta", "La nueva contraseña"));
  });
});

describe("ADM-3 · sin segundo admin ni linaje en el contrato", () => {
  it("SIN_ORDENES_USER: en producción no hay ningún tipo de orden `user.*` ni aprobaciones: el API de órdenes los rechaza", async () => {
    const a = await mkAdmin("so-a");
    const b = await mkAdmin("so-b");
    const ta = await tokenOf(a);
    for (const kind of [
      "user.recovery_admin",
      "user.revoke_admin",
      "user.grant_admin",
      "user.block_admin",
      "user.unblock_admin",
    ]) {
      const r = await request(app)
        .post("/admin/operations")
        .set(auth(ta))
        .send({ kind, params: { userId: b.id } });
      expect(r.status, kind).toBe(400);
    }
    // y no existen las tablas/columnas del mecanismo retirado
    const t = await h.db.raw(`SELECT to_regclass('public.admin_grant_edges') AS t`);
    expect(t.rows[0].t).toBeNull();
    const c = await h.db.raw(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('users','password_resets') AND column_name IN ('admin_granted_by','issued_via_operation')`,
    );
    expect(c.rows[0].n).toBe(0);
  });
});

describe("ADM-3 · restablecer también la 2FA (D-OP-44)", () => {
  const withTotp = async (label: string, roles?: string[]) => {
    const u = await mkUser(label, roles);
    await h
      .db("users")
      .where({ id: u.id })
      .update({ totp_secret: "SECRETO-TOTP-DE-PRUEBA", recovery_codes: JSON.stringify(["h1", "h2"]) });
    return u;
  };
  const tfa = async (id: string) => {
    const r = await h.db("users").where({ id }).first("totp_secret", "recovery_codes");
    return { secret: r.totp_secret as string | null, codes: r.recovery_codes as unknown };
  };

  it("TFA_POR_DEFECTO_SE_CONSERVA: sin la marca la 2FA y los códigos siguen igual tras canjear", async () => {
    const a = await mkAdmin("tf0-a");
    const u = await withTotp("tf0-u");
    const r = await issue(await tokenOf(a), u.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.resetTwoFactor).toBe(false);
    expect((await reset(r.body.token)).status).toBe(204);
    const t = await tfa(u.id);
    expect(t.secret).toBe("SECRETO-TOTP-DE-PRUEBA");
    expect(t.codes).toEqual(["h1", "h2"]);
  });

  it("TFA_SOLO_AL_CANJEAR: con la marca, emitir NO toca la 2FA; canjear borra secreto y códigos y lo audita", async () => {
    const a = await mkAdmin("tf1-a");
    const u = await withTotp("tf1-u");
    const r = await issue(await tokenOf(a), u.id, { password: PW, resetTwoFactor: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.resetTwoFactor).toBe(true);
    expect((await tfa(u.id)).secret).toBe("SECRETO-TOTP-DE-PRUEBA"); // emitir no desactiva nada
    expect((await reset(r.body.token)).status).toBe(204);
    const t = await tfa(u.id);
    expect(t.secret).toBeNull();
    expect(t.codes).toBeNull();
    const rows = await h
      .db("audit_log")
      .where("id", ">", auditFloor)
      .whereIn("action", ["auth.two_factor.reset_by_recovery", "auth.password.reset"]);
    expect(rows.map((x: { action: string }) => x.action).sort()).toEqual([
      "auth.password.reset",
      "auth.two_factor.reset_by_recovery",
    ]);
    expect(JSON.stringify(rows)).not.toContain("SECRETO-TOTP-DE-PRUEBA");
    // y la persona ya entra sin segundo factor con la contraseña nueva
    const login = await request(app).post("/auth/login").send({ email: u.email, password: NEWPW });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });

  it("TFA_TOKEN_ANULADO_NO_TOCA: un token con la marca que fue anulado (nuevo token sin marca o bloqueo) no desactiva la 2FA", async () => {
    const a = await mkAdmin("tf2-a");
    const u = await withTotp("tf2-u");
    const ta = await tokenOf(a);
    const old = (await issue(ta, u.id, { password: PW, resetTwoFactor: true })).body.token as string;
    const fresh = (await issue(ta, u.id)).body.token as string; // anula el anterior, ya sin marca
    expect((await reset(old)).status).toBe(401);
    expect((await tfa(u.id)).secret).not.toBeNull();
    expect((await reset(fresh)).status).toBe(204);
    expect((await tfa(u.id)).secret).not.toBeNull(); // el vigente no llevaba marca
    const u2 = await withTotp("tf2-u2");
    const t2 = (await issue(ta, u2.id, { password: PW, resetTwoFactor: true })).body.token as string;
    expect((await setStatus(ta, u2.id, "blocked")).status).toBe(200);
    await setStatus(ta, u2.id, "active");
    expect((await reset(t2)).status).toBe(401);
    expect((await tfa(u2.id)).secret).not.toBeNull();
  });

  it("TFA_OTRO_ADMIN: también restablece la 2FA de otro admin (la cuenta sigue siendo admin; sin guarda del último)", async () => {
    const a = await mkAdmin("tf3-a");
    const b = await withTotp("tf3-b", ["user", "developer", "admin"]);
    const r = await issue(await tokenOf(a), b.id, { password: PW, resetTwoFactor: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await reset(r.body.token)).status).toBe(204);
    expect((await tfa(b.id)).secret).toBeNull();
    expect(await hasAdmin(b.id)).toBe(true);
  });

  it("TFA_MARCA_VALIDADA: resetTwoFactor no booleano es 400 y exige reautenticación como el resto", async () => {
    const a = await mkAdmin("tf4-a");
    const u = await mkUser("tf4-u");
    const ta = await tokenOf(a);
    expect((await issue(ta, u.id, { password: PW, resetTwoFactor: "yes" })).status).toBe(400);
    expect((await issue(ta, u.id, { resetTwoFactor: true })).status).toBe(401);
  });
});

describe("ADM-3 · confirmación explícita en el SERVIDOR (P3-5)", () => {
  const noEffectRoles = async (id: string) => (await currentRolesOf(id)).sort().join(",");
  const currentRolesOf = async (id: string) =>
    (await h.db("user_roles").where({ user_id: id })).map((r: { role: string }) => r.role as string);

  it("CONFIRMACION_SERVIDOR_ROLES: conceder o quitar «admin» sin frase (o con otra) es 400 y no cambia nada", async () => {
    const a = await mkAdmin("cs-r-a");
    const b = await mkAdmin("cs-r-b");
    const u = await mkUser("cs-r-u");
    const ta = await tokenOf(a);
    const before = await noEffectRoles(u.id);
    for (const confirmPhrase of [undefined, "", "CAMBIAR ROLES otra@cuenta.es", userActionPhrase("block", u.email)]) {
      const r = await request(app)
        .put(`/users/${u.id}/roles`)
        .set(auth(ta))
        .send({
          roles: ["user", "developer", "admin"],
          password: PW,
          ...(confirmPhrase === undefined ? {} : { confirmPhrase }),
        });
      expect(r.status, String(confirmPhrase)).toBe(400);
      expect(r.body.message ?? r.body.error ?? "").toMatch(/confirmación|confirmPhrase/i);
    }
    expect(await noEffectRoles(u.id)).toBe(before);
    // quitar admin a otro admin: igual
    const r2 = await request(app)
      .put(`/users/${b.id}/roles`)
      .set(auth(ta))
      .send({ roles: ["user"], password: PW });
    expect(r2.status).toBe(400);
    expect(await hasAdmin(b.id)).toBe(true);
    // con la frase correcta, sí
    expect((await putRoles(ta, u.id, { roles: ["user", "developer", "admin"], password: PW })).status).toBe(200);
    expect(await hasAdmin(u.id)).toBe(true);
  });

  it("CONFIRMACION_SERVIDOR_ESTADO: bloquear y desbloquear sin la frase de SU verbo es 400 y no cambia el estado", async () => {
    const a = await mkAdmin("cs-s-a");
    const u = await mkUser("cs-s-u");
    const ta = await tokenOf(a);
    const put = (body: Record<string, unknown>) =>
      request(app)
        .put(`/admin/users/${u.id}/status`)
        .set(auth(ta))
        .send({ password: PW, ...body });
    expect((await put({ status: "blocked" })).status).toBe(400);
    expect((await put({ status: "blocked", confirmPhrase: userActionPhrase("unblock", u.email) })).status).toBe(400);
    expect(await statusOf(u.id)).toBe("active");
    expect((await setStatus(ta, u.id, "blocked")).status).toBe(200);
    expect((await put({ status: "active" })).status).toBe(400);
    expect((await put({ status: "active", confirmPhrase: userActionPhrase("block", u.email) })).status).toBe(400);
    expect(await statusOf(u.id)).toBe("blocked");
    expect((await setStatus(ta, u.id, "active")).status).toBe(200);
  });

  it("CONFIRMACION_SERVIDOR_TOKEN: emitir el token exige su frase; restablecer la 2FA exige la suya, distinta", async () => {
    const a = await mkAdmin("cs-t-a");
    const u = await mkUser("cs-t-u");
    const ta = await tokenOf(a);
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post(`/admin/users/${u.id}/recovery-token`)
        .set(auth(ta))
        .send({ password: PW, ...body });
    const openTokens = async () =>
      Number((await h.db("password_resets").where({ user_id: u.id }).count({ n: "*" }).first())?.n);
    expect((await post({})).status).toBe(400);
    expect((await post({ confirmPhrase: userActionPhrase("block", u.email) })).status).toBe(400);
    // la frase simple NO basta para restablecer la 2FA (acción más fuerte, confirmación propia)
    expect((await post({ resetTwoFactor: true, confirmPhrase: userActionPhrase("recover", u.email) })).status).toBe(
      400,
    );
    expect(await openTokens()).toBe(0);
    expect((await post({ resetTwoFactor: true, confirmPhrase: userActionPhrase("recover_2fa", u.email) })).status).toBe(
      201,
    );
    expect((await post({ confirmPhrase: userActionPhrase("recover", u.email) })).status).toBe(201);
  });
});

describe("ADM-3 · el ACTOR se revalida bajo el cerrojo (P3-4)", () => {
  /** Espera (sondeando pg_locks) a que haya una petición bloqueada esperando un cerrojo consultivo. */
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await h.db.raw(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (r.rows[0].n >= 1) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("la petición no llegó a esperar el cerrojo");
  }
  /** Retiene el cerrojo, lanza la petición (que queda esperando), bloquea al actor y suelta el cerrojo. */
  async function blockActorWhileWaiting(actor: TUser, start: () => PromiseLike<{ status: number }>) {
    const { lockAdminChanges } = await import("./services/account-recovery.js");
    let pending: PromiseLike<{ status: number }> = Promise.resolve({ status: 0 });
    await h.db.transaction(async (trx) => {
      await lockAdminChanges(trx as never);
      pending = start();
      await waitForLockWaiter();
      await trx("users").where({ id: actor.id }).update({ status: "blocked", blocked_at: new Date() });
    });
    return pending;
  }

  it("TOCTOU_ACTOR_BLOQUEADO: un admin bloqueado mientras su petición esperaba el cerrojo NO concede admin", async () => {
    const a = await mkAdmin("tc-a");
    const c = await mkUser("tc-c");
    const ta = await tokenOf(a);
    const r = await blockActorWhileWaiting(a, () =>
      putRoles(ta, c.id, { roles: ["user", "developer", "admin"], password: PW }),
    );
    expect(r.status).toBe(403);
    expect(await hasAdmin(c.id)).toBe(false);
  });

  it("TOCTOU_ACTOR_BLOQUEADO_ESTADO: lo mismo al bloquear a otra cuenta", async () => {
    const a = await mkAdmin("tcs-a");
    const u = await mkUser("tcs-u");
    const ta = await tokenOf(a);
    const r = await blockActorWhileWaiting(a, () => setStatus(ta, u.id, "blocked"));
    expect(r.status).toBe(403);
    expect(await statusOf(u.id)).toBe("active");
  });

  it("TOCTOU_ACTOR_DEGRADADO: un actor al que se le quitó «admin» mientras esperaba tampoco actúa; y emitir token revalida igual", async () => {
    const a = await mkAdmin("td-a");
    const u = await mkUser("td-u");
    const ta = await tokenOf(a);
    // degradado a mano con el access token aún vigente
    await h.db("user_roles").where({ user_id: a.id, role: "admin" }).delete();
    expect((await issue(ta, u.id)).status).toBe(403); // la ruta exige rol admin
    // el servicio, llamado directamente, también lo rechaza (defensa en profundidad bajo el cerrojo)
    const { issueRecoveryToken, setUserStatus } = await import("./services/account-recovery.js");
    await expect(issueRecoveryToken(h.db, { actorId: a.id }, u.id)).rejects.toMatchObject({ status: 403 });
    await expect(setUserStatus(h.db, { actorId: a.id }, u.id, "blocked")).rejects.toMatchObject({ status: 403 });
    await expect(issueRecoveryToken(h.db, { actorId: null }, u.id)).rejects.toMatchObject({ status: 403 });
    expect(await statusOf(u.id)).toBe("active");
  });
});

describe("ADM-3 · el listado muestra la marca de 2FA del token pendiente (P3-6)", () => {
  it("LISTA_MARCA_2FA: recoveryResetsTwoFactor sólo es true si el token vigente la lleva", async () => {
    const a = await mkAdmin("lm-a");
    const u = await mkUser("lm-u");
    const ta = await tokenOf(a);
    const view = async () =>
      (await request(app).get(`/admin/users/${u.id}`).set(auth(ta))).body as {
        recoveryPending: boolean;
        recoveryResetsTwoFactor: boolean;
      };
    expect(await view()).toMatchObject({ recoveryPending: false, recoveryResetsTwoFactor: false });
    expect((await issue(ta, u.id)).status).toBe(201);
    expect(await view()).toMatchObject({ recoveryPending: true, recoveryResetsTwoFactor: false });
    expect((await issue(ta, u.id, { password: PW, resetTwoFactor: true })).status).toBe(201);
    expect(await view()).toMatchObject({ recoveryPending: true, recoveryResetsTwoFactor: true });
    // un token con marca ya anulado (se emite otro sin ella) no se anuncia
    expect((await issue(ta, u.id)).status).toBe(201);
    expect(await view()).toMatchObject({ recoveryPending: true, recoveryResetsTwoFactor: false });
  });
});
