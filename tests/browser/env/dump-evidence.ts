/**
 * PRC DEV-CI (TD-045) · evidencia de BD del E2E de navegador, SIN secretos.
 *
 * Lo invoca tests/browser/run.sh justo después de la fase golden (antes de parar
 * la API: con el PostgreSQL embebido la BD vive en el proceso de la API). Escribe
 * en el fichero de salida (argv[2]) un JSON con lo que hace falta para
 * diagnosticar un golden en rojo sin abrir la BD:
 *   - builds: estado y etapas (incluye los logs del sandbox de cada etapa);
 *   - bot_versions: estado y motivo de rechazo/suspensión;
 *   - battles: estado, resultado, failure_kind y replay;
 *   - jobs: tipo, estado e intentos.
 * NUNCA vuelca credenciales: ni users, ni sessions, ni el código fuente (bytea),
 * ni payloads de jobs, ni artefactos firmados. DATABASE_URL llega por entorno
 * (leída del fichero 0600 db.url), nunca por argv.
 */
import { writeFileSync } from "node:fs";
import { createDb } from "../../../apps/api/src/db/connection.js";

const out = process.argv[2];
if (!out) {
  console.error("uso: dump-evidence.ts <fichero-salida.json>");
  process.exit(2);
}

const db = createDb(process.env.DATABASE_URL ?? "");
try {
  const builds = await db("builds").select("bot_id", "version", "status", "stages", "created_at", "updated_at");
  const versions = await db("bot_versions").select(
    "bot_id",
    "version",
    "state",
    "runtime",
    "rejection_reason",
    "suspend_reason",
    "published_at",
  );
  const battles = await db("battles").select("id", "status", "mode", "map_id", "result", "failure_kind", "replay_ref");
  const jobs = await db("jobs").select("kind", "status", "attempts", "created_at", "updated_at");
  writeFileSync(out, JSON.stringify({ builds, versions, battles, jobs }, null, 2));
  console.log(
    JSON.stringify({
      msg: "db evidence",
      builds: builds.length,
      versions: versions.length,
      battles: battles.length,
      jobs: jobs.length,
    }),
  );
} finally {
  await db.destroy();
}
