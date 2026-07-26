/**
 * B2 (arena-engine) · DoD de `safeLookup` y de su uso en `loadRuleset`.
 *
 * Hallazgo del supervisor (cuarto sitio con el mismo patrón en un solo bloque):
 * `RULESETS[id]` sin guarda, con `id="__proto__"`, resolvía a `Object.prototype`
 * (truthy) y `loadRuleset` devolvía un ruleset con `mode: undefined` en vez de
 * lanzar "Ruleset desconocido". `safeLookup` (`Object.prototype.hasOwnProperty`)
 * cierra esta clase de fallo en el punto de lectura, no solo para RULESETS.
 */
import { describe, expect, it } from "vitest";
import { safeLookup } from "./safe-lookup.js";
import { loadRuleset, RULESETS } from "./index.js";

describe("safeLookup", () => {
  const dict: Record<string, number> = { a: 1, b: 2 };

  it("devuelve el valor real para una clave propia", () => {
    expect(safeLookup(dict, "a")).toBe(1);
  });

  it("devuelve undefined para una clave ausente normal", () => {
    expect(safeLookup(dict, "no-existe")).toBeUndefined();
  });

  for (const pollutedKey of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    it(`devuelve undefined para la clave heredada de Object.prototype "${pollutedKey}" (NUNCA algo truthy)`, () => {
      expect(safeLookup(dict, pollutedKey)).toBeUndefined();
    });
  }
});

describe("B2 · loadRuleset con id envenenado (cuarto sitio del mismo patrón: RULESETS)", () => {
  for (const pollutedKey of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`id="${pollutedKey}" → lanza "Ruleset desconocido" (NUNCA un ruleset con mode undefined)`, () => {
      expect(() => loadRuleset(pollutedKey)).toThrow(/Ruleset desconocido/);
    });
  }

  it("los rulesets legítimos siguen cargando con normalidad (no rompe la ruta legal)", () => {
    for (const id of Object.keys(RULESETS)) {
      const rs = loadRuleset(id);
      expect(rs.rulesetId).toBe(id);
      expect(typeof rs.mode).toBe("string");
    }
    // Al menos comprobamos que hay rulesets reales (la suite no es vacuamente cierta).
    expect(Object.keys(RULESETS).length).toBeGreaterThan(0);
  });

  it("overrides sigue funcionando sobre un ruleset legítimo", () => {
    const [anyId] = Object.keys(RULESETS);
    const rs = loadRuleset(anyId, { timeLimitTicks: 42 });
    expect(rs.timeLimitTicks).toBe(42);
  });
});
