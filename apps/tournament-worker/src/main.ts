/**
 * E9 · T9.1 — entrypoint de servicio del tournament-worker.
 *
 * Cablea las piezas que ya existen: la cola (queue.ts), el bucle (worker.ts) y
 * los handlers de cada JobKind. No añade lógica de negocio; si algo falla aquí,
 * el fallo está en la pieza cableada, no en este archivo.
 *
 * El healthcheck del Compose lee /tmp/heartbeat (mtime < 120 s): el bucle vive
 * dentro del proceso y no expone HTTP, así que la señal de vida es un fichero.
 */
import { writeFileSync } from "node:fs";
import { versionPayload } from "../../../packages/build-info/index.js";
import { requireWritableDataDir } from "../../replay-service/src/data-dir.js";
import { createDb } from "../../api/src/db/connection.js";
import { SpectateGateway } from "../../api/src/spectate/gateway.js";
import { makeRunBattleHandler, markBattleForReview } from "./battle-runner.js";
import { makeEngineExecutor } from "./engine-executor.js";
import { containerAgents } from "./container-agents.js";
import { artifactLaunchProvider } from "./bot-launch-provider.js";
import { loadArtifactVerifyKey } from "../../bot-manager/src/bot-launch.js";
import { DbArtifactLaunchGuard } from "../../bot-manager/src/launch-verify.js";
import { ProxyContainerRunner } from "../../bot-manager/src/docker-proxy.js";
import { RedisSignal } from "./redis-signal.js";
import { handleGenerateSchedule, handleTournamentDryRun } from "./scheduler.js";
import { handleProcessResult } from "./results.js";
import { handleUpdateStandings } from "./standings.js";
import { TournamentWorker } from "./worker.js";

// ADR-016 · el worker NO expone HTTP (su señal de vida es un fichero), así que
// su identidad de build se publica igual: como fichero, con el MISMO cuerpo del
// contrato de /version. El gate lo lee con `docker exec … cat`.
const VERSION_PATH = process.env.VERSION_PATH ?? "/tmp/version.json";

const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH ?? "/tmp/heartbeat";
const HEARTBEAT_MS = 30_000;

function publicarIdentidadDeBuild(): void {
  writeFileSync(VERSION_PATH, JSON.stringify(versionPayload(process.env, "tournament-worker")));
}

function beat(): void {
  writeFileSync(HEARTBEAT_PATH, String(Math.floor(Date.now() / 1000)));
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", service: "tournament-worker", msg, ...extra }));
}

const db = createDb();
const replaysDir = process.env.REPLAYS_DIR ?? "/data/replays";

// B7 · Este worker INGESTA replays en disco (battle-runner.finishBattle →
// ingestReplay(replaysDir, …)) y guarda la ruta resultante en
// battles.replay_ref. Hasta B7 el servicio ni siquiera tenía montado
// `arena_replays`: escribía en el sistema de ficheros efímero del contenedor
// —cuando podía— y la API, que lee ese replay_ref de otro contenedor, jamás
// encontraba el archivo. El preflight falla RUIDOSAMENTE si el volumen no es
// escribible, en vez de tumbar cada batalla al final con un EACCES.
requireWritableDataDir("tournament-worker", replaysDir);

// Espectador en vivo (E8/T8.2): el gateway vive AQUÍ porque las batallas se
// simulan en este proceso; attachBattle() necesita el objeto Battle en memoria.
// El nginx del gateway enruta /ws/ a este puerto.
const spectatePort = Number(process.env.SPECTATE_PORT ?? 8081);
const spectate = new SpectateGateway({ port: spectatePort });

// run_battle (DEV-B · TD-002): AUTORIDAD ÚNICA de ejecución. El motor corre EN
// ESTE proceso (aloja el ProtocolServer y el espectador) y los vehículos los
// conduce el CÓDIGO REAL de cada bot, en su contenedor, lanzado a través de
// s9-docker-proxy (nunca docker.sock). Ya NO hay stub por defecto: si falta la
// configuración del sandbox, este worker NO reclama `run_battle` (las batallas
// se quedan `scheduled`, visibles como pendientes) en vez de jugarlas con
// HunterBot. Lo dice al arrancar.
let artifactGuard: DbArtifactLaunchGuard | undefined;
async function buildExecutor() {
  const proxyUrl = process.env.DOCKER_PROXY_URL;
  const engineHost = process.env.ARENA_ENGINE_HOST;
  if (!proxyUrl || !engineHost) {
    return { executor: undefined, reason: "faltan DOCKER_PROXY_URL y/o ARENA_ENGINE_HOST" };
  }
  try {
    // REVIEW (R4.1) · clave PÚBLICA (ARTIFACT_VERIFY_KEY_FILE) y digests de runtime
    // se cargan aquí: si faltan, el worker lo anuncia y no reclama run_battle.
    const publicKey = loadArtifactVerifyKey();
    const provider = artifactLaunchProvider(db, engineHost, { publicKey });
    // R2.5 · verificación previa por participante: un artefacto manipulado
    // DESCALIFICA a ese bot (walkover del íntegro) en vez de tumbar la batalla
    // como fallo de infraestructura; el proveedor vuelve a verificar al lanzar.
    artifactGuard = new DbArtifactLaunchGuard(db, publicKey);
    const executor = makeEngineExecutor({
      db,
      spectate,
      agents: containerAgents({
        runner: new ProxyContainerRunner(proxyUrl),
        provider,
        network: process.env.ARENA_NETWORK || "arena",
        engineHost,
      }),
    });
    return { executor, reason: undefined };
  } catch (err) {
    return { executor: undefined, reason: `proveedor de lanzamiento no disponible: ${String(err)}` };
  }
}
const { executor, reason: executionDisabledReason } = await buildExecutor();
if (!executor) {
  log("EJECUCIÓN DE BATALLAS DESACTIVADA: este worker no reclamará run_battle", {
    reason: executionDisabledReason,
  });
}

// Sin Redis el bucle hace polling de la BD; el aviso solo recorta la latencia.
let signal: RedisSignal | undefined;
if (process.env.REDIS_URL) {
  signal = new RedisSignal(process.env.REDIS_URL);
  await signal.connect().catch((err: unknown) => {
    log("Redis no disponible: el worker hará polling de la BD", { err: String(err) });
    signal = undefined;
  });
}

const worker = new TournamentWorker({
  db,
  handlers: {
    ...(executor ? { run_battle: makeRunBattleHandler({ executor, replaysDir, artifactGuard }) } : {}),
    generate_schedule: handleGenerateSchedule,
    process_result: handleProcessResult,
    update_standings: handleUpdateStandings,
    tournament_dry_run: handleTournamentDryRun,
  },
  signal,
  // Degradar NO es hacerlo en silencio: si Redis se cae con el worker ya en
  // marcha, el bucle sigue trabajando por polling de la BD (la autoridad de los
  // trabajos es PostgreSQL) y lo DICE, igual que dice que no lo encontró al
  // arrancar. Sin esta línea, la única señal de que el canal de aviso murió
  // sería la latencia.
  //
  // Este aviso sale SÓLO en las transiciones de estado del canal. Que la cola
  // esté vacía (BLPOP vencido) no llega aquí: medido en VM108, clasificar ese
  // vencimiento como caída producía 379 «Redis no disponible» en media hora con
  // Redis sano, y una alarma que grita siempre no distingue la caída real.
  // `degradaciones`/`recuperaciones` cuentan transiciones, no intentos: una
  // caída de 30 s es 1 degradación y 1 recuperación, no 30.
  onSignalError: (err, estado) =>
    log(
      err === null
        ? "Redis recuperado: vuelve el aviso por señal"
        : "Redis no disponible: el worker degrada a polling de la BD",
      { err: err === null ? undefined : String(err), ...estado },
    ),
  onExhausted: (job, ctx) => markBattleForReview(ctx.db, job),
});

publicarIdentidadDeBuild();
beat();
const heartbeat = setInterval(beat, HEARTBEAT_MS);
worker.start();
log(`worker ${worker.workerId} en marcha`, {
  replaysDir,
  signal: Boolean(signal),
  spectatePort,
  battleExecution: executor ? "container" : "disabled",
});

async function shutdown(sig: string): Promise<void> {
  log(`${sig}: parando`);
  clearInterval(heartbeat);
  await worker.stop().catch(() => undefined);
  await db.destroy().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
