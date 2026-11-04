/**
 * Cierre funcional (REVIEW) — orden estable y numeración única de las migraciones.
 *
 * Al integrar los carriles aparecieron dos `012_*` (`012_a_bot_versioning` y
 * `012_b_battle_claim`). knex ordena por el NOMBRE, así que dos prefijos iguales
 * dejan el orden a merced del sufijo, y un nombre con letra de carril se cuela en
 * la historia de la BD. Este test fija el contrato: prefijo numérico de 3 cifras
 * consecutivo desde 001, nombres únicos, sin letra de carril y la lista en el
 * mismo orden en que knex la aplicará (orden lexicográfico del nombre).
 */
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("MIGRATIONS: numeración y orden", () => {
  const names = MIGRATIONS.map((m) => m.name);

  it("cada nombre es NNN_tema, sin letra de carril", () => {
    for (const n of names) {
      expect(n).toMatch(/^\d{3}_[a-z0-9_]+$/);
      expect(n).not.toMatch(/^\d{3}_[a-d]_/);
    }
  });

  // Huecos RESERVADOS, explícitos y temporales: un número reservado por otro PR abierto
  // puede faltar, pero sólo ése. EQ5e · con `017_streaming_admin` (PR #227) integrada detrás
  // de `018_battle_reverted` (#229) ya no queda ninguno: la numeración vuelve a ser consecutiva.
  const RESERVED_GAPS = new Set<number>();

  it("prefijos únicos, consecutivos desde 001 (salvo huecos reservados) y en orden de aplicación", () => {
    const prefixes = names.map((n) => Number(n.slice(0, 3)));
    const expected: number[] = [];
    for (let n = 1; expected.length < prefixes.length; n++) {
      if (RESERVED_GAPS.has(n) && !prefixes.includes(n)) continue;
      expected.push(n);
    }
    expect(prefixes).toEqual(expected);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });
});
