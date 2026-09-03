/**
 * CARRIL E · Modelo de EVIDENCIA de la copia de seguridad.
 *
 * El problema que resuelve, en una línea:
 *
 *     cron alive != backup working
 *
 * El healthcheck del servicio `backup` en producción es `pgrep crond`. Ese
 * comando pasa —y el contenedor sale `healthy`— con la copia fallando TODAS
 * las noches, que es literalmente el incidente que este código existe para
 * evitar y que este proyecto ya pagó una vez: un contenedor sano cuyo único
 * trabajo llevaba días sin hacerse.
 *
 * La respuesta no es "un healthcheck mejor" sino separar la pregunta en
 * SEÑALES, cada una con (a) su fuente de evidencia, (b) su método de
 * obtención, (c) qué demuestra, (d) qué NO demuestra y (e) si puede o no
 * alimentar el veredicto de readiness. Esa última columna es la que impide
 * que "el demonio está vivo" se lea como "la copia funciona".
 *
 * Dos familias de evidencia, deliberadamente independientes:
 *
 *   - PRODUCTOR  (`producer`): lo que dice el propio backup.sh sobre sí mismo
 *     — métricas del textfile collector y sus registros. Barato, inmediato...
 *     y juez y parte: el productor se corrige su propio examen.
 *   - REPOSITORIO (`repository`): lo que se observa DESDE el repositorio
 *     restic, sin preguntarle al productor — `restic snapshots/ls/dump`, todo
 *     con `--no-lock`. Caro, pero es la única evidencia que sobrevive a que el
 *     productor mienta o no llegue a ejecutarse.
 *
 * Regla dura de este módulo: un veredicto favorable exige evidencia de AMBAS
 * familias. Con sólo el productor no se puede afirmar que exista un snapshot;
 * con sólo el repositorio no se puede afirmar que la última ejecución fuera
 * bien. Y `backup.process_alive` no alimenta el veredicto en ningún caso.
 *
 * Núcleo PURO a propósito: no ejecuta nada. Las observaciones las reúne
 * `infrastructure/backup/evidence.sh` (solo lectura) y aquí sólo se
 * interpretan, para que los tests puedan poner cada señal roja sin
 * infraestructura.
 *
 * Coordinación (carril hermano R17 v2): este módulo NO redefine las
 * comprobaciones de `checks.ts` ni la interfaz `ReadinessProbes` de
 * `engine.ts` — ese carril las está descomponiendo ahora mismo. Aquí vive la
 * capa que aquel no cubre: de dónde salen los datos de verdad, con qué
 * contrato y qué se puede afirmar con ellos.
 */
// Una sola verdad sobre cuándo una copia deja de representar el sistema: se
// reutiliza la de `checks.ts` (26 h = periodicidad diaria + margen), la misma
// que usan la alerta BackupTooOld y healthcheck.sh. Definir aquí un segundo
// umbral sería exactamente cómo dos partes del sistema acaban discrepando
// sobre si la copia está rancia.
import { BACKUP_MAX_AGE_HOURS } from "./checks.ts";
export { BACKUP_MAX_AGE_HOURS };

/** Estados. Mismos tres que el motor de readiness, y con el mismo significado. */
export type EvidenceStatus =
  /** Se miró y la condición SE CUMPLE, con efecto observado. */
  | "verified"
  /** Se miró y la condición NO se cumple. */
  | "failed"
  /** NO se miró, o se miró sobre la nada. NO es aprobado. */
  | "not_exercised";

/** De dónde sale la evidencia. Determina la independencia entre señales. */
export type EvidenceFamily = "producer" | "repository" | "scheduler";

/** Contrato del manifest observado en el snapshot que se está mirando. */
export type ManifestContract =
  /** `manifest.json` sin `schema`: el pg_dump está EXCLUIDO de manifest.sha256. */
  | "legacy"
  /** `"schema":2`: el pg_dump entra en manifest.sha256 como un activo más. */
  | "schema2"
  /** No se pudo leer o no se pudo decidir. Nunca se asume el favorable. */
  | "unknown";

/** Identificadores de las señales. Son el contrato público del carril. */
export type BackupSignalId =
  | "backup.process_alive"
  | "backup.last_run_started"
  | "backup.last_run_success"
  | "backup.last_snapshot_id"
  | "backup.last_snapshot_timestamp"
  | "backup.manifest_verified"
  | "backup.pg_dump_present"
  | "backup.pg_dump_sha256"
  | "backup.repository_accessible";

export interface BackupSignalSpec {
  id: BackupSignalId;
  family: EvidenceFamily;
  /** Fuente de evidencia: el artefacto concreto del que sale el dato. */
  source: string;
  /** Método de obtención: el comando/lectura exacta, siempre de solo lectura. */
  method: string;
  proves: string;
  doesNotProve: string;
  /**
   * ¿Puede esta señal alimentar el veredicto de readiness?
   *
   * `false` NO significa "no importa": significa que su verde no puede
   * comprar readiness ni por sí solo ni sumado a otros. Se reporta siempre.
   */
  readinessEligible: boolean;
  /** Si es elegible y no queda `verified`, el veredicto es NOT_READY. */
  required: boolean;
  /** Por qué se decidió su elegibilidad. Sin esto la decisión es una opinión. */
  eligibilityRationale: string;
}

/**
 * El modelo. Orden de lectura: primero lo barato y engañoso, luego lo caro y
 * concluyente.
 */
export const BACKUP_SIGNALS: readonly BackupSignalSpec[] = [
  {
    id: "backup.process_alive",
    family: "scheduler",
    source: "Tabla de procesos DENTRO del contenedor backup.",
    method: "`pgrep crond` (lo que hoy ES el healthcheck).",
    proves: "Que existe un proceso crond vivo en el contenedor en este instante.",
    doesNotProve:
      "NADA sobre la copia: ni que la entrada de crontab exista, ni que se haya disparado nunca, ni que la ejecución terminara bien, ni que haya un solo byte en el repositorio. Es exactamente la señal que deja un contenedor 'healthy' con la copia fallando cada noche.",
    readinessEligible: false,
    required: false,
    eligibilityRationale:
      "PROHIBIDA como fuente de readiness por construcción. Si pudiera aprobar —sola o sumada— reproduciríamos el defecto que este carril existe para eliminar. Su utilidad es la contraria: cuando la copia falla, distingue 'el planificador está muerto' de 'el planificador corre y el trabajo revienta'.",
  },
  {
    id: "backup.last_run_started",
    family: "producer",
    source: "Textfile collector `$METRICS_DIR/s9_backup.prom` (lo escribe backup.sh al terminar) y sus registros.",
    method: "Lectura del fichero .prom: presencia de `s9_backup_duration_seconds` / `s9_backup_last_exit_code`.",
    proves: "Que una ejecución de la copia llegó a existir y avanzó hasta escribir sus métricas.",
    doesNotProve:
      "Que terminara bien, ni que guardara nada. Una ejecución que arranca y falla escribe estas mismas métricas.",
    readinessEligible: false,
    required: false,
    eligibilityRationale:
      "No elegible: 'empezó' no es 'funcionó'. Su papel es discriminador — separa 'no ha corrido nunca' (`not_exercised`) de 'corrió y salió mal' (`failed`), que exigen respuestas distintas del operador y que sin esta señal se confundirían.",
  },
  {
    id: "backup.last_run_success",
    family: "producer",
    source: "Textfile collector `s9_backup.prom`.",
    method:
      "`s9_backup_run_success`, `s9_backup_last_exit_code`, `s9_backup_postgres_success`, `s9_backup_restic_snapshot_created` y la antigüedad de `s9_backup_last_success_timestamp_seconds`.",
    proves:
      "Que la última ejecución del script terminó con código 0, declaró éxito de la fuente crítica postgres, declaró haber creado snapshot y estampó una época de éxito reciente.",
    doesNotProve:
      "Que exista un snapshot: todo esto lo escribe el PRODUCTOR sobre sí mismo. Un fichero .prom rancio, congelado o escrito por una ejecución anterior produce exactamente esta misma señal en verde.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante, pero NUNCA suficiente: es evidencia de la familia `producer`, y el veredicto exige además corroboración independiente de la familia `repository`.",
  },
  {
    id: "backup.repository_accessible",
    family: "repository",
    source: "El repositorio restic de destino (sftp://<backup-host>/<backup-path>).",
    method:
      "`restic snapshots --no-lock --json` (rc explícito + JSON parseado). NUNCA `restic check`: toma lock y escribe.",
    proves:
      "Que en el momento de la sonda el repositorio se pudo abrir con la clave y credenciales del contenedor de backup, y se pudo listar su índice de snapshots.",
    doesNotProve:
      "Que se pueda ESCRIBIR esta noche (leer no es escribir), ni la integridad de los packs —eso es `restic check`, que no es de solo lectura y aquí está prohibido—, ni que el destino tenga espacio.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante, y además PRECONDICIÓN: si el repositorio no se pudo abrir, las señales que se leen de él quedan `not_exercised` con motivo, jamás `failed`. Un falso fallo por 'no pude mirar' entierra los fallos de verdad.",
  },
  {
    id: "backup.last_snapshot_id",
    family: "repository",
    source: "Índice de snapshots del repositorio restic, tag `s9-arena-data`.",
    method:
      "`restic snapshots --no-lock --json --tag s9-arena-data`, último elemento del array (campos de PRIMER nivel).",
    proves:
      "Que el repositorio contiene un objeto snapshot identificable, observado desde el destino y no desde quien lo escribió.",
    doesNotProve:
      "Qué hay dentro, que corresponda a la última ejecución, ni que sea restaurable. Un snapshot de un árbol vacío existe igual y tiene id igual de válido.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante: es la primera evidencia que NO viene del productor. Es la que convierte 'el script dice que hizo la copia' en 'la copia está donde tiene que estar'.",
  },
  {
    id: "backup.last_snapshot_timestamp",
    family: "repository",
    source: "Campo `time` del snapshot más reciente con tag `s9-arena-data`.",
    method: `Antigüedad = ahora − time, contrastada contra ${BACKUP_MAX_AGE_HOURS} h (periodicidad diaria + margen).`,
    proves: "Que la copia más reciente del repositorio representa un estado reciente del sistema.",
    doesNotProve:
      "Que su CONTENIDO esté al día. Un snapshot recién creado de un staging vacío es igual de reciente y no respalda nada; por eso esta señal nunca va sola.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante: una copia rancia existe pero ya no representa el sistema. Es el corte que el healthcheck `pgrep crond` no puede hacer ni en principio.",
  },
  {
    id: "backup.pg_dump_present",
    family: "repository",
    source: "Listado de ficheros DEL SNAPSHOT (no del disco local).",
    method: "`restic ls --no-lock <id>`; se busca `pgdump-*.dump` en la RAÍZ del staging.",
    proves: "Que el activo más crítico —el volcado de PostgreSQL— está dentro de ese snapshot concreto.",
    doesNotProve:
      "Que el volcado esté completo, sea SQL válido o se pueda cargar. Un fichero de 0 bytes con ese nombre satisface la presencia y no respalda nada; por eso existe la señal del checksum aparte.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante: si el activo crítico no está en el snapshot, todo lo demás es decorado. Fue el incidente que motivó el rediseño #110b (el dump se perdía y nadie lo notaba).",
  },
  {
    id: "backup.manifest_verified",
    family: "repository",
    source: "`manifest.json` y `manifest.sha256` LEÍDOS DE DENTRO del snapshot.",
    method:
      "`restic dump --no-lock <id> …/manifest.json` para decidir el contrato (`schema`), y `…/manifest.sha256` contrastado con el listado real de ficheros del snapshot.",
    proves:
      "Que el manifest describe exactamente los ficheros que el snapshot contiene, bajo el contrato que el propio manifest declara.",
    doesNotProve:
      "Que los checksums cuadren con los bytes: eso exige leer cada fichero. Cobertura completa no es integridad verificada, y ninguna de las dos es restaurabilidad (BACKED_UP != RECOVERY_VERIFIED).",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante: un manifest truncado da por buena una restauración incompleta. Bajo contrato `unknown` queda `not_exercised` con motivo — nunca se asume el contrato favorable.",
  },
  {
    id: "backup.pg_dump_sha256",
    family: "repository",
    source: "Línea del pg_dump en `manifest.sha256` + los bytes del dump dentro del snapshot.",
    method:
      "`restic dump --no-lock <id> …/manifest.sha256` para el hash declarado y `restic dump … <dump> | sha256sum` para el hash real. Comparación de los dos.",
    proves:
      "Bajo contrato `schema2`: que los bytes del volcado almacenados en el repositorio son exactamente los que el manifest declara.",
    doesNotProve:
      "Que el volcado sea semánticamente correcto ni recuperable: un dump truncado por pg_dump y luego hasheado coincide consigo mismo perfectamente.",
    readinessEligible: true,
    required: true,
    eligibilityRationale:
      "Elegible y bloqueante SÓLO bajo `schema2`. Bajo `legacy` el backup.sh que escribió esos snapshots EXCLUÍA el dump del manifest (`! -path './pgdump-*'`): no hay checksum que contrastar, así que la señal queda `not_exercised` CON MOTIVO. Aprobarla por omisión sería inventar una garantía que ese contrato nunca dio; suspenderla sería un falso fallo de un manifest que está perfecto para su contrato.",
  },
];

export function backupSignal(id: BackupSignalId): BackupSignalSpec {
  const spec = BACKUP_SIGNALS.find((s) => s.id === id);
  if (!spec) throw new Error(`señal de backup desconocida: ${id}`);
  return spec;
}

// ── Observaciones ────────────────────────────────────────────────────────────
//
// Todas llevan `probed`: distinguir "no se pudo mirar" de "se miró y salió
// mal" es la diferencia entre un `not_exercised` honesto y un falso fallo.

export interface ProcessObservation {
  probed: boolean;
  running: boolean;
  reason?: string;
}

export interface MetricsObservation {
  probed: boolean;
  /** ¿Existía el fichero .prom? */
  present: boolean;
  /** Métricas sin etiquetas, ya parseadas. */
  values: Readonly<Record<string, number>>;
  reason?: string;
}

export interface RepositoryObservation {
  probed: boolean;
  accessible: boolean;
  snapshotCount: number;
  reason?: string;
}

export interface SnapshotObservation {
  probed: boolean;
  id: string | null;
  /** ISO-8601 del campo `time` del snapshot. */
  timeIso: string | null;
  /** Ficheros del snapshot, con ruta RELATIVA a la raíz del staging. */
  files: readonly string[];
  reason?: string;
}

export interface ManifestObservation {
  probed: boolean;
  /** Contenido crudo de manifest.json, tal cual salió de `restic dump`. */
  jsonRaw: string | null;
  /** Contenido crudo de manifest.sha256. */
  sha256Raw: string | null;
  reason?: string;
}

export interface PgDumpObservation {
  probed: boolean;
  /** sha256 RECALCULADO leyendo los bytes del dump desde el snapshot. */
  recomputedSha256: string | null;
  bytes: number;
  reason?: string;
}

export interface BackupObservations {
  nowMs: number;
  process: ProcessObservation;
  metrics: MetricsObservation;
  repository: RepositoryObservation;
  snapshot: SnapshotObservation;
  manifest: ManifestObservation;
  pgDump: PgDumpObservation;
  maxAgeHours?: number;
}

export interface BackupSignalOutcome {
  spec: BackupSignalSpec;
  status: EvidenceStatus;
  /** Efecto observado, en una línea. Sin secretos ni topología real. */
  evidence: string;
  remedy?: string;
}

export interface BackupEvidenceReport {
  verdict: "READY" | "NOT_READY";
  contract: ManifestContract;
  outcomes: BackupSignalOutcome[];
  counts: Record<EvidenceStatus, number>;
  blockers: string[];
  /** Familias que han aportado al menos una señal `verified` elegible. */
  corroboratingFamilies: EvidenceFamily[];
}

// ── Parseadores ──────────────────────────────────────────────────────────────

/**
 * Textfile collector de Prometheus. Sólo métricas SIN etiquetas (las que
 * llevan `{source="…"}` son por fuente y no deciden este veredicto).
 */
export function parsePromTextfile(raw: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?[0-9.eE+]+)$/.exec(t);
    if (!m) continue;
    const n = Number(m[2]);
    if (Number.isFinite(n)) values[m[1]] = n;
  }
  return values;
}

/**
 * Decide el contrato del manifest.
 *
 * `schema` sólo cuenta en el PRIMER nivel del objeto: un `schema` anidado
 * dentro de una fuente no puede suplantarlo (mismo criterio que el parser
 * consciente del anidamiento de restore.sh).
 */
export function detectManifestContract(jsonRaw: string | null): ManifestContract {
  if (jsonRaw === null || jsonRaw.trim() === "") return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonRaw);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unknown";
  const schema = (parsed as Record<string, unknown>).schema;
  if (schema === undefined) {
    // Un manifest.json legítimo SIEMPRE declara sus fuentes. Un objeto vacío
    // no es "legacy": es un manifest que no dice nada, y eso es `unknown`.
    return Object.keys(parsed as object).length > 0 ? "legacy" : "unknown";
  }
  if (typeof schema === "number" && schema >= 2) return "schema2";
  if (typeof schema === "number") return "legacy";
  return "unknown";
}

/** Líneas "<hash>  <ruta>" del formato portable de sha256sum. */
export function parseManifestSha256(raw: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === null) return out;
  for (const line of raw.split("\n")) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (m) out.set(m[2].replace(/^\.\//, ""), m[1]);
  }
  return out;
}

const DUMP_RE = /^pgdump-[^/]*\.dump$/;

/** El pg_dump vive en la RAÍZ del staging: `maps/pgdump-x.dump` no es el dump. */
export function findPgDumpPath(files: readonly string[]): string | null {
  return files.map((f) => f.replace(/^\.\//, "")).find((f) => DUMP_RE.test(f)) ?? null;
}

// ── Interpretación ───────────────────────────────────────────────────────────

function outcome(id: BackupSignalId, status: EvidenceStatus, evidence: string, remedy?: string): BackupSignalOutcome {
  return { spec: backupSignal(id), status, evidence, remedy };
}

function num(values: Readonly<Record<string, number>>, key: string): number | null {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
}

export function assessBackupEvidence(obs: BackupObservations): BackupEvidenceReport {
  const maxAgeHours = obs.maxAgeHours ?? BACKUP_MAX_AGE_HOURS;
  const contract = obs.manifest.probed ? detectManifestContract(obs.manifest.jsonRaw) : "unknown";
  const outcomes: BackupSignalOutcome[] = [];

  // 1 · process_alive — se reporta, no decide.
  outcomes.push(
    !obs.process.probed
      ? outcome(
          "backup.process_alive",
          "not_exercised",
          `no se pudo mirar la tabla de procesos${obs.process.reason ? ` (${obs.process.reason})` : ""}`,
        )
      : obs.process.running
        ? outcome("backup.process_alive", "verified", "crond vivo (informativo: NO alimenta el veredicto)")
        : outcome(
            "backup.process_alive",
            "failed",
            "crond NO está vivo: nada disparará la copia de esta noche",
            "Revisa el entrypoint del servicio backup. Ojo: que estuviera vivo tampoco habría probado que la copia funciona.",
          ),
  );

  // 2 · last_run_started.
  const v = obs.metrics.values;
  const hasRunMarkers = num(v, "s9_backup_duration_seconds") !== null || num(v, "s9_backup_last_exit_code") !== null;
  if (!obs.metrics.probed) {
    outcomes.push(
      outcome(
        "backup.last_run_started",
        "not_exercised",
        `no se pudo leer el textfile de métricas${obs.metrics.reason ? ` (${obs.metrics.reason})` : ""}`,
      ),
    );
  } else if (!obs.metrics.present || !hasRunMarkers) {
    outcomes.push(
      outcome(
        "backup.last_run_started",
        "failed",
        "no consta NINGUNA ejecución de la copia: el textfile de métricas no existe o no tiene marcas de ejecución",
        "El planificador puede estar vivo y no haber ejecutado nada nunca. Revisa la crontab y el log del contenedor.",
      ),
    );
  } else {
    outcomes.push(
      outcome(
        "backup.last_run_started",
        "verified",
        `consta una ejecución que llegó a escribir métricas (duración ${num(v, "s9_backup_duration_seconds") ?? "?"} s)`,
      ),
    );
  }

  // 3 · last_run_success.
  if (!obs.metrics.probed || !obs.metrics.present) {
    outcomes.push(
      outcome(
        "backup.last_run_success",
        "not_exercised",
        `sin métricas del productor no se puede afirmar nada de la última ejecución${obs.metrics.reason ? ` (${obs.metrics.reason})` : ""}`,
        "Comprueba que el volumen de textfile esté montado y que backup.sh escriba en él.",
      ),
    );
  } else {
    const runSuccess = num(v, "s9_backup_run_success");
    const exitCode = num(v, "s9_backup_last_exit_code");
    const pgSuccess = num(v, "s9_backup_postgres_success");
    const snapCreated = num(v, "s9_backup_restic_snapshot_created");
    const lastSuccessEpoch = num(v, "s9_backup_last_success_timestamp_seconds");
    const fails: string[] = [];
    if (runSuccess !== 1) fails.push(`s9_backup_run_success=${runSuccess ?? "ausente"}`);
    if (exitCode !== 0) fails.push(`s9_backup_last_exit_code=${exitCode ?? "ausente"}`);
    if (pgSuccess !== 1) fails.push(`s9_backup_postgres_success=${pgSuccess ?? "ausente"}`);
    if (snapCreated !== 1) fails.push(`s9_backup_restic_snapshot_created=${snapCreated ?? "ausente"}`);
    if (fails.length > 0) {
      outcomes.push(
        outcome(
          "backup.last_run_success",
          "failed",
          `la última ejecución NO fue un éxito completo: ${fails.join(", ")}`,
          "Contenedor 'healthy' con su único trabajo fallando: exactamente lo que `pgrep crond` no puede ver.",
        ),
      );
    } else if (lastSuccessEpoch === null) {
      outcomes.push(
        outcome(
          "backup.last_run_success",
          "not_exercised",
          "las métricas declaran éxito pero no hay época de último éxito que fechar",
          "Sin fecha no se puede distinguir un éxito de hoy de uno de hace un mes.",
        ),
      );
    } else {
      const ageHours = (obs.nowMs / 1000 - lastSuccessEpoch) / 3600;
      if (ageHours > maxAgeHours) {
        outcomes.push(
          outcome(
            "backup.last_run_success",
            "failed",
            `el último éxito declarado tiene ${ageHours.toFixed(1)} h (> ${maxAgeHours} h)`,
            "Métricas congeladas o copia rancia: existe, pero ya no representa el estado actual.",
          ),
        );
      } else {
        outcomes.push(
          outcome(
            "backup.last_run_success",
            "verified",
            `última ejecución con éxito hace ${ageHours.toFixed(1)} h (exit 0, postgres ok, snapshot declarado)`,
          ),
        );
      }
    }
  }

  // 4 · repository_accessible — precondición de todo lo que sigue.
  const repoUsable = obs.repository.probed && obs.repository.accessible;
  outcomes.push(
    !obs.repository.probed
      ? outcome(
          "backup.repository_accessible",
          "not_exercised",
          `no se intentó abrir el repositorio${obs.repository.reason ? ` (${obs.repository.reason})` : ""}`,
          "Sin mirar el destino, la única evidencia sería la del propio productor.",
        )
      : !obs.repository.accessible
        ? outcome(
            "backup.repository_accessible",
            "failed",
            `el repositorio de copias no se pudo abrir${obs.repository.reason ? ` (${obs.repository.reason})` : ""}`,
            "Credenciales, red o known_hosts: la copia de esta noche fallará igual y nadie lo sabría hasta necesitarla.",
          )
        : outcome(
            "backup.repository_accessible",
            "verified",
            `repositorio abierto y listado (${obs.repository.snapshotCount} snapshots)`,
          ),
  );

  const repoBlocked = (id: BackupSignalId) =>
    outcome(
      id,
      "not_exercised",
      "no se miró: el repositorio de copias no estaba accesible",
      "Resuelve primero backup.repository_accessible; un fallo aquí sería falso.",
    );

  // 5 · last_snapshot_id.
  if (!repoUsable) {
    outcomes.push(repoBlocked("backup.last_snapshot_id"));
  } else if (!obs.snapshot.probed) {
    outcomes.push(
      outcome(
        "backup.last_snapshot_id",
        "not_exercised",
        `no se listaron snapshots del tag de datos${obs.snapshot.reason ? ` (${obs.snapshot.reason})` : ""}`,
      ),
    );
  } else if (!obs.snapshot.id) {
    outcomes.push(
      outcome(
        "backup.last_snapshot_id",
        "failed",
        "el repositorio es accesible y NO contiene ningún snapshot de datos",
        "El productor puede estar declarando éxito sobre un repositorio vacío.",
      ),
    );
  } else {
    outcomes.push(
      outcome(
        "backup.last_snapshot_id",
        "verified",
        `snapshot de datos observado en el repositorio: ${obs.snapshot.id.slice(0, 12)}`,
      ),
    );
  }

  // 6 · last_snapshot_timestamp.
  if (!repoUsable) {
    outcomes.push(repoBlocked("backup.last_snapshot_timestamp"));
  } else if (!obs.snapshot.probed || !obs.snapshot.id) {
    outcomes.push(outcome("backup.last_snapshot_timestamp", "not_exercised", "no hay snapshot cuya fecha fechar"));
  } else {
    const t = obs.snapshot.timeIso ? Date.parse(obs.snapshot.timeIso) : NaN;
    if (!Number.isFinite(t)) {
      outcomes.push(
        outcome(
          "backup.last_snapshot_timestamp",
          "not_exercised",
          `el snapshot no trae una fecha interpretable (${obs.snapshot.timeIso ?? "ausente"})`,
        ),
      );
    } else {
      const ageHours = (obs.nowMs - t) / 3_600_000;
      outcomes.push(
        ageHours > maxAgeHours
          ? outcome(
              "backup.last_snapshot_timestamp",
              "failed",
              `el snapshot más reciente tiene ${ageHours.toFixed(1)} h (> ${maxAgeHours} h)`,
              "Copia rancia observada en el DESTINO, digan lo que digan las métricas del productor.",
            )
          : outcome(
              "backup.last_snapshot_timestamp",
              "verified",
              `snapshot más reciente de hace ${ageHours.toFixed(1)} h`,
            ),
      );
    }
  }

  // 7 · pg_dump_present.
  const dumpPath = findPgDumpPath(obs.snapshot.files);
  if (!repoUsable) {
    outcomes.push(repoBlocked("backup.pg_dump_present"));
  } else if (!obs.snapshot.probed || !obs.snapshot.id) {
    outcomes.push(outcome("backup.pg_dump_present", "not_exercised", "no hay snapshot cuyo contenido listar"));
  } else if (obs.snapshot.files.length === 0) {
    outcomes.push(
      outcome(
        "backup.pg_dump_present",
        "not_exercised",
        `el listado del snapshot vino vacío${obs.snapshot.reason ? ` (${obs.snapshot.reason})` : ""}`,
        "Un listado vacío es 'no se pudo mirar dentro', no 'está todo bien'.",
      ),
    );
  } else if (!dumpPath) {
    outcomes.push(
      outcome(
        "backup.pg_dump_present",
        "failed",
        `el snapshot ${obs.snapshot.id.slice(0, 12)} NO contiene ningún pgdump-*.dump en la raíz del staging`,
        "El activo crítico no está respaldado: el resto del snapshot no lo compensa.",
      ),
    );
  } else {
    outcomes.push(outcome("backup.pg_dump_present", "verified", `volcado presente en el snapshot: ${dumpPath}`));
  }

  // 8 · manifest_verified.
  const declared = parseManifestSha256(obs.manifest.sha256Raw);
  if (!repoUsable) {
    outcomes.push(repoBlocked("backup.manifest_verified"));
  } else if (!obs.manifest.probed || obs.manifest.sha256Raw === null) {
    outcomes.push(
      outcome(
        "backup.manifest_verified",
        "not_exercised",
        `no se pudo leer manifest.sha256 del snapshot${obs.manifest.reason ? ` (${obs.manifest.reason})` : ""}`,
      ),
    );
  } else if (contract === "unknown") {
    outcomes.push(
      outcome(
        "backup.manifest_verified",
        "not_exercised",
        "el contrato del manifest no se pudo determinar (manifest.json ausente, ilegible o sin fuentes)",
        "Sin saber si el dump debe estar dentro del manifest, cualquier veredicto sería inventado.",
      ),
    );
  } else {
    // Cobertura: los ficheros del snapshot que el contrato obliga a describir.
    const expected = obs.snapshot.files
      .map((f) => f.replace(/^\.\//, ""))
      .filter((f) => !/^manifest\.[^/]*$/.test(f))
      .filter((f) => !(contract === "legacy" && DUMP_RE.test(f)));
    const missing = expected.filter((f) => !declared.has(f));
    const extra = [...declared.keys()].filter((f) => !expected.includes(f));
    if (declared.size === 0) {
      outcomes.push(
        outcome(
          "backup.manifest_verified",
          "failed",
          `manifest.sha256 vacío frente a ${expected.length} ficheros que el contrato ${contract} obliga a describir`,
          "Un manifest vacío daría por buena cualquier restauración.",
        ),
      );
    } else if (missing.length > 0 || extra.length > 0) {
      outcomes.push(
        outcome(
          "backup.manifest_verified",
          "failed",
          `manifest incoherente con el snapshot (contrato ${contract}): ${missing.length} sin checksum, ${extra.length} declarados y ausentes`,
          "Manifest truncado o de otro árbol: `--verify` lo daría por bueno igual.",
        ),
      );
    } else {
      outcomes.push(
        outcome(
          "backup.manifest_verified",
          "verified",
          `manifest ${contract} coherente: ${declared.size} entradas para ${expected.length} ficheros del snapshot`,
        ),
      );
    }
  }

  // 9 · pg_dump_sha256 — aquí es donde el contrato manda.
  if (!repoUsable) {
    outcomes.push(repoBlocked("backup.pg_dump_sha256"));
  } else if (contract === "unknown") {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "not_exercised",
        "contrato del manifest indeterminado: no se sabe si debería haber checksum del volcado",
      ),
    );
  } else if (contract === "legacy") {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "not_exercised",
        "contrato LEGACY (manifest.json sin `schema`): el backup.sh que escribió este snapshot excluía el pg_dump de manifest.sha256, así que NO existe checksum del volcado que contrastar",
        'No es un fallo del manifest: es una garantía que ese contrato nunca dio. Se cierra desplegando el backup.sh de main (`"schema":2`) y esperando al primer snapshot nuevo.',
      ),
    );
  } else if (!dumpPath) {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "failed",
        "contrato schema2 y ningún pgdump-*.dump en el snapshot: no hay volcado que verificar",
      ),
    );
  } else if (!declared.has(dumpPath)) {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "failed",
        `contrato schema2 y ${dumpPath} SIN línea en manifest.sha256: el activo crítico viaja sin checksum`,
        "Un manifest que promete cobertura completa y deja fuera el dump es peor que no tenerlo.",
      ),
    );
  } else if (!obs.pgDump.probed || obs.pgDump.recomputedSha256 === null) {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "not_exercised",
        `hay checksum declarado para ${dumpPath} pero no se recalculó sobre los bytes almacenados${obs.pgDump.reason ? ` (${obs.pgDump.reason})` : ""}`,
        "Creer al manifest sin leer el fichero es creer al productor otra vez.",
      ),
    );
  } else if (obs.pgDump.bytes <= 0) {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "failed",
        `el volcado almacenado tiene ${obs.pgDump.bytes} bytes: un dump vacío hashea perfectamente y no respalda nada`,
      ),
    );
  } else if (obs.pgDump.recomputedSha256 !== declared.get(dumpPath)) {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "failed",
        `el sha256 recalculado del volcado NO coincide con el declarado en manifest.sha256 (${obs.pgDump.bytes} B leídos)`,
        "Corrupción o manifest de otro árbol: la restauración pasaría `--verify` sólo si el manifest miente igual.",
      ),
    );
  } else {
    outcomes.push(
      outcome(
        "backup.pg_dump_sha256",
        "verified",
        `sha256 del volcado recalculado sobre ${obs.pgDump.bytes} B almacenados y coincidente con manifest.sha256`,
      ),
    );
  }

  // ── Veredicto ──────────────────────────────────────────────────────────────
  const counts: Record<EvidenceStatus, number> = { verified: 0, failed: 0, not_exercised: 0 };
  const blockers: string[] = [];
  const families = new Set<EvidenceFamily>();
  for (const o of outcomes) {
    counts[o.status] += 1;
    if (!o.spec.readinessEligible) continue;
    if (o.status === "verified") families.add(o.spec.family);
    else if (o.spec.required) blockers.push(`${o.spec.id} (${o.status}): ${o.evidence}`);
  }

  // La regla anti-`pgrep`: hacen falta las DOS familias que pueden corroborarse
  // entre sí. `scheduler` no cuenta ni aunque estuviera verde — no es elegible,
  // así que nunca entra en este conjunto.
  const corroborating = [...families];
  if (!families.has("producer") || !families.has("repository")) {
    blockers.push(
      `evidencia insuficiente: se exige corroboración de productor Y repositorio, y sólo hay [${corroborating.join(", ") || "ninguna"}]`,
    );
  }

  return {
    verdict: blockers.length === 0 ? "READY" : "NOT_READY",
    contract,
    outcomes,
    counts,
    blockers,
    corroboratingFamilies: corroborating,
  };
}

/** Render de texto plano para consola y parte de incidencia. */
export function renderBackupEvidence(report: BackupEvidenceReport): string {
  const ICON = { verified: "OK  ", failed: "FAIL", not_exercised: "??? " } as const;
  const lines: string[] = [];
  lines.push(`COPIA DE SEGURIDAD · VEREDICTO: ${report.verdict}`);
  lines.push(`Contrato del manifest observado: ${report.contract}`);
  lines.push(
    `Recuento: verificadas=${report.counts.verified} fallidas=${report.counts.failed} no-ejercidas=${report.counts.not_exercised} (no-ejercida NO es aprobada)`,
  );
  lines.push(`Familias que corroboran: ${report.corroboratingFamilies.join(", ") || "ninguna"}`);
  lines.push("");
  for (const o of report.outcomes) {
    lines.push(`  [${ICON[o.status]}] ${o.spec.id}${o.spec.readinessEligible ? "" : "  (no alimenta el veredicto)"}`);
    lines.push(`        fuente: ${o.spec.source}`);
    lines.push(`        método: ${o.spec.method}`);
    lines.push(`        efecto: ${o.evidence}`);
    lines.push(`        demuestra: ${o.spec.proves}`);
    lines.push(`        NO demuestra: ${o.spec.doesNotProve}`);
    if (o.remedy) lines.push(`        acción: ${o.remedy}`);
  }
  if (report.blockers.length > 0) {
    lines.push("");
    lines.push("── Bloqueantes ──");
    for (const b of report.blockers) lines.push(`  - ${b}`);
  }
  return lines.join("\n");
}

/**
 * Adaptador de la salida JSON de `infrastructure/backup/evidence.sh` a las
 * observaciones de este módulo. Vive aquí, y no en el script, para que el
 * contrato entre los dos esté fijado por tests.
 */
export function observationsFromEvidenceJson(doc: unknown, nowMs: number): BackupObservations {
  const d = (typeof doc === "object" && doc !== null ? doc : {}) as Record<string, any>;
  const asBool = (x: unknown) => x === true;
  const asNum = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const asStr = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
  return {
    nowMs,
    process: {
      probed: asBool(d.process?.probed),
      running: asBool(d.process?.running),
      reason: asStr(d.process?.reason) ?? undefined,
    },
    metrics: {
      probed: asBool(d.metrics?.probed),
      present: asBool(d.metrics?.present),
      values: typeof d.metrics?.values === "object" && d.metrics.values !== null ? d.metrics.values : {},
      reason: asStr(d.metrics?.reason) ?? undefined,
    },
    repository: {
      probed: asBool(d.repository?.probed),
      accessible: asBool(d.repository?.accessible),
      snapshotCount: asNum(d.repository?.snapshotCount),
      reason: asStr(d.repository?.reason) ?? undefined,
    },
    snapshot: {
      probed: asBool(d.snapshot?.probed),
      id: asStr(d.snapshot?.id),
      timeIso: asStr(d.snapshot?.time),
      files: arr(d.snapshot?.files),
      reason: asStr(d.snapshot?.reason) ?? undefined,
    },
    manifest: {
      probed: asBool(d.manifest?.probed),
      jsonRaw: asStr(d.manifest?.json),
      sha256Raw: asStr(d.manifest?.sha256),
      reason: asStr(d.manifest?.reason) ?? undefined,
    },
    pgDump: {
      probed: asBool(d.pgDump?.probed),
      recomputedSha256: asStr(d.pgDump?.sha256),
      bytes: asNum(d.pgDump?.bytes),
      reason: asStr(d.pgDump?.reason) ?? undefined,
    },
  };
}
