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
import { createDb } from "../../api/src/db/connection.js";
import { SpectateGateway } from "../../api/src/spectate/gateway.js";
import { makeRunBattleHandler, markBattleForReview } from "./battle-runner.js";
import { makeEngineExecutor } from "./engine-executor.js";
import { RedisSignal } from "./redis-signal.js";
import { handleGenerateSchedule, handleTournamentDryRun } from "./scheduler.js";
import { handleProcessResult } from "./results.js";
import { handleUpdateStandings } from "./standings.js";
import { TournamentWorker } from "./worker.js";

const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH ?? "/tmp/heartbeat";
const HEARTBEAT_MS = 30_000;

function beat(): void {
  writeFileSync(HEARTBEAT_PATH, String(Math.floor(Date.now() / 1000)));
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", service: "tournament-worker", msg, ...extra }));
}

const db = createDb();
const replaysDir = process.env.REPLAYS_DIR ?? "/data/replays";

// Espectador en vivo (E8/T8.2): el gateway vive AQUÍ porque las batallas se
// simulan en este proceso; attachBattle() necesita el objeto Battle en memoria.
// El nginx del gateway enruta /ws/ a este puerto.
const spectatePort = Number(process.env.SPECTATE_PORT ?? 8081);
const spectate = new SpectateGateway({ port: spectatePort });

// run_battle: el motor se ejecuta EN ESTE proceso (engine-executor), no en un
// servicio aparte. Sin agentResolver containerizado (R6.2 pendiente), el
// ejecutor usa los stubs deterministas del motor para las batallas del sistema.
const executor = makeEngineExecutor({ db, spectate });

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
    run_battle: makeRunBattleHandler({ executor, replaysDir }),
    generate_schedule: handleGenerateSchedule,
    process_result: handleProcessResult,
    update_standings: handleUpdateStandings,
    tournament_dry_run: handleTournamentDryRun,
  },
  signal,
  onExhausted: (job, ctx) => markBattleForReview(ctx.db, job),
});

beat();
const heartbeat = setInterval(beat, HEARTBEAT_MS);
worker.start();
log(`worker ${worker.workerId} en marcha`, { replaysDir, signal: Boolean(signal), spectatePort });

async function shutdown(sig: string): Promise<void> {
  log(`${sig}: parando`);
  clearInterval(heartbeat);
  await worker.stop().catch(() => undefined);
  await db.destroy().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
