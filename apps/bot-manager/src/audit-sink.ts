/**
 * E6 · bot-manager — interfaz de auditoría consumida por el pipeline (T6.1 → T6.4).
 *
 * El pipeline (T6.1) solo conoce esta interfaz: emite eventos y hallazgos sin saber
 * dónde se guardan. En T6.1 el sink por defecto es no-op (NullAuditSink). En T6.4 se
 * conecta la implementación real (audit_log de solo inserción + security_findings con
 * RBAC, cap. 23). Así el pipeline nace ya instrumentado sin acoplarse al almacén.
 */
export type Severity = "low" | "medium" | "high" | "critical";

export interface AuditEventInput {
  type: string;
  botId: string;
  version: number;
  userId: string;
  correlationId: string;
  detail?: Record<string, unknown>;
}

export interface SecurityFindingInput {
  category: string; // p. ej. "secret_leak", "sandbox_escape", "resource_abuse"
  severity: Severity;
  botId: string;
  version: number;
  userId: string;
  correlationId: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEventInput): void;
  finding(finding: SecurityFindingInput): void;
}

export const NullAuditSink: AuditSink = {
  record() {},
  finding() {},
};
