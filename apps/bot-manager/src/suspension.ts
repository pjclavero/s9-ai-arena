/**
 * E6 · bot-manager — suspensión de bots (T6.4, estados cap. 17.1).
 *
 * DoD T6.4: "un moderador o administrador puede pasar un bot a Suspendido desde la API; el
 * bot-manager rehúsa lanzar bots suspendidos y las inscripciones activas se marcan" +
 * "un bot suspendido no puede lanzarse aunque esté inscrito en un torneo; la batalla lo
 * descalifica administrativamente".
 *
 * SuspensionRegistry es la fuente de verdad de qué bots están suspendidos. Implementa
 * SuspensionCheck (lo consume LaunchAuthority de T6.2) y registra cada suspensión en el
 * audit_log. Solo moderador/admin pueden suspender.
 */
import type { AuditSink } from "./audit-sink.js";
import type { Principal } from "./launch-guard.js";
import type { SuspensionCheck } from "./launch-guard.js";

export class SuspensionForbidden extends Error {}

interface Enrollment {
  entryId: string;
  botId: string;
  version: number;
  marked: boolean;
}

function key(botId: string, version?: number): string {
  return version === undefined ? `${botId}:*` : `${botId}:${version}`;
}

export class SuspensionRegistry implements SuspensionCheck {
  /** claves suspendidas: "botId:version" o "botId:*" (todas las versiones). */
  private suspended = new Map<string, { reason: string; by: string; at: string }>();
  private enrollments: Enrollment[] = [];
  private now: () => string;

  constructor(
    private audit: AuditSink,
    clock?: () => string,
  ) {
    this.now = clock ?? (() => new Date().toISOString());
  }

  /** Registra una inscripción activa (torneo/entry) para poder marcarla al suspender. */
  registerEnrollment(entryId: string, botId: string, version: number): void {
    this.enrollments.push({ entryId, botId, version, marked: false });
  }

  /** Suspende un bot (o una versión). Solo moderador/admin. Motivo obligatorio. */
  suspend(actor: Principal, botId: string, version: number | undefined, reason: string): void {
    if (actor.role !== "moderator" && actor.role !== "admin") {
      throw new SuspensionForbidden(`rol '${actor.role}' no puede suspender bots (solo moderador/admin)`);
    }
    if (!reason || !reason.trim()) throw new SuspensionForbidden("motivo de suspensión obligatorio");
    this.suspended.set(key(botId, version), { reason, by: actor.id, at: this.now() });

    // Marca las inscripciones activas afectadas.
    const marked: string[] = [];
    for (const e of this.enrollments) {
      if (e.botId === botId && (version === undefined || e.version === version)) {
        e.marked = true;
        marked.push(e.entryId);
      }
    }
    this.audit.record({
      type: "bot.suspended",
      botId,
      version: version ?? -1,
      userId: actor.id,
      correlationId: `susp_${botId}_${version ?? "all"}`,
      detail: { reason, markedEnrollments: marked },
    });
  }

  isSuspended(botId: string, version?: number): boolean {
    if (this.suspended.has(key(botId))) return true; // todas las versiones
    if (version !== undefined && this.suspended.has(key(botId, version))) return true;
    return false;
  }

  /** Inscripciones marcadas como suspendidas (para reflejarlo en la competición). */
  markedEnrollments(): string[] {
    return this.enrollments.filter((e) => e.marked).map((e) => e.entryId);
  }
}

/**
 * Descalificación administrativa: dado el conjunto de inscritos que iban a lanzarse en una
 * batalla, devuelve las que hay que descalificar por estar suspendidas. La batalla no las
 * lanza; se registran como DQ administrativa.
 */
export function administrativeDisqualifications(
  entries: { entryId: string; botId: string; version: number }[],
  suspension: SuspensionCheck,
): { entryId: string; botId: string; version: number }[] {
  return entries.filter((e) => suspension.isSuspended(e.botId, e.version));
}
