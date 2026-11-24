/**
 * V1 ADM-3 · Correcciones de la revisión de #347 (PG real). Cada caso lleva su mutante en `scripts/adm3-mutants.py`.
 *
 *  P1-1 · un admin SOLO no puede recuperar una cuenta admin ajena: canje que revalida el rol, cambio de roles que
 *         anula tokens, y quitar «admin» a otra cuenta con segundo admin + reautenticación.
 *  P2-1 · el cerrojo del último admin resiste la carrera (varias rondas).
 *  P2-2 · crear/cancelar órdenes `user.*` exige reautenticación y límite; unicidad por cuenta objetivo.
 *  P3   · interbloqueo ⇒ 409, el aprobador debe seguir siendo admin, el objetivo no cuenta como segundo admin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { hashPassword } from "./auth/passwords.js";
import { passwordPolicyViolation } from "./auth/passwords.js";
import { mapDeadlock } from "./services/account-recovery.js";
import { RECOVERY_APPROVAL_WINDOW_MS } from "./services/account-recovery.js";

let h: TestDbHandle;
let app: Express;
let usersLimiter: SlidingWindowLimiter;
const PW = "password-larga-adm3-1";
const NEWPW = "contrasena-nueva-adm3-2";

beforeAll(async () => {
  h = await startTestDb();
  usersLimiter = new SlidingWindowLimiter(1000, 60_000);
  app = createApp({
    db: h.db,
    loginGuard: new FailedLoginGuard(1000, 60_000),
    loginLimiter: new SlidingWindowLimiter(1000, 60_000),
    registerLimiter: new SlidingWindowLimiter(1000, 60_000),
    refreshLimiter: new SlidingWindowLimiter(1000, 60_000),
    adminConfirmLimiter: new SlidingWindowLimiter(1000, 60_000),
    resetLimiter: new SlidingWindowLimiter(1000, 60_000),
    adminUsersLimiter: { hit: (k: string) => usersLimiter.hit(k) },
  });
}, 120_000);
afterAll(async () => {
  await h.stop();
});

let tagN = 0;
let auditFloor = 0;
beforeEach(async () => {
  await h.db("user_roles").where({ role: "admin" }).delete();
  await h.db("admin_operations").delete();
  auditFloor = Number((await h.db("audit_log").max({ m: "id" }).first())?.m ?? 0);
  usersLimiter = new SlidingWindowLimiter(1000, 60_000);
});

interface TUser {
  id: string;
  email: string;
}
async function mkUser(label: string, roles: string[] = ["user", "developer"]): Promise<TUser> {
  const email = `rv-${label}-${++tagN}@test.local`.toLowerCase();
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: await hashPassword(PW), display_name: `Rv ${label} ${tagN}` })
    .returning("id");
  await h.db("user_roles").insert(roles.map((role) => ({ user_id: u.id, role })));
  return { id: u.id, email };
}
const mkAdmin = (label: string) => mkUser(label, ["user", "developer", "admin"]);
async function tokenOf(u: TUser): Promise<string> {
  const r = await request(app).post("/auth/login").send({ email: u.email, password: PW });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const putRoles = (t: string, id: string, body: Record<string, unknown>) =>
  request(app).put(`/users/${id}/roles`).set(auth(t)).send(body);
const issue = (t: string, id: string, body: Record<string, unknown> = { password: PW }) =>
  request(app).post(`/admin/users/${id}/recovery-token`).set(auth(t)).send(body);
const reset = (token: string, newPassword = NEWPW) => request(app).post("/auth/reset").send({ token, newPassword });
const setStatus = (t: string, id: string, status: string) =>
  request(app).put(`/admin/users/${id}/status`).set(auth(t)).send({ status, password: PW });
const createOp = (t: string, kind: string, userId: string, extra: Record<string, unknown> = { password: PW }) =>
  request(app)
    .post("/admin/operations")
    .set(auth(t))
    .send({ kind, params: { userId }, ...extra });
const confirmOp = (t: string, id: string, phrase: string) =>
  request(app).post(`/admin/operations/${id}/confirm`).set(auth(t)).send({ phrase, password: PW });
const cancelOp = (t: string, id: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/admin/operations/${id}/cancel`).set(auth(t)).send(body);
const hasAdmin = async (id: string) => !!(await h.db("user_roles").where({ user_id: id, role: "admin" }).first());
const audits = async (like: string) =>
  (await h.db("audit_log").where("action", "like", like).where("id", ">", auditFloor).orderBy("id")) as {
    action: string;
    target: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
  }[];

/** Aprobación completa de una orden `user.*`: quien solicita crea, otro admin aprueba. Devuelve el id. */
async function approvedOp(kind: string, ta: string, tc: string, target: TUser): Promise<string> {
  const op = await createOp(ta, kind, target.id);
  expect(op.status, JSON.stringify(op.body)).toBe(201);
  expect((await confirmOp(tc, op.body.operation.id, op.body.operation.confirmPhrase)).status).toBe(200);
  return op.body.operation.id as string;
}

describe("ADM-3 R1 · P1-1 · un admin solo no recupera una cuenta admin ajena", () => {
  it("BYPASS_DEGRADAR: degradar a la víctima ya NO es posible sin segundo admin (el ataque de la revisión se detiene en el paso 1)", async () => {
    const a = await mkAdmin("byp-a");
    const b = await mkAdmin("byp-b");
    await mkAdmin("byp-c");
    const ta = await tokenOf(a);
    // paso 1 del ataque: A quita «admin» a B él solo
    const r = await putRoles(ta, b.id, { roles: ["user"], password: PW });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_required");
    expect(await hasAdmin(b.id)).toBe(true);
    // y con una aprobación inventada tampoco
    const bad = await putRoles(ta, b.id, {
      roles: ["user"],
      password: PW,
      operationId: "00000000-0000-4000-8000-000000000000",
    });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("second_admin_approval_invalid");
    expect(await hasAdmin(b.id)).toBe(true);
    // emitir el token sin operationId sigue vedado mientras B sea admin
    expect((await issue(ta, b.id)).status).toBe(403);
  });

  it("REVOCA_CON_SEGUNDO_ADMIN: quitar «admin» a otra cuenta funciona con la aprobación de OTRO admin, que se gasta una vez", async () => {
    const a = await mkAdmin("rev-a");
    const b = await mkAdmin("rev-b");
    const c = await mkAdmin("rev-c");
    const ta = await tokenOf(a);
    const tc = await tokenOf(c);
    const id = await approvedOp("user.revoke_admin", ta, tc, b);
    // sin reautenticación: 401 y la aprobación no se gasta
    expect((await putRoles(ta, b.id, { roles: ["user"], operationId: id })).status).toBe(401);
    expect(await hasAdmin(b.id)).toBe(true);
    // la aprobación es de A: C (que la confirmó) y un cuarto no pueden usarla
    expect((await putRoles(tc, b.id, { roles: ["user"], password: PW, operationId: id })).status).toBe(403);
    // para otra cuenta no vale
    expect((await putRoles(ta, c.id, { roles: ["user"], password: PW, operationId: id })).status).toBe(403);
    const ok = await putRoles(ta, b.id, { roles: ["user", "developer"], password: PW, operationId: id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await hasAdmin(b.id)).toBe(false);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("done");
    // reutilizarla: 403 (y B ya no es admin; se la vuelve a dar para comprobar que no basta)
    const grant = await approvedOp("user.grant_admin", ta, tc, b); // conceder: reauth + aprobación (hay otro admin)
    expect((await putRoles(ta, b.id, { roles: ["user", "admin"], password: PW, operationId: grant })).status).toBe(200);
    expect((await putRoles(ta, b.id, { roles: ["user"], password: PW, operationId: id })).status).toBe(403);
    expect(await hasAdmin(b.id)).toBe(true);
    const aud = (await audits("admin.user.roles_set")).filter((x) => x.target === `user:${b.id}`);
    expect(aud[0].detail).toMatchObject({ secondAdminOperation: id });
  });

  it("REVOCA_SIN_TERCERO: con sólo dos admins nadie puede aprobar: 409 second_admin_unavailable (y la orden también)", async () => {
    const a = await mkAdmin("sin3-a");
    const b = await mkAdmin("sin3-b");
    const ta = await tokenOf(a);
    const r = await putRoles(ta, b.id, { roles: ["user"], password: PW });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
    const op = await createOp(ta, "user.revoke_admin", b.id);
    expect(op.status).toBe(409);
    expect(op.body.error).toBe("second_admin_unavailable");
    expect(await hasAdmin(b.id)).toBe(true);
  });

  it("ROLES_REAUTENTICACION: conceder o quitarse «admin» exige reautenticación; el resto de cambios, no", async () => {
    const a = await mkAdmin("reauth-a");
    const rb = await mkAdmin("reauth-b");
    const u = await mkUser("reauth-u");
    const ta = await tokenOf(a);
    // conceder admin sin contraseña: 401 y nada cambia
    expect((await putRoles(ta, u.id, { roles: ["user", "admin"] })).status).toBe(401);
    expect((await putRoles(ta, u.id, { roles: ["user", "admin"], password: "mala-contraseña-larga" })).status).toBe(
      401,
    );
    expect(await hasAdmin(u.id)).toBe(false);
    // con otro admin activo, tampoco basta la contraseña: hace falta la aprobación de otro admin
    expect((await putRoles(ta, u.id, { roles: ["user", "admin"], password: PW })).status).toBe(403);
    const gr = await approvedOp("user.grant_admin", ta, await tokenOf(rb), u);
    expect((await putRoles(ta, u.id, { roles: ["user", "admin"], password: PW, operationId: gr })).status).toBe(200);
    expect(await hasAdmin(u.id)).toBe(true);
    // quitarse el rol a uno mismo sin contraseña: 401
    expect((await putRoles(ta, a.id, { roles: ["user"] })).status).toBe(401);
    expect(await hasAdmin(a.id)).toBe(true);
    expect((await putRoles(ta, a.id, { roles: ["user"], password: PW })).status).toBe(200);
    // un cambio que no toca «admin» no pide contraseña
    const v = await mkUser("reauth-v");
    const tb = await tokenOf((await mkAdmin("reauth-d")) as TUser);
    expect((await putRoles(tb, v.id, { roles: ["user", "organizer"] })).status).toBe(200);
  });

  it("ROLES_ANULA_TOKENS: cualquier cambio de roles anula los tokens de recuperación abiertos; el mismo conjunto, no", async () => {
    const a = await mkAdmin("anula-a");
    await mkAdmin("anula-b");
    const u = await mkUser("anula-u");
    const ta = await tokenOf(a);
    const t1 = (await issue(ta, u.id)).body.token as string;
    // mismo conjunto (otro orden): el token sigue vigente
    expect((await putRoles(ta, u.id, { roles: ["developer", "user"] })).status).toBe(200);
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "1" });
    // cambio real: anulado
    expect((await putRoles(ta, u.id, { roles: ["user", "developer", "organizer"] })).status).toBe(200);
    expect((await reset(t1)).status).toBe(401);
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "0" });
    const aud = (await audits("admin.user.roles_set")).filter((x) => x.target === `user:${u.id}`);
    expect(aud[1].detail).toMatchObject({ changed: true, recoveryTokensVoided: 1 });
  });

  it("PROMOCION_TRAS_EMITIR: un token emitido a un usuario normal que luego es promovido a admin NO se puede canjear", async () => {
    const a = await mkAdmin("promo-a");
    const pb = await mkAdmin("promo-b");
    const u = await mkUser("promo-u");
    const ta = await tokenOf(a);
    const token = (await issue(ta, u.id)).body.token as string;
    // promoción por la API: además anula el token (capa b)
    const gr = await approvedOp("user.grant_admin", ta, await tokenOf(pb), u);
    expect((await putRoles(ta, u.id, { roles: ["user", "admin"], password: PW, operationId: gr })).status).toBe(200);
    expect((await reset(token)).status).toBe(401);
  });

  it("CANJE_REVALIDA_ROL: aunque el rol cambie por otra vía (sin anular tokens), el canje de una cuenta admin sin aprobación se rechaza y NO consume el token", async () => {
    const a = await mkAdmin("reval-a");
    const u = await mkUser("reval-u");
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    await h.db("user_roles").insert({ user_id: u.id, role: "admin" }); // promoción «a mano»: capa (b) no actúa
    const r = await reset(token);
    expect(r.status).toBe(401);
    expect(r.body.message).toBe("Token de recuperación inválido o expirado");
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({ n: "1" });
    // si deja de ser admin, el mismo token vuelve a servir
    await h.db("user_roles").where({ user_id: u.id, role: "admin" }).delete();
    expect((await reset(token)).status).toBe(204);
  });

  it("CANJE_ADMIN_CON_APROBACION: un token emitido con la aprobación del segundo admin SÍ se canjea para una cuenta admin", async () => {
    const a = await mkAdmin("apr-a");
    const b = await mkAdmin("apr-b");
    const t = await mkAdmin("apr-t");
    const ta = await tokenOf(a);
    const op = await createOp(ta, "user.recovery_admin", t.id);
    await confirmOp(await tokenOf(b), op.body.operation.id, op.body.operation.confirmPhrase);
    const r = await issue(ta, t.id, { password: PW, operationId: op.body.operation.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await reset(r.body.token)).status).toBe(204);
  });
});

describe("ADM-3 R1 · P2-1 · carrera del último administrador", () => {
  it("CARRERA_ULTIMO_ADMIN_ROLES: dos admins que se quitan el rol a la vez nunca dejan cero admins (5 rondas)", async () => {
    for (let round = 0; round < 5; round++) {
      await h.db("user_roles").where({ role: "admin" }).delete();
      const a = await mkAdmin(`car-r${round}-a`);
      const b = await mkAdmin(`car-r${round}-b`);
      const [ta, tb] = [await tokenOf(a), await tokenOf(b)];
      const [r1, r2] = await Promise.all([
        putRoles(ta, a.id, { roles: ["user"], password: PW }),
        putRoles(tb, b.id, { roles: ["user"], password: PW }),
      ]);
      expect([r1.status, r2.status].sort(), `ronda ${round}`).toEqual([200, 409]);
      const n = await h.db("user_roles").where({ role: "admin" }).count({ n: "*" }).first();
      expect(Number((n as { n: string }).n), `ronda ${round}`).toBe(1);
    }
  });
});

describe("ADM-3 R1 · P2-1 · el cerrojo se toma de verdad (determinista)", () => {
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

  it("CERROJO_BLOQUEO: bloquear a un admin espera al cerrojo del último admin", async () => {
    const { setUserStatus } = await import("./services/account-recovery.js");
    const a = await mkAdmin("lock-a");
    const b = await mkUser("lock-b");
    const r = await holdsWhile(() => setUserStatus(h.db, { actorId: a.id }, b.id, "blocked"));
    expect(r.doneWhileHeld).toBe(false);
    expect(r.error).toBeNull();
    expect((await h.db("users").where({ id: b.id }).first()).status).toBe("blocked");
  });

  it("CERROJO_ROLES: quitarse el rol admin espera al cerrojo del último admin", async () => {
    const { setUserRoles } = await import("./services/account-recovery.js");
    const a = await mkAdmin("lockr-a");
    await mkAdmin("lockr-b");
    const r = await holdsWhile(() => setUserRoles(h.db, { actorId: a.id }, a.id, ["user"], { reauthed: true }));
    expect(r.doneWhileHeld).toBe(false);
    expect(r.error).toBeNull();
    expect(await hasAdmin(a.id)).toBe(false);
  });
});

describe("ADM-3 R1 · aprobadores", () => {
  it("APROBADOR_BLOQUEADO_NO_CUENTA: un admin bloqueado no cuenta como segundo admin disponible", async () => {
    const a = await mkAdmin("apb-a");
    const t = await mkAdmin("apb-t");
    const c = await mkAdmin("apb-c");
    await h.db("users").where({ id: c.id }).update({ status: "blocked", blocked_at: new Date() });
    const r = await createOp(await tokenOf(a), "user.recovery_admin", t.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
  });
});

describe("ADM-3 R1 · P2-2 · órdenes user.*: reautenticación, límite y unicidad por cuenta", () => {
  it("OP_USER_REAUTH: crear una orden user.* sin credenciales frescas es 401 y no deja fila", async () => {
    const a = await mkAdmin("opre-a");
    await mkAdmin("opre-b");
    const t = await mkAdmin("opre-t");
    const ta = await tokenOf(a);
    expect((await createOp(ta, "user.recovery_admin", t.id, {})).status).toBe(401);
    expect((await createOp(ta, "user.recovery_admin", t.id, { password: "mala-contraseña-larga" })).status).toBe(401);
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect((await createOp(ta, "user.recovery_admin", t.id)).status).toBe(201);
  });

  it("OP_USER_LIMITE: crear y cancelar órdenes user.* tiene límite por admin (429)", async () => {
    usersLimiter = new SlidingWindowLimiter(2, 60_000);
    const a = await mkAdmin("oplim-a");
    await mkAdmin("oplim-b");
    const t = await mkAdmin("oplim-t");
    const ta = await tokenOf(a);
    expect((await createOp(ta, "user.recovery_admin", t.id, { password: "mala-contraseña-larga" })).status).toBe(401);
    expect((await createOp(ta, "user.recovery_admin", t.id, { password: "mala-contraseña-larga" })).status).toBe(401);
    expect((await createOp(ta, "user.recovery_admin", t.id)).status).toBe(429);
  });

  it("CANCELAR_AJENA: otro admin NO puede cancelar sin reautenticarse; con ella sí, y queda auditado con quién", async () => {
    const a = await mkAdmin("canc-a");
    const b = await mkAdmin("canc-b");
    const m = await mkAdmin("canc-m");
    const t = await mkAdmin("canc-t");
    const ta = await tokenOf(a);
    const tm = await tokenOf(m);
    const op = await createOp(ta, "user.recovery_admin", t.id);
    const id = op.body.operation.id as string;
    await confirmOp(await tokenOf(b), id, op.body.operation.confirmPhrase);
    // M sin credenciales: 401 y la aprobación sigue viva
    expect((await cancelOp(tm, id)).status).toBe(401);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("pending");
    // el solicitante tampoco cancela una orden user.* sin reautenticarse
    expect((await cancelOp(ta, id)).status).toBe(401);
    // M reautenticado: puede, y se audita con su id y «no es el solicitante»
    expect((await cancelOp(tm, id, { password: PW })).status).toBe(200);
    const aud = (await audits("admin.op.cancelled")).find((x) => x.target === `operation:${id}`);
    expect(aud).toMatchObject({ actor_id: m.id });
    expect(aud!.detail).toMatchObject({ byRequester: false, requestedBy: a.id });
  });

  it("UNICIDAD_POR_CUENTA: dos recuperaciones de cuentas DISTINTAS conviven; la misma cuenta dos veces, no", async () => {
    const a = await mkAdmin("uni-a");
    await mkAdmin("uni-b");
    const t1 = await mkAdmin("uni-t1");
    const t2 = await mkAdmin("uni-t2");
    const ta = await tokenOf(a);
    expect((await createOp(ta, "user.recovery_admin", t1.id)).status).toBe(201);
    expect((await createOp(ta, "user.recovery_admin", t2.id)).status).toBe(201);
    const dup = await createOp(ta, "user.recovery_admin", t1.id);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("operation_in_progress");
  });
});

describe("ADM-3 R1 · P3", () => {
  it("INTERBLOQUEO_409: un interbloqueo de PostgreSQL (40P01) sale como 409 controlado y reintentable, nunca 500", async () => {
    const e = await mapDeadlock(Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).catch(
      (x) => x,
    );
    expect(e).toMatchObject({ status: 409, code: "concurrent_change" });
    // otros errores se propagan intactos
    await expect(mapDeadlock(Promise.reject(new Error("otro")))).rejects.toThrow("otro");
  });

  it("CANJE_Y_BLOQUEO_SIMULTANEOS: canjear y bloquear a la vez nunca da 500 (10 rondas)", async () => {
    const a = await mkAdmin("simul-a");
    await mkAdmin("simul-b");
    const ta = await tokenOf(a);
    for (let i = 0; i < 10; i++) {
      const u = await mkUser(`simul-u${i}`);
      const token = (await issue(ta, u.id)).body.token as string;
      const [r1, r2] = await Promise.all([reset(token), setStatus(ta, u.id, "blocked")]);
      expect(r1.status, `canje ${i}`).toBeLessThan(500);
      expect(r2.status, `bloqueo ${i}`).toBeLessThan(500);
    }
  });

  it("APROBADOR_SIGUE_ADMIN: si quien aprobó deja de ser admin activo antes de consumirse, la aprobación ya no vale", async () => {
    const a = await mkAdmin("apv-a");
    const b = await mkAdmin("apv-b");
    await mkAdmin("apv-c");
    const t = await mkAdmin("apv-t");
    const ta = await tokenOf(a);
    const op = await createOp(ta, "user.recovery_admin", t.id);
    await confirmOp(await tokenOf(b), op.body.operation.id, op.body.operation.confirmPhrase);
    await h.db("users").where({ id: b.id }).update({ status: "blocked", blocked_at: new Date() });
    const r = await issue(ta, t.id, { password: PW, operationId: op.body.operation.id });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_approval_invalid");
    expect(await h.db("password_resets").where({ user_id: t.id }).count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(RECOVERY_APPROVAL_WINDOW_MS).toBe(10 * 60_000);
  });

  it("OBJETIVO_NO_ES_SEGUNDO_ADMIN: con dos admins (solicitante y objetivo) no hay quien apruebe: 409", async () => {
    const a = await mkAdmin("objn-a");
    const t = await mkAdmin("objn-t");
    const r = await createOp(await tokenOf(a), "user.recovery_admin", t.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
  });

  it("POLITICA_MENSAJE_DERIVADO: el mensaje de política del canje sale de la función única, no de una copia", async () => {
    const r = await reset("token-cualquiera-no-importa-1234567890", "corta");
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(passwordPolicyViolation("corta", "La nueva contraseña"));
  });
});

describe("ADM-3 R2 · P1-2 · el admin «títere»", () => {
  const register = async (label: string) => {
    const email = `rv-ti-${label}-${++tagN}@test.local`;
    const r = await request(app)
      .post("/auth/register")
      .send({ email, password: PW, displayName: `Titere ${label}` });
    expect(r.status).toBe(201);
    return { id: r.body.id as string, email } as TUser;
  };

  it("TITERE_RECUPERACION: con otro admin activo, A NO puede darle admin a una cuenta registrada por él (el ataque de la revisión se detiene)", async () => {
    const a = await mkAdmin("tit-a");
    const b = await mkAdmin("tit-b");
    const ta = await tokenOf(a);
    const x = await register("x");
    // paso 2 del ataque: conceder admin a X sólo con la contraseña de A
    const r = await putRoles(ta, x.id, { roles: ["user", "developer", "admin"], password: PW });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_required");
    expect(await hasAdmin(x.id)).toBe(false);
    // y sin X como admin, con sólo A y B nadie puede aprobar la recuperación de B
    const op = await createOp(ta, "user.recovery_admin", b.id);
    expect(op.status).toBe(409);
    expect(op.body.error).toBe("second_admin_unavailable");
  });

  it("GRANT_BOOTSTRAP: el ÚNICO admin activo puede crear al segundo con sólo la reautenticación (queda auditado como bootstrap)", async () => {
    const a = await mkAdmin("boot-a");
    const ta = await tokenOf(a);
    const x = await register("boot-x");
    expect((await putRoles(ta, x.id, { roles: ["user", "admin"] })).status).toBe(401);
    const r = await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await hasAdmin(x.id)).toBe(true);
    expect((await h.db("users").where({ id: x.id }).first()).admin_granted_by).toBe(a.id);
    const aud = (await audits("admin.user.roles_set")).find((e) => e.target === `user:${x.id}`);
    expect(aud!.detail).toMatchObject({ bootstrap: true, secondAdminOperation: null });
  });

  it("PROMOVIDO_NO_APRUEBA: un admin promovido por A NO aprueba órdenes user.* de A (ni cuenta como aprobador disponible)", async () => {
    const a = await mkAdmin("pro-a");
    const ta = await tokenOf(a);
    const x = await register("pro-x");
    expect((await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW })).status).toBe(200); // bootstrap
    const b = await mkAdmin("pro-b"); // otro admin «real» (alta por consola)
    // sólo X podría aprobar (B es el objetivo) y fue promovido por A: no hay aprobador
    const none = await createOp(ta, "user.recovery_admin", b.id);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("second_admin_unavailable");
    // con un tercero real C sí se crea, pero X no puede confirmarla; C sí
    const c = await mkAdmin("pro-c");
    const op = await createOp(ta, "user.recovery_admin", b.id);
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    const byX = await confirmOp(await tokenOf(x), op.body.operation.id, op.body.operation.confirmPhrase);
    expect(byX.status).toBe(403);
    expect((await confirmOp(await tokenOf(c), op.body.operation.id, op.body.operation.confirmPhrase)).status).toBe(200);
  });

  it("PROMOVIDO_NO_CONSUME: aunque la aprobación venga de un promovido (p. ej. por SQL), emitir el token la rechaza", async () => {
    const a = await mkAdmin("pnc-a");
    const c = await mkAdmin("pnc-c");
    const b = await mkAdmin("pnc-b");
    const ta = await tokenOf(a);
    const op = await createOp(ta, "user.recovery_admin", b.id);
    await confirmOp(await tokenOf(c), op.body.operation.id, op.body.operation.confirmPhrase);
    await h.db("users").where({ id: c.id }).update({ admin_granted_by: a.id }); // C resulta ser promovido por A
    const r = await issue(ta, b.id, { password: PW, operationId: op.body.operation.id });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_approval_invalid");
  });

  it("OBJETIVO_NO_APRUEBA: la cuenta objetivo no aprueba la orden sobre sí misma (recuperación, degradación ni bloqueo)", async () => {
    const a = await mkAdmin("obj-a");
    const t = await mkAdmin("obj-t");
    await mkAdmin("obj-c");
    const ta = await tokenOf(a);
    const tt = await tokenOf(t);
    for (const kind of ["user.recovery_admin", "user.revoke_admin", "user.block_admin"]) {
      const op = await createOp(ta, kind, t.id);
      expect(op.status, `${kind}: ${JSON.stringify(op.body)}`).toBe(201);
      const r = await confirmOp(tt, op.body.operation.id, op.body.operation.confirmPhrase);
      expect(r.status, kind).toBe(403);
      expect((await cancelOp(ta, op.body.operation.id, { password: PW })).status).toBe(200);
    }
  });

  it("OBJETIVO_NO_CONSUME: aunque el objetivo figure como confirmador (p. ej. por SQL), emitir el token rechaza la aprobación", async () => {
    const a = await mkAdmin("onc-a");
    const c = await mkAdmin("onc-c");
    const b = await mkAdmin("onc-b");
    const ta = await tokenOf(a);
    const op = await createOp(ta, "user.recovery_admin", b.id);
    await confirmOp(await tokenOf(c), op.body.operation.id, op.body.operation.confirmPhrase);
    await h.db.raw("ALTER TABLE admin_operations DISABLE TRIGGER admin_operations_guard");
    await h.db("admin_operations").where({ id: op.body.operation.id }).update({ confirmed_by: b.id });
    await h.db.raw("ALTER TABLE admin_operations ENABLE TRIGGER admin_operations_guard");
    const r = await issue(ta, b.id, { password: PW, operationId: op.body.operation.id });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_approval_invalid");
  });

  it("CADENA_BLOQUEO: un admin no puede bloquear a los demás él solo, y no se queda solo a la fuerza", async () => {
    const a = await mkAdmin("cad-a");
    const b = await mkAdmin("cad-b");
    const c = await mkAdmin("cad-c");
    const ta = await tokenOf(a);
    const direct = await request(app)
      .put(`/admin/users/${b.id}/status`)
      .set(auth(ta))
      .send({ status: "blocked", password: PW });
    expect(direct.status).toBe(403);
    expect(direct.body.error).toBe("second_admin_required");
    expect((await h.db("users").where({ id: b.id }).first()).status).toBe("active");
    // con la aprobación de C sí
    const id = await approvedOp("user.block_admin", ta, await tokenOf(c), b);
    const ok = await request(app)
      .put(`/admin/users/${b.id}/status`)
      .set(auth(ta))
      .send({ status: "blocked", password: PW, operationId: id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("done");
    // ahora quedan A y C: bloquear a C no tiene aprobador (B está bloqueado): 409, A no se queda solo
    const solo = await request(app)
      .put(`/admin/users/${c.id}/status`)
      .set(auth(ta))
      .send({ status: "blocked", password: PW });
    expect(solo.status).toBe(409);
    expect(solo.body.error).toBe("second_admin_unavailable");
    expect((await h.db("users").where({ id: c.id }).first()).status).toBe("active");
  });

  it("GRANT_CON_APROBACION: con otro admin, conceder admin funciona con la aprobación y se gasta una vez", async () => {
    const a = await mkAdmin("gra-a");
    const b = await mkAdmin("gra-b");
    const u = await mkUser("gra-u");
    const ta = await tokenOf(a);
    const id = await approvedOp("user.grant_admin", ta, await tokenOf(b), u);
    const ok = await putRoles(ta, u.id, { roles: ["user", "developer", "admin"], password: PW, operationId: id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await hasAdmin(u.id)).toBe(true);
    expect((await h.db("users").where({ id: u.id }).first()).admin_granted_by).toBe(a.id);
    // reutilizada para otra cuenta: no vale
    const v = await mkUser("gra-v");
    expect((await putRoles(ta, v.id, { roles: ["user", "admin"], password: PW, operationId: id })).status).toBe(403);
  });
});

describe("ADM-3 R2 · P2-4 · la retirada de admin sólo quita admin", () => {
  it("REVOCA_SOLO_QUITA_ADMIN: con la aprobación, un conjunto de roles distinto de «los actuales menos admin» es 400 y no consume la aprobación", async () => {
    const a = await mkAdmin("rso-a");
    const b = await mkUser("rso-b", ["user", "developer", "organizer", "admin"]);
    const c = await mkAdmin("rso-c");
    const ta = await tokenOf(a);
    const id = await approvedOp("user.revoke_admin", ta, await tokenOf(c), b);
    expect((await putRoles(ta, b.id, { roles: [], password: PW, operationId: id })).status).toBe(400);
    expect((await putRoles(ta, b.id, { roles: ["user"], password: PW, operationId: id })).status).toBe(400);
    expect(await hasAdmin(b.id)).toBe(true);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("pending");
    const ok = await putRoles(ta, b.id, { roles: ["user", "developer", "organizer"], password: PW, operationId: id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await hasAdmin(b.id)).toBe(false);
  });

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
});

describe("ADM-3 R3 · P1-3 · linaje de promoción, bootstrap y desbloqueo", () => {
  const register = async (label: string) => {
    const email = `rv-l-${label}-${++tagN}@test.local`;
    const r = await request(app)
      .post("/auth/register")
      .send({ email, password: PW, displayName: `Linaje ${label}` });
    expect(r.status).toBe(201);
    return { id: r.body.id as string, email } as TUser;
  };
  const block = (id: string) => h.db("users").where({ id }).update({ status: "blocked", blocked_at: new Date() });
  const unblock = (t: string, id: string, body: Record<string, unknown> = {}) =>
    request(app)
      .put(`/admin/users/${id}/status`)
      .set(auth(t))
      .send({ status: "active", password: PW, ...body });

  it("BOOTSTRAP_SIN_OTROS_ADMINS: con otro admin BLOQUEADO ya no hay bootstrap (el ataque S8 se detiene en el paso 1)", async () => {
    const a = await mkAdmin("s8-a");
    const b = await mkAdmin("s8-b");
    await block(b.id);
    const ta = await tokenOf(a);
    const x = await register("s8-x");
    const r = await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
    expect(await hasAdmin(x.id)).toBe(false);
    // y desbloquear a B sin aprobación tampoco es posible (paso 2 del ataque)
    expect((await unblock(ta, b.id)).status).toBe(409);
    expect((await h.db("users").where({ id: b.id }).first()).status).toBe("blocked");
  });

  it("DESBLOQUEO_ADMIN: desbloquear a otra cuenta admin exige la aprobación de otro admin (user.unblock_admin)", async () => {
    const a = await mkAdmin("unb-a");
    const b = await mkAdmin("unb-b");
    const c = await mkAdmin("unb-c");
    await block(b.id);
    const ta = await tokenOf(a);
    const direct = await unblock(ta, b.id);
    expect(direct.status).toBe(403);
    expect(direct.body.error).toBe("second_admin_required");
    expect((await h.db("users").where({ id: b.id }).first()).status).toBe("blocked");
    const id = await approvedOp("user.unblock_admin", ta, await tokenOf(c), b);
    const ok = await unblock(ta, b.id, { operationId: id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.db("users").where({ id: b.id }).first()).status).toBe("active");
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("done");
  });

  it("LINAJE_CADENA_X_Y: A → X → Y; ni A aprueba lo de X, ni Y lo de A (S9), a cualquier profundidad", async () => {
    const a = await mkAdmin("s9-a");
    const ta = await tokenOf(a);
    const x = await register("s9-x");
    expect((await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW })).status).toBe(200); // bootstrap
    const tx = await tokenOf(x);
    const z = await mkAdmin("s9-z"); // admin real (alta por consola)
    const y = await register("s9-y");
    // X pide conceder admin a Y: con sólo A (su promotor) no hay aprobador; con Z sí
    const op = await createOp(tx, "user.grant_admin", y.id);
    expect(op.status, JSON.stringify(op.body)).toBe(201); // Z disponible
    const byA = await confirmOp(ta, op.body.operation.id, op.body.operation.confirmPhrase);
    expect(byA.status).toBe(403); // A es ANCESTRO de X: S9 paso 2 detenido
    expect((await confirmOp(await tokenOf(z), op.body.operation.id, op.body.operation.confirmPhrase)).status).toBe(200);
    const ok = await putRoles(tx, y.id, {
      roles: ["user", "developer", "admin"],
      password: PW,
      operationId: op.body.operation.id,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.db("users").where({ id: y.id }).first()).admin_granted_by).toBe(x.id);
    const ty = await tokenOf(y);
    // 3 niveles: Y (nieto de A) no aprueba lo de A, y A (abuelo de Y) no aprueba lo de Y
    const v = await mkAdmin("s9-v");
    const opA = await createOp(ta, "user.recovery_admin", v.id);
    expect(opA.status, JSON.stringify(opA.body)).toBe(201);
    expect((await confirmOp(ty, opA.body.operation.id, opA.body.operation.confirmPhrase)).status).toBe(403);
    expect((await confirmOp(await tokenOf(z), opA.body.operation.id, opA.body.operation.confirmPhrase)).status).toBe(
      200,
    );
    const w = await mkAdmin("s9-w");
    const opY = await createOp(ty, "user.recovery_admin", w.id);
    expect(opY.status, JSON.stringify(opY.body)).toBe(201);
    expect((await confirmOp(ta, opY.body.operation.id, opY.body.operation.confirmPhrase)).status).toBe(403);
    expect((await confirmOp(tx, opY.body.operation.id, opY.body.operation.confirmPhrase)).status).toBe(403);
    expect((await confirmOp(await tokenOf(z), opY.body.operation.id, opY.body.operation.confirmPhrase)).status).toBe(
      200,
    );
  });

  it("LINAJE_SIN_APROBADOR: si sólo queda gente del linaje, no se puede ni CREAR la orden (409), ni siquiera con un nieto", async () => {
    const a = await mkAdmin("lsa-a");
    const ta = await tokenOf(a);
    const x = await register("lsa-x");
    expect((await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW })).status).toBe(200);
    const t = await mkAdmin("lsa-t");
    // aprobadores posibles para A: X (descendiente) y T (objetivo): ninguno
    const r = await createOp(ta, "user.recovery_admin", t.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
    // para X: A (ancestro) y T (objetivo): tampoco
    const r2 = await createOp(await tokenOf(x), "user.recovery_admin", t.id);
    expect(r2.status).toBe(409);
  });

  it("LINAJE_NO_CONSUME: aunque un ancestro o descendiente figure como confirmador (p. ej. por SQL), emitir el token rechaza la aprobación", async () => {
    const a = await mkAdmin("lnc-a");
    const ta = await tokenOf(a);
    const x = await register("lnc-x");
    await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW }); // bootstrap
    const z = await mkAdmin("lnc-z");
    const t = await mkAdmin("lnc-t");
    const tx = await tokenOf(x);
    const op = await createOp(tx, "user.recovery_admin", t.id);
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    await confirmOp(await tokenOf(z), op.body.operation.id, op.body.operation.confirmPhrase);
    await h.db.raw("ALTER TABLE admin_operations DISABLE TRIGGER admin_operations_guard");
    await h.db("admin_operations").where({ id: op.body.operation.id }).update({ confirmed_by: a.id });
    await h.db.raw("ALTER TABLE admin_operations ENABLE TRIGGER admin_operations_guard");
    const r = await issue(tx, t.id, { password: PW, operationId: op.body.operation.id });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_approval_invalid");
  });

  it("LINAJE_SE_CONSERVA: quitar el rol admin a un promovido NO borra su linaje (no se puede «blanquear»)", async () => {
    const a = await mkAdmin("lsc-a");
    const ta = await tokenOf(a);
    const x = await register("lsc-x");
    await putRoles(ta, x.id, { roles: ["user", "admin"], password: PW }); // bootstrap
    const tx = await tokenOf(x);
    // X se quita el rol a sí mismo (hay otro admin: A)
    expect((await putRoles(tx, x.id, { roles: ["user", "developer"], password: PW })).status).toBe(200);
    expect((await h.db("users").where({ id: x.id }).first()).admin_granted_by).toBe(a.id);
  });
});
