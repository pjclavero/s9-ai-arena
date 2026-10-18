/**
 * R2.5 (ERR-SEC-12) — entrypoint de servicio del worker de builds.
 *
 * Cablea las piezas existentes: la cola durable (build-worker.ts, tabla `jobs`)
 * y el adaptador REAL del pipeline de E6 (E6PipelineBotManager de la API, que
 * NO reimplementa lógica de builds). El proceso de la API solo encola; este
 * proceso ejecuta.
 *
 * DEV-A · TD-001: el sandbox REAL (contenedor vía s9-docker-proxy) se cablea en
 * build-worker-wiring.ts. Sin DOCKER_PROXY_URL/BUILD_SANDBOX_HOST el pipeline
 * sigue fallando cerrado (R1.5 · ERR-SEC-03): rechaza como "no verificable" y el
 * arranque lo anuncia en el log. La clave de firma sale
 * del almacén de secretos (loadServiceKeypair, ERR-SEC-15): sin clave, el
 * proceso NO arranca.
 */
import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { createDb } from "../../api/src/db/connection.js";
import { createBuildExecutor } from "./build-worker-wiring.js";
import { loadServiceKeypair } from "./signing.js";
import { startBuildWorker } from "./build-worker.js";

const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH ?? "/tmp/heartbeat";

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", service: "bot-build-worker", msg, ...extra }));
}

const db = createDb();
const workerId = `build-worker:${hostname()}:${process.pid}`;
// Fallar cerrado en el arranque: sin clave de firma no hay pipeline que firmar.
const signer = loadServiceKeypair();
const { executor, sandbox, reason } = createBuildExecutor(db, signer);
if (!sandbox) {
  console.error(
    JSON.stringify({
      level: "error",
      service: "bot-build-worker",
      msg: `sin sandbox: todo build se rechazará (${reason})`,
    }),
  );
}

setInterval(() => writeFileSync(HEARTBEAT_PATH, String(Math.floor(Date.now() / 1000))), 30_000).unref();

log("worker de builds arrancado", { workerId, sandbox: sandbox ? "container" : "none" });
startBuildWorker(db, executor, { workerId }).catch((e) => {
  console.error(JSON.stringify({ level: "error", service: "bot-build-worker", msg: String(e) }));
  process.exit(1);
});
