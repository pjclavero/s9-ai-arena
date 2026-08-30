/**
 * Identidad de build (procedencia de imagen) — ADR-016.
 *
 * Problema real que resuelve (dos incidentes de producción, ver el ADR):
 *   1. Un `docker compose --project-directory <producción>` con `context: ..`
 *      construyó el árbol VIEJO y lo etiquetó con el commit NUEVO. El gate
 *      comparaba "imagen declarada == imagen desplegada", que es una tautología
 *      cuando la ETIQUETA MIENTE: nada dentro de la imagen decía de qué código
 *      salió.
 *   2. Un contenedor seguía corriendo una image ID ya BORRADA del daemon: el
 *      contenedor vivía sobre sus capas, pero ese estado no era reproducible
 *      tras un restart y nadie podía verlo.
 *
 * La respuesta es que el COMMIT VIAJE DENTRO de la imagen (ARG → ENV → LABEL
 * OCI) y sea OBSERVABLE en ejecución. Un build del árbol viejo etiquetado como
 * nuevo pasa a ser detectable: su ENV/LABEL/`/version` dicen el commit viejo.
 *
 * Contrato del cuerpo de `/version` (estable, sin secretos):
 *   {"service":"replay-service","commit":"4d469dc","builtAt":"2026-08-30T..."}
 * `builtAt` se omite si no se embebió. NUNCA se añaden aquí hostname, IP,
 * rutas, variables de entorno ni versiones de dependencias: este endpoint no
 * está autenticado (ver "Autenticación" en el ADR) y todo lo que devuelva es
 * público de hecho.
 */

export interface BuildInfo {
  /** Nombre del servicio, embebido en la imagen (SERVICE_NAME). */
  service: string;
  /** Commit del árbol con el que se CONSTRUYÓ la imagen (BUILD_COMMIT). */
  commit: string;
  /** Fecha ISO-8601 del build (BUILD_DATE); ausente si no se embebió. */
  builtAt?: string;
}

/** Valor que se reporta cuando la imagen se construyó sin embeber la identidad. */
export const COMMIT_DESCONOCIDO = "unknown";

type Entorno = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Lee la identidad embebida en la imagen.
 *
 * `fallbackService` es el nombre del servicio en el código (p. ej.
 * "replay-service"): se usa solo si la imagen no trae SERVICE_NAME, para que un
 * arranque en desarrollo sin build args siga respondiendo algo coherente.
 *
 * NO falla si falta la identidad: devuelve `commit: "unknown"`. La diferencia
 * entre "unknown" y un commit real es justo lo que comprueba el gate — un
 * servicio que se negara a arrancar sin BUILD_COMMIT convertiría un problema de
 * trazabilidad en una caída, y el `npx tsx` de desarrollo nunca lo tiene.
 */
export function readBuildInfo(env: Entorno = process.env, fallbackService = "unknown"): BuildInfo {
  const service = limpiar(env.SERVICE_NAME) ?? fallbackService;
  const commit = limpiar(env.BUILD_COMMIT) ?? COMMIT_DESCONOCIDO;
  const builtAt = limpiar(env.BUILD_DATE);
  return builtAt ? { service, commit, builtAt } : { service, commit };
}

/** Cuerpo JSON de `/version` tal cual se sirve (mismo objeto, sin extras). */
export function versionPayload(env: Entorno = process.env, fallbackService = "unknown"): BuildInfo {
  return readBuildInfo(env, fallbackService);
}

interface RespuestaJson {
  set?(cabecera: string, valor: string): unknown;
  json(cuerpo: unknown): unknown;
}

/**
 * Monta `GET /version` en una app Express ya creada.
 *
 * Se pasa la app en vez de devolver un router para no obligar a cada servicio a
 * importar el tipo Router; el objeto solo necesita tener `get`, así que esto
 * vale igual para una app o para un router.
 */
export function mountVersionEndpoint(
  app: { get(ruta: string, manejador: (req: never, res: RespuestaJson) => void): unknown },
  fallbackService: string,
  env: Entorno = process.env,
): void {
  app.get("/version", (_req, res) => {
    // Sin caché: el gate y el operador tienen que ver lo que corre AHORA, no lo
    // que corría antes de un redespliegue detrás de un proxy que cachee.
    res.set?.("Cache-Control", "no-store");
    res.json(versionPayload(env, fallbackService));
  });
}

function limpiar(valor: string | undefined): string | undefined {
  const v = valor?.trim();
  return v && v.length > 0 ? v : undefined;
}
