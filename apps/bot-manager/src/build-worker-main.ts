/**
 * R2.5 (ERR-SEC-12) — entrypoint de servicio del worker de builds.
 *
 * Cablea las piezas existentes: la cola durable (build-worker.ts, tabla `jobs`)
 * y el adaptador REAL del pipeline de E6 (E6PipelineBotManager de la API, que
 * NO reimplementa lógica de builds). El proceso de la API solo encola; este
 * proceso ejecuta.
 *
 * Sin sandbox real (agentResolver de T6.2) el pipeline sigue fallando cerrado
 * (R1.5 · ERR-SEC-03): rechaza como "no verificable". La clave de firma sale
 * del almacén de secretos (loadServiceKeypair, ERR-SEC-15): sin clave, el
 * proceso NO arranca.
 */
import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { createDb } from "../../api/src/db/connection.js";
import { E6PipelineBotManager } from "../../api/src/services/e6-bot-manager.js";
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
const executor = new E6PipelineBotManager(db, { signer });

setInterval(() => writeFileSync(HEARTBEAT_PATH, String(Math.floor(Date.now() / 1000))), 30_000).unref();

log("worker de builds arrancado", { workerId });
startBuildWorker(db, executor, { workerId }).catch((e) => {
  console.error(JSON.stringify({ level: "error", service: "bot-build-worker", msg: String(e) }));
  process.exit(1);
});
