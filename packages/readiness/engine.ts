/**
 * R17 · Motor de readiness.
 *
 * La tesis del bloque: "healthy" no es "listo". Este proyecto ya ha pagado esa
 * factura seis veces (contenedor sano con la copia nocturna fallando, volumen
 * existente pero no escribible, imagen etiquetada con un commit y construida
 * desde otro, `UPDATE 0` leído como "aceptado"...). El motor existe para que la
 * pregunta "¿está listo?" tenga una respuesta con EVIDENCIA en vez de un color.
 *
 * Reglas duras del motor:
 *
 *  1. Cada comprobación declara `proves` y `doesNotProve`. Si no puede decir qué
 *     NO demuestra, no es una comprobación: es una opinión.
 *  2. Toda comprobación devuelve un EFECTO OBSERVADO. Terminar sin error no es
 *     aprobar: si el efecto es nulo (0 filas, 0 bytes, nada montado) el estado
 *     es `not_exercised`, nunca `verified`.
 *  3. `not_exercised` NO es aprobado. Un "skipped" cuenta como no listo.
 *  4. Una comprobación que no puede ponerse roja no cuenta: cada una registra
 *     mutaciones (`mutations.ts`) y un test comprueba que cada mutación la pone
 *     roja de verdad.
 */

export type CheckStatus =
  /** El comportamiento se ejerció y salió bien. Hay efecto observado. */
  | "verified"
  /** Se ejerció y falló. */
  | "failed"
  /** No se pudo ejercer, o se ejerció sobre la nada (efecto nulo). NO es aprobado. */
  | "not_exercised";

export type ReadinessBlock =
  "almacenamiento" | "copias" | "puertas-ejecucion" | "puertas-spectator" | "seguridad" | "diagnostico";

export interface CheckOutcome {
  status: CheckStatus;
  /** Efecto observado, en una línea. Sin secretos, sin IPs internas. */
  evidence: string;
  /** Detalle accionable cuando no está `verified`. */
  remedy?: string;
}

export interface ReadinessCheck<C = ReadinessContext> {
  id: string;
  block: ReadinessBlock;
  title: string;
  /** Qué demuestra esta comprobación si sale verde. */
  proves: string;
  /** Qué NO demuestra aunque salga verde. Obligatorio. */
  doesNotProve: string;
  /**
   * Bloqueante: si no queda `verified`, la instalación NO está lista.
   * Una comprobación no bloqueante sigue sin poder aprobarse por omisión: se
   * reporta aparte, nunca se pinta de verde.
   */
  required: boolean;
  run(ctx: C): Promise<CheckOutcome>;
}

export interface ReadinessReport {
  verdict: "READY" | "NOT_READY";
  results: Array<{ check: ReadinessCheck; outcome: CheckOutcome }>;
  counts: Record<CheckStatus, number>;
  /** Motivos por los que el veredicto no es READY. */
  blockers: string[];
}

/** Contexto que reciben las comprobaciones: entorno + sondas inyectables. */
export interface ReadinessContext {
  env: Record<string, string | undefined>;
  probes: ReadinessProbes;
}

/**
 * Sondas. Son la frontera con el mundo real: en producción las implementa el
 * runner (fs, docker, psql, restic); en los tests se sustituyen para provocar
 * fallos y demostrar que cada comprobación se pone roja.
 *
 * Todas devuelven EFECTO, no "exit code". Un `exitCode: 0` con `rowsAffected: 0`
 * es exactamente el fallo que costó más caro en este proyecto.
 */
export interface ReadinessProbes {
  /** Escribe y relee un fichero de prueba en el directorio de datos. */
  dataDirWrite(dir: string): Promise<{
    bytesWritten: number;
    readBack: boolean;
    sameContent: boolean;
    reason?: string;
  }>;
  /** Última ejecución REAL de la copia de seguridad. */
  backupLastRun(): Promise<{
    ranAt: string | null;
    exitCode: number | null;
    snapshotCount: number;
    lastSnapshotBytes: number;
    ageHours: number | null;
    reason?: string;
  }>;
  /** Restauración de prueba a un destino desechable, con canario. */
  backupRestoreDrill(): Promise<{
    attempted: boolean;
    restoredBytes: number;
    canaryFound: boolean;
    reason?: string;
  }>;
  /** Versión realmente desplegada, según el daemon, no según la etiqueta. */
  deployedVersion(): Promise<{
    imageTag: string | null;
    taggedCommit: string | null;
    builtFromCommit: string | null;
    runningImageId: string | null;
    imageIdPresentInDaemon: boolean;
    /**
     * ¿La etiqueta resuelve HOY a la misma image ID que corre el contenedor?
     * `false` = la etiqueta se movió bajo los pies del contenedor: un restart
     * traería otra imagen. `undefined` = la sonda no lo miró.
     */
    tagResolvesToRunningId?: boolean;
    /**
     * Estado explícito del modelo de drift de ADR-016 (cuatro estados):
     * `IMAGE_MISSING` · `TAG_CONTENT_MISMATCH` · `TAG_MOVED` · `RUNTIME_MATCH`.
     * `null` = no se pudo observar. La comprobación decide sobre esto, no
     * combinando los booleanos de arriba a mano.
     */
    driftState: "TAG_CONTENT_MISMATCH" | "IMAGE_MISSING" | "TAG_MOVED" | "RUNTIME_MATCH" | null;
    driftExplanation?: string;
    reason?: string;
  }>;
  /** Un secreto concreto: existir en el host no es estar montado en el proceso. */
  secretMounted(logicalName: string): Promise<{
    existsOnHost: boolean;
    mountedInProcess: boolean;
    readableBytes: number;
    reason?: string;
  }>;
  /**
   * Consulta de sanidad con canario: distingue "0 filas correcto" de
   * "la consulta no se ejecutó" y de "la tabla estaba vacía".
   */
  dbCanary(): Promise<{
    queryExecuted: boolean;
    canaryRowsSeen: number;
    rowsAffected: number;
    reason?: string;
  }>;
  /** Estado REAL de una puerta: lo que dice el entorno y lo que expone el runtime. */
  gateState(key: string): Promise<{
    envEnabled: boolean;
    runtimeAdvertisesEnabled: boolean;
    probedRuntime: boolean;
    reason?: string;
  }>;
  /** Paquete de diagnóstico: debe generarse y debe estar redactado. */
  diagnosticsBundle(): Promise<{
    generated: boolean;
    bytes: number;
    secretLikeMatches: number;
    reason?: string;
  }>;
}

export async function runReadiness(checks: readonly ReadinessCheck[], ctx: ReadinessContext): Promise<ReadinessReport> {
  const results: ReadinessReport["results"] = [];
  const counts: Record<CheckStatus, number> = { verified: 0, failed: 0, not_exercised: 0 };
  const blockers: string[] = [];

  for (const check of checks) {
    let outcome: CheckOutcome;
    try {
      outcome = await check.run(ctx);
    } catch (err) {
      // Una excepción NO es un "skip": es una comprobación que no se pudo
      // ejercer, y eso deja la instalación en NOT_READY si era bloqueante.
      outcome = {
        status: "not_exercised",
        evidence: `la sonda lanzó una excepción: ${(err as Error)?.message ?? String(err)}`,
        remedy: "Arregla la sonda o el entorno: sin ejecutar la prueba no hay readiness.",
      };
    }
    counts[outcome.status] += 1;
    results.push({ check, outcome });
    if (check.required && outcome.status !== "verified") {
      blockers.push(`${check.id} (${outcome.status}): ${outcome.evidence}`);
    }
  }

  return {
    verdict: blockers.length === 0 ? "READY" : "NOT_READY",
    results,
    counts,
    blockers,
  };
}

/** Ayuda: un efecto nulo nunca es verde. Codifica "EXIT 0 != BEHAVIOR EXERCISED". */
export function requireEffect(
  effectMagnitude: number,
  onEmpty: { evidence: string; remedy: string },
): CheckOutcome | null {
  if (effectMagnitude > 0) return null;
  return { status: "not_exercised", evidence: onEmpty.evidence, remedy: onEmpty.remedy };
}
