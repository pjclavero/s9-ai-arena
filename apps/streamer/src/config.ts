/**
 * T11.2 · Configuración del servicio streamer (cap. 21).
 *
 * La clave RTMPS de YouTube entra SOLO por archivo (STREAM_KEY_FILE, secreto
 * del Compose vía init-secrets.sh) y vive separada del objeto de configuración:
 * `StreamerConfig` es serializable/loggable sin riesgo; la clave viaja aparte
 * y todo texto que salga por el logger pasa por `redactSecret`.
 */
import type { readFileSync as ReadFileSync } from "node:fs";

export interface StreamerConfig {
  /** URL de la vista /broadcast de T11.1 que captura Chromium. */
  broadcastUrl: string;
  /** Ingesta RTMPS (YouTube: rtmps://a.rtmps.youtube.com/live2). */
  rtmpsUrl: string;
  /** rtmps = emitir; record = "solo grabación" a archivo (E11.M, sin canal). */
  mode: "rtmps" | "record";
  /** Directorio del modo grabación (E11.M: arena_replays/video). */
  recordDir: string;
  /** x264 por software (base); nvenc exige GPU con passthrough en Proxmox. */
  encoder: "x264" | "nvenc";
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  /** DISPLAY del Xvfb donde pinta Chromium y captura FFmpeg. */
  display: string;
  /** Puerto de la API interna de control (red platform; jamás publicado). */
  controlPort: number;
  /** Reintentos ante corte de RTMPS y espera entre ellos. */
  maxRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_CONFIG: StreamerConfig = {
  broadcastUrl: "http://web:3000/broadcast",
  rtmpsUrl: "rtmps://a.rtmps.youtube.com/live2",
  mode: "rtmps",
  recordDir: "/data/replays/video",
  encoder: "x264",
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrateKbps: 4500,
  display: ":99",
  controlPort: 8090,
  maxRetries: 20,
  retryDelayMs: 3000,
};

function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: Record<string, string | undefined>): StreamerConfig {
  const mode = env.STREAM_MODE === "record" ? "record" : "rtmps";
  const encoder = env.STREAM_ENCODER === "nvenc" ? "nvenc" : "x264";
  return {
    ...DEFAULT_CONFIG,
    broadcastUrl: env.BROADCAST_URL || DEFAULT_CONFIG.broadcastUrl,
    rtmpsUrl: env.RTMPS_URL || DEFAULT_CONFIG.rtmpsUrl,
    mode,
    recordDir: env.RECORD_DIR || DEFAULT_CONFIG.recordDir,
    encoder,
    fps: intEnv(env.STREAM_FPS, DEFAULT_CONFIG.fps),
    videoBitrateKbps: intEnv(env.STREAM_BITRATE_KBPS, DEFAULT_CONFIG.videoBitrateKbps),
    display: env.DISPLAY || DEFAULT_CONFIG.display,
    controlPort: intEnv(env.STREAMER_CONTROL_PORT, DEFAULT_CONFIG.controlPort),
    maxRetries: intEnv(env.STREAM_MAX_RETRIES, DEFAULT_CONFIG.maxRetries),
    retryDelayMs: intEnv(env.STREAM_RETRY_DELAY_MS, DEFAULT_CONFIG.retryDelayMs),
  };
}

/**
 * Lee la clave de emisión del ARCHIVO de secreto (cap. 21: "nunca en variables
 * visibles ni logs"). En modo record no hace falta clave.
 */
export function loadStreamKey(
  env: Record<string, string | undefined>,
  readFile: typeof ReadFileSync,
  mode: StreamerConfig["mode"],
): string | null {
  const file = env.STREAM_KEY_FILE;
  if (!file) {
    if (mode === "record") return null;
    throw new Error("STREAM_KEY_FILE no definido: la clave RTMPS va por archivo de secreto");
  }
  let raw = "";
  try {
    raw = String(readFile(file, "utf8")).trim();
  } catch {
    raw = "";
  }
  if (!raw && mode === "rtmps") {
    throw new Error(`El secreto ${file} está vacío: rellenar con la clave de YouTube (init-secrets.sh)`);
  }
  return raw || null;
}

/** Sustituye la clave por *** en cualquier texto destinado a logs/respuestas. */
export function redactSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

/** Logger JSON que REDACTA la clave en todo lo que escribe (revisión T11.2). */
export function createLogger(secret: string | null, write: (line: string) => void = (l) => console.log(l)) {
  return (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ level, service: "streamer", msg, ...extra });
    write(redactSecret(line, secret));
  };
}
export type Logger = ReturnType<typeof createLogger>;
