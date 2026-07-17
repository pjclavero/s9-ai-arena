/**
 * T11.2 · Métricas de emisión: parser del `-progress pipe:1` de FFmpeg
 * (bloques clave=valor terminados en `progress=continue|end`) y exposición en
 * formato Prometheus para que E10 las raspe (prometheus.yml, red platform).
 */

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
  private pending: Record<string, string> = {};

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
    this.pending = {};
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
    this.pending = {};
    this.buffer = "";
  }
}

export interface MetricsView {
  state: string;
  restarts: number;
  stats: StreamStats;
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
    "",
  ].join("\n");
}
