/**
 * T5.4 · DoD: "cada loadout referenciado existe y valida contra el catálogo
 * vigente en el repo (si cambia el catálogo de E3 y deja de validar, debe fallar
 * un test aquí, no descubrirse en producción)".
 */
import { describe, expect, it } from "vitest";
import { validateLoadout } from "../packages/module-catalog/validator/index.js";
import { loadCatalog } from "../packages/module-catalog/loadCatalog.js";
import { ARCHETYPES } from "../packages/module-catalog/resolve/archetypes.js";
import { BUDGET_CREDITS_MVP } from "../packages/game-rules/index.js";

const catalog = loadCatalog();

// Debe coincidir con bot.ARCHETYPE / self.ARCHETYPE de cada bot en example-bots/.
const BOT_ARCHETYPES = {
  "explorer.py": "scout",
  "defender.py": "heavy",
  "gunner.ts": "gunner",
  "miner.ts": "miner",
} as const;

describe("T5.4 · los loadouts de los 4 bots oficiales validan contra el catálogo vigente", () => {
  for (const [bot, archetype] of Object.entries(BOT_ARCHETYPES)) {
    it(`${bot} usa el arquetipo "${archetype}", que es un loadout legal`, () => {
      const loadout = ARCHETYPES[archetype as keyof typeof ARCHETYPES];
      expect(loadout, `arquetipo "${archetype}" no existe en ARCHETYPES`).toBeDefined();
      const violations = validateLoadout(loadout, catalog, BUDGET_CREDITS_MVP);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }

  it("los 4 arquetipos son distintos entre sí (un rol por chasis, no repetido)", () => {
    const archetypes = Object.values(BOT_ARCHETYPES);
    expect(new Set(archetypes).size).toBe(archetypes.length);
  });
});
