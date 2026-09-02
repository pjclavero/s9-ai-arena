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
 *     jamás es `verified`.
 *  3. `not_exercised` NO es aprobado. Un "skipped" cuenta como no listo.
 *  3.bis Los tres estados NO son intercambiables y su frontera es SI SE MIRÓ:
 *       - `verified`      se miró y la condición SE CUMPLE (con evidencia).
 *       - `failed`        se miró y la condición NO se cumple.
 *       - `not_exercised` NO se miró (o no se pudo mirar).
 *     Confundirlos en cualquiera de los dos sentidos rompe el gate: un
 *     `failed` por "no disponible en este entorno" es un FALSO FALLO que
 *     entierra los fallos de verdad, y un `not_exercised` sobre un efecto que
 *     SÍ se observó nulo es un fallo real disfrazado de "ya lo miraremos".
 *     Por eso toda sonda distingue "no se pudo observar" (`probed: false` /
 *     `attempted: false`) de "se observó y salió mal".
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
  /**
   * Escribe y relee un fichero de prueba en el directorio de datos.
   * `attempted: false` = ni se intentó (no hay directorio que mirar);
   * `attempted: true` con `bytesWritten: 0` = se intentó y el volumen lo
   * rechazó, que es un FALLO observado, no una comprobación pendiente.
   */
  dataDirWrite(dir: string): Promise<{
    attempted: boolean;
    bytesWritten: number;
    readBack: boolean;
    sameContent: boolean;
    reason?: string;
  }>;
  /**
   * ¿Está vivo el proceso que dispara la copia (cron/temporizador)?
   * Es EXACTAMENTE el healthcheck que engaña: pasa con la copia fallando todas
   * las noches. Por eso vive separado y no es bloqueante.
   */
  backupProcessAlive(): Promise<{
    probed: boolean;
    processRunning: boolean;
    reason?: string;
  }>;
  /** Última ejecución REAL de la copia: cuándo corrió y con qué resultado. */
  backupLastRun(): Promise<{
    probed: boolean;
    ranAt: string | null;
    exitCode: number | null;
    ageHours: number | null;
    reason?: string;
  }>;
  /** El snapshot que dejó esa ejecución: que exista, sea reciente y tenga bytes. */
  backupLastSnapshot(): Promise<{
    probed: boolean;
    /** Snapshots que llevan la etiqueta de datos: el subconjunto que se juzga. */
    snapshotCount: number;
    /**
     * Snapshots TOTALES del repositorio. Se informa aparte porque decir "N
     * snapshots en el repositorio" cuando N es un recuento filtrado es
     * describir un subconjunto como si fuera el todo — y en la instalación real
     * la diferencia es 17 frente a 35.
     */
    repositorySnapshotCount: number;
    latestSnapshotAt: string | null;
    latestSnapshotBytes: number;
    ageHours: number | null;
    reason?: string;
  }>;
  /**
   * Contraste del volcado de PostgreSQL contra su checksum en el manifest.
   * Exige LEER el dump ya almacenado, no creer al productor que lo escribió.
   */
  backupPgDumpChecksum(): Promise<{
    probed: boolean;
    checksumMatches: boolean;
    dumpBytes: number;
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
    reason?: string;
  }>;
  /**
   * Un secreto concreto: existir en el host no es estar montado en el proceso.
   * `probed: false` = la sonda NO pudo mirar el espacio de montaje. Eso NO es
   * "no está montado": es "no lo sé", y confundirlo fue el falso fallo que
   * dejó `security.secret_mounted` en rojo sin haber mirado nada.
   */
  secretMounted(logicalName: string): Promise<{
    probed: boolean;
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

/**
 * Ayuda: un efecto nulo nunca es verde. Codifica "EXIT 0 != BEHAVIOR EXERCISED".
 *
 * El `status` es OBLIGATORIO y sin defecto a propósito: cada sitio que llama
 * tiene que declarar si el efecto nulo significa "lo miré y salió a cero"
 * (`failed`) o "no llegué a mirar" (`not_exercised`). Cuando el defecto era
 * siempre `not_exercised`, media docena de fallos reales —una copia con exit 0
 * y 0 bytes, un secreto montado y vacío, una restauración que recupera nada—
 * se contaban como comprobaciones pendientes en vez de como lo que son.
 */
export function requireEffect(
  effectMagnitude: number,
  onEmpty: { evidence: string; remedy: string; status: CheckStatus },
): CheckOutcome | null {
  if (effectMagnitude > 0) return null;
  return { status: onEmpty.status, evidence: onEmpty.evidence, remedy: onEmpty.remedy };
}
