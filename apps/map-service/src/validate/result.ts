/**
 * Tipos y utilidades compartidas por las SEIS comprobaciones del validador de mapas
 * (cap. 14.3). La forma de cada entrada es EXACTAMENTE la del componente `MapInvalid`
 * de apps/api/openapi.yaml (`{check, severity, message}`): el servicio de E4 (T4.3)
 * puede reenviar `result.checks` tal cual en la respuesta 422, sin re-mapear nada.
 */

/** Identificadores estables de comprobación (coinciden con el enum de openapi.yaml). */
export type CheckId = "geometry" | "navigation" | "playability" | "balance" | "mode" | "destruction";

export type Severity = "error" | "warning";

export interface Check {
  check: CheckId;
  severity: Severity;
  message: string;
}

export interface ValidationResult {
  checks: Check[];
}

/**
 * Acumulador de hallazgos de UNA comprobación. Cada módulo crea el suyo con su `CheckId`
 * fijo, de modo que es imposible etiquetar un hallazgo con la comprobación equivocada.
 */
export class CheckCollector {
  readonly checks: Check[] = [];
  constructor(private readonly id: CheckId) {}

  error(message: string): void {
    this.checks.push({ check: this.id, severity: "error", message });
  }

  warning(message: string): void {
    this.checks.push({ check: this.id, severity: "warning", message });
  }
}
