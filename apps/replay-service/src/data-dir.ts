/**
 * B13 · Reexport del preflight de directorio de datos, que ahora vive en
 * `packages/data-dir` para poder compartirlo con servicios que se empaquetan en
 * IMÁGENES distintas (el streamer no copia `apps/replay-service` en la suya).
 *
 * Este archivo se mantiene para no romper los importadores existentes
 * (apps/replay-service/src/main.ts, apps/tournament-worker/src/main.ts) ni las
 * rutas que citan la documentación y los diagnósticos de B7.
 */
export {
  checkWritableDataDir,
  dataDirFailureLog,
  requireWritableDataDir,
  type DataDirCheck,
} from "../../../packages/data-dir/index.js";
