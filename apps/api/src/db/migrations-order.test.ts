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

  it("prefijos únicos, consecutivos desde 001 y en orden de aplicación", () => {
    const prefixes = names.map((n) => Number(n.slice(0, 3)));
    expect(prefixes).toEqual(prefixes.map((_p, i) => i + 1));
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });
});
