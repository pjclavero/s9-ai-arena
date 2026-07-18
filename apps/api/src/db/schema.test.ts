/**
 * T7.1 · DoD: migraciones up/down limpias, seeds por rol, restricciones de
 * integridad e importación idempotente e inmutable del catálogo E3.
 *
 * Corre contra PostgreSQL REAL embebido (ADR-E7-002), mismas migraciones que prod.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { migrateToLatest, rollbackAll, ROLES } from "./migrations.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./seeds/dev.js";
import { importCatalogVersion, getCatalog, CatalogImmutableError } from "../services/catalog.js";
import { loadCatalog, CATALOG_VERSION } from "../../../../packages/module-catalog/loadCatalog.js";

let h: TestDbHandle;

beforeAll(async () => {
  h = await startTestDb({ migrate: false });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function tableNames(): Promise<string[]> {
  const r = await h.db.raw(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'`,
  );
  return r.rows.map((x: { tablename: string }) => x.tablename).sort();
}

describe("T7.1 migraciones", () => {
  it("aplican y revierten limpiamente en una BD vacía (up → down → up)", async () => {
    expect(await tableNames()).toEqual([]);

    await migrateToLatest(h.db);
    const after = await tableNames();
    for (const t of [
      "users",
      "roles",
      "sessions",
      "teams",
      "team_members",
      "bots",
      "bot_versions",
      "bot_loadouts",
      "builds",
      "artifacts",
      "maps",
      "map_versions",
      "module_definitions",
      "rulesets",
      "tournaments",
      "entries",
      "matches",
      "battles",
      "participants",
      "battle_stats",
      "ratings",
      "standings",
      "achievements",
      "jobs",
      "audit_log",
      "security_findings",
      "api_usage",
    ]) {
      expect(after, `falta la tabla ${t}`).toContain(t);
    }

    await rollbackAll(h.db);
    expect(await tableNames()).toEqual([]);

    await migrateToLatest(h.db); // vuelve a aplicar sin residuos
    expect((await tableNames()).length).toBe(after.length);
  });

  it("los seeds crean un entorno de desarrollo con un usuario por rol", async () => {
    await seedDev(h.db);
    await seedDev(h.db); // idempotencia

    for (const role of ROLES) {
      const u = await h.db("users").where({ email: DEV_USERS[role] }).first();
      expect(u, `usuario semilla del rol ${role}`).toBeTruthy();
      const r = await h.db("user_roles").where({ user_id: u.id, role }).first();
      expect(r, `rol ${role} asignado`).toBeTruthy();
    }
    expect(await h.db("rulesets").where({ id: DEFAULT_RULESET_ID }).first()).toBeTruthy();
    expect(await h.db("map_versions").where({ state: "published" }).first()).toBeTruthy();
    const catalogCount = await h.db("module_definitions").where({ catalog_version: CATALOG_VERSION });
    expect(catalogCount.length).toBe(loadCatalog().length);
  });
});

describe("T7.1 restricciones de integridad", () => {
  it("no se puede borrar un módulo referenciado por un loadout congelado", async () => {
    const owner = await h.db("users").where({ email: DEV_USERS.developer }).first();
    const [bot] = await h
      .db("bots")
      .insert({ name: "integrity-bot", owner_id: owner.id, visibility: "private" })
      .returning("*");
    const [loadout] = await h
      .db("bot_loadouts")
      .insert({
        bot_id: bot.id,
        revision: 1,
        catalog_version: CATALOG_VERSION,
        chassis: "chassis.light@2",
        modules: JSON.stringify([{ slot: "movement", moduleId: "movement.wheels@1" }]),
      })
      .returning("*");
    await h.db("loadout_modules").insert([
      {
        loadout_id: loadout.id,
        slot: "__chassis__",
        catalog_version: CATALOG_VERSION,
        module_id: "chassis.light",
        module_version: 2,
      },
      {
        loadout_id: loadout.id,
        slot: "movement",
        catalog_version: CATALOG_VERSION,
        module_id: "movement.wheels",
        module_version: 1,
      },
    ]);

    // Congelamos la revisión en una inscripción de torneo (cap. 17.2)
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: 1,
      state: "published",
      runtime: "python",
      loadout_revision: 1,
    });
    const [t] = await h
      .db("tournaments")
      .insert({ name: "integrity-cup", format: "round_robin", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID })
      .returning("*");
    await h.db("entries").insert({
      tournament_id: t.id,
      bot_id: bot.id,
      version: 1,
      loadout_revision: 1,
      frozen: true,
    });

    await expect(
      h
        .db("module_definitions")
        .where({ catalog_version: CATALOG_VERSION, module_id: "movement.wheels", module_version: 1 })
        .delete(),
    ).rejects.toThrow(/foreign key|viola/i);
  });

  it("no se puede borrar un usuario con bots publicados", async () => {
    const owner = await h.db("users").where({ email: DEV_USERS.developer }).first();
    await expect(h.db("users").where({ id: owner.id }).delete()).rejects.toThrow(/foreign key|viola/i);
  });

  it("audit_log es de solo inserción: UPDATE y DELETE fallan", async () => {
    const [row] = await h.db("audit_log").insert({ action: "test.append_only", target: "audit_log" }).returning("*");
    await expect(h.db("audit_log").where({ id: row.id }).update({ action: "tamper" })).rejects.toThrow(
      /solo inserción/,
    );
    await expect(h.db("audit_log").where({ id: row.id }).delete()).rejects.toThrow(/solo inserción/);
  });
});

describe("T7.1 importación del catálogo E3", () => {
  it("es idempotente: reimportar los mismos JSON no cambia nada", async () => {
    const modules = loadCatalog();
    const first = await importCatalogVersion(h.db, "test@1", modules);
    expect(first.inserted).toBe(modules.length);
    const second = await importCatalogVersion(h.db, "test@1", modules);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(modules.length);
  });

  it("respeta la inmutabilidad: cambiar una versión existente es rechazado", async () => {
    const modules = loadCatalog();
    const mutated = modules.map((m) =>
      m.id === "weapon.mg" && m.version === 1 ? { ...m, costCredits: m.costCredits + 1 } : m,
    );
    await expect(importCatalogVersion(h.db, "test@1", mutated)).rejects.toThrow(CatalogImmutableError);
    // y la BD conserva el original
    const catalog = await getCatalog(h.db, "test@1");
    const mg = catalog.find((m) => m.id === "weapon.mg" && m.version === 1)!;
    expect(mg.costCredits).toBe(modules.find((m) => m.id === "weapon.mg" && m.version === 1)!.costCredits);
  });
});
