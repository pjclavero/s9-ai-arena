/**
 * ADM-1 · Órdenes administrativas y confirmación en dos pasos contra PostgreSQL REAL:
 * un no-admin no crea órdenes, tipos cerrados, token de un solo uso con caducidad, frase
 * literal, reautenticación, segundo admin para lo irreversible, ciclo de lease del ejecutor
 * (con un rol de BD de privilegios mínimos). Cada caso lleva su mutante en scripts/adm1-mutants.py.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedDev, DEV_USERS, DEV_PASSWORD } from "../db/seeds/dev.js";
import { tokenFor } from "../testing/helpers.js";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/passwords.js";
import { generateTotpSecret } from "../auth/totp.js";
import {
  claimOperation,
  completeOperation,
  extendLease,
  failOperation,
  reapExpiredLeases,
} from "./operations-consumer.js";

let h: TestDbHandle;
let app: Express;
let admin: string;
let admin2: string;
let moderator: string;
let organizer: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  // Segundo administrador (para lo irreversible).
  const [u] = await h.db("users").insert({ email: "admin2@dev.arena.local", password_hash: await hashPassword(DEV_PASSWORD), display_name: "admin2" }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "admin" });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  admin2 = await tokenFor(h.db, "admin2@dev.arena.local");
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

let auditFloor = 0;
beforeEach(async () => {
  await h.db("admin_operations").delete();
  auditFloor = Number((await h.db("audit_log").max({ m: "id" }).first())?.m ?? 0);
});
const audits = async (like = "admin.op.%") =>
  (await h.db("audit_log").where("action", "like", like).where("id", ">", auditFloor).orderBy("id")) as {
    action: string;
    target: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
  }[];

const create = (body: unknown, t: string = admin) =>
  request(app).post("/admin/operations").set("Authorization", `Bearer ${t}`).send(body as object);
const confirm = (id: string, body: Record<string, unknown>, t: string = admin) =>
  request(app).post(`/admin/operations/${id}/confirm`).set("Authorization", `Bearer ${t}`).send(body);
const destructive = { kind: "system.noop", params: { impactClass: "destructive" } };
const irreversible = { kind: "system.noop", params: { impactClass: "irreversible" } };

async function createAndTake(body: unknown, t: string = admin) {
  const r = await create(body, t);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.operation.id as string, token: r.body.confirmToken as string, phrase: r.body.operation.confirmPhrase as string };
}

describe("ADM-1 · permisos de las órdenes", () => {
  it("NO_ADMIN_NO_CREA: anónimo 401, moderador/organizador 403, y no queda NINGUNA orden ni auditoría", async () => {
    expect((await request(app).post("/admin/operations").send({ kind: "system.noop" })).status).toBe(401);
    expect((await create({ kind: "system.noop" }, moderator)).status).toBe(403);
    expect((await create(destructive, organizer)).status).toBe(403);
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(await audits()).toHaveLength(0);
    // ni leer, ni confirmar, ni cancelar
    const fake = "11111111-1111-4111-8111-111111111111";
    for (const [m, p] of [["get", "/admin/operations"], ["get", `/admin/operations/${fake}`], ["post", `/admin/operations/${fake}/cancel`], ["post", `/admin/operations/${fake}/confirm`]] as const) {
      const r = await (request(app) as never as Record<string, (u: string) => request.Test>)[m](p).set("Authorization", `Bearer ${moderator}`).send({});
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });

  it("ADMIN_CREA_Y_AUDITA: una orden sin impacto pasa directa a pending y deja `requested`", async () => {
    const r = await create({ kind: "system.noop" });
    expect(r.status).toBe(201);
    expect(r.body.confirmToken).toBeNull();
    expect(r.body.operation).toMatchObject({ kind: "system.noop", status: "pending", confirmPhrase: null });
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["admin.op.requested"]);
    expect(a[0].detail).toMatchObject({ kind: "system.noop", impactClass: "none" });
  });
});

describe("ADM-1 · tipos CERRADOS y sin parámetros de ruta ni de comando", () => {
  it("KIND_CERRADO: tipo desconocido, ruta o comando como tipo ⇒ 400 y nada insertado", async () => {
    for (const kind of ["backup.run", "rm -rf /", "../../etc/passwd", "__proto__", "constructor", "", 5, null]) {
      expect((await create({ kind }) ).status, String(kind)).toBe(400);
    }
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it("PARAMS_CERRADOS: ninguna cadena libre; parámetros ajenos o fuera del enumerado ⇒ 400", async () => {
    for (const params of [{ path: "/etc" }, { cmd: "ls" }, { impactClass: "../x" }, { impactClass: "destructive; rm" }, { impactClass: 1 }, "ruta", ["x"]]) {
      expect((await create({ kind: "system.noop", params })).status, JSON.stringify(params)).toBe(400);
    }
    expect((await create({ kind: "system.noop", extra: 1 })).status).toBe(400);
  });

  it("KIND_CHECK_EN_BD: aunque alguien se salte la API, la BD rechaza un tipo fuera de la lista", async () => {
    await expect(
      h.db("admin_operations").insert({ kind: "shell.exec", status: "pending" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("UNA_ACTIVA_POR_TIPO: segunda orden activa del mismo tipo ⇒ 409; tras cancelar la primera, vuelve a poderse", async () => {
    const first = await create({ kind: "system.noop" });
    expect(first.status).toBe(201);
    const second = await create({ kind: "system.noop" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("operation_in_progress");
    const c = await request(app).post(`/admin/operations/${first.body.operation.id}/cancel`).set("Authorization", `Bearer ${admin}`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled");
    expect((await create({ kind: "system.noop" })).status).toBe(201);
  });
});

describe("ADM-1 · confirmación en dos pasos", () => {
  it("IMPACTO_DEL_SERVIDOR: devuelve resumen calculado, frase literal y token; dryRun no crea orden", async () => {
    const r = await create({ ...destructive, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, impactClass: "destructive", confirmPhrase: "EJECUTAR system.noop destructive" });
    expect(r.body.impact.summary).toMatch(/prueba/);
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect((await audits()).map((x) => x.action)).toEqual(["admin.op.dry_run"]);

    const real = await create(destructive);
    expect(real.status).toBe(201);
    expect(real.body.operation.status).toBe("awaiting_confirmation");
    expect(typeof real.body.confirmToken).toBe("string");
    expect(real.body.confirmToken.length).toBeGreaterThanOrEqual(40);
    expect(real.body.operation.confirmPhrase).toBe("EJECUTAR system.noop destructive");
    // En BD sólo hay el HASH del token, nunca el token.
    const row = await h.db("admin_operations").where({ id: real.body.operation.id }).first();
    expect(row.confirm_token_hash).not.toBe(real.body.confirmToken);
    expect(row.confirm_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TOKEN_NO_FILTRADO: ni el listado ni el detalle ni la auditoría devuelven token ni hash", async () => {
    const { id, token } = await createAndTake(destructive);
    const list = await request(app).get("/admin/operations").set("Authorization", `Bearer ${admin}`);
    const one = await request(app).get(`/admin/operations/${id}`).set("Authorization", `Bearer ${admin}`);
    const audit = JSON.stringify(await audits());
    for (const text of [JSON.stringify(list.body), JSON.stringify(one.body), audit]) {
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/confirm_token_hash|confirmToken/);
    }
  });

  it("CONFIRMA_OK: token + frase + contraseña ⇒ pending, confirmado por quien confirma y auditado", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    const r = await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("pending");
    const adminRow = await h.db("users").where({ email: DEV_USERS.admin }).first();
    expect(r.body.confirmedBy).toBe(adminRow.id);
    expect((await audits()).map((x) => x.action)).toEqual(["admin.op.requested", "admin.op.confirmed"]);
  });

  it("TOKEN_UN_SOLO_USO: la 2.ª confirmación con el mismo token falla y no cambia nada", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })).status).toBe(200);
    const again = await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_awaiting_confirmation");
    expect((await audits("admin.op.confirmed")).length).toBe(1);
  });

  it("TOKEN_UN_SOLO_USO_CARRERA: dos confirmaciones SIMULTÁNEAS ⇒ exactamente una gana", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    const rs = await Promise.all([1, 2, 3].map(() => confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await audits("admin.op.confirmed")).length).toBe(1);
  });

  it("TOKEN_CADUCADO: pasado el plazo ⇒ 409 confirmation_expired, estado expired y auditado", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    await h.db("admin_operations").where({ id }).update({ confirm_expires_at: new Date(Date.now() - 1000) });
    const r = await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("confirmation_expired");
    const row = await h.db("admin_operations").where({ id }).first();
    expect(row.status).toBe("expired");
    expect((await audits("admin.op.expired")).length).toBe(1);
    // y la orden caducada ya no bloquea el hueco del tipo
    expect((await create(destructive)).status).toBe(201);
  });

  it("CADUCADA_LIBERA_HUECO: una confirmación pendiente caducada no impide crear otra del mismo tipo", async () => {
    const first = await createAndTake(destructive);
    await h.db("admin_operations").where({ id: first.id }).update({ confirm_expires_at: new Date(Date.now() - 1000) });
    const next = await create(destructive);
    expect(next.status).toBe(201);
    expect((await h.db("admin_operations").where({ id: first.id }).first()).status).toBe("expired");
  });

  it("TOKEN_INCORRECTO: no confirma y no consume el verdadero", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    const bad = await confirm(id, { confirmToken: "x".repeat(43), phrase, password: DEV_PASSWORD });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("confirmation_token_invalid");
    expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })).status).toBe(200);
  });

  it("FRASE_LITERAL: frase distinta (incluida otra capitalización) ⇒ 400 sin consumir el token", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    for (const bad of ["", "ejecutar system.noop destructive", "EJECUTAR system.noop", phrase + "!"]) {
      const r = await confirm(id, { confirmToken: token, phrase: bad, password: DEV_PASSWORD });
      expect(r.status, bad).toBe(400);
    }
    expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })).status).toBe(200);
  });

  it("REAUTENTICACION: sin contraseña o con contraseña errónea ⇒ 401 y el token SIGUE vivo", async () => {
    const { id, token, phrase } = await createAndTake(destructive);
    expect((await confirm(id, { confirmToken: token, phrase })).status).toBe(401);
    expect((await confirm(id, { confirmToken: token, phrase, password: "otra-contraseña" })).status).toBe(401);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("awaiting_confirmation");
    expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })).status).toBe(200);
  });

  it("REAUTENTICACION_TOTP: con 2FA activo exige el código", async () => {
    const secret = generateTotpSecret();
    await h.db("users").where({ email: DEV_USERS.admin }).update({ totp_secret: secret });
    try {
      const { id, token, phrase } = await createAndTake(destructive);
      expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD })).status).toBe(401);
      expect((await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD, totp: "000000" })).status).toBe(401);
    } finally {
      await h.db("users").where({ email: DEV_USERS.admin }).update({ totp_secret: null });
    }
  });

  it("CANCELAR: awaiting/pending se pueden cancelar; una orden ya tomada por un ejecutor no", async () => {
    const a = await createAndTake(destructive);
    expect((await request(app).post(`/admin/operations/${a.id}/cancel`).set("Authorization", `Bearer ${admin}`)).body.status).toBe("cancelled");
    // la confirmación de una cancelada falla
    expect((await confirm(a.id, { confirmToken: a.token, phrase: a.phrase, password: DEV_PASSWORD })).status).toBe(409);
    const p = await create({ kind: "system.noop" });
    await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    const c = await request(app).post(`/admin/operations/${p.body.operation.id}/cancel`).set("Authorization", `Bearer ${admin}`);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("not_cancellable");
  });

  it("ID_MALFORMADO: un id que no es uuid ⇒ 404 (no 500)", async () => {
    expect((await request(app).get("/admin/operations/no-es-uuid").set("Authorization", `Bearer ${admin}`)).status).toBe(404);
  });
});

describe("ADM-1 · segundo admin para lo irreversible", () => {
  it("SEGUNDO_ADMIN: el solicitante NO puede confirmar su propia acción irreversible; otro admin sí", async () => {
    const { id, token, phrase } = await createAndTake(irreversible, admin);
    const own = await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD }, admin);
    expect(own.status).toBe(403);
    const other = await confirm(id, { confirmToken: token, phrase, password: DEV_PASSWORD }, admin2);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const requester = await h.db("users").where({ email: DEV_USERS.admin }).first();
    const confirmer = await h.db("users").where({ email: "admin2@dev.arena.local" }).first();
    expect(other.body).toMatchObject({ requestedBy: requester.id, confirmedBy: confirmer.id, requiresSecondAdmin: true });
  });

  it("SEGUNDO_ADMIN_AUSENTE: con un único admin la irreversible se rechaza (ruta de consola)", async () => {
    await h.db("user_roles").where({ role: "admin", user_id: (await h.db("users").where({ email: "admin2@dev.arena.local" }).first()).id }).delete();
    try {
      const r = await create(irreversible);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("second_admin_unavailable");
      expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    } finally {
      await h.db("user_roles").insert({ user_id: (await h.db("users").where({ email: "admin2@dev.arena.local" }).first()).id, role: "admin" });
    }
  });
});

describe("ADM-1 · ejecutor: lease, reintentos y rol de BD mínimo", () => {
  async function pendingOp() {
    const r = await create({ kind: "system.noop" });
    return r.body.operation.id as string;
  }

  it("CICLO: pending → running (lease) → done con resultado, todo auditado", async () => {
    const id = await pendingOp();
    const c = await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    expect(c).toMatchObject({ id, kind: "system.noop", attempts: 1 });
    expect(await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-2", leaseMs: 60_000 })).toBeNull();
    expect(await completeOperation(h.db, id, "exec-1", { ok: true })).toBe(true);
    const row = await h.db("admin_operations").where({ id }).first();
    expect(row).toMatchObject({ status: "done", result: { ok: true } });
    expect((await audits()).map((x) => x.action)).toEqual(["admin.op.requested", "admin.op.started", "admin.op.succeeded"]);
  });

  it("LEASE_AJENO: otro ejecutor no puede completar, fallar ni renovar una orden que no tiene", async () => {
    const id = await pendingOp();
    await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    expect(await completeOperation(h.db, id, "intruso", {})).toBe(false);
    expect(await failOperation(h.db, id, "intruso", "x")).toBe(false);
    expect(await extendLease(h.db, id, "intruso", 60_000)).toBe(false);
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("running");
    expect(await extendLease(h.db, id, "exec-1", 60_000)).toBe(true);
  });

  it("SOLO_SUS_TIPOS: un ejecutor sin el tipo no toma la orden; tipo desconocido lanza", async () => {
    await pendingOp();
    await expect(claimOperation(h.db, { kinds: ["backup.run"], owner: "e", leaseMs: 1000 })).rejects.toThrow(/desconocido/);
    await expect(claimOperation(h.db, { kinds: [], owner: "e", leaseMs: 1000 })).rejects.toThrow();
  });

  it("LEASE_CADUCADO: la orden vuelve a pending; tras maxAttempts pasa a failed", async () => {
    const id = await pendingOp();
    await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    await h.db("admin_operations").where({ id }).update({ lease_expires_at: new Date(Date.now() - 1000) });
    expect(await reapExpiredLeases(h.db, { kinds: ["system.noop"], maxAttempts: 2 })).toEqual({ requeued: 1, failed: 0 });
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("pending");
    const again = await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-2", leaseMs: 60_000 });
    expect(again?.attempts).toBe(2);
    await h.db("admin_operations").where({ id }).update({ lease_expires_at: new Date(Date.now() - 1000) });
    expect(await reapExpiredLeases(h.db, { kinds: ["system.noop"], maxAttempts: 2 })).toEqual({ requeued: 0, failed: 1 });
    expect(await h.db("admin_operations").where({ id }).first()).toMatchObject({ status: "failed", result: { error: "lease_expired" } });
  });

  it("LEASE_VIGENTE_NO_SE_RECOGE: el reaper no toca una orden con lease vivo", async () => {
    const id = await pendingOp();
    await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    expect(await reapExpiredLeases(h.db, { kinds: ["system.noop"], maxAttempts: 3 })).toEqual({ requeued: 0, failed: 0 });
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("running");
  });

  it("RESULTADO_ACOTADO: un resultado enorme se sustituye por un marcador", async () => {
    const id = await pendingOp();
    await claimOperation(h.db, { kinds: ["system.noop"], owner: "exec-1", leaseMs: 60_000 });
    await completeOperation(h.db, id, "exec-1", { blob: "x".repeat(40_000) });
    const row = await h.db("admin_operations").where({ id }).first();
    expect(row.result).toMatchObject({ truncated: true });
  });

  it("ROL_MINIMO: el ejecutor funciona con SELECT + UPDATE de columnas de estado + INSERT en audit_log, y NADA más", async () => {
    const id = await pendingOp();
    await h.db.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's9_ops_exec') THEN CREATE ROLE s9_ops_exec NOLOGIN; END IF; END $$`);
    await h.db.raw(`GRANT SELECT ON admin_operations TO s9_ops_exec`);
    await h.db.raw(`GRANT UPDATE (status, result, lease_owner, lease_expires_at, attempts, started_at, finished_at) ON admin_operations TO s9_ops_exec`);
    await h.db.raw(`GRANT INSERT ON audit_log TO s9_ops_exec`);
    await h.db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ROLE s9_ops_exec`);
      const t = trx as unknown as typeof h.db;
      const c = await claimOperation(t, { kinds: ["system.noop"], owner: "rol-minimo", leaseMs: 60_000 });
      expect(c?.id).toBe(id);
      expect(await extendLease(t, id, "rol-minimo", 60_000)).toBe(true);
      expect(await completeOperation(t, id, "rol-minimo", { ok: 1 })).toBe(true);
    });
    expect((await h.db("admin_operations").where({ id }).first()).status).toBe("done");
    // Lo que NO puede: cambiar los parámetros, quién la pidió, ni leer tablas de dominio.
    for (const sql of [
      `UPDATE admin_operations SET params = '{}'::jsonb`,
      `UPDATE admin_operations SET requested_by = NULL`,
      `UPDATE admin_operations SET kind = 'system.noop'`,
      `SELECT 1 FROM users LIMIT 1`,
      `DELETE FROM admin_operations`,
    ]) {
      await expect(
        h.db.transaction(async (trx) => {
          await trx.raw(`SET LOCAL ROLE s9_ops_exec`);
          await trx.raw(sql);
        }),
        sql,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
