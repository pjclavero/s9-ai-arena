/** ELIG-REVIEW · falsos positivos: arquetipos oficiales y de balance → elegibles. */
import { describe, it, expect } from "vitest";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { BALANCE_ARCHETYPES } from "../../../packages/module-catalog/balance/archetypes.js";
import { evaluateLoadout } from "./services/version-eligibility.js";

const catalog = loadCatalog();
describe("ELIG-REVIEW · ninguna versión válida se bloquea", () => {
  for (const [name, l] of Object.entries({ ...ARCHETYPES, ...BALANCE_ARCHETYPES })) {
    it(`${name} elegible`, () => {
      const e = evaluateLoadout({ catalog_version: CATALOG_VERSION, chassis: l.chassis, modules: l.modules }, catalog);
      expect(e.eligible, JSON.stringify(e)).toBe(true);
      expect(e.warnings).toEqual([]);
    });
  }
  it("modules como string JSON (columna text) se evalúa igual que el array", () => {
    const l = ARCHETYPES.heavy;
    const a = evaluateLoadout({ catalog_version: CATALOG_VERSION, chassis: l.chassis, modules: l.modules }, catalog);
    const b = evaluateLoadout(
      { catalog_version: CATALOG_VERSION, chassis: l.chassis, modules: JSON.stringify(l.modules) },
      catalog,
    );
    expect(b).toEqual(a);
  });
});
