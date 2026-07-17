/**
 * T7.1 · Importación del catálogo de E3 a module_definitions.
 *
 * Idempotente e inmutable (DoD T7.1 y openapi importCatalogVersion): reimportar el
 * mismo contenido es un no-op; intentar cambiar una versión existente lanza
 * CatalogImmutableError. Nunca se sobrescribe ni se borra una versión.
 */
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";

export class CatalogImmutableError extends Error {}

function contentHash(def: ModuleDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(def, Object.keys(def as object).sort()))
    .digest("hex");
}

export interface ImportResult {
  catalogVersion: string;
  inserted: number;
  unchanged: number;
}

export async function importCatalogVersion(
  db: Knex,
  catalogVersion: string,
  modules: ModuleDefinition[],
): Promise<ImportResult> {
  return db.transaction(async (trx) => {
    let inserted = 0;
    let unchanged = 0;

    await trx("catalog_versions")
      .insert({ catalog_version: catalogVersion, module_count: modules.length })
      .onConflict("catalog_version")
      .ignore();

    for (const def of modules) {
      const hash = contentHash(def);
      const existing = await trx("module_definitions")
        .where({ catalog_version: catalogVersion, module_id: def.id, module_version: def.version })
        .first();
      if (existing) {
        if (existing.content_hash !== hash) {
          throw new CatalogImmutableError(
            `${def.id}@${def.version} ya existe en el catálogo ${catalogVersion} con otro contenido: las versiones son inmutables`,
          );
        }
        unchanged += 1;
        continue;
      }
      await trx("module_definitions").insert({
        catalog_version: catalogVersion,
        module_id: def.id,
        module_version: def.version,
        category: def.category,
        definition: JSON.stringify(def),
        content_hash: hash,
      });
      inserted += 1;
    }

    await trx("catalog_versions")
      .where({ catalog_version: catalogVersion })
      .update({ module_count: inserted + unchanged });

    return { catalogVersion, inserted, unchanged };
  });
}

/** Catálogo cargado desde la BD, con la forma que esperan validator/resolve de E3. */
export async function getCatalog(db: Knex, catalogVersion: string): Promise<ModuleDefinition[]> {
  const rows = await db("module_definitions").where({ catalog_version: catalogVersion });
  return rows.map((r: { definition: ModuleDefinition }) => r.definition);
}

export async function listCatalogVersions(db: Knex) {
  const rows = await db("catalog_versions").orderBy("imported_at", "asc");
  return rows.map((r: Record<string, unknown>) => ({
    catalogVersion: r.catalog_version,
    moduleCount: r.module_count,
    frozen: r.frozen,
    importedAt: (r.imported_at as Date).toISOString(),
  }));
}
