/**
 * T11.2 · Supervisor de emisión: lanza Chromium (pinta /broadcast en el Xvfb)
 * y FFmpeg (captura + codifica al destino), y se encarga de:
 *  - reintentos ante corte de RTMPS: si ffmpeg muere mientras la emisión está
 *    activa, se relanza con espera constante hasta maxRetries seguidos; un
 *    tramo con progreso resetea el contador (un corte de red de 30 s se
 *    recupera solo, DoD T11.2);
 *  - start/stop desde la API interna de control (control.ts);
 *  - métricas frames/bitrate desde el `-progress` de ffmpeg (metrics.ts).
 *
 * Todo lo externo entra inyectado (spawner, sleep, logger): la lógica se
 * prueba SIN Chromium/FFmpeg reales — en este entorno no hay navegador ni
 * salida a YouTube (limitación declarada en docs/entrega-E11.md).
 *
 * Regla de oro del cap. 21: este proceso es un espectador más. No abre ningún
 * canal hacia el motor: solo carga /broadcast (que consume el gateway de E8)
 * y empuja vídeo hacia fuera.
 */
import { EventEmitter } from "node:events";
import { buildChromiumArgs, buildFfmpegArgs, redactArgs } from "./ffmpeg.js";
import { ProgressParser } from "./metrics.js";
import type { Logger, StreamerConfig } from "./config.js";

/** Contrato mínimo de un proceso hijo (ChildProcess lo cumple). */
export interface SpawnedProcess extends EventEmitter {
  stdout?: EventEmitter | null;
  stderr?: EventEmitter | null;
  kill(signal?: NodeJS.Signals): boolean | void;
}

export type Spawner = (command: string, args: string[]) => SpawnedProcess;

export type SupervisorState = "idle" | "streaming" | "retrying" | "stopped" | "failed";

export interface SupervisorOptions {
  config: StreamerConfig;
  streamKey: string | null;
  spawner: Spawner;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  chromiumBin?: string;
  ffmpegBin?: string;
}

export class StreamSupervisor {
  readonly metrics = new ProgressParser();
  private state_: SupervisorState = "idle";
  private restarts_ = 0;
  private attempts = 0;
  private broadcastUrl: string;
  private chromium: SpawnedProcess | null = null;
  private ffmpeg: SpawnedProcess | null = null;
  private generation = 0; // invalida reintentos en vuelo tras stop()/start()

  constructor(private readonly opts: SupervisorOptions) {
    this.broadcastUrl = opts.config.broadcastUrl;
  }

  get state(): SupervisorState {
    return this.state_;
  }
  get restarts(): number {
    return this.restarts_;
  }
  get currentBroadcastUrl(): string {
    return this.broadcastUrl;
  }

  /** Arranca (o re-apunta) la emisión sobre una URL de broadcast. */
  start(broadcastUrl?: string): void {
    if (broadcastUrl) this.broadcastUrl = broadcastUrl;
    this.stopProcesses();
    this.generation++;
    this.attempts = 0;
    this.state_ = "streaming";
    this.launchChromium();
    this.launchFfmpeg();
    this.opts.logger("info", "emisión arrancada", { broadcastUrl: this.broadcastUrl, mode: this.opts.config.mode });
  }

  stop(): void {
    this.generation++;
    this.stopProcesses();
    this.state_ = "stopped";
    this.opts.logger("info", "emisión parada por control");
  }

  private stopProcesses(): void {
    try {
      this.ffmpeg?.kill("SIGTERM");
    } catch {}
    try {
      this.chromium?.kill("SIGTERM");
    } catch {}
    this.ffmpeg = null;
    this.chromium = null;
  }

  private launchChromium(): void {
    const gen = this.generation;
    const args = buildChromiumArgs(this.opts.config, this.broadcastUrl);
    this.chromium = this.opts.spawner(this.opts.chromiumBin ?? "chromium-browser", args);
    this.chromium.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      // Chromium caído = pantalla negra: cuenta como corte y se relanza junto a ffmpeg.
      this.opts.logger("warn", "chromium terminó; se relanza", { code });
      void this.retry();
    });
  }

  private launchFfmpeg(): void {
    const gen = this.generation;
    const plan = buildFfmpegArgs(this.opts.config, this.opts.streamKey);
    this.metrics.markRestart();
    const child = this.opts.spawner(this.opts.ffmpegBin ?? "ffmpeg", plan.args);
    this.ffmpeg = child;
    // Solo argv REDACTADO sale por el logger (la clave nunca en logs, cap. 21).
    this.opts.logger("info", "ffmpeg lanzado", {
      target: plan.describeTarget,
      argv: redactArgs(plan.args, this.opts.streamKey).join(" "),
    });
    child.stdout?.on("data", (chunk: string | Buffer) => {
      this.metrics.push(chunk);
      // Progreso real = la emisión fluye: un corte anterior queda saldado.
      if (this.metrics.snapshot().reporting) this.attempts = 0;
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      this.opts.logger("error", "ffmpeg stderr", { detail: chunk.toString().trim().slice(0, 500) });
    });
    child.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      this.opts.logger("warn", "ffmpeg terminó", { code });
      void this.retry();
    });
  }

  /** Corte de RTMPS o proceso muerto: espera y relanza, hasta maxRetries seguidos. */
  private async retry(): Promise<void> {
    // Nueva generación YA: el exit del proceso hermano (lo matamos aquí abajo)
    // no debe encolar un segundo reintento.
    this.generation++;
    const gen = this.generation;
    this.attempts++;
    this.restarts_++;
    if (this.attempts > this.opts.config.maxRetries) {
      this.state_ = "failed";
      this.stopProcesses();
      this.opts.logger("error", "emisión abandonada: reintentos agotados", { attempts: this.attempts - 1 });
      return;
    }
    this.state_ = "retrying";
    this.stopProcesses();
    const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(this.opts.config.retryDelayMs);
    if (gen !== this.generation) return; // stop()/start() durante la espera
    this.state_ = "streaming";
    this.opts.logger("info", "reintento de emisión", { attempt: this.attempts });
    this.launchChromium();
    this.launchFfmpeg();
  }
}
