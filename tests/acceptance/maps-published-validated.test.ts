/**
 * E12 · T12.2 — Criterio "mapas" del capítulo 28: "todo mapa publicado pasó
 * validación", implementado como QUERY de verificación en BD + re-validación
 * REAL con el validador de E4 sobre el contenido versionado.
 *
 * Es transversal de verdad: los mapas publicados los siembra E7 (seeds) en la
 * BD de plataforma, y el juez es el validador de E4 (apps/map-service). Si
 * alguien publica un mapa que E4 no aprueba, este job se pone rojo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDbHandle } from "../../apps/api/src/testing/test-db.js";
import { seedDev } from "../../apps/api/src/db/seeds/dev.js";
import { validateMap, isPublishable } from "../../apps/map-service/src/validate/index.js";
import { toEngineMap } from "../../apps/map-service/src/to-engine-map.js";
import type { InternalMap } from "../../apps/map-service/src/types.js";

let h: TestDbHandle;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("cap. 28 · mapas: todo mapa publicado pasó validación", () => {
  it("query de verificación: no hay map_versions publicadas sin contenido o sin checksum", async () => {
    const broken = await h.db("map_versions")
      .where({ state: "published" })
      .andWhere((q) => q.whereNull("content").orWhereNull("checksum"))
      .select("map_id", "version");
    expect(broken).toEqual([]);
  });

  it("cada mapa publicado re-valida en verde con el validador REAL de E4 y es convertible a arena del motor", async () => {
    const published = await h.db("map_versions").where({ state: "published" });
    expect(published.length).toBeGreaterThan(0); // al menos el mapa MVP

    for (const row of published) {
      const doc = (typeof row.content === "string" ? JSON.parse(row.content) : row.content) as InternalMap;
      const result = validateMap(doc);
      const errors = result.checks.filter((c) => c.severity === "error" && !c.passed);
      expect(errors, `${row.map_id}@${row.version}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(isPublishable(result), `${row.map_id}@${row.version} no publicable`).toBe(true);
      // Y el motor de E2 puede consumirlo (integración E4→E2 del worker E9).
      expect(() => toEngineMap(doc)).not.toThrow();
    }
  });
});
