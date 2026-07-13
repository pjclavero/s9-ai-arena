import { describe, it, expect } from "vitest";
import * as C from "./constants";

describe("ADR-000 · coherencia de constantes", () => {
  it("la frecuencia de decisión divide exactamente el tick", () => {
    expect(C.TICK_HZ % C.DECISION_HZ).toBe(0);
    expect(C.DECISION_EVERY_N_TICKS).toBe(C.TICK_HZ / C.DECISION_HZ);
    expect(Number.isInteger(C.DECISION_EVERY_N_TICKS)).toBe(true);
  });

  it("el deadline de decisión cabe dentro del ciclo de decisión", () => {
    expect(C.DECISION_DEADLINE_MS).toBeLessThan(1000 / C.DECISION_HZ);
  });

  it("el reparto de daño chasis/módulo suma 1", () => {
    expect(C.CHASSIS_DAMAGE_SHARE + C.MODULE_DAMAGE_SHARE).toBeCloseTo(1, 10);
  });

  it("el blindaje nunca anula el daño ni lo amplifica", () => {
    expect(C.DMG_MIN_FRACTION).toBeGreaterThan(0);
    expect(C.DMG_MIN_FRACTION).toBeLessThan(1);
  });

  it("el presupuesto por defecto cae dentro del rango permitido a un ruleset", () => {
    expect(C.BUDGET_CREDITS_MVP).toBeGreaterThanOrEqual(C.BUDGET_CREDITS_MIN);
    expect(C.BUDGET_CREDITS_MVP).toBeLessThanOrEqual(C.BUDGET_CREDITS_MAX);
    expect(C.BUDGET_CREDITS_MIN).toBeLessThan(C.BUDGET_CREDITS_MAX);
  });

  it("el suelo de velocidad por masa está en (0,1)", () => {
    expect(C.MASS_SPEED_FLOOR).toBeGreaterThan(0);
    expect(C.MASS_SPEED_FLOOR).toBeLessThan(1);
  });

  it("los límites de radio son coherentes con la frecuencia de decisión", () => {
    expect(C.RADIO_MAX_MESSAGE_BYTES).toBeGreaterThan(0);
    expect(C.RADIO_MAX_MESSAGES_PER_SECOND).toBeLessThanOrEqual(C.DECISION_HZ);
  });

  it("los estados de módulo cubren la tabla de rendimiento y son monótonos", () => {
    for (const s of C.MODULE_STATES) {
      expect(C.MODULE_STATE_PERFORMANCE[s]).toBeGreaterThanOrEqual(0);
      expect(C.MODULE_STATE_PERFORMANCE[s]).toBeLessThanOrEqual(1);
    }
    expect(C.MODULE_STATE_PERFORMANCE.operational).toBeGreaterThan(
      C.MODULE_STATE_PERFORMANCE.damaged,
    );
    expect(C.MODULE_STATE_PERFORMANCE.damaged).toBeGreaterThan(
      C.MODULE_STATE_PERFORMANCE.critical,
    );
    expect(C.MODULE_STATE_PERFORMANCE.destroyed).toBe(0);
    expect(C.MODULE_STATE_PERFORMANCE.offline).toBe(0);
  });

  it("hay exactamente cuatro sectores de blindaje", () => {
    expect(C.SECTORS).toHaveLength(4);
    expect(new Set(C.SECTORS).size).toBe(4);
  });

  it("el protocolo por defecto está entre los soportados", () => {
    expect(C.PROTO_ENCODINGS_SUPPORTED).toContain(C.PROTO_ENCODING_DEFAULT);
  });
});
