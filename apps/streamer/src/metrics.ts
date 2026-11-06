/**
 * T11.2 · Métricas de emisión: parser del `-progress pipe:1` de FFmpeg
 * (bloques clave=valor terminados en `progress=continue|end`) y exposición en
 * formato Prometheus para que E10 las raspe (prometheus.yml, red platform).
 */
import { emptyDict } from "../../../packages/game-rules/safe-lookup.js";

export interface StreamStats {
  frames: number;
  fps: number;
  bitrateKbps: number;
  outTimeSeconds: number;
  droppedFrames: number;
  /** true si ha llegado al menos un bloque de progreso desde el último arranque. */
  reporting: boolean;
}

export class ProgressParser {
  private buffer = "";
  private stats: StreamStats = {
    frames: 0,
    fps: 0,
    bitrateKbps: 0,
    outTimeSeconds: 0,
    droppedFrames: 0,
    reporting: false,
  };
  /**
   * B8 (barrido, 2ª pasada) · `emptyDict()`, NO `{}`: la clave se parsea de la
   * SALIDA DE FFMPEG (`clave=valor`), es decir de un proceso externo. Con `{}`
   * una línea `__proto__=algo` se perdía en silencio (asignar una string a
   * `__proto__` ni siquiera lanza: no hace nada), y `constructor=algo` dejaba
   * una lectura posterior heredando de `Object.prototype`.
   */
  private pending: Record<string, string> = emptyDict<string>();
  /** EQ5b · instante (ms) del último bloque de progreso; null = ninguno aún. */
  lastProgressAt: number | null = null;
  constructor(private readonly clock: () => number = Date.now) {}

  /** Alimenta bytes del stdout de ffmpeg (troceados como lleguen). */
  push(chunk: string | Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      if (key === "progress") {
        this.commit();
        continue;
      }
      this.pending[key] = value;
    }
  }

  private commit(): void {
    const p = this.pending;
    this.lastProgressAt = this.clock();
    // B8 · el reseteo también debe ser sin prototipo, o el fix duraría un ciclo.
    this.pending = emptyDict<string>();
    const num = (v: string | undefined) => {
      const n = parseFloat(v ?? "");
      return Number.isFinite(n) ? n : 0;
    };
    this.stats = {
      frames: num(p.frame) || this.stats.frames,
      fps: num(p.fps),
      // ffmpeg emite "4500.1kbits/s" o "N/A"
      bitrateKbps: num((p.bitrate ?? "").replace(/kbits\/s$/, "")),
      outTimeSeconds: p.out_time_us ? num(p.out_time_us) / 1e6 : this.stats.outTimeSeconds,
      droppedFrames: num(p.drop_frames) || this.stats.droppedFrames,
      reporting: true,
    };
  }

  snapshot(): StreamStats {
    return { ...this.stats };
  }

  /** Al (re)arrancar ffmpeg: conserva acumulados pero exige progreso fresco. */
  markRestart(): void {
    this.stats = { ...this.stats, fps: 0, bitrateKbps: 0, reporting: false };
    // B8 · el reseteo también debe ser sin prototipo, o el fix duraría un ciclo.
    this.pending = emptyDict<string>();
    this.buffer = "";
  }
}

export interface MetricsView {
  state: string;
  restarts: number;
  stats: StreamStats;
  /** EQ5b · 1 si hay una emisión PEDIDA (streaming, retrying o failed). */
  desired?: boolean;
  /** EQ5b · segundos desde el último progreso de ffmpeg (-1 si no hay sesión). */
  progressAgeSeconds?: number;
  /** EQ5b · 1 si el relé RTMP está publicando. */
  relayPublishing?: boolean;
  /** STREAMER §28 · contadores de arranques, paradas y fallos terminales. */
  counters?: { starts: number; stops: number; failures: number; killed: number };
  /** STREAMER §28 · segundos desde el arranque de la emisión pedida (0 sin emisión). */
  uptimeSeconds?: number;
}

/** Texto Prometheus (contrato con E10: scrape en la red platform). */
export function renderPrometheus(view: MetricsView): string {
  const up = view.state === "streaming" && view.stats.reporting ? 1 : 0;
  return [
    "# HELP streamer_up 1 si hay emision activa con progreso reciente",
    "# TYPE streamer_up gauge",
    `streamer_up ${up}`,
    "# HELP streamer_frames_total Frames codificados por ffmpeg",
    "# TYPE streamer_frames_total counter",
    `streamer_frames_total ${view.stats.frames}`,
    "# HELP streamer_fps Frames por segundo instantaneos",
    "# TYPE streamer_fps gauge",
    `streamer_fps ${view.stats.fps}`,
    "# HELP streamer_bitrate_kbps Bitrate de salida en kbit/s",
    "# TYPE streamer_bitrate_kbps gauge",
    `streamer_bitrate_kbps ${view.stats.bitrateKbps}`,
    "# HELP streamer_dropped_frames_total Frames descartados",
    "# TYPE streamer_dropped_frames_total counter",
    `streamer_dropped_frames_total ${view.stats.droppedFrames}`,
    "# HELP streamer_restarts_total Reintentos de emision (cortes RTMPS)",
    "# TYPE streamer_restarts_total counter",
    `streamer_restarts_total ${view.restarts}`,
    // EQ5b · señales para las alertas (alerts.yml, grupo streamer): todas se
    // condicionan a `streamer_desired == 1`, así que con la emisión parada o
    // el streaming desactivado ninguna alerta puede saltar.
    "# HELP streamer_desired 1 si hay una emision pedida (activa, reintentando o agotada)",
    "# TYPE streamer_desired gauge",
    `streamer_desired ${view.desired ? 1 : 0}`,
    "# HELP streamer_progress_age_seconds Segundos desde el ultimo progreso de ffmpeg (-1 sin sesion)",
    "# TYPE streamer_progress_age_seconds gauge",
    `streamer_progress_age_seconds ${view.progressAgeSeconds ?? -1}`,
    "# HELP streamer_relay_publishing 1 si el rele RTMP esta publicando en la ingesta",
    "# TYPE streamer_relay_publishing gauge",
    `streamer_relay_publishing ${view.relayPublishing ? 1 : 0}`,
    "# HELP streamer_failed 1 si la emision se abandono por reintentos agotados",
    "# TYPE streamer_failed gauge",
    `streamer_failed ${view.state === "failed" ? 1 : 0}`,
    // STREAMER §28 · nombres del encargo, sobre el MISMO endpoint (sin sistema
    // de métricas nuevo). `stream_active` = emisión en curso o reintentando (no
    // «pedida»: una agotada no está activa).
    "# HELP stream_active 1 si hay una emision en curso (emitiendo o reintentando)",
    "# TYPE stream_active gauge",
    `stream_active ${view.state === "streaming" || view.state === "retrying" ? 1 : 0}`,
    "# HELP stream_start_total Arranques de emision desde que arranco el servicio",
    "# TYPE stream_start_total counter",
    `stream_start_total ${view.counters?.starts ?? 0}`,
    "# HELP stream_stop_total Paradas de una emision pedida desde que arranco el servicio",
    "# TYPE stream_stop_total counter",
    `stream_stop_total ${view.counters?.stops ?? 0}`,
    "# HELP stream_failures_total Emisiones abandonadas (reintentos agotados, sin credencial o ingesta invalida)",
    "# TYPE stream_failures_total counter",
    `stream_failures_total ${view.counters?.failures ?? 0}`,
    "# HELP stream_reconnects_total Reintentos de emision (cortes de la ingesta o procesos caidos)",
    "# TYPE stream_reconnects_total counter",
    `stream_reconnects_total ${view.restarts}`,
    "# HELP stream_uptime_seconds Segundos desde el arranque de la emision en curso (0 sin emision)",
    "# TYPE stream_uptime_seconds gauge",
    `stream_uptime_seconds ${view.uptimeSeconds ?? 0}`,
    "# HELP stream_frames_total Frames codificados (alias de streamer_frames_total)",
    "# TYPE stream_frames_total counter",
    `stream_frames_total ${view.stats.frames}`,
    "# HELP stream_dropped_frames_total Frames descartados (alias de streamer_dropped_frames_total)",
    "# TYPE stream_dropped_frames_total counter",
    `stream_dropped_frames_total ${view.stats.droppedFrames}`,
    "# HELP stream_killed_total Procesos hijos que hubo que matar con SIGKILL",
    "# TYPE stream_killed_total counter",
    `stream_killed_total ${view.counters?.killed ?? 0}`,
    "",
  ].join("\n");
}
