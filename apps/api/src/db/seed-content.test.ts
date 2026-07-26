/**
 * Contenido base apto para entornos reales: `seedContent` deja la aplicación
 * usable (ruleset, catálogo con chasis y mapa publicado) SIN crear usuarios.
 *
 * Motivación: en producción el editor de loadout mostraba "el catálogo no
 * contiene ningún chasis" porque la BD nunca se pobló, y la única vía
 * existente (`seedDev`) crea cuentas con contraseña conocida del repo.
 *
 * Corre contra PostgreSQL REAL embebido (ADR-E7-002), mismas migraciones que prod.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedContent, DEFAULT_RULESET_ID } from "./seeds/dev.js";
import { getCatalog } from "../services/catalog.js";
import { loadCatalog, CATALOG_VERSION } from "../../../../packages/module-catalog/loadCatalog.js";

let h: TestDbHandle;

beforeAll(async () => {
  h = await startTestDb({ migrate: true });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function count(table: string): Promise<number> {
  const row = await h.db(table).count<{ count: string }[]>({ count: "*" });
  return Number(row[0].count);
}

describe("seedContent (contenido base para entorno real)", () => {
  it("parte de una BD sin contenido", async () => {
    expect(await count("catalog_versions")).toBe(0);
    expect(await count("module_definitions")).toBe(0);
    expect(await count("rulesets")).toBe(0);
    expect(await count("map_versions")).toBe(0);
  });

  it("importa el catálogo con al menos un chasis, que es lo que desbloquea el editor", async () => {
    await seedContent(h.db);

    const modules = await getCatalog(h.db, CATALOG_VERSION);
    expect(modules.length).toBe(loadCatalog().length);

    const chassis = modules.filter((m) => (m as { category?: string }).category === "chassis");
    expect(chassis.length).toBeGreaterThan(0);
  });

  it("deja el ruleset por defecto y un mapa PUBLICADO", async () => {
    const ruleset = await h.db("rulesets").where({ id: DEFAULT_RULESET_ID }).first();
    expect(ruleset).toBeTruthy();
    expect(Number(ruleset.budget_credits)).toBeGreaterThan(0);

    const published = await h.db("map_versions").where({ state: "published" });
    expect(published.length).toBeGreaterThan(0);
  });

  it("NO crea usuarios ni roles de usuario (garantía de seguridad en producción)", async () => {
    expect(await count("users")).toBe(0);
    expect(await count("user_roles")).toBe(0);
  });

  it("es idempotente: repetirlo no duplica ni falla", async () => {
    const before = {
      modules: await count("module_definitions"),
      versions: await count("catalog_versions"),
      rulesets: await count("rulesets"),
      maps: await count("map_versions"),
      users: await count("users"),
    };

    await seedContent(h.db);

    expect(await count("module_definitions")).toBe(before.modules);
    expect(await count("catalog_versions")).toBe(before.versions);
    expect(await count("rulesets")).toBe(before.rulesets);
    expect(await count("map_versions")).toBe(before.maps);
    expect(await count("users")).toBe(before.users);
  });
});
