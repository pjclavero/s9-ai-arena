/**
 * E6 · bot-manager — puente de eventos de seguridad del sandbox al audit/findings (T6.4).
 *
 * Cuando la suite de escape (T6.2) o el runtime en producción detectan un intento de
 * escape, se registra como security_finding (consultable solo por admins) y como evento de
 * audit_log. Aquí se centraliza esa traducción para que el harness y el orquestador no
 * hablen directamente con el almacén.
 */
import type { AuditSink, Severity } from "./audit-sink.js";

export interface EscapeReport {
  botId: string;
  version: number;
  userId: string;
  correlationId: string;
  /** Vector de la suite: internet_connect, write_outside_tmp, fork_bomb, ... */
  vector: string;
  severity?: Severity;
  detail?: Record<string, unknown>;
}

export function reportSandboxEscape(audit: AuditSink, report: EscapeReport): void {
  audit.finding({
    category: "sandbox_escape",
    severity: report.severity ?? "high",
    botId: report.botId,
    version: report.version,
    userId: report.userId,
    correlationId: report.correlationId,
    summary: `intento de escape del sandbox: ${report.vector}`,
    detail: { vector: report.vector, ...report.detail },
  });
}
