/**
 * Los 3 arquetipos del banco de balance deben ser loadouts legales contra el
 * catálogo real con BUDGET_CREDITS_MVP, igual que los goldens de T3.3.
 */
import { describe, expect, it } from "vitest";
import { validateLoadout } from "../validator/index.js";
import { loadCatalog } from "../loadCatalog.js";
import { BUDGET_CREDITS_MVP } from "../../game-rules/index.js";
import { BALANCE_ARCHETYPES } from "./archetypes.js";

const catalog = loadCatalog();

describe("T3.4 · arquetipos del banco de balance son legales", () => {
  for (const [name, loadout] of Object.entries(BALANCE_ARCHETYPES)) {
    it(`${name}: 0 violaciones con BUDGET_CREDITS_MVP`, () => {
      const violations = validateLoadout(loadout, catalog, BUDGET_CREDITS_MVP);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }
});
