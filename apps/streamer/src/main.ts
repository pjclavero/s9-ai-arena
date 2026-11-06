/**
 * T11.2 · Entrypoint real del contenedor streamer (SERVICE_ENTRY del Compose).
 *
 * Arranca el Xvfb (el entrypoint.sh ya lo deja corriendo y exporta DISPLAY),
 * levanta la API interna de control y, si STREAM_AUTOSTART=1, arranca la
 * emisión directamente sobre BROADCAST_URL.
 *
 * EQ5b · La cadena real (Chromium + Xvfb + FFmpeg + relé RTMP contra una
 * ingesta RTMPS local) se verifica con la imagen construida: ver
 * docs/operations/streaming.md § «Cómo se verificó».
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createLogger, loadConfig, loadStreamKey, SecretRegistry } from "./config.js";
import { StreamSupervisor, type Spawner } from "./supervisor.js";
import { createControlServer } from "./control.js";
import type { Capabilities } from "./session.js";
import { requireWritableDataDir } from "../../../packages/data-dir/index.js";

/** Lee un fichero de secreto en el momento (no se cachea: rotar no exige reiniciar). */
function readSecretFile(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const v = readFileSync(path, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * EQ5b §6 · NVENC sólo si el RUNTIME lo confirma: no basta con que el binario
 * liste el encoder (Alpine 3.20 ni lo trae); se codifica de verdad un frame.
 */
function probeNvenc(ffmpegBin: string, caps: Capabilities): void {
  // Sin dispositivo NVIDIA en el contenedor no hay NVENC posible: ni se intenta.
  if (!existsSync("/dev/nvidiactl")) {
    caps.nvenc = false;
    return;
  }
  execFile(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=256x256",
      "-frames:v",
      "1",
      "-c:v",
      "h264_nvenc",
      "-f",
      "null",
      "-",
    ],
    { timeout: 15_000 },
    (err) => {
      caps.nvenc = !err;
    },
  );
}

/**
 * STREAMER §12/§20 · spawner REAL. Los hijos se quedan en el grupo de procesos
 * del servicio (si el servicio muere de golpe, su grupo se los lleva) y el
 * supervisor (`processTree`) para el ÁRBOL de cada uno leyendo /proc: no quedan
 * renderers/zygote de Chromium huérfanos.
 * EQ5b §3 · ffmpeg recibe un 4.º descriptor (fd 3) por el que escribe el FLV que
 * publica el relé RTMP; Chromium no lo recibe.
 */
export const realSpawner: Spawner = (cmd, args, o) =>
  spawn(cmd, args, { stdio: o?.mediaFd ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  // EQ5b · la clave YA NO se lee al arrancar: llega sellada en cada orden de
  // arranque (web) o se lee del secreto heredado en ese momento.
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets);
  const readLegacyKey = () => {
    if (!env.STREAM_KEY_FILE) return null;
    try {
      return loadStreamKey(env, readFileSync, "record");
    } catch {
      return null;
    }
  };

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

  const spawner = realSpawner;
  const allowPlainRtmp = env.STREAMER_ALLOW_PLAIN_RTMP === "1";
  const supervisor = new StreamSupervisor({
    config,
    spawner,
    logger,
    secrets,
    allowPlainRtmp,
    processTree: true,
    chromiumBin: env.CHROMIUM_BIN ?? "chromium-browser",
    ffmpegBin: env.FFMPEG_BIN ?? "ffmpeg",
  });

  const capabilities: Capabilities = { nvenc: null };
  probeNvenc(env.FFMPEG_BIN ?? "ffmpeg", capabilities);
  // EQ5c (P2-3) · FALLA EN CERRADO: con STREAMER_CONTROL_SECRET_FILE definido el
  // secreto es OBLIGATORIO; si no se puede leer (owner/modo equivocado, vacío),
  // el control deniega todo (401) y /healthz da 503, en vez de quedar abierto.
  // Sólo sin la variable (uso heredado/local) el control queda abierto.
  const requireControlSecret = !!env.STREAMER_CONTROL_SECRET_FILE;
  const controlSecret = requireControlSecret ? () => readSecretFile(env.STREAMER_CONTROL_SECRET_FILE) : null;
  if (!requireControlSecret) {
    logger("warn", "API de control SIN secreto compartido (STREAMER_CONTROL_SECRET_FILE): sólo para compatibilidad");
  } else if (!readSecretFile(env.STREAMER_CONTROL_SECRET_FILE)) {
    logger(
      "error",
      "STREAMER_CONTROL_SECRET_FILE definido pero ilegible o vacío: la API de control DENIEGA todo (401) hasta que se corrija",
    );
  }

  const server = createControlServer({
    supervisor,
    config,
    logger,
    capabilities,
    controlSecret,
    requireControlSecret,
    readPrivateKey: () => readSecretFile(env.STREAM_SECRETS_PRIVATE_KEY_FILE),
    readLegacyKey,
    allowPlainRtmp,
  });
  server.listen(config.controlPort, () => {
    logger("info", "API de control escuchando", {
      port: config.controlPort,
      mode: config.mode,
      encoder: config.encoder,
    });
  });

  if (env.STREAM_AUTOSTART === "1")
    supervisor.start(undefined, undefined, config.mode === "rtmps" ? readLegacyKey() : null);

  // Parada del contenedor: para la emisión y espera (como mucho la gracia del
  // SIGKILL + 1 s) a que los hijos salgan antes de terminar el proceso.
  const shutdown = () => {
    supervisor.stop();
    server.close();
    const deadline = Date.now() + 6000;
    const wait = () => {
      if (supervisor.pendingChildren === 0 || Date.now() > deadline) process.exit(0);
      setTimeout(wait, 100);
    };
    wait();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Ejecutable directo (npx tsx apps/streamer/src/main.ts), no al importarlo en tests.
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  main();
}
