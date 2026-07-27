/**
 * T11.2 · Entrypoint real del contenedor streamer (SERVICE_ENTRY del Compose).
 *
 * Arranca el Xvfb (el entrypoint.sh ya lo deja corriendo y exporta DISPLAY),
 * levanta la API interna de control y, si STREAM_AUTOSTART=1, arranca la
 * emisión directamente sobre BROADCAST_URL.
 *
 * [INSPECCIÓN] En el entorno de desarrollo de esta entrega no hay docker ni
 * Chromium/FFmpeg: este cableado se prueba con procesos inyectados
 * (supervisor.test.ts / control.test.ts); la pasada real es del despliegue.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createLogger, loadConfig, loadStreamKey } from "./config.js";
import { StreamSupervisor, type Spawner } from "./supervisor.js";
import { createControlServer } from "./control.js";
import { requireWritableDataDir } from "../../../packages/data-dir/index.js";

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const streamKey = loadStreamKey(env, readFileSync, config.mode);
  const logger = createLogger(streamKey);

  // B13 · Preflight del directorio de grabación (mismo mecanismo que B7 en
  // replay-service y tournament-worker, no uno paralelo).
  //
  // En modo `record` quien escribe es FFmpeg, no Node: si el directorio no es
  // escribible, ffmpeg muere al abrir el fichero, el supervisor reintenta hasta
  // maxRetries... y /healthz de la API de control sigue respondiendo "ok"
  // porque no toca el disco. Es EXACTAMENTE el fallo silencioso que dejó
  // `arena_replays` vacío diez días en VM108, solo que aquí el que se pierde es
  // el vídeo. Con el preflight el contenedor muere al arrancar (bucle de
  // reinicio VISIBLE) en vez de fingir que emite.
  //
  // En modo `rtmps` no se escribe nada en disco: no se comprueba nada (un
  // preflight de más ahí sería un servicio que no arranca sin motivo).
  if (config.mode === "record") requireWritableDataDir("streamer", config.recordDir);

  const spawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const supervisor = new StreamSupervisor({
    config,
    streamKey,
    spawner,
    logger,
    chromiumBin: env.CHROMIUM_BIN ?? "chromium-browser",
    ffmpegBin: env.FFMPEG_BIN ?? "ffmpeg",
  });

  const server = createControlServer({ supervisor, config, logger });
  server.listen(config.controlPort, () => {
    logger("info", "API de control escuchando", {
      port: config.controlPort,
      mode: config.mode,
      encoder: config.encoder,
    });
  });

  if (env.STREAM_AUTOSTART === "1") supervisor.start();

  const shutdown = () => {
    supervisor.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Ejecutable directo (npx tsx apps/streamer/src/main.ts), no al importarlo en tests.
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  main();
}
