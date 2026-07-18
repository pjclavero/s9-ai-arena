/**
 * E6 · bot-manager — audit_log de solo inserción y security_findings con RBAC (T6.4, cap. 23).
 *
 * DoD T6.4:
 *  - todo evento del pipeline y del sandbox genera un registro con bot, versión, usuario y
 *    correlation_id;
 *  - un security_finding es consultable por administradores y SOLO por ellos (RBAC);
 *  - el audit_log es de SOLO INSERCIÓN: no existe endpoint ni permiso de borrado/edición.
 *
 * AuditLog implementa el AuditSink que el pipeline (T6.1) ya usaba: al conectarlo, todo el
 * pipeline queda instrumentado sin cambios. La clase NO expone ningún método de borrado o
 * edición (append + query); el modelo de permisos AUDIT_PERMISSIONS no concede `delete` a
 * ningún rol. Esa ausencia ES la garantía de inmutabilidad, verificada por el test.
 */
import { randomUUID } from "node:crypto";
import type { AuditEventInput, AuditSink, SecurityFindingInput } from "./audit-sink.js";
import type { PrincipalRole } from "./launch-guard.js";

export interface AuditEntry extends AuditEventInput {
  id: string;
  seq: number;
  at: string;
}

export interface SecurityFinding extends SecurityFindingInput {
  id: string;
  seq: number;
  at: string;
  status: "open" | "acknowledged";
}

export class Forbidden extends Error {}

/** Permisos sobre el audit_log. Deliberadamente NO existe la acción "delete"/"update". */
export const AUDIT_PERMISSIONS: Record<PrincipalRole, { readAudit: boolean; readFindings: boolean }> = {
  admin: { readAudit: true, readFindings: true },
  moderator: { readAudit: true, readFindings: false },
  "bot-manager-internal": { readAudit: true, readFindings: false },
  web: { readAudit: false, readFindings: false },
  "public-api": { readAudit: false, readFindings: false },
};

export interface AuditPrincipal {
  id: string;
  role: PrincipalRole;
}

export class AuditLog implements AuditSink {
  private entries: AuditEntry[] = [];
  private findings: SecurityFinding[] = [];
  private seq = 0;
  private now: () => string;

  constructor(clock?: () => string) {
    this.now = clock ?? (() => new Date().toISOString());
  }

  // ---- SOLO INSERCIÓN --------------------------------------------------------------
  record(event: AuditEventInput): void {
    this.entries.push({ ...event, id: randomUUID(), seq: this.seq++, at: this.now() });
  }

  finding(finding: SecurityFindingInput): void {
    this.findings.push({ ...finding, id: randomUUID(), seq: this.seq++, at: this.now(), status: "open" });
    // Un hallazgo también deja rastro en el audit_log (evento correlacionado).
    this.record({
      type: "security.finding",
      botId: finding.botId,
      version: finding.version,
      userId: finding.userId,
      correlationId: finding.correlationId,
      detail: { category: finding.category, severity: finding.severity, summary: finding.summary },
    });
  }

  // ---- CONSULTA CON RBAC -----------------------------------------------------------
  /** audit_log: moderador/admin/servicio interno. Nunca la web ni la API pública. */
  queryAudit(principal: AuditPrincipal, filter?: { botId?: string; correlationId?: string }): AuditEntry[] {
    if (!AUDIT_PERMISSIONS[principal.role]?.readAudit) {
      throw new Forbidden(`rol '${principal.role}' no puede leer el audit_log`);
    }
    return this.entries
      .filter(
        (e) =>
          (!filter?.botId || e.botId === filter.botId) &&
          (!filter?.correlationId || e.correlationId === filter.correlationId),
      )
      .map((e) => ({ ...e }));
  }

  /** security_findings: SOLO administradores (DoD T6.4). */
  queryFindings(principal: AuditPrincipal, filter?: { botId?: string; category?: string }): SecurityFinding[] {
    if (!AUDIT_PERMISSIONS[principal.role]?.readFindings) {
      throw new Forbidden(`rol '${principal.role}' no puede leer security_findings (solo admin)`);
    }
    return this.findings
      .filter(
        (f) => (!filter?.botId || f.botId === filter.botId) && (!filter?.category || f.category === filter.category),
      )
      .map((f) => ({ ...f }));
  }

  /** Tamaño del log (para tests/observabilidad). No permite mutación. */
  size(): { audit: number; findings: number } {
    return { audit: this.entries.length, findings: this.findings.length };
  }
}
