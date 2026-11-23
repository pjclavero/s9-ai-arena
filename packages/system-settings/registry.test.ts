/**
 * ADM-1 · Registro de ajustes (puro, sin BD): tipos estrictos, rangos, techo del entorno y
 * valor efectivo. Cada caso lleva su mutante en scripts/adm1-mutants.py.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSettingsRegistry,
  effectiveValue,
  envCeiling,
  envCeilingState,
  SYSTEM_SETTINGS_REGISTRY,
  validateSettingValue,
  type SettingDef,
} from "./registry.js";

const INT: SettingDef = {
  key: "test.count",
  type: "integer",
  min: 1,
  max: 16,
  default: 4,
  consumer: "worker",
  apply: "hot",
  env: "S9_TEST_COUNT_MAX",
  description: "x",
};

describe("registro de ajustes: validación en servidor", () => {
  it("RANGO_ENTERO: acepta los límites y rechaza fuera de rango", () => {
    expect(validateSettingValue(INT, 1, {}).ok).toBe(true);
    expect(validateSettingValue(INT, 16, {}).ok).toBe(true);
    expect(validateSettingValue(INT, 0, {}).ok).toBe(false);
    expect(validateSettingValue(INT, 17, {}).ok).toBe(false);
  });

  it("TIPO_ESTRICTO: sin coerción (cadena, decimal, NaN, booleano donde va número)", () => {
    for (const bad of ["5", 2.5, Number.NaN, Infinity, true, null, undefined, {}]) {
      expect(validateSettingValue(INT, bad, {}).ok, String(bad)).toBe(false);
    }
    const B: SettingDef = { ...INT, key: "test.flag", type: "boolean", default: false, env: undefined };
    for (const bad of ["true", 1, 0, null]) expect(validateSettingValue(B, bad, {}).ok, String(bad)).toBe(false);
    expect(validateSettingValue(B, true, {}).ok).toBe(true);
  });

  it("ENUM_CERRADO: sólo las opciones declaradas", () => {
    const E: SettingDef = { ...INT, key: "test.mode", type: "enum", options: ["a", "b"], default: "a", env: undefined };
    expect(validateSettingValue(E, "b", {}).ok).toBe(true);
    expect(validateSettingValue(E, "c", {}).ok).toBe(false);
    expect(validateSettingValue(E, "__proto__", {}).ok).toBe(false);
  });

  it("TECHO_ENTORNO: el valor no puede superar el techo del entorno (sí igualarlo)", () => {
    const env = { S9_TEST_COUNT_MAX: "8" };
    expect(envCeiling(INT, env)).toBe(8);
    expect(validateSettingValue(INT, 8, env).ok).toBe(true);
    const r = validateSettingValue(INT, 9, env);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/techo del entorno/);
  });

  it("TECHO_ENTORNO_VACIO: una variable ausente o vacía es «sin techo» (no es un error)", () => {
    expect(envCeilingState(INT, {})).toEqual({ state: "none" });
    expect(envCeilingState(INT, { S9_TEST_COUNT_MAX: "  " })).toEqual({ state: "none" });
    expect(envCeiling(INT, { S9_TEST_COUNT_MAX: "" })).toBeNull();
  });

  it("TECHO_ENTORNO_INVALIDO: una variable mal formada FALLA CERRADO (clave bloqueada, defecto, y queda en el log)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const raw of ["abc", "8x", "2.5", "0", "99", "NaN"]) {
        const env = { S9_TEST_COUNT_MAX: raw };
        expect(envCeilingState(INT, env), raw).toEqual({ state: "invalid" });
        // Escritura: bloqueada aunque el valor esté en rango.
        const w = validateSettingValue(INT, 3, env);
        expect(w.ok, raw).toBe(false);
        expect(w.error).toMatch(/bloqueada/);
        // Lectura: vale el defecto, nunca el valor de la BD (ni un techo imaginario).
        expect(effectiveValue(INT, 12, env), raw).toMatchObject({ value: 4, source: "default", invalid: true });
      }
      expect(spy).toHaveBeenCalled();
      const logged = String(spy.mock.calls[0][0]);
      expect(logged).toMatch(/S9_TEST_COUNT_MAX/);
      expect(logged).not.toMatch(/8x/); // el valor crudo no se vuelca al log
    } finally {
      spy.mockRestore();
    }
  });
});

describe("registro de ajustes: valor efectivo", () => {
  it("sin fila: techo del entorno si lo hay y si no, el defecto", () => {
    expect(effectiveValue(INT, undefined, {})).toMatchObject({ value: 4, source: "default" });
    expect(effectiveValue(INT, undefined, { S9_TEST_COUNT_MAX: "8" })).toMatchObject({
      value: 8,
      source: "environment",
    });
  });

  it("fila válida manda; por encima del techo se RECORTA al techo", () => {
    expect(effectiveValue(INT, 6, {})).toMatchObject({ value: 6, source: "database", invalid: false });
    expect(effectiveValue(INT, 12, { S9_TEST_COUNT_MAX: "8" })).toMatchObject({ value: 8, source: "environment" });
  });

  it("fila inválida se IGNORA y se marca como inválida", () => {
    expect(effectiveValue(INT, "boom", {})).toMatchObject({ value: 4, source: "default", invalid: true });
    expect(effectiveValue(INT, 99, {})).toMatchObject({ invalid: true });
  });
});

describe("registro de ajustes: construcción", () => {
  it("rechaza claves mal formadas, duplicadas, sin rango y defectos inválidos", () => {
    expect(() => createSettingsRegistry([{ ...INT, key: "Mala Clave" }])).toThrow(/clave de ajuste inválida/);
    expect(() => createSettingsRegistry([INT, INT])).toThrow(/duplicada/);
    expect(() => createSettingsRegistry([{ ...INT, min: undefined }])).toThrow(/min y max/);
    expect(() => createSettingsRegistry([{ ...INT, default: 99 }])).toThrow(/por defecto/);
  });

  it("FABRICA_VACIA: el registro de producción no trae sondas ni claves sin consumidor real", () => {
    expect(SYSTEM_SETTINGS_REGISTRY.defs).toEqual([]);
    for (const d of SYSTEM_SETTINGS_REGISTRY.defs) {
      expect(d.consumer.length).toBeGreaterThan(0);
      expect(["hot", "restart"]).toContain(d.apply);
    }
    // clave inexistente: no hay entrada «libre»
    expect(SYSTEM_SETTINGS_REGISTRY.get("ops.probe_hot")).toBeUndefined();
    expect(SYSTEM_SETTINGS_REGISTRY.get("__proto__")).toBeUndefined();
    expect(SYSTEM_SETTINGS_REGISTRY.get("constructor")).toBeUndefined();
  });
});
