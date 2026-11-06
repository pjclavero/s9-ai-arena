/**
 * T11.2 · Supervisor de emisión: lanza Chromium (pinta /broadcast en el Xvfb)
 * y FFmpeg (captura + codifica al destino), y se encarga de:
 *  - reintentos ante corte de RTMPS: si ffmpeg (o el relé) muere mientras la
 *    emisión está activa, se relanza con espera constante hasta maxRetries
 *    seguidos; un tramo con progreso PUBLICADO resetea el contador (un corte de
 *    red de 30 s se recupera solo, DoD T11.2);
 *  - start/stop desde la API interna de control (control.ts);
 *  - métricas frames/bitrate desde el `-progress` de ffmpeg (metrics.ts).
 *
 * EQ5b §3 · En modo rtmps ffmpeg ya NO conoce el destino ni la clave: escribe
 * FLV por el fd 3 y `RtmpPublisher` (rtmp/publisher.ts), en este proceso, lo
 * publica. La clave llega SELLADA en la orden de arranque y se abre aquí, en
 * memoria; si no, se usa el secreto de despliegue heredado (STREAM_KEY_FILE),
 * leído en el momento del arranque.
 *
 * Todo lo externo entra inyectado (spawner, sleep, logger, dial): la lógica se
 * prueba SIN Chromium/FFmpeg reales.
 *
 * Regla de oro del cap. 21: este proceso es un espectador más. No abre ningún
 * canal hacia el motor: solo carga /broadcast (que consume el gateway de E8)
 * y empuja vídeo hacia fuera.
 */
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { buildChromiumArgs, buildFfmpegArgs, MEDIA_FD, redactArgs } from "./ffmpeg.js";
import { ProgressParser } from "./metrics.js";
import { SecretRegistry, type Logger, type StreamerConfig } from "./config.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { presetOf, sessionFingerprint, type PresetName, type SessionPlan } from "./session.js";

/** Contrato mínimo de un proceso hijo (ChildProcess lo cumple). */
export interface SpawnedProcess extends EventEmitter {
  stdout?: EventEmitter | null;
  stderr?: EventEmitter | null;
  /** stdio[3] = salida FLV hacia el relé (sólo si se pidió `mediaFd`). */
  stdio?: ArrayLike<unknown> | null;
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals): boolean | void;
}

/**
 * `group`: el hijo encabeza su PROPIO grupo de procesos (spawn `detached`), de
 * modo que la señal llega también a sus descendientes (Chromium lanza zygote,
 * GPU y renderers: matar sólo al padre los dejaba huérfanos).
 */
export type Spawner = (
  command: string,
  args: string[],
  opts?: { mediaFd?: boolean; group?: boolean },
) => SpawnedProcess;

/** Espera tras SIGTERM antes de SIGKILL (§12). */
export const STOP_GRACE_MS = 5000;

export type SupervisorState = "idle" | "streaming" | "retrying" | "stopped" | "failed";

export interface SupervisorOptions {
  config: StreamerConfig;
  /** Clave fija (tests y compatibilidad). En producción se resuelve en cada arranque. */
  streamKey?: string | null;
  spawner: Spawner;
  logger: Logger;
  /** Conjunto de secretos que redacta el logger (se le añade la clave activa). */
  secrets?: SecretRegistry;
  sleep?: (ms: number) => Promise<void>;
  chromiumBin?: string;
  ffmpegBin?: string;
  /** Inyectable en tests: transporte hacia la ingesta. */
  dial?: (t: IngestTarget) => Duplex;
  now?: () => number;
  /** Sólo pruebas locales: admite `rtmp://` sin TLS (STREAMER_ALLOW_PLAIN_RTMP=1). */
  allowPlainRtmp?: boolean;
  /**
   * El spawner real crea grupos de procesos (`group`): las señales se mandan al
   * GRUPO (`kill(-pid)`). Nunca con procesos falsos (un pid inventado sería un
   * grupo ajeno).
   */
  processGroups?: boolean;
  /** Espera entre SIGTERM y SIGKILL (por defecto STOP_GRACE_MS). */
  stopGraceMs?: number;
}

/** Contadores de §28 (stream_*), acumulados desde que arrancó el proceso. */
export interface StreamCounters {
  starts: number;
  stops: number;
  failures: number;
  /** Escalados a SIGKILL (proceso que no atendió SIGTERM a tiempo). */
  killed: number;
}

export interface ActiveSessionView {
  sessionId: string | null;
  mode: "rtmps" | "record";
  encoder: "x264" | "nvenc";
  preset: PresetName;
  fps: number;
  videoBitrateKbps: number;
  broadcastUrl: string;
  target: string;
  startedAt: string;
}

export class StreamSupervisor {
  readonly metrics = new ProgressParser();
  private state_: SupervisorState = "idle";
  private restarts_ = 0;
  private attempts = 0;
  private broadcastUrl: string;
  private chromium: SpawnedProcess | null = null;
  private ffmpeg: SpawnedProcess | null = null;
  private publisher: RtmpPublisher | null = null;
  private generation = 0; // invalida reintentos en vuelo tras stop()/start()
  private plan: SessionPlan | null = null;
  private key: string | null = null;
  private startedAt: number | null = null;
  private lastError_: { message: string; at: string } | null = null;
  private recordFile_: string | null = null;
  private fingerprint: string | null = null;
  private readonly secrets: SecretRegistry;
  readonly counters: StreamCounters = { starts: 0, stops: 0, failures: 0, killed: 0 };
  /** Hijos señalados que aún no han salido (huérfanos potenciales). */
  private readonly terminating = new Set<SpawnedProcess>();

  constructor(private readonly opts: SupervisorOptions) {
    this.broadcastUrl = opts.config.broadcastUrl;
    this.secrets = opts.secrets ?? new SecretRegistry();
    this.secrets.add(opts.streamKey ?? null);
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
  /** Emisión pedida y no detenida (incluye reintentando y agotada). */
  get desired(): boolean {
    return this.state_ === "streaming" || this.state_ === "retrying" || this.state_ === "failed";
  }
  get active(): boolean {
    return this.state_ === "streaming" || this.state_ === "retrying";
  }
  get lastError(): { message: string; at: string } | null {
    return this.lastError_;
  }
  get recordingFile(): string | null {
    return this.active ? this.recordFile_ : null;
  }
  get relayState(): string | null {
    return this.publisher?.state ?? null;
  }
  get relayBytesOut(): number {
    return this.publisher?.bytesOut ?? 0;
  }
  /** Sesión de la emisión pedida (null = sin sesión: heredada o STREAM_AUTOSTART). */
  get currentSessionId(): string | null {
    return this.plan?.sessionId ?? null;
  }
  get sessionFingerprint(): string | null {
    return this.desired ? this.fingerprint : null;
  }
  get startedAtMs(): number | null {
    return this.startedAt;
  }
  get effectiveConfig(): StreamerConfig {
    return this.plan?.config ?? this.opts.config;
  }

  session(): ActiveSessionView | null {
    if (!this.desired || this.startedAt === null) return null;
    const c = this.effectiveConfig;
    return {
      sessionId: this.plan?.sessionId ?? null,
      mode: c.mode,
      encoder: c.encoder,
      preset: this.plan?.preset ?? presetOf(c),
      fps: c.fps,
      videoBitrateKbps: c.videoBitrateKbps,
      broadcastUrl: this.broadcastUrl,
      target: this.describeTarget(),
      startedAt: new Date(this.startedAt).toISOString(),
    };
  }

  describeTarget(): string {
    const c = this.effectiveConfig;
    if (c.mode === "record") return c.recordDir;
    if (this.plan?.ingest) return this.plan.ingest.display;
    try {
      return parseIngestUrl(c.rtmpsUrl, true).display;
    } catch {
      return "ingesta no válida";
    }
  }

  private setError(message: string): void {
    this.lastError_ = { message: this.secrets.redact(message).slice(0, 300), at: new Date(this.now()).toISOString() };
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Arranca (o re-apunta) la emisión. Con `plan` (orden de la API) aplica su
   * configuración y su clave ya abierta; sin él, la configuración de entorno.
   */
  start(broadcastUrl?: string, plan?: SessionPlan, streamKey?: string | null): void {
    if (plan) {
      this.plan = plan;
      this.broadcastUrl = plan.broadcastUrl;
    } else {
      // STREAMER · un arranque SIN plan (heredado o STREAM_AUTOSTART) no hereda
      // la sesión anterior: si no, /status y el stop condicionado verían el
      // sessionId de una sesión que ya no es la que emite.
      this.broadcastUrl = broadcastUrl ?? this.opts.config.broadcastUrl;
      this.plan = null;
    }
    if (streamKey !== undefined) {
      if (this.key && this.key !== streamKey && this.key !== this.opts.streamKey) this.secrets.delete(this.key);
      this.key = streamKey;
      this.secrets.add(streamKey);
    } else if (this.key === null) {
      this.key = this.opts.streamKey ?? null;
    }
    this.fingerprint = plan ? sessionFingerprint(plan) : null;
    this.stopProcesses();
    this.generation++;
    this.attempts = 0;
    this.lastError_ = null;
    this.startedAt = this.now();
    this.state_ = "streaming";
    this.counters.starts++;
    this.launch();
    this.opts.logger("info", "emisión arrancada", {
      sessionId: this.plan?.sessionId ?? null,
      broadcastUrl: this.broadcastUrl,
      mode: this.effectiveConfig.mode,
      target: this.describeTarget(),
    });
  }

  stop(): void {
    this.generation++;
    this.stopProcesses();
    const was = this.state_;
    this.state_ = "stopped";
    this.startedAt = null;
    this.fingerprint = null;
    if (was === "streaming" || was === "retrying" || was === "failed") this.counters.stops++;
    if (was !== "stopped") this.opts.logger("info", "emisión parada por control", { previous: was });
  }

  /** Procesos hijos señalados que todavía no han terminado (0 = sin huérfanos pendientes). */
  get pendingChildren(): number {
    return this.terminating.size;
  }

  /**
   * §12 · SIGTERM y, si el proceso no ha salido en `stopGraceMs`, SIGKILL. Con
   * grupos de procesos la señal va al GRUPO entero (Chromium y sus hijos).
   */
  private terminate(proc: SpawnedProcess | null, name: string): void {
    if (!proc) return;
    const exited = () => (proc.exitCode !== undefined && proc.exitCode !== null) || !!proc.signalCode;
    if (exited()) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (this.opts.processGroups && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        /* ya no existe */
      }
    };
    this.terminating.add(proc);
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      this.terminating.delete(proc);
      if (timer) clearTimeout(timer);
      timer = null;
    };
    proc.once("exit", done);
    signal("SIGTERM");
    timer = setTimeout(() => {
      timer = null;
      if (!this.terminating.has(proc)) return;
      this.counters.killed++;
      this.opts.logger("warn", "proceso sin salir tras SIGTERM: SIGKILL", { process: name });
      signal("SIGKILL");
    }, this.opts.stopGraceMs ?? STOP_GRACE_MS);
    timer.unref?.();
  }

  private stopProcesses(): void {
    try {
      this.publisher?.close();
    } catch {}
    this.terminate(this.ffmpeg, "ffmpeg");
    this.terminate(this.chromium, "chromium");
    this.publisher = null;
    this.ffmpeg = null;
    this.chromium = null;
  }

  private launch(): void {
    const cfg = this.effectiveConfig;
    if (cfg.mode === "rtmps" && !this.key) {
      // Sin clave no hay nada que reintentar: estado terminal y visible.
      this.setError("modo rtmps sin credencial de emisión configurada");
      this.state_ = "failed";
      this.counters.failures++;
      this.opts.logger("error", "emisión imposible: no hay credencial de emisión");
      return;
    }
    this.launchChromium();
    this.launchFfmpeg();
  }

  private launchChromium(): void {
    const gen = this.generation;
    const args = buildChromiumArgs(this.effectiveConfig, this.broadcastUrl);
    this.chromium = this.opts.spawner(this.opts.chromiumBin ?? "chromium-browser", args, { group: true });
    this.chromium.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      // Chromium caído = pantalla negra: cuenta como corte y se relanza junto a ffmpeg.
      this.setError(`chromium terminó (código ${String(code)})`);
      this.opts.logger("warn", "chromium terminó; se relanza", { code });
      void this.retry();
    });
  }

  private launchFfmpeg(): void {
    const gen = this.generation;
    const cfg = this.effectiveConfig;
    const plan = buildFfmpegArgs(cfg);
    this.recordFile_ = plan.recordFile ?? null;
    this.metrics.markRestart();

    let publisher: RtmpPublisher | null = null;
    if (cfg.mode === "rtmps") {
      let target = this.plan?.ingest ?? null;
      if (!target) {
        try {
          target = parseIngestUrl(cfg.rtmpsUrl, this.opts.allowPlainRtmp);
        } catch (e) {
          this.setError(`ingesta RTMPS no válida: ${(e as Error).message}`);
          this.state_ = "failed";
          this.counters.failures++;
          this.stopProcesses();
          return;
        }
      }
      publisher = new RtmpPublisher({ target, streamKey: this.key!, dial: this.opts.dial });
      this.publisher = publisher;
      publisher.on("error", (e: Error) => {
        if (gen !== this.generation || this.state_ === "stopped") return;
        this.setError(e.message);
        this.opts.logger("warn", "relé RTMP: corte de la ingesta", { detail: e.message });
        void this.retry();
      });
      publisher.on("publishing", () => {
        if (gen === this.generation) this.opts.logger("info", "relé RTMP publicando", { target: target.display });
      });
      publisher.start().catch(() => {
        /* el mismo fallo llega por 'error' */
      });
    }

    const child = this.opts.spawner(this.opts.ffmpegBin ?? "ffmpeg", plan.args, {
      mediaFd: cfg.mode === "rtmps",
      group: true,
    });
    this.ffmpeg = child;
    // Solo argv REDACTADO sale por el logger (y desde EQ5b ya no contiene la clave).
    this.opts.logger("info", "ffmpeg lanzado", {
      target: cfg.mode === "rtmps" ? this.describeTarget() : plan.describeTarget,
      argv: redactArgs(plan.args, this.key).join(" "),
    });
    if (publisher) {
      const media = (child.stdio?.[MEDIA_FD] ?? null) as Readable | null;
      if (!media) {
        this.setError("ffmpeg sin descriptor de salida FLV");
        void this.retry();
        return;
      }
      media.on("data", (chunk: Buffer) => {
        if (!publisher!.writeFlv(chunk)) media.pause();
      });
      media.on("error", () => {});
      publisher.on("drain", () => media.resume());
    }
    child.stdout?.on("data", (chunk: string | Buffer) => {
      this.metrics.push(chunk);
      // Progreso real = la emisión fluye: un corte anterior queda saldado. En
      // rtmps sólo cuenta si el relé está PUBLICANDO (ffmpeg puede progresar
      // unos frames contra la tubería aunque la ingesta lo haya rechazado).
      const flowing = cfg.mode === "record" || publisher?.state === "publishing";
      if (this.metrics.snapshot().reporting && flowing) this.attempts = 0;
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const detail = chunk.toString().trim().slice(0, 500);
      this.setError(`ffmpeg: ${detail}`);
      this.opts.logger("error", "ffmpeg stderr", { detail });
    });
    child.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      this.setError(`ffmpeg terminó (código ${String(code)})`);
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
      this.counters.failures++;
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
    this.launch();
  }
}
