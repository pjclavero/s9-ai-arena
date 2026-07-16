/**
 * T11.2 · Construcción de las líneas de comando de captura y codificación.
 *
 * - Chromium NO headless pintando en el Xvfb (DISPLAY) en modo kiosco: la vista
 *   /broadcast de T11.1 no tiene controles ni cursor, así que el framebuffer es
 *   la emisión tal cual.
 * - FFmpeg captura ese DISPLAY por x11grab y codifica: x264 por software como
 *   BASE (no bloquea el hito); h264_nvenc como OPCIÓN si el host tiene GPU con
 *   passthrough en Proxmox (requisito documentado en docs/streaming-runbook.md).
 * - La clave RTMPS solo aparece en el argv de ffmpeg (dentro del contenedor);
 *   jamás en logs: todo lo loggable pasa por `redactArgs`/`redactSecret`.
 * - El retardo anti-coaching (E11.M, finales) NO se hace aquí: ya existe en el
 *   canal de espectador (`ruleset.spectator.delaySeconds`, E8) y /broadcast lo
 *   hereda; duplicarlo en ffmpeg desincronizaría marcador y vídeo.
 */
import type { StreamerConfig } from "./config.js";

export function buildChromiumArgs(cfg: StreamerConfig, broadcastUrl: string): string[] {
  return [
    // Kiosco a pantalla exacta 1920×1080 sobre el Xvfb; sin GPU (framebuffer).
    `--window-size=${cfg.width},${cfg.height}`,
    "--window-position=0,0",
    "--kiosk",
    "--no-first-run",
    "--disable-infobars",
    "--disable-gpu",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    // El contenedor ya aísla (usuario sin privilegios, no-new-privileges).
    "--no-sandbox",
    `--app=${broadcastUrl}`,
  ];
}

export interface FfmpegPlan {
  args: string[];
  /** Destino SIN clave, apto para logs y /status. */
  describeTarget: string;
}

export function buildFfmpegArgs(cfg: StreamerConfig, streamKey: string | null, now: () => Date = () => new Date()): FfmpegPlan {
  const gop = cfg.fps * 2; // keyframe cada 2 s (recomendación de ingesta de YouTube)
  const video =
    cfg.encoder === "nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency"];

  const common = [
    "-nostats",
    "-loglevel",
    "error",
    // Métricas de frames/bitrate hacia la API de control (T11.2 → E10).
    "-progress",
    "pipe:1",
    // Captura del Xvfb donde pinta Chromium.
    "-f",
    "x11grab",
    "-framerate",
    String(cfg.fps),
    "-video_size",
    `${cfg.width}x${cfg.height}`,
    "-i",
    cfg.display,
    // YouTube exige pista de audio: silencio estable.
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    ...video,
    "-b:v",
    `${cfg.videoBitrateKbps}k`,
    "-maxrate",
    `${cfg.videoBitrateKbps}k`,
    "-bufsize",
    `${cfg.videoBitrateKbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
  ];

  if (cfg.mode === "record") {
    // E11.M · modo "solo grabación": clips sin emitir, antes de tener canal.
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const file = `${cfg.recordDir}/broadcast-${stamp}.mp4`;
    return { args: [...common, "-f", "mp4", file], describeTarget: file };
  }

  if (!streamKey) throw new Error("Modo rtmps sin clave de emisión");
  return {
    args: [...common, "-f", "flv", `${cfg.rtmpsUrl}/${streamKey}`],
    describeTarget: `${cfg.rtmpsUrl}/***`,
  };
}

/** argv apto para logs: la clave sustituida por ***. */
export function redactArgs(args: string[], streamKey: string | null): string[] {
  if (!streamKey) return [...args];
  return args.map((a) => a.split(streamKey).join("***"));
}
