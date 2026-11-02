/**
 * T11.2 · Construcción de las líneas de comando de captura y codificación.
 *
 * - Chromium NO headless pintando en el Xvfb (DISPLAY) en modo kiosco: la vista
 *   /broadcast de T11.1 no tiene controles ni cursor, así que el framebuffer es
 *   la emisión tal cual.
 * - FFmpeg captura ese DISPLAY por x11grab y codifica: x264 por software como
 *   BASE (no bloquea el hito); h264_nvenc como OPCIÓN si el host tiene GPU con
 *   passthrough en Proxmox (requisito documentado en docs/streaming-runbook.md).
 * - EQ5b §3 · La clave RTMPS YA NO está en el argv de ffmpeg (lo veía `ps` de
 *   cualquier usuario del host). En modo rtmps ffmpeg escribe FLV por el fd 3
 *   (`-f flv pipe:3`) y el relé RTMP del propio streamer (rtmp/publisher.ts)
 *   lo publica con la clave, que no sale del proceso Node.
 * - El retardo anti-coaching (E11.M, finales) NO se hace aquí: ya existe en el
 *   canal de espectador (`ruleset.spectator.delaySeconds`, E8) y /broadcast lo
 *   hereda; duplicarlo en ffmpeg desincronizaría marcador y vídeo.
 */
import type { StreamerConfig } from "./config.js";

export function buildChromiumArgs(cfg: StreamerConfig, broadcastUrl: string): string[] {
  return [
    // Kiosco a pantalla exacta 1920×1080 sobre el Xvfb; sin GPU física.
    `--window-size=${cfg.width},${cfg.height}`,
    "--window-position=0,0",
    "--kiosk",
    "--no-first-run",
    "--disable-infobars",
    // R3.2 (ERR-VIS-08): WebGL FORZADO por SwiftShader (rasterizador software de
    // ANGLE). Con `--disable-gpu` a secas, Phaser caía a Canvas 2D y el render de
    // la emisión no era el mismo camino que el del visor en un navegador normal.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    // EQ5 (2026-11-02, visto en un MP4 real): la página es lang="es" y el
    // Chromium de la imagen va en inglés ⇒ la barra de Google Translate quedaba
    // FIJA en la esquina de la emisión. Y tras un reintento (SIGTERM + relanzar)
    // Chromium ofrece «restaurar páginas». Nada del navegador debe entrar en vídeo.
    "--lang=es",
    "--disable-features=Translate",
    "--hide-crash-restore-bubble",
    "--noerrdialogs",
    // El contenedor ya aísla (usuario sin privilegios, no-new-privileges).
    "--no-sandbox",
    `--app=${broadcastUrl}`,
  ];
}

export interface FfmpegPlan {
  args: string[];
  /** Destino SIN clave, apto para logs y /status. */
  describeTarget: string;
  /** Modo record: fichero que se está escribiendo (la retención nunca lo toca). */
  recordFile?: string;
}

/** Descriptor heredado por el que ffmpeg entrega el FLV al relé RTMP. */
export const MEDIA_FD = 3;

export function buildFfmpegArgs(
  cfg: StreamerConfig,
  opts?: { now?: () => Date } | null,
): FfmpegPlan {
  const now = (opts && typeof opts === "object" && opts.now) || (() => new Date());
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
    // EQ5 · x11grab dibuja el puntero por defecto: en el MP4 real salía la «X»
    // del Xvfb en el centro mientras Chromium arrancaba. El CSS `cursor: none`
    // de /broadcast no cubre ese tramo (ni un Chromium caído).
    "-draw_mouse",
    "0",
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
    // EQ5b · preset 720p: se compone SIEMPRE a 1920×1080 (la vista /broadcast es
    // de tamaño fijo) y se escala al codificar.
    ...(cfg.outputWidth !== cfg.width || cfg.outputHeight !== cfg.height
      ? ["-vf", `scale=${cfg.outputWidth}:${cfg.outputHeight}:flags=bicubic`]
      : []),
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
    return { args: [...common, "-f", "mp4", file], describeTarget: file, recordFile: file };
  }

  // EQ5b §3 · ni destino de red ni clave: FLV al relé por el fd 3.
  return {
    args: [...common, "-flvflags", "no_duration_filesize", "-f", "flv", `pipe:${MEDIA_FD}`],
    describeTarget: `relé RTMP interno (fd ${MEDIA_FD})`,
  };
}

/** argv apto para logs: la clave sustituida por *** (defensa en profundidad). */
export function redactArgs(args: string[], streamKey: string | null): string[] {
  if (!streamKey) return [...args];
  return args.map((a) => a.split(streamKey).join("***"));
}
