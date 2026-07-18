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

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const streamKey = loadStreamKey(env, readFileSync, config.mode);
  const logger = createLogger(streamKey);

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
