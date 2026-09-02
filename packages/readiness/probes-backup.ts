/**
 * R17 · Sondas REALES del bloque de copias (solo lectura).
 *
 * Qué resuelve: el healthcheck del servicio de copias en este despliegue es
 * `pgrep crond`. Está en verde AHORA MISMO y no dice absolutamente nada de si
 * la copia de anoche funcionó. Aquí se separan tres observaciones distintas,
 * todas obtenibles sin escribir nada:
 *
 *   1. `backupProcessAliveProbe`  → `docker inspect`: ¿corre el contenedor y qué
 *      dice su healthcheck? (es decir: ¿hay quien dispare la copia?).
 *   2. `backupLastRunProbe`       → las métricas que la propia copia deja
 *      escritas al terminar: código de salida y época del último éxito.
 *   3. `backupLastSnapshotProbe`  → el REPOSITORIO: `restic snapshots --no-lock`
 *      y `restic stats --no-lock`. Es la única de las tres que no se cree al
 *      productor: mira lo que quedó guardado.
 *
 * Reglas que respeta:
 *  - SOLO LECTURA. `docker inspect` y `docker exec` de comandos que no escriben
 *    (`cat`, `restic snapshots/stats` con `--no-lock`). Nada de `restic check`
 *    (toma lock exclusivo y escribe), ni forget, ni prune, ni restore.
 *  - Efecto observado, no exit code: si no se puede consultar se devuelve
 *    `probed: false` con motivo y la comprobación queda `not_exercised`.
 *  - Núcleo puro separado de la ejecución, para poder ponerlo rojo sin daemon.
 */
import type { EjecutorComando } from "./probes-docker.ts";
import { ejecutorRealDocker } from "./probes-docker.ts";

/** Etiqueta con la que la copia marca el snapshot de datos de la arena. */
export const TAG_SNAPSHOT_DATOS = "s9-arena-data";

const SIN_CONTENEDOR = "S9_READINESS_BACKUP_CONTAINER sin definir: no se ha mirado ningún servicio de copias";

// ── 1. ¿Hay quien dispare la copia? ──────────────────────────────────────────

export interface ObservacionProceso {
  probed: boolean;
  running: boolean;
  /** `healthy`/`unhealthy`/`starting`, o cadena vacía si el servicio no declara healthcheck. */
  healthStatus: string;
  reason?: string;
}

/**
 * Núcleo puro. Un contenedor parado no dispara nada; uno vivo con healthcheck
 * en `unhealthy` tampoco se da por bueno. Un servicio SIN healthcheck y
 * corriendo cuenta como vivo: no se puede exigir más de lo que se observa.
 */
export function interpretarProceso(obs: ObservacionProceso): {
  probed: boolean;
  processRunning: boolean;
  reason?: string;
} {
  if (!obs.probed) {
    return { probed: false, processRunning: false, reason: obs.reason ?? "no se pudo consultar el servicio de copias" };
  }
  const sano = obs.healthStatus === "" || obs.healthStatus === "healthy";
  return {
    probed: true,
    processRunning: obs.running && sano,
    ...(obs.running && !sano ? { reason: `el healthcheck del servicio dice '${obs.healthStatus}'` } : {}),
  };
}

export function observarProceso(contenedor: string, run: EjecutorComando): ObservacionProceso {
  const r = run("docker", [
    "inspect",
    "-f",
    "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}",
    contenedor,
  ]);
  if (r.rc !== 0) {
    return {
      probed: false,
      running: false,
      healthStatus: "",
      reason: `docker inspect ${contenedor}: ${r.err || "falló"}`,
    };
  }
  const [running, health] = r.out.split("\t");
  return { probed: true, running: (running ?? "").trim() === "true", healthStatus: (health ?? "").trim() };
}

export function backupProcessAliveProbe(contenedor: string, run?: EjecutorComando) {
  return async () => {
    const nombre = contenedor.trim();
    if (nombre === "") return { probed: false, processRunning: false, reason: SIN_CONTENEDOR };
    return interpretarProceso(observarProceso(nombre, run ?? ejecutorRealDocker()));
  };
}

// ── 2. ¿Qué resultado dejó la última ejecución? ──────────────────────────────

/**
 * Lee un gauge de un textfile de Prometheus. Ignora comentarios (`# HELP`,
 * `# TYPE`) y series con etiquetas: aquí sólo interesan los escalares.
 * Devuelve `null` cuando la métrica NO está, que es distinto de valer 0.
 */
export function leerGauge(prom: string, nombre: string): number | null {
  for (const linea of prom.split("\n")) {
    const l = linea.trim();
    if (l === "" || l.startsWith("#")) continue;
    const [clave, valor] = l.split(/\s+/);
    if (clave !== nombre) continue;
    const n = Number(valor);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Núcleo puro: métricas de la última copia → resultado observable.
 * Que el fichero exista pero no traiga las métricas NO es "no consta ninguna
 * ejecución": es que no se ha podido observar, y se dice así.
 */
export function interpretarMetricasCopia(
  prom: string,
  ahoraMs: number,
): { probed: boolean; ranAt: string | null; exitCode: number | null; ageHours: number | null; reason?: string } {
  const exit = leerGauge(prom, "s9_backup_last_exit_code");
  const epoca = leerGauge(prom, "s9_backup_last_success_timestamp_seconds");
  const exito = leerGauge(prom, "s9_backup_run_success");

  if (exit === null && epoca === null && exito === null) {
    return {
      probed: false,
      ranAt: null,
      exitCode: null,
      ageHours: null,
      reason: "el fichero de métricas no contiene ninguna métrica de copia",
    };
  }
  // Se observó el registro; a partir de aquí, la ausencia de ejecución SÍ es
  // una afirmación: se miró y no consta ninguna.
  if (epoca === null || epoca <= 0) {
    return { probed: true, ranAt: null, exitCode: exit, ageHours: null };
  }
  const ranAt = new Date(epoca * 1000).toISOString();
  const ageHours = Math.round(((ahoraMs - epoca * 1000) / 3_600_000) * 10) / 10;
  // `run_success` a 0 con `last_exit_code` a 0 significa que la última
  // ejecución NO fue un éxito aunque el código escrito sea viejo: prevalece el
  // indicador de éxito.
  const exitCode = exito !== null && exito !== 1 ? (exit !== null && exit !== 0 ? exit : 1) : (exit ?? 0);
  return { probed: true, ranAt, exitCode, ageHours };
}

export function backupLastRunProbe(contenedor: string, run?: EjecutorComando, ahora: () => number = Date.now) {
  return async () => {
    const nombre = contenedor.trim();
    if (nombre === "") return { probed: false, ranAt: null, exitCode: null, ageHours: null, reason: SIN_CONTENEDOR };
    const ejec = run ?? ejecutorRealDocker();
    // `cat` no escribe nada; el directorio de métricas lo declara METRICS_DIR.
    const r = ejec("docker", ["exec", nombre, "sh", "-c", "cat ${METRICS_DIR:-/textfile}/s9_backup.prom"]);
    if (r.rc !== 0) {
      return {
        probed: false,
        ranAt: null,
        exitCode: null,
        ageHours: null,
        reason: `no se pudo leer el textfile de métricas: ${r.err || "falló"}`,
      };
    }
    return interpretarMetricasCopia(r.out, ahora());
  };
}

// ── 3. ¿Qué quedó guardado en el repositorio? ────────────────────────────────

export interface SnapshotRestic {
  time?: string;
  id?: string;
  short_id?: string;
  hostname?: string;
  tags?: string[];
}

/**
 * Núcleo puro. Elige el snapshot de datos MÁS RECIENTE.
 *
 * Se acota por ETIQUETA, no por host, y esto viene de una observación real: en
 * esta instalación `RESTIC_HOSTNAME` llega vacío al contenedor, así que restic
 * etiqueta cada snapshot con el hostname del contenedor — que cambia en cada
 * recreación. Filtrar por un host fijo devolvería CERO snapshots en un
 * repositorio lleno de ellos, y "cero snapshots" es una acusación grave que
 * aquí sería falsa. Si el operador fija `RESTIC_HOSTNAME`, se puede acotar
 * además por host y se hace.
 */
export function elegirUltimoSnapshot(
  snapshots: readonly SnapshotRestic[],
  opciones: { tag?: string; host?: string } = {},
): { total: number; ultimo: SnapshotRestic | null } {
  const tag = opciones.tag ?? TAG_SNAPSHOT_DATOS;
  const host = (opciones.host ?? "").trim();
  const candidatos = snapshots.filter((s) => (s.tags ?? []).includes(tag) && (host === "" || s.hostname === host));
  let ultimo: SnapshotRestic | null = null;
  for (const s of candidatos) {
    if (!s.time) continue;
    if (ultimo === null || Date.parse(s.time) > Date.parse(ultimo.time!)) ultimo = s;
  }
  return { total: candidatos.length, ultimo };
}

/** `restic snapshots --json` devuelve un array plano de objetos. */
export function parsearSnapshots(json: string): SnapshotRestic[] | null {
  try {
    const dato: unknown = JSON.parse(json);
    return Array.isArray(dato) ? (dato as SnapshotRestic[]) : null;
  } catch {
    return null;
  }
}

/** `restic stats --json` devuelve `{"total_size":N,...}`. */
export function parsearTotalSize(json: string): number {
  try {
    const dato = JSON.parse(json) as { total_size?: unknown };
    return typeof dato.total_size === "number" && Number.isFinite(dato.total_size) ? dato.total_size : 0;
  } catch {
    return 0;
  }
}

export function backupLastSnapshotProbe(
  contenedor: string,
  run?: EjecutorComando,
  ahora: () => number = Date.now,
  env: Record<string, string | undefined> = process.env,
) {
  return async () => {
    const vacio = {
      probed: false,
      snapshotCount: 0,
      latestSnapshotAt: null as string | null,
      latestSnapshotBytes: 0,
      ageHours: null as number | null,
    };
    const nombre = contenedor.trim();
    if (nombre === "") return { ...vacio, reason: SIN_CONTENEDOR };
    const ejec = run ?? ejecutorRealDocker();

    const listado = ejec("docker", ["exec", nombre, "restic", "snapshots", "--no-lock", "--json"]);
    if (listado.rc !== 0) {
      return { ...vacio, reason: `restic snapshots: ${listado.err || "falló"}` };
    }
    const snapshots = parsearSnapshots(listado.out);
    if (snapshots === null) {
      return { ...vacio, reason: "la salida de restic snapshots no es JSON interpretable" };
    }
    const { total, ultimo } = elegirUltimoSnapshot(snapshots, { host: env.RESTIC_HOSTNAME ?? "" });
    if (ultimo === null || !ultimo.time) {
      // Se consultó el repositorio de verdad: cero snapshots de datos es un
      // hecho observado, no una comprobación pendiente.
      return { ...vacio, probed: true, snapshotCount: total };
    }

    const id = ultimo.id ?? ultimo.short_id ?? "latest";
    const stats = ejec("docker", ["exec", nombre, "restic", "stats", "--no-lock", "--json", id]);
    const bytes = stats.rc === 0 ? parsearTotalSize(stats.out) : 0;
    return {
      probed: true,
      snapshotCount: total,
      latestSnapshotAt: new Date(Date.parse(ultimo.time)).toISOString(),
      latestSnapshotBytes: bytes,
      ageHours: Math.round(((ahora() - Date.parse(ultimo.time)) / 3_600_000) * 10) / 10,
      ...(stats.rc === 0 ? {} : { reason: `no se pudo medir el tamaño del snapshot: ${stats.err || "falló"}` }),
    };
  };
}
