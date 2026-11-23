/**
 * ADM-1 · Ajustes del sistema contra PostgreSQL REAL: permisos (sólo admin), validación de
 * rangos en servidor, techo del entorno, auditoría atómica, concurrencia optimista y lectura en
 * caliente con sondeo y fail-closed. Cada caso lleva su mutante en scripts/adm1-mutants.py.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedDev, DEV_USERS } from "../db/seeds/dev.js";
import { tokenFor } from "../testing/helpers.js";
import { createApp } from "../app.js";
import { createSettingsRegistry } from "../../../../packages/system-settings/registry.js";
import { SystemSettingsReader } from "../../../../packages/system-settings/reader.js";

const REGISTRY = createSettingsRegistry([
  {
    key: "test.workers",
    type: "integer",
    min: 1,
    max: 16,
    default: 2,
    consumer: "worker",
    apply: "hot",
    env: "S9_TEST_WORKERS_MAX",
    description: "workers",
  },
  {
    key: "test.flag",
    type: "boolean",
    default: false,
    consumer: "replay-service",
    apply: "restart",
    description: "flag",
  },
  {
    key: "test.mode",
    type: "enum",
    options: ["a", "b"],
    default: "a",
    consumer: "api",
    apply: "hot",
    description: "modo",
  },
]);

let h: TestDbHandle;
let app: Express;
let env: NodeJS.ProcessEnv;
let admin: string;
let moderator: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  env = {};
  app = createApp({ db: h.db, systemSettings: { registry: REGISTRY, env } });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
}, 120_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await h.db("system_settings").delete();
  auditFloor = Number((await h.db("audit_log").max({ m: "id" }).first())?.m ?? 0);
  for (const k of Object.keys(env)) delete env[k];
});

const get = (t?: string) => {
  const r = request(app).get("/admin/settings");
  return t ? r.set("Authorization", `Bearer ${t}`) : r;
};
const patch = (body: unknown, t: string = admin) =>
  request(app)
    .patch("/admin/settings")
    .set("Authorization", `Bearer ${t}`)
    .send(body as object);
const one = (key: string, value: unknown, expectedVersion = 0) => ({ changes: [{ key, value, expectedVersion }] });
let auditFloor = 0;
const auditRows = () =>
  h.db("audit_log").where({ action: "settings.system.update" }).where("id", ">", auditFloor).orderBy("id");

describe("ADM-1 · permisos", () => {
  it("SOLO_ADMIN: anónimo 401, moderador 403 (lectura y escritura) y no se escribe nada", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(moderator)).status).toBe(403);
    expect((await request(app).patch("/admin/settings").send(one("test.workers", 3))).status).toBe(401);
    expect((await patch(one("test.workers", 3), moderator)).status).toBe(403);
    expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("ADM-1 · lectura del registro", () => {
  it("LISTA_REGISTRO: cada clave con tipo, consumidor, clase de aplicación y origen", async () => {
    const r = await get(admin);
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.body.settings.map((s: { key: string }) => [s.key, s]));
    expect(Object.keys(byKey).sort()).toEqual(["test.flag", "test.mode", "test.workers"]);
    expect(byKey["test.workers"]).toMatchObject({
      value: 2,
      source: "default",
      version: 0,
      consumer: "worker",
      apply: "hot",
      requiresRestart: false,
      min: 1,
      max: 16,
    });
    expect(byKey["test.flag"]).toMatchObject({ requiresRestart: true, apply: "restart" });
  });
});

describe("ADM-1 · validación en servidor", () => {
  it("RANGOS: fuera de rango, tipo erróneo, clave no registrada y forma inválida ⇒ 400 y NADA guardado", async () => {
    const bad: unknown[] = [
      one("test.workers", 0),
      one("test.workers", 17),
      one("test.workers", 2.5),
      one("test.workers", "3"),
      one("test.flag", "true"),
      one("test.mode", "c"),
      one("no.registrada", 1),
      one("__proto__", 1),
      { changes: [] },
      { changes: [{ key: "test.workers", value: 3 }] },
      { changes: [{ key: "test.workers", value: 3, expectedVersion: -1 }] },
      { changes: [{ key: "test.workers", value: 3, expectedVersion: 0, extra: 1 }] },
      {
        changes: [
          { key: "test.workers", value: 3, expectedVersion: 0 },
          { key: "test.workers", value: 4, expectedVersion: 0 },
        ],
      },
      { cambios: [] },
      [],
    ];
    for (const b of bad) {
      const r = await patch(b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("TECHO_ENTORNO: el entorno es el techo duro (no se puede subir por encima, aunque esté en rango)", async () => {
    env.S9_TEST_WORKERS_MAX = "4";
    expect((await patch(one("test.workers", 5))).status).toBe(400);
    expect((await patch(one("test.workers", 4))).status).toBe(200);
    // El techo bajó después de guardar: el valor vigente se recorta al techo.
    env.S9_TEST_WORKERS_MAX = "3";
    const r = await get(admin);
    expect(r.body.settings.find((s: { key: string }) => s.key === "test.workers")).toMatchObject({
      value: 3,
      envCeiling: 3,
    });
  });

  it("ATOMICO: un cambio inválido en la lista aborta TODO (ni valores ni auditoría)", async () => {
    const r = await patch({
      changes: [
        { key: "test.workers", value: 5, expectedVersion: 0 },
        { key: "test.mode", value: "zzz", expectedVersion: 0 },
      ],
    });
    expect(r.status).toBe(400);
    expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("ATOMICO_BD: un conflicto de versión en un cambio posterior (en orden de bloqueo) revierte también el anterior y su auditoría", async () => {
    await patch(one("test.workers", 3)); // test.workers ya tiene versión 1
    const before = (await auditRows()).length;
    // Se bloquea por clave: test.mode (ok) va ANTES que test.workers (conflicto).
    const r = await patch({
      changes: [
        { key: "test.workers", value: 5, expectedVersion: 0 }, // versión real = 1
        { key: "test.mode", value: "b", expectedVersion: 0 },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("version_conflict");
    expect(await h.db("system_settings").where({ key: "test.mode" })).toHaveLength(0);
    expect((await auditRows()).length).toBe(before);
  });
});

describe("ADM-1 · auditoría y versiones", () => {
  it("AUDITORIA: una fila por clave cambiada con actor, antes y después", async () => {
    const r = await patch({
      changes: [
        { key: "test.workers", value: 5, expectedVersion: 0 },
        { key: "test.mode", value: "b", expectedVersion: 0 },
      ],
    });
    expect(r.status).toBe(200);
    let rows = await auditRows();
    expect(rows).toHaveLength(2);
    const adminRow = await h.db("users").where({ email: DEV_USERS.admin }).first();
    expect(rows.every((x: { actor_id: string }) => x.actor_id === adminRow.id)).toBe(true);
    const w = rows.find((x: { target: string }) => x.target === "setting:test.workers");
    expect(w.detail).toMatchObject({ key: "test.workers", before: null, after: 5, beforeVersion: 0, afterVersion: 1 });

    const r2 = await patch(one("test.workers", 7, 1));
    expect(r2.status).toBe(200);
    rows = await auditRows();
    expect(rows).toHaveLength(3);
    expect(rows[2].detail).toMatchObject({ before: 5, after: 7, beforeVersion: 1, afterVersion: 2 });
    const stored = await h.db("system_settings").where({ key: "test.workers" }).first();
    expect(stored).toMatchObject({ value: 7, version: 2, updated_by: adminRow.id });
  });

  it("AUDITORIA_MISMA_TRANSACCION: si la auditoría falla, el valor no queda guardado", async () => {
    await h.db.raw(`CREATE OR REPLACE FUNCTION adm1_block_audit() RETURNS trigger AS $$
      BEGIN IF NEW.action = 'settings.system.update' THEN RAISE EXCEPTION 'auditoria bloqueada'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await h.db.raw(
      `CREATE TRIGGER adm1_block BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION adm1_block_audit()`,
    );
    try {
      const r = await patch(one("test.workers", 5));
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    } finally {
      await h.db.raw(`DROP TRIGGER adm1_block ON audit_log`);
    }
  });

  it("VERSION_OPTIMISTA: expectedVersion viejo ⇒ 409 version_conflict con la versión vigente", async () => {
    expect((await patch(one("test.workers", 5, 0))).status).toBe(200);
    const stale = await patch(one("test.workers", 6, 0));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "version_conflict", currentVersion: 1 });
    expect((await h.db("system_settings").where({ key: "test.workers" }).first()).value).toBe(5);
  });

  it("SIN_CAMBIO: guardar el mismo valor no sube versión ni audita", async () => {
    await patch(one("test.workers", 5, 0));
    const r = await patch(one("test.workers", 5, 1));
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual([]);
    expect((await h.db("system_settings").where({ key: "test.workers" }).first()).version).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it("AVISO_REINICIO: la respuesta distingue lo que exige reinicio de lo que se aplica en caliente", async () => {
    const hot = await patch(one("test.workers", 5, 0));
    expect(hot.body.pendingRestart).toEqual([]);
    expect(hot.body.changed[0]).toMatchObject({ key: "test.workers", requiresRestart: false });
    const cold = await patch(one("test.flag", true, 0));
    expect(cold.body.pendingRestart).toEqual(["test.flag"]);
    const detail = (await auditRows()).at(-1).detail;
    expect(detail).toMatchObject({ key: "test.flag", requiresRestart: true, consumer: "replay-service" });
  });
});

describe("ADM-1 · lector con sondeo (en caliente) y fail-closed", () => {
  function reader(clock: { t: number }, e: NodeJS.ProcessEnv = env) {
    return new SystemSettingsReader(h.db, REGISTRY, { refreshMs: 5_000, now: () => clock.t, env: e });
  }

  it("EN_CALIENTE: un PATCH se ve en el lector al sondear, sin reiniciar nada", async () => {
    const clock = { t: 1_000 };
    const rd = reader(clock);
    await rd.refresh();
    expect(rd.get("test.workers")).toBe(2);
    await patch(one("test.workers", 9, 0));
    expect(rd.get("test.workers")).toBe(2); // aún no ha sondeado
    clock.t += 5_000;
    await rd.refresh();
    expect(rd.get("test.workers")).toBe(9);
    expect(rd.entry("test.workers").source).toBe("database");
  });

  it("SONDEO_PERIODICO: start() relee solo, sin llamadas manuales", async () => {
    const rd = new SystemSettingsReader(h.db, REGISTRY, { refreshMs: 50, env });
    await rd.refresh();
    rd.start();
    try {
      await patch(one("test.workers", 11, 0));
      await new Promise((r) => setTimeout(r, 400));
      expect(rd.get("test.workers")).toBe(11);
    } finally {
      rd.stop();
    }
  });

  it("FAIL_CLOSED: sin lectura válida (arranque) o con la BD caída pasada la ventana, valen los defectos", async () => {
    await patch(one("test.workers", 9, 0));
    const clock = { t: 0 };
    const rd = reader(clock);
    // Arranque sin lectura: defecto conservador, no un valor guardado ni el entorno.
    expect(rd.get("test.workers")).toBe(2);
    expect(rd.entry("test.workers").source).toBe("fail_closed");
    await rd.refresh();
    expect(rd.get("test.workers")).toBe(9);
    // BD caída: dentro de la ventana se conserva; fuera, vuelve al defecto.
    const broken = new SystemSettingsReader(
      new Proxy(h.db, {
        apply: () => {
          throw new Error("db down");
        },
      }) as never,
      REGISTRY,
      { refreshMs: 5_000, now: () => clock.t, env },
    );
    await broken.refresh();
    expect(broken.get("test.workers")).toBe(2);
    clock.t = 14_000; // dentro de 3 × 5 s desde la última lectura buena del lector sano
    expect(rd.get("test.workers")).toBe(9);
    clock.t = 16_000; // pasada la ventana sin releer
    expect(rd.get("test.workers")).toBe(2);
    expect(rd.entry("test.workers").source).toBe("fail_closed");
  });

  it("FILA_INVALIDA: un valor ilegible o una clave desconocida se ignoran y se cuentan", async () => {
    await h.db("system_settings").insert([
      { key: "test.workers", value: JSON.stringify("basura"), version: 1 },
      { key: "otra.clave", value: JSON.stringify(1), version: 1 },
    ]);
    const rd = reader({ t: 1 });
    await rd.refresh();
    expect(rd.get("test.workers")).toBe(2);
    expect(rd.invalidCount).toBe(2);
    expect(() => rd.get("otra.clave")).toThrow(/no registrado/);
  });

  it("TECHO_EN_LECTOR: el lector recorta al techo del entorno aunque la BD diga más", async () => {
    await h.db("system_settings").insert({ key: "test.workers", value: JSON.stringify(12), version: 1 });
    const rd = reader({ t: 1 }, { S9_TEST_WORKERS_MAX: "6" });
    await rd.refresh();
    expect(rd.get("test.workers")).toBe(6);
  });
});

describe("ADM-1 · techo del entorno mal formado (fail-closed)", () => {
  it("ENV_INVALIDO_BLOQUEA: la clave queda bloqueada para escribir, vale su defecto y el GET lo avisa", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h.db("system_settings").insert({ key: "test.workers", value: JSON.stringify(9), version: 1 });
      env.S9_TEST_WORKERS_MAX = "8x";
      const w = await patch(one("test.workers", 3, 1));
      expect(w.status).toBe(400);
      expect(String(w.body.message)).toMatch(/bloqueada/);
      const g = await get(admin);
      const row = g.body.settings.find((x: { key: string }) => x.key === "test.workers");
      expect(row).toMatchObject({ value: 2, source: "default", envCeilingInvalid: true, envCeiling: null });
      // El lector de los servicios hace lo mismo: ni el valor de la BD ni un techo inexistente.
      const rd = new SystemSettingsReader(h.db, REGISTRY, { refreshMs: 5_000, env });
      await rd.refresh();
      expect(rd.get("test.workers")).toBe(2);
      // Otras claves siguen escribibles.
      expect((await patch(one("test.mode", "b", 0))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ADM-1 · bloqueo ordenado del PATCH", () => {
  it("PATCH_ORDEN_DETERMINISTA: dos PATCH con las mismas claves en orden inverso nunca se interbloquean", async () => {
    await h.db("system_settings").insert([
      { key: "test.workers", value: JSON.stringify(3), version: 1 },
      { key: "test.mode", value: JSON.stringify("a"), version: 1 },
    ]);
    let version = 1;
    for (let round = 0; round < 12; round++) {
      const mk = (keys: string[], n: number) => ({
        changes: keys.map((k) => ({
          key: k,
          value: k === "test.workers" ? 4 + (n % 5) : n % 2 ? "a" : "b",
          expectedVersion: version,
        })),
      });
      const [r1, r2] = await Promise.all([
        patch(mk(["test.workers", "test.mode"], round * 2 + 1)),
        patch(mk(["test.mode", "test.workers"], round * 2 + 2)),
      ]);
      for (const r of [r1, r2]) {
        expect([200, 409]).toContain(r.status);
        // Un 409 legítimo es de versión: trae la versión vigente; un interbloqueo mapeado no la trae.
        if (r.status === 409) expect(r.body.currentVersion).toBeDefined();
      }
      const cur = await h.db("system_settings").where({ key: "test.workers" }).first();
      version = cur.version;
      await h.db("system_settings").where({ key: "test.mode" }).update({ version });
    }
  });

  it("RESPUESTA_EN_ORDEN_DE_PETICION: aunque se bloquee ordenado, `changed` conserva el orden pedido", async () => {
    const r = await patch({
      changes: [
        { key: "test.workers", value: 5, expectedVersion: 0 },
        { key: "test.mode", value: "b", expectedVersion: 0 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.changed.map((c: { key: string }) => c.key)).toEqual(["test.workers", "test.mode"]);
  });
});
