/**
 * B7 · Preflight del directorio de datos (volumen `arena_replays`).
 *
 * Defecto REAL observado en producción (VM108, 2026-07-17 → 2026-07-27): el
 * volumen `arena_replays` se creó `root:root`, el replay-service corre como
 * `node` (uid 1000) y CADA ingesta moría con
 * `EACCES: permission denied, open '/data/replays/...'`. El servicio estaba
 * "healthy" todo ese tiempo — /healthz no toca el disco — y el directorio
 * llevaba diez días vacío. El fallo era invisible.
 *
 * Este módulo convierte ese fallo silencioso en un fallo RUIDOSO: se comprueba
 * al arrancar que el directorio de datos existe y es ESCRIBIBLE DE VERDAD
 * (se escribe y se borra un fichero de prueba, no se consulta `access()` ni el
 * bit de permiso: sobre volúmenes y sistemas de ficheros de red el único
 * chequeo fiable es escribir). Si no lo es, el servicio se niega a arrancar
 * con un diagnóstico accionable en vez de aceptar tráfico y perder replays.
 *
 * No requiere privilegios: solo mira si PUEDE escribir. Quien garantiza la
 * propiedad correcta es el entrypoint acotado de la imagen
 * (infrastructure/docker/node-service/entrypoint.sh) más la siembra del
 * directorio en las imágenes que montan el volumen.
 *
 * B13 · Vive en `packages/` y no dentro de un `apps/*` porque lo usan servicios
 * que se empaquetan en IMÁGENES DISTINTAS: replay-service y tournament-worker
 * (imagen genérica node-service) y el streamer (imagen propia, que solo copia
 * `apps/streamer` y este paquete). Importarlo desde otro `apps/*` compilaría en
 * el monorepo y reventaría dentro de la imagen del streamer con
 * ERR_MODULE_NOT_FOUND — el error que ya ha mordido seis veces a este proyecto.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DataDirCheck {
  ok: boolean;
  /** Motivo técnico (mensaje del error de fs) cuando `ok` es false. */
  reason?: string;
}

/**
 * Comprueba que `dir` existe (lo crea si puede) y que el proceso puede escribir
 * en él. Nunca lanza: devuelve el veredicto para que quien llama decida.
 */
export function checkWritableDataDir(dir: string): DataDirCheck {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `no se pudo crear el directorio: ${(e as Error).message}` };
  }
  // Nombre irrepetible: dos procesos del mismo servicio pueden arrancar a la vez.
  const probe = join(dir, `.s9-write-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "s9");
  } catch (e) {
    return { ok: false, reason: `no se pudo escribir en el directorio: ${(e as Error).message}` };
  } finally {
    rmSync(probe, { force: true });
  }
  return { ok: true };
}

/**
 * Diagnóstico completo (una línea JSON) para el arranque de un servicio cuyo
 * directorio de datos no sirve. Incluye el uid real del proceso y el remedio,
 * que es exactamente lo que faltó en el incidente de VM108.
 */
export function dataDirFailureLog(service: string, dir: string, check: DataDirCheck): string {
  return JSON.stringify({
    level: "error",
    service,
    msg: `directorio de datos ${dir} no utilizable: el servicio NO arranca (antes se arrancaba y se perdían los replays en silencio)`,
    dir,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    reason: check.reason,
    remedy:
      "el volumen que se monta en este directorio debe pertenecer al usuario del servicio; " +
      "la imagen lo ajusta sola vía ARENA_DATA_DIRS (infrastructure/docker/node-service/entrypoint.sh). " +
      "Si ves esto, el servicio arrancó sin ese entrypoint o el volumen se montó en otra ruta.",
  });
}

/**
 * Preflight de arranque: si el directorio de datos no sirve, escribe el
 * diagnóstico y termina el proceso con código 1. Un contenedor que sale con 1
 * entra en bucle de reinicio VISIBLE (`docker ps`, logs, alertas) — que es
 * justo lo contrario de lo que pasó en VM108.
 */
export function requireWritableDataDir(service: string, dir: string): void {
  const check = checkWritableDataDir(dir);
  if (check.ok) return;
  console.error(dataDirFailureLog(service, dir, check));
  process.exit(1);
}
