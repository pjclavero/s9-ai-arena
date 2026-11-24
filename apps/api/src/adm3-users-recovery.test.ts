/**
 * V1 ADM-3 · Usuarios operables desde la web y recuperación de cuentas (B5, D-OP-8) contra PostgreSQL REAL.
 *
 * Cada caso lleva su mutante en `scripts/adm3-mutants.py` (se pone en rojo sin la garantía que prueba).
 * Pruebas de contrato HTTP: supertest sobre `createApp` real, con límites inyectados holgados salvo en los casos
 * que prueban el propio límite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { hashToken } from "./auth/tokens.js";
import { RECOVERY_APPROVAL_WINDOW_MS, RECOVERY_TTL_MS } from "./services/account-recovery.js";

let h: TestDbHandle;
let app: Express;
let resetLimiter: SlidingWindowLimiter;
let usersLimiter: SlidingWindowLimiter;

const PW = "password-larga-adm3-1";
const NEWPW = "contrasena-nueva-adm3-2";

beforeAll(async () => {
  h = await startTestDb();
  resetLimiter = new SlidingWindowLimiter(1000, 60_000);
  usersLimiter = new SlidingWindowLimiter(1000, 60_000);
  app = createApp({
    db: h.db,
    loginGuard: new FailedLoginGuard(1000, 60_000),
    loginLimiter: new SlidingWindowLimiter(1000, 60_000),
    registerLimiter: new SlidingWindowLimiter(1000, 60_000),
    refreshLimiter: new SlidingWindowLimiter(1000, 60_000),
    adminConfirmLimiter: new SlidingWindowLimiter(1000, 60_000),
    // Indirección: cada caso puede sustituir el limitador sin recrear la app.
    resetLimiter: { hit: (k: string) => resetLimiter.hit(k) },
    adminUsersLimiter: { hit: (k: string) => usersLimiter.hit(k) },
  });
}, 120_000);
afterAll(async () => {
  await h.stop();
});

let tagN = 0;
let auditFloor = 0;
beforeEach(async () => {
  // Cada caso parte sin administradores y sin órdenes: los crea él (la guarda del último admin depende de ello).
  await h.db("user_roles").where({ role: "admin" }).delete();
  await h.db("admin_operations").delete();
  auditFloor = Number((await h.db("audit_log").max({ m: "id" }).first())?.m ?? 0);
  resetLimiter = new SlidingWindowLimiter(1000, 60_000);
  usersLimiter = new SlidingWindowLimiter(1000, 60_000);
});

interface TUser {
  id: string;
  email: string;
  name: string;
}

async function mkUser(label: string, roles: string[] = ["user", "developer"], displayName?: string): Promise<TUser> {
  const email = `adm3-${label}-${++tagN}@test.local`.toLowerCase();
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: await hashPassword(PW), display_name: displayName ?? `Adm3 ${label} ${tagN}` })
    .returning("id");
  await h.db("user_roles").insert(roles.map((role) => ({ user_id: u.id, role })));
  return { id: u.id, email, name: displayName ?? `Adm3 ${label} ${tagN}` };
}
const mkAdmin = (label: string) => mkUser(label, ["user", "developer", "admin"]);

const login = (u: TUser, password = PW) => request(app).post("/auth/login").send({ email: u.email, password });
async function tokenOf(u: TUser): Promise<string> {
  const r = await login(u);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}
const listUsers = (t: string, qs = "") => request(app).get(`/admin/users${qs}`).set("Authorization", `Bearer ${t}`);
const setStatus = (t: string, id: string, body: Record<string, unknown>) =>
  request(app).put(`/admin/users/${id}/status`).set("Authorization", `Bearer ${t}`).send(body);
const issue = (t: string, id: string, body: Record<string, unknown> = { password: PW }) =>
  request(app).post(`/admin/users/${id}/recovery-token`).set("Authorization", `Bearer ${t}`).send(body);
const reset = (token: unknown, newPassword: unknown) => request(app).post("/auth/reset").send({ token, newPassword });
const audits = async (like: string) =>
  (await h.db("audit_log").where("action", "like", like).where("id", ">", auditFloor).orderBy("id")) as {
    action: string;
    target: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
  }[];

describe("ADM-3 · permisos (RBAC)", () => {
  it("SOLO_ADMIN: anónimo 401; user/organizer/moderator 403 en las tres operaciones nuevas, sin efecto alguno", async () => {
    const target = await mkUser("target");
    expect((await request(app).get("/admin/users")).status).toBe(401);
    for (const role of ["user", "organizer", "moderator"]) {
      const u = await mkUser(`rbac-${role}`, [...new Set(["user", role])]);
      const t = await tokenOf(u);
      expect((await listUsers(t)).status, `GET /admin/users como ${role}`).toBe(403);
      expect((await setStatus(t, target.id, { status: "blocked", password: PW })).status, `status como ${role}`).toBe(
        403,
      );
      expect((await issue(t, target.id)).status, `recovery-token como ${role}`).toBe(403);
    }
    expect((await h.db("users").where({ id: target.id }).first()).status).toBe("active");
    expect(await h.db("password_resets").where({ user_id: target.id }).count({ n: "*" }).first()).toMatchObject({
      n: "0",
    });
  });
});

describe("ADM-3 · listado de usuarios", () => {
  it("LISTA_SIN_SECRETOS: ni hashes, ni secreto TOTP, ni códigos de recuperación; sólo los campos del contrato", async () => {
    const a = await mkAdmin("lista");
    const withTotp = await mkUser("conTotp");
    await h
      .db("users")
      .where({ id: withTotp.id })
      .update({ totp_secret: "JBSWY3DPEHPK3PXP", recovery_codes: JSON.stringify(["deadbeefcode"]) });
    const r = await listUsers(await tokenOf(a), `?q=${encodeURIComponent(withTotp.email)}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const item = r.body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "blockedAt",
        "createdAt",
        "displayName",
        "email",
        "id",
        "recoveryPending",
        "roles",
        "status",
        "twoFactorEnabled",
      ].sort(),
    );
    expect(item.twoFactorEnabled).toBe(true);
    const all = JSON.stringify((await listUsers(await tokenOf(a), "?limit=100")).body);
    expect(all).not.toContain("$argon2");
    expect(all).not.toContain("JBSWY3DPEHPK3PXP");
    expect(all).not.toContain("deadbeefcode");
    expect(all).not.toMatch(/password_hash|passwordHash|totp_secret|recovery_codes/i);
  });

  it("LISTA_BUSQUEDA: por nombre o email sin distinguir mayúsculas; «%» y «_» son literales; q larguísima = 400", async () => {
    const a = await mkAdmin("busca");
    const t = await tokenOf(a);
    const u1 = await mkUser("uno", ["user"], "Zelda Búsqueda");
    const u2 = await mkUser("dos", ["user"], "Descuento 100%real");
    const u3 = await mkUser("tres", ["user"], "Guion_bajo Único");
    const ids = async (q: string) =>
      (await listUsers(t, `?q=${encodeURIComponent(q)}`)).body.items.map((x: { id: string }) => x.id).sort();
    expect(await ids("zELDA")).toEqual([u1.id]);
    expect(await ids(u2.email.toUpperCase())).toEqual([u2.id]);
    expect(await ids("%")).toEqual([u2.id]); // sólo el que lleva un «%» de verdad
    expect(await ids("_")).toEqual([u3.id].sort()); // el «_» de su nombre; los emails del test usan «-»
    expect((await listUsers(t, `?q=${"x".repeat(101)}`)).status).toBe(400);
    expect((await listUsers(t, "?cursor=no-es-un-cursor")).status).toBe(400);
  });

  it("LISTA_PAGINA: páginas por cursor sin repetir ni perder a nadie", async () => {
    const a = await mkAdmin("pagina");
    const t = await tokenOf(a);
    for (let i = 0; i < 5; i++) await mkUser(`pg${i}`, ["user"], `Paginado ${i}`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const qs = `?q=Paginado&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await listUsers(t, qs);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.items.map((x: { id: string }) => x.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("LISTA_ESTADO: refleja roles, bloqueo y token de recuperación pendiente", async () => {
    const a = await mkAdmin("estado");
    const t = await tokenOf(a);
    const u = await mkUser("estado-u", ["user", "organizer"]);
    expect((await issue(t, u.id)).status).toBe(201);
    const item = (await listUsers(t, `?q=${encodeURIComponent(u.email)}`)).body.items[0];
    expect(item.roles).toEqual(["organizer", "user"]);
    expect(item.recoveryPending).toBe(true);
    expect(item.status).toBe("active");
  });
});

describe("ADM-3 · roles y última cuenta admin", () => {
  it("ULTIMO_ADMIN_ROLES: quitarse «admin» siendo el último administrador activo es 409; con otro activo, sí", async () => {
    const a = await mkAdmin("ultimo-a");
    const b = await mkAdmin("ultimo-b");
    const ta = await tokenOf(a);
    const selfRevoke = (t: string, id: string) =>
      request(app)
        .put(`/users/${id}/roles`)
        .set("Authorization", `Bearer ${t}`)
        .send({ roles: ["user"], password: PW });
    // b bloqueado a mano: «a» pasa a ser el único ADMIN ACTIVO
    await h.db("users").where({ id: b.id }).update({ status: "blocked", blocked_at: new Date() });
    const r = await selfRevoke(ta, a.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("last_admin");
    expect(await h.db("user_roles").where({ user_id: a.id, role: "admin" }).first()).toBeTruthy();
    // con b activo, «a» puede quitarse el rol a sí mismo (reautenticado)...
    await h.db("users").where({ id: b.id }).update({ status: "active", blocked_at: null });
    expect((await selfRevoke(ta, a.id)).status).toBe(200);
    // ...y ahora b es el último: tampoco puede
    expect((await selfRevoke(await tokenOf(b), b.id)).status).toBe(409);
  });

  it("ROLES_AUDITADOS: asignar roles sigue auditado con quien lo hizo", async () => {
    const a = await mkAdmin("roles-aud");
    const u = await mkUser("roles-aud-u");
    const r = await request(app)
      .put(`/users/${u.id}/roles`)
      .set("Authorization", `Bearer ${await tokenOf(a)}`)
      .send({ roles: ["user", "organizer"] });
    expect(r.status).toBe(200);
    const rows = (await audits("admin.user.roles_set")).filter((x) => x.target === `user:${u.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(a.id);
  });
});

describe("ADM-3 · bloqueo y desbloqueo", () => {
  it("BLOQUEO_REAUTH: sin contraseña o con una errónea, 401 y NO se bloquea", async () => {
    const a = await mkAdmin("bl-reauth");
    const u = await mkUser("bl-reauth-u");
    const t = await tokenOf(a);
    expect((await setStatus(t, u.id, { status: "blocked" })).status).toBe(401);
    expect((await setStatus(t, u.id, { status: "blocked", password: "otra-contraseña-larga" })).status).toBe(401);
    expect((await h.db("users").where({ id: u.id }).first()).status).toBe("active");
    expect(await audits("admin.user.blocked")).toHaveLength(0);
  });

  it("BLOQUEO_EFECTOS: no entra (login 403 y refresh), cierra sesiones, anula tokens abiertos y deja auditoría", async () => {
    const a = await mkAdmin("bl-efectos");
    const u = await mkUser("bl-efectos-u");
    const ta = await tokenOf(a);
    const s1 = await login(u);
    const s2 = await login(u);
    expect(s1.status).toBe(200);
    expect((await issue(ta, u.id)).status).toBe(201);
    const r = await setStatus(ta, u.id, { status: "blocked", password: PW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "blocked", changed: true, sessionsRevoked: 2 });
    // sesiones vivas ya no valen
    expect((await request(app).get("/users/me").set("Authorization", `Bearer ${s1.body.accessToken}`)).status).toBe(
      401,
    );
    expect((await request(app).post("/auth/refresh").send({ refreshToken: s2.body.refreshToken })).status).toBe(401);
    // con la contraseña correcta, el login es un 403 explícito (no abre sesión)
    const l = await login(u);
    expect(l.status).toBe(403);
    expect(l.body.error).toBe("account_blocked");
    expect(l.body.accessToken).toBeUndefined();
    // con una contraseña errónea sigue siendo el 401 genérico: el bloqueo no se revela sin la contraseña
    expect((await login(u, "mala-contraseña-larga-1")).status).toBe(401);
    // el token de recuperación abierto quedó anulado
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({
      n: "0",
    });
    const row = (await audits("admin.user.blocked"))[0];
    expect(row).toMatchObject({ target: `user:${u.id}`, actor_id: a.id });
  });

  it("REFRESH_BLOQUEADO: una cuenta bloqueada no rota tokens aunque su sesión siguiera viva (defensa en profundidad)", async () => {
    const u = await mkUser("refresh-blq");
    const s = await login(u);
    expect(s.status).toBe(200);
    // bloqueo «a mano»: sin cerrar la sesión, para probar la guarda propia del refresh
    await h.db("users").where({ id: u.id }).update({ status: "blocked", blocked_at: new Date() });
    const r = await request(app).post("/auth/refresh").send({ refreshToken: s.body.refreshToken });
    expect(r.status).toBe(401);
  });

  it("DESBLOQUEO: vuelve a entrar y queda auditado; repetir la orden no cambia nada ni audita de nuevo", async () => {
    const a = await mkAdmin("desbloq");
    const u = await mkUser("desbloq-u");
    const ta = await tokenOf(a);
    await setStatus(ta, u.id, { status: "blocked", password: PW });
    const again = await setStatus(ta, u.id, { status: "blocked", password: PW });
    expect(again.body).toMatchObject({ status: "blocked", changed: false });
    expect(await audits("admin.user.blocked")).toHaveLength(1);
    const r = await setStatus(ta, u.id, { status: "active", password: PW });
    expect(r.body).toMatchObject({ status: "active", changed: true });
    expect((await login(u)).status).toBe(200);
    const un = await audits("admin.user.unblocked");
    expect(un).toHaveLength(1);
    expect(un[0].actor_id).toBe(a.id);
    const row = await h.db("users").where({ id: u.id }).first();
    expect(row.blocked_at).toBeNull();
  });

  it("BLOQUEO_NO_A_UNO_MISMO: un admin no se bloquea ni se desbloquea a sí mismo (403)", async () => {
    const a = await mkAdmin("bl-self");
    await mkAdmin("bl-self-otro");
    const t = await tokenOf(a);
    expect((await setStatus(t, a.id, { status: "blocked", password: PW })).status).toBe(403);
    expect((await h.db("users").where({ id: a.id }).first()).status).toBe("active");
  });

  it("BLOQUEO_ULTIMO_ADMIN: nunca se deja el sistema sin un administrador ACTIVO (409), y con otro activo se puede", async () => {
    const { setUserStatus } = await import("./services/account-recovery.js");
    const a = await mkAdmin("bl-ultimo-a");
    const b = await mkAdmin("bl-ultimo-b");
    const ta = await tokenOf(a);
    // con dos activos, bloquear a b es legal
    expect((await setStatus(ta, b.id, { status: "blocked", password: PW })).status).toBe(200);
    // ahora «a» es el único activo: un actor distinto (cuya sesión se acaba de ver bloqueada por otra vía) no puede
    // bloquearlo; la guarda es del SERVICIO, no de quién llame
    const actor = await mkUser("bl-ultimo-actor", ["user"]);
    await expect(setUserStatus(h.db, { actorId: actor.id }, a.id, "blocked")).rejects.toMatchObject({
      status: 409,
      code: "last_admin",
    });
    expect((await h.db("users").where({ id: a.id }).first()).status).toBe("active");
    // desbloquear a b devuelve a dos activos y entonces sí se puede bloquear a «a»
    await setUserStatus(h.db, { actorId: actor.id }, b.id, "active");
    await expect(setUserStatus(h.db, { actorId: actor.id }, a.id, "blocked")).resolves.toMatchObject({
      status: "blocked",
    });
  });

  it("BLOQUEO_ENTRADAS: id que no es uuid o inexistente 404; estado desconocido 400", async () => {
    const a = await mkAdmin("bl-entradas");
    const u = await mkUser("bl-entradas-u");
    const t = await tokenOf(a);
    expect((await setStatus(t, "no-es-uuid", { status: "blocked", password: PW })).status).toBe(404);
    expect(
      (await setStatus(t, "00000000-0000-4000-8000-000000000000", { status: "blocked", password: PW })).status,
    ).toBe(404);
    expect((await setStatus(t, u.id, { status: "dormido", password: PW })).status).toBe(400);
    expect((await setStatus(t, u.id, { password: PW })).status).toBe(400);
  });

  it("LIMITE_ACCIONES: las acciones con reautenticación tienen límite de intentos por admin (429)", async () => {
    usersLimiter = new SlidingWindowLimiter(3, 60_000);
    const a = await mkAdmin("limite");
    const u = await mkUser("limite-u");
    const t = await tokenOf(a);
    for (let i = 0; i < 3; i++) {
      expect((await setStatus(t, u.id, { status: "blocked", password: "mala-contraseña-larga" })).status).toBe(401);
    }
    const r = await setStatus(t, u.id, { status: "blocked", password: PW });
    expect(r.status).toBe(429);
    expect((await h.db("users").where({ id: u.id }).first()).status).toBe("active");
    // el límite es POR ADMIN: otro administrador no se ve afectado
    const other = await mkAdmin("limite-otro");
    expect((await setStatus(await tokenOf(other), u.id, { status: "blocked", password: PW })).status).toBe(200);
  });
});

describe("ADM-3 · token de recuperación", () => {
  it("TOKEN_EMISION: 201, se muestra una vez (no-store), 30 min, SÓLO el hash en BD y sin el token en la auditoría", async () => {
    const a = await mkAdmin("emite");
    const u = await mkUser("emite-u");
    const r = await issue(await tokenOf(a), u.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const token = r.body.token as string;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(r.body.userId).toBe(u.id);
    const row = await h.db("password_resets").where({ user_id: u.id }).first();
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const ttl = new Date(row.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(RECOVERY_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(RECOVERY_TTL_MS + 1000);
    expect(RECOVERY_TTL_MS).toBe(30 * 60_000);
    expect(row.created_by).toBe(a.id);
    // ni la auditoría ni ninguna otra fila de audit_log contienen el token
    const everything = JSON.stringify(await h.db("audit_log").where("id", ">", auditFloor));
    expect(everything).not.toContain(token);
    const rows = (await audits("admin.user.recovery_token_issued")).filter((x) => x.target === `user:${u.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(a.id);
  });

  it("TOKEN_REAUTH: sin credenciales frescas 401, sin fila ni auditoría", async () => {
    const a = await mkAdmin("emite-reauth");
    const u = await mkUser("emite-reauth-u");
    const t = await tokenOf(a);
    expect((await issue(t, u.id, {})).status).toBe(401);
    expect((await issue(t, u.id, { password: "mala-contraseña-larga" })).status).toBe(401);
    expect(await h.db("password_resets").where({ user_id: u.id }).count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect((await audits("admin.user.recovery_token_issued")).filter((x) => x.target === `user:${u.id}`)).toHaveLength(
      0,
    );
  });

  it("TOKEN_CASOS: uno mismo 400, inexistente 404, bloqueada 409; ninguno crea fila", async () => {
    const a = await mkAdmin("emite-casos");
    const u = await mkUser("emite-casos-u");
    const t = await tokenOf(a);
    expect((await issue(t, a.id)).status).toBe(400);
    expect((await issue(t, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await issue(t, "no-uuid")).status).toBe(404);
    await h.db("users").where({ id: u.id }).update({ status: "blocked", blocked_at: new Date() });
    const r = await issue(t, u.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("account_blocked");
    expect(await h.db("password_resets").count({ n: "*" }).first()).toMatchObject({ n: expect.any(String) });
    expect(await h.db("password_resets").where({ user_id: u.id }).count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it("TOKEN_UN_SOLO_USO: el canje funciona UNA vez, también con dos canjes simultáneos", async () => {
    const a = await mkAdmin("uso");
    const u = await mkUser("uso-u");
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    const [r1, r2, r3] = await Promise.all([
      reset(token, NEWPW),
      reset(token, "otra-contrasena-nueva-3"),
      reset(token, "otra-contrasena-nueva-4"),
    ]);
    const statuses = [r1.status, r2.status, r3.status].sort();
    expect(statuses).toEqual([204, 401, 401]);
    // la contraseña vigente es la del canje ganador y sólo una
    const winner = [r1, r2, r3].findIndex((r) => r.status === 204);
    const pw = [NEWPW, "otra-contrasena-nueva-3", "otra-contrasena-nueva-4"][winner];
    expect(await verifyPassword((await h.db("users").where({ id: u.id }).first()).password_hash, pw)).toBe(true);
    // y repetirlo después sigue siendo 401
    expect((await reset(token, "otra-contrasena-nueva-5")).status).toBe(401);
  });

  it("TOKEN_CADUCA: pasados 30 min el canje es 401 y no cambia nada", async () => {
    const a = await mkAdmin("caduca");
    const u = await mkUser("caduca-u");
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    await h
      .db("password_resets")
      .where({ user_id: u.id })
      .update({ expires_at: new Date(Date.now() - 1000) });
    const r = await reset(token, NEWPW);
    expect(r.status).toBe(401);
    expect((await login(u)).status).toBe(200); // la contraseña vieja sigue valiendo
  });

  it("TOKEN_REVOCA_ANTERIORES: emitir uno nuevo anula el anterior del mismo usuario", async () => {
    const a = await mkAdmin("revoca");
    const u = await mkUser("revoca-u");
    const t = await tokenOf(a);
    const first = (await issue(t, u.id)).body.token as string;
    const second = (await issue(t, u.id)).body.token as string;
    expect(first).not.toBe(second);
    expect((await reset(first, NEWPW)).status).toBe(401);
    expect((await reset(second, NEWPW)).status).toBe(204);
  });

  it("CANJE_REVOCA_SESIONES: cierra TODAS las sesiones, sirve la contraseña nueva y no la vieja, y queda auditado", async () => {
    const a = await mkAdmin("canje");
    const u = await mkUser("canje-u");
    const s1 = await login(u);
    const s2 = await login(u);
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    const r = await reset(token, NEWPW);
    expect(r.status).toBe(204);
    expect(
      await h.db("sessions").where({ user_id: u.id }).whereNull("revoked_at").count({ n: "*" }).first(),
    ).toMatchObject({
      n: "0",
    });
    expect((await request(app).get("/users/me").set("Authorization", `Bearer ${s1.body.accessToken}`)).status).toBe(
      401,
    );
    expect((await request(app).post("/auth/refresh").send({ refreshToken: s2.body.refreshToken })).status).toBe(401);
    expect((await login(u, PW)).status).toBe(401);
    expect((await login(u, NEWPW)).status).toBe(200);
    const rows = (await audits("auth.password.reset")).filter((x) => x.target === `user:${u.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(u.id);
    expect(rows[0].detail).toMatchObject({ sessionsRevoked: expect.any(Number), issuedBy: a.id });
    expect(JSON.stringify(await h.db("audit_log").where("id", ">", auditFloor))).not.toContain(NEWPW);
  });

  it("CANJE_NO_ELUDE_2FA: tras canjear, la cuenta con 2FA sigue exigiendo el segundo factor", async () => {
    const a = await mkAdmin("canje2fa");
    const u = await mkUser("canje2fa-u");
    await h.db("users").where({ id: u.id }).update({ totp_secret: "JBSWY3DPEHPK3PXP" });
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    expect((await reset(token, NEWPW)).status).toBe(204);
    expect((await login(u, NEWPW)).status).toBe(401); // sin TOTP no entra
    expect((await h.db("users").where({ id: u.id }).first()).totp_secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("POLITICA_CONTRASENAS: la política única se aplica al canje y un rechazo NO consume el token", async () => {
    const a = await mkAdmin("politica");
    const u = await mkUser("politica-u");
    const token = (await issue(await tokenOf(a), u.id)).body.token as string;
    for (const bad of ["corta", "a".repeat(11), "", undefined, 123456789012, null]) {
      const r = await reset(token, bad);
      expect(r.status, String(bad)).toBe(400);
    }
    expect((await reset(undefined, NEWPW)).status).toBe(400);
    expect((await reset("", NEWPW)).status).toBe(400);
    const row = await h
      .db("password_resets")
      .where({ token_hash: hashToken(token) })
      .first();
    expect(row.used_at).toBeNull();
    expect((await reset(token, "a".repeat(12))).status).toBe(204);
  });

  it("NO_ENUMERACION: token inexistente, ya usado, caducado y de cuenta bloqueada dan EXACTAMENTE la misma respuesta", async () => {
    const a = await mkAdmin("enum");
    const t = await tokenOf(a);
    const used = await mkUser("enum-used");
    const expired = await mkUser("enum-exp");
    const blocked = await mkUser("enum-blk");
    const usedTok = (await issue(t, used.id)).body.token as string;
    await reset(usedTok, NEWPW);
    const expTok = (await issue(t, expired.id)).body.token as string;
    await h
      .db("password_resets")
      .where({ user_id: expired.id })
      .update({ expires_at: new Date(Date.now() - 1000) });
    const blkTok = (await issue(t, blocked.id)).body.token as string;
    await h.db("users").where({ id: blocked.id }).update({ status: "blocked", blocked_at: new Date() }); // a mano: el token sigue abierto
    const responses = [
      await reset("token-que-no-existe-nunca-jamas-1234567890", NEWPW),
      await reset(usedTok, NEWPW),
      await reset(expTok, NEWPW),
      await reset(blkTok, NEWPW),
    ];
    for (const r of responses) expect(r.status).toBe(401);
    expect(new Set(responses.map((r) => JSON.stringify({ error: r.body.error, message: r.body.message }))).size).toBe(
      1,
    );
    // la cuenta bloqueada no cambió su contraseña y el token NO se consumió (el canje se deshizo)
    expect(await verifyPassword((await h.db("users").where({ id: blocked.id }).first()).password_hash, PW)).toBe(true);
    expect(
      (
        await h
          .db("password_resets")
          .where({ token_hash: hashToken(blkTok) })
          .first()
      ).used_at,
    ).toBeNull();
  });

  it("RECOVER_RETIRADO: POST /auth/recover ya no existe (404 idéntico exista o no la cuenta) y no crea tokens", async () => {
    const u = await mkUser("recover");
    const before = await h.db("password_resets").count({ n: "*" }).first();
    const r1 = await request(app).post("/auth/recover").send({ email: u.email });
    const r2 = await request(app).post("/auth/recover").send({ email: "no-existe-nadie@test.local" });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect({ error: r1.body.error, message: r1.body.message }).toEqual({
      error: r2.body.error,
      message: r2.body.message,
    });
    expect(await h.db("password_resets").count({ n: "*" }).first()).toEqual(before);
  });

  it("RATE_LIMIT_RESET: el canje tiene límite de intentos por IP (429)", async () => {
    resetLimiter = new SlidingWindowLimiter(3, 60_000);
    for (let i = 0; i < 3; i++)
      expect((await reset("token-inexistente-" + i + "x".repeat(20), NEWPW)).status).toBe(401);
    const r = await reset("token-inexistente-final" + "x".repeat(20), NEWPW);
    expect(r.status).toBe(429);
  });
});

describe("ADM-3 · cuenta admin ⇒ segundo administrador", () => {
  async function flow() {
    const a = await mkAdmin("sa-a");
    const b = await mkAdmin("sa-b");
    const target = await mkAdmin("sa-t");
    return { a, b, target, ta: await tokenOf(a), tb: await tokenOf(b) };
  }
  const createOp = (t: string, userId: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post("/admin/operations")
      .set("Authorization", `Bearer ${t}`)
      .send({ kind: "user.recovery_admin", params: { userId }, password: PW, ...extra });
  const confirmOp = (t: string, id: string, phrase: string, password = PW) =>
    request(app).post(`/admin/operations/${id}/confirm`).set("Authorization", `Bearer ${t}`).send({ phrase, password });

  it("ADMIN_EXIGE_SEGUNDO: sin aprobación (o con una que no vale) la cuenta admin NO recibe token", async () => {
    const { a, target, ta } = await flow();
    const r = await issue(ta, target.id);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("second_admin_required");
    // orden creada pero SIN confirmar
    const op = await createOp(ta, target.id);
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    expect(op.body.confirmToken).toBeNull();
    expect(op.body.operation.requiresSecondAdmin).toBe(true);
    const r2 = await issue(ta, target.id, { password: PW, operationId: op.body.operation.id });
    expect(r2.status).toBe(403);
    expect(r2.body.error).toBe("second_admin_approval_invalid");
    // un operationId que no es uuid tampoco abre nada
    expect((await issue(ta, target.id, { password: PW, operationId: "x'; --" })).status).toBe(403);
    expect(await h.db("password_resets").where({ user_id: target.id }).count({ n: "*" }).first()).toMatchObject({
      n: "0",
    });
    expect(
      (await audits("admin.user.recovery_token_issued")).filter((x) => x.target === `user:${target.id}`),
    ).toHaveLength(0);
    void a;
  });

  it("ADMIN_SEGUNDO_FLUJO: A solicita, B (otro admin) aprueba, A emite; la aprobación se gasta UNA vez; el canje cierra sesiones", async () => {
    const { a, b, target, ta, tb } = await flow();
    const sess = await login(target);
    const op = await createOp(ta, target.id);
    const id = op.body.operation.id as string;
    const phrase = op.body.operation.confirmPhrase as string;
    expect(phrase).toMatch(/^RECUPERAR ADMIN [0-9a-f]{8}$/);
    // el propio solicitante NO puede aprobarla
    expect((await confirmOp(ta, id, phrase)).status).toBe(403);
    // B aprueba (frase + reautenticación)
    expect((await confirmOp(tb, id, phrase, "mala-contraseña-larga")).status).toBe(401);
    expect((await confirmOp(tb, id, phrase)).status).toBe(200);
    // sólo quien la solicitó puede consumirla: B no
    const byB = await issue(tb, target.id, { password: PW, operationId: id });
    expect(byB.status).toBe(403);
    expect(byB.body.error).toBe("second_admin_approval_invalid");
    // ni un TERCER admin que no la solicitó ni la confirmó
    const c = await mkAdmin("sa-c");
    const byC = await issue(await tokenOf(c), target.id, { password: PW, operationId: id });
    expect(byC.status).toBe(403);
    expect(byC.body.error).toBe("second_admin_approval_invalid");
    // A emite
    const r = await issue(ta, target.id, { password: PW, operationId: id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = await h.db("password_resets").where({ user_id: target.id }).first();
    expect(row.issued_via_operation).toBe(id);
    expect(row.created_by).toBe(a.id);
    const opRow = await h.db("admin_operations").where({ id }).first();
    expect(opRow.status).toBe("done");
    expect(opRow.confirmed_by).toBe(b.id);
    // la aprobación no se reutiliza
    const again = await issue(ta, target.id, { password: PW, operationId: id });
    expect(again.status).toBe(403);
    // canjear cierra las sesiones de la cuenta admin
    expect((await reset(r.body.token, NEWPW)).status).toBe(204);
    expect((await request(app).get("/users/me").set("Authorization", `Bearer ${sess.body.accessToken}`)).status).toBe(
      401,
    );
    expect((await login(target, NEWPW)).status).toBe(200);
    const rows = await audits("admin.user.recovery_token_issued");
    expect(rows.find((x) => x.target === `user:${target.id}`)?.detail).toMatchObject({ secondAdminOperation: id });
  });

  it("ADMIN_APROBACION_ATADA: vale sólo para la cuenta aprobada, y caduca", async () => {
    const { a, b, target, ta, tb } = await flow();
    const other = await mkAdmin("sa-other");
    const op = await createOp(ta, target.id);
    const id = op.body.operation.id as string;
    await confirmOp(tb, id, op.body.operation.confirmPhrase);
    // otra cuenta admin: no vale
    const wrong = await issue(ta, other.id, { password: PW, operationId: id });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("second_admin_approval_invalid");
    // caducada (confirmada hace más de la ventana)
    await h.db.raw("ALTER TABLE admin_operations DISABLE TRIGGER admin_operations_guard");
    await h
      .db("admin_operations")
      .where({ id })
      .update({ confirmed_at: new Date(Date.now() - RECOVERY_APPROVAL_WINDOW_MS - 60_000) });
    await h.db.raw("ALTER TABLE admin_operations ENABLE TRIGGER admin_operations_guard");
    const late = await issue(ta, target.id, { password: PW, operationId: id });
    expect(late.status).toBe(403);
    expect(await h.db("password_resets").where({ user_id: target.id }).count({ n: "*" }).first()).toMatchObject({
      n: "0",
    });
    void a;
    void b;
  });

  it("ADMIN_APROBACION_CADUCADA_LIBERA: una aprobación sin consumir caducada se cancela al pedir otra (no bloquea el hueco)", async () => {
    const { target, ta, tb } = await flow();
    const op = await createOp(ta, target.id);
    await confirmOp(tb, op.body.operation.id, op.body.operation.confirmPhrase);
    // mientras está viva, una segunda solicitud del mismo tipo choca (una activa por tipo)
    expect((await createOp(ta, target.id)).status).toBe(409);
    await h.db.raw("ALTER TABLE admin_operations DISABLE TRIGGER admin_operations_guard");
    await h
      .db("admin_operations")
      .where({ id: op.body.operation.id })
      .update({ confirmed_at: new Date(Date.now() - RECOVERY_APPROVAL_WINDOW_MS - 60_000) });
    await h.db.raw("ALTER TABLE admin_operations ENABLE TRIGGER admin_operations_guard");
    const again = await createOp(ta, target.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await h.db("admin_operations").where({ id: op.body.operation.id }).first()).status).toBe("cancelled");
  });

  it("ADMIN_UNICO: con un solo administrador activo no hay segundo admin posible (409) y la vía es la CLI", async () => {
    const a = await mkAdmin("unico-a");
    const t = await tokenOf(a);
    const target = await mkUser("unico-t", ["user", "admin"]);
    await h.db("users").where({ id: target.id }).update({ status: "blocked", blocked_at: new Date() }); // admin bloqueado no cuenta
    const r = await createOp(t, target.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("second_admin_unavailable");
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it("OP_SOLO_CUENTAS_ADMIN: la orden sólo se acepta para una cuenta admin existente y con parámetros cerrados", async () => {
    const { ta } = await flow();
    const plain = await mkUser("op-plain");
    expect((await createOp(ta, plain.id)).status).toBe(400);
    expect((await createOp(ta, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await createOp(ta, "no-uuid")).status).toBe(400);
    const target = await mkAdmin("op-extra-t");
    const extra = await request(app)
      .post("/admin/operations")
      .set("Authorization", `Bearer ${ta}`)
      .send({ kind: "user.recovery_admin", params: { userId: target.id, rol: "admin" }, password: PW });
    expect(extra.status).toBe(400);
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });
});

describe("ADM-3 · CLI local (un solo administrador)", () => {
  it("CLI_SERVICIO: fija la contraseña (política única), cierra sesiones, anula tokens y audita SIN la contraseña", async () => {
    const { resetPasswordLocal, ResetPasswordCliError } = await import("./services/account-recovery.js");
    const a = await mkAdmin("cli-a");
    const u = await mkAdmin("cli-u");
    const s = await login(u);
    await issue(await tokenOf(a), u.id, { password: PW, operationId: undefined }).catch(() => undefined);
    const r = await resetPasswordLocal(h.db, { email: u.email.toUpperCase(), password: NEWPW });
    expect(r.userId).toBe(u.id);
    expect((await request(app).get("/users/me").set("Authorization", `Bearer ${s.body.accessToken}`)).status).toBe(401);
    expect((await login(u, NEWPW)).status).toBe(200);
    expect((await login(u, PW)).status).toBe(401);
    expect(
      await h.db("password_resets").where({ user_id: u.id }).whereNull("used_at").count({ n: "*" }).first(),
    ).toMatchObject({
      n: "0",
    });
    const rows = (await audits("admin.reset_password_cli")).filter((x) => x.target === `user:${u.id}`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(await h.db("audit_log").where("id", ">", auditFloor))).not.toContain(NEWPW);
    // política y cuenta inexistente
    await expect(resetPasswordLocal(h.db, { email: u.email, password: "corta" })).rejects.toBeInstanceOf(
      ResetPasswordCliError,
    );
    await expect(resetPasswordLocal(h.db, { email: "nadie@test.local", password: NEWPW })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await verifyPassword((await h.db("users").where({ id: u.id }).first()).password_hash, NEWPW)).toBe(true);
  });

  it("CLI_ARGV: la contraseña NUNCA por argv y exactamente una fuente", async () => {
    const { parseResetPasswordArgs } = await import("./db/password-input.js");
    expect(() => parseResetPasswordArgs(["a@b.test", "--password=secreta"])).toThrow(/NO se pasa por argv/);
    expect(() => parseResetPasswordArgs(["a@b.test", "--password", "secreta"])).toThrow(/NO se pasa por argv/);
    expect(() => parseResetPasswordArgs(["a@b.test", "-psecreta"])).toThrow(/NO se pasa por argv/);
    expect(() => parseResetPasswordArgs(["a@b.test"])).toThrow(/exactamente una fuente/);
    expect(() => parseResetPasswordArgs(["a@b.test", "--password-stdin", "--password-file", "/x"])).toThrow(
      /exactamente una fuente/,
    );
    expect(() => parseResetPasswordArgs(["--password-stdin"])).toThrow(/<email>/);
    expect(parseResetPasswordArgs(["a@b.test", "--password-stdin"])).toEqual({
      email: "a@b.test",
      source: { kind: "stdin" },
    });
  });
});

describe("ADM-3 · auditoría atómica", () => {
  it("AUDITORIA_ATOMICA: un fallo a medias de la emisión no deja token ni auditoría, y el bloqueo y su auditoría van juntos", async () => {
    const a = await mkAdmin("atomica");
    const t = await tokenOf(a);
    const u = await mkUser("atomica-u");
    // bloqueo: estado + sesiones + auditoría en la misma transacción
    await login(u);
    await setStatus(t, u.id, { status: "blocked", password: PW });
    expect((await h.db("users").where({ id: u.id }).first()).status).toBe("blocked");
    expect((await audits("admin.user.blocked")).filter((x) => x.target === `user:${u.id}`)).toHaveLength(1);
    // emisión: forzamos el fallo de la auditoría y comprobamos que NO queda el token
    const v = await mkUser("atomica-v");
    await h.db.raw(
      `CREATE OR REPLACE FUNCTION adm3_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`,
    );
    await h.db.raw(
      `CREATE TRIGGER adm3_boom BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'admin.user.recovery_token_issued') EXECUTE FUNCTION adm3_test_boom()`,
    );
    try {
      const r = await issue(t, v.id);
      expect(r.status).toBe(500);
      expect(await h.db("password_resets").where({ user_id: v.id }).count({ n: "*" }).first()).toMatchObject({
        n: "0",
      });
    } finally {
      await h.db.raw("DROP TRIGGER adm3_boom ON audit_log");
      await h.db.raw("DROP FUNCTION adm3_test_boom()");
    }
  });
});
