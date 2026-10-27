/**
 * FC-C (TD-016) · La tabla de efecto real cubre TODAS las propiedades del catálogo:
 * una propiedad nueva en data/*.json sin clasificar pone esto en rojo (y, sin
 * clasificar, la UI no sabría si presentarla como funcional).
 */
import { describe, it, expect } from "vitest";
import { loadCatalog } from "./loadCatalog.js";
import { NON_GAMEPLAY_KEYS, PROPERTY_EFFECTS, categoryEffect, effectOf } from "./effect-status.js";
import type { ModuleCategory } from "./types.js";

function gameplayKeys(def: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(def)) {
    if (k === "power" && v && typeof v === "object") {
      for (const sub of Object.keys(v)) out.push(`power.${sub}`);
      continue;
    }
    if (!NON_GAMEPLAY_KEYS.has(k)) out.push(k);
  }
  return out;
}

describe("effect-status: clasificación ACTIVE/PARTIAL/FUTURE del catálogo real", () => {
  const catalog = loadCatalog() as unknown as Record<string, unknown>[];

  it("cada propiedad de juego de cada módulo del catálogo está clasificada", () => {
    const missing: string[] = [];
    for (const m of catalog) {
      for (const k of gameplayKeys(m)) {
        if (!effectOf(m.category as ModuleCategory, k)) missing.push(`${m.id}@${m.version}.${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("los campos que el motor ignora están marcados FUTURE (no se presentan como funcionales)", () => {
    expect(effectOf("movement", "terrain")!.status).toBe("FUTURE");
    expect(effectOf("weapon", "rangeM")!.status).toBe("FUTURE");
    expect(effectOf("radio", "rangeM")!.status).toBe("FUTURE");
    expect(categoryEffect("utility")).toBe("FUTURE");
    expect(categoryEffect("chassis")).toBe("ACTIVE");
  });

  it("UX-01 · el camino real juega el loadout elegido: los módulos cambian la batalla", () => {
    // El executor del worker resuelve el loadout PERSISTIDO (ux01-loadout-welcome.test.ts):
    // ninguna propiedad que el motor lea puede presentarse como «del arquetipo».
    expect(categoryEffect("weapon")).toBe("ACTIVE");
    expect(categoryEffect("movement")).toBe("ACTIVE");
    expect(categoryEffect("mine")).toBe("ACTIVE");
    expect(effectOf("weapon", "damage")!.status).toBe("ACTIVE");
    expect(effectOf("movement", "maxSpeedMs")!.status).toBe("ACTIVE");
    // lo que sólo valida sigue siendo PARTIAL
    expect(effectOf("weapon", "costCredits")!.status).toBe("PARTIAL");
    for (const byCat of Object.values(PROPERTY_EFFECTS))
      for (const e of Object.values(byCat)) expect(e.note).not.toMatch(/arquetipo/i);
  });

  it("no consulta la cadena de prototipos", () => {
    expect(effectOf("weapon", "__proto__")).toBeUndefined();
    expect(effectOf("weapon", "constructor")).toBeUndefined();
  });
});
