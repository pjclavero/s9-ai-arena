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
import { readdirSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { buildChromiumArgs, buildFfmpegArgs, MEDIA_FD, redactArgs } from "./ffmpeg.js";
import { ProgressParser } from "./metrics.js";
import { SecretRegistry, type Logger, type StreamerConfig } from "./config.js";
import { parseIngestUrl, RtmpPublisher, type Dialer, type IngestTarget } from "./rtmp/publisher.js";
import { presetOf, sessionFingerprint, type PresetName, type SessionPlan } from "./session.js";
import { classifyFrame, type FrameVerdict, type LumaStats } from "./frame-check.js";
import type { IngestTap } from "./tap.js";

/**
 * #256 · BROADCAST_RENDER_READY. La emisión real de YouTube salió en BLANCO durante toda
 * la sesión: el renderer de Chromium se quedaba atascado antes de su primer frame y el
 * Xvfb conservaba el fondo blanco de la ventana; ffmpeg, el FLV y el relé lo
 * transportaban fielmente y nada lo detectaba (ver docs/operations/streaming.md, #256).
 *
 * Regla: NO se arranca ffmpeg (ni, en rtmps, el relé) hasta que el framebuffer del Xvfb
 * —exactamente lo que capturaría ffmpeg— muestre RENDER_READY_CONSECUTIVE frames
 * seguidos VISIBLES (ni blanco ni uniforme, frame-check.ts). Es una condición
 * comprobada, no una espera fija: se sondea cada RENDER_POLL_MS hasta un plazo. Si el
 * plazo vence, Chromium se relanza (reintento contado): nunca se emite una pantalla
 * blanca. Con la emisión en marcha, un vigilante sondea cada RENDER_WATCH_INTERVAL_MS y,
 * con RENDER_BLANK_STRIKES lecturas seguidas no visibles, corta y relanza.
 */
export const RENDER_READY_TIMEOUT_MS = 30_000;
export const RENDER_POLL_MS = 500;
export const RENDER_READY_CONSECUTIVE = 2;
export const RENDER_WATCH_INTERVAL_MS = 5_000;
export const RENDER_BLANK_STRIKES = 3;

export type RenderState = "off" | "waiting" | "ready" | "blank";
export interface RenderFrameView {
  verdict: FrameVerdict | "error";
  lumaMean: number | null;
  lumaStddev: number | null;
  at: string;
}

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

export type Spawner = (command: string, args: string[], opts?: { mediaFd?: boolean }) => SpawnedProcess;

/** Espera tras SIGTERM antes de SIGKILL (§12). */
export const STOP_GRACE_MS = 5000;

/**
 * STREAMER-2 (H1) · Cola de la salida de Chromium que se conserva para el
 * diagnóstico (bytes). El resto se lee y se descarta.
 */
export const CHROMIUM_OUTPUT_TAIL_BYTES = 2048;

export type SupervisorState = "idle" | "streaming" | "retrying" | "stopped" | "failed";

/**
 * STREAMING-UX (§23-§25) · política de failover principal → respaldo:
 *  - SÓLO cuentan los fallos de red, transporte o handshake ANTES de que la ingesta
 *    conteste a `connect` (códigos del relé `timeout`, `network`, `closed_by_server`
 *    y `protocol`). Una clave rechazada, un error de autorización (`rejected`), un
 *    certificado inválido (`tls`) o una configuración local mala no cambian de
 *    ingesta, porque el respaldo fallaría igual o sería inseguro cambiar;
 *  - hacen falta FAILOVER_AFTER fallos SEGUIDOS de la principal: uno transitorio no basta;
 *  - tras el cambio, el respaldo se queda hasta el final de la sesión (sin saltar
 *    de una a otra); la siguiente sesión (start) vuelve a empezar por la principal.
 */
export const FAILOVER_AFTER = 3;
export const FAILOVER_CODES: ReadonlySet<string> = new Set(["timeout", "network", "closed_by_server", "protocol"]);
export type IngestRole = "primary" | "backup";

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
  dial?: Dialer;
  now?: () => number;
  /** Sólo pruebas locales: admite `rtmp://` sin TLS (STREAMER_ALLOW_PLAIN_RTMP=1). */
  allowPlainRtmp?: boolean;
  /**
   * Procesos REALES: la parada señala el ÁRBOL entero de cada hijo (sus
   * descendientes, leídos de /proc). Nunca con procesos falsos (un pid inventado
   * sería un proceso ajeno).
   */
  processTree?: boolean;
  /** Espera entre SIGTERM y SIGKILL (por defecto STOP_GRACE_MS). */
  stopGraceMs?: number;
  /**
   * #256 · Lectura de UN frame del Xvfb (luma). Con ella se activa la puerta
   * BROADCAST_RENDER_READY y el vigilante de frame en blanco; main.ts siempre la pasa
   * (x11grab real). Sin ella (pruebas antiguas con procesos falsos) no hay puerta.
   */
  renderProbe?: () => Promise<LumaStats>;
  renderReadyTimeoutMs?: number;
  renderPollMs?: number;
  renderWatchIntervalMs?: number;
  /**
   * DIAG · tap pasivo de la señal de ingesta (OFF por defecto: sólo existe con
   * STREAM_TAP_ENABLED=true). Recibe una COPIA lógica de cada trozo FLV DESPUÉS de
   * entregarlo al relé; lo que devuelva o haga no afecta al relé (ver tap.ts).
   */
  tap?: IngestTap | null;
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
  private backupKey: string | null = null;
  private ingestRole_: IngestRole = "primary";
  private connectFailures = 0;
  private failedOver_ = false;
  private ingestErrors_: { primary: string | null; backup: string | null } = { primary: null, backup: null };
  private startedAt: number | null = null;
  private lastError_: { message: string; at: string } | null = null;
  private recordFile_: string | null = null;
  private fingerprint: string | null = null;
  private readonly secrets: SecretRegistry;
  readonly counters: StreamCounters = { starts: 0, stops: 0, failures: 0, killed: 0 };
  private renderState_: RenderState = "off";
  private renderFrame_: RenderFrameView | null = null;
  /** #256 · veces que la puerta venció o el vigilante vio la pantalla en blanco. */
  renderBlankEvents = 0;
  /** Paradas en curso: hijos (y sus descendientes) señalados que aún no han salido. */
  private readonly terminating = new Set<{ alive: () => boolean }>();

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
  /** #256 · estado de la puerta de render y última lectura del Xvfb (para /status). */
  get render(): { state: RenderState; lastFrame: RenderFrameView | null; blankEvents: number } {
    return {
      state: this.desired ? this.renderState_ : "off",
      lastFrame: this.renderFrame_,
      blankEvents: this.renderBlankEvents,
    };
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
  /** STREAMING-UX (§22) · ingesta que usa (o intenta) la emisión en curso. */
  get ingestRole(): IngestRole {
    return this.ingestRole_;
  }
  get backupAvailable(): boolean {
    return !!this.plan?.backupIngest && !!this.backupKey;
  }
  get failedOver(): boolean {
    return this.failedOver_;
  }
  /** Último error de cada ingesta en esta sesión (redactado; null = sin error). */
  get ingestErrors(): { primary: string | null; backup: string | null } {
    return { ...this.ingestErrors_ };
  }
  private currentTarget(): IngestTarget | null {
    if (this.ingestRole_ === "backup" && this.plan?.backupIngest) return this.plan.backupIngest;
    return this.plan?.ingest ?? null;
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
    const t = this.currentTarget();
    if (t) return t.display;
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
  start(broadcastUrl?: string, plan?: SessionPlan, streamKey?: string | null, backupKey?: string | null): void {
    // STREAMING-UX (§25) · cada sesión nueva empieza por la PRINCIPAL.
    if (this.backupKey && this.backupKey !== streamKey && this.backupKey !== this.opts.streamKey) {
      this.secrets.delete(this.backupKey);
    }
    this.backupKey = plan?.backupIngest ? (backupKey ?? null) : null;
    this.secrets.add(this.backupKey);
    this.ingestRole_ = "primary";
    this.connectFailures = 0;
    this.failedOver_ = false;
    this.ingestErrors_ = { primary: null, backup: null };
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
    let n = 0;
    for (const t of [...this.terminating]) {
      if (t.alive()) n++;
      else this.terminating.delete(t);
    }
    return n;
  }

  /**
   * §12/§20 · SIGTERM al proceso y a TODOS sus descendientes y, si alguno sigue
   * vivo pasados `stopGraceMs`, SIGKILL. Con procesos reales (`processTree`) el
   * árbol se lee de /proc (ppid) al parar y otra vez al escalar, y cada pid se
   * guarda con su instante de arranque para no señalar a un proceso ajeno que
   * reutilice el pid. Los hijos NO se sacan del grupo de procesos del servicio:
   * si el propio servicio muere de golpe (SIGKILL al grupo, el contenedor que
   * se para), su grupo se los lleva también.
   */
  private terminate(proc: SpawnedProcess | null, name: string): void {
    if (!proc) return;
    const grace = this.opts.stopGraceMs ?? STOP_GRACE_MS;
    if (this.opts.processTree && proc.pid) {
      const tracked = processTree(proc.pid);
      const alive = () => [...tracked].some(([pid, start]) => sameProcess(pid, start));
      const signalAll = (sig: NodeJS.Signals) => {
        for (const [pid, start] of tracked) {
          if (!sameProcess(pid, start)) continue;
          try {
            process.kill(pid, sig);
          } catch {
            /* ya no existe */
          }
        }
      };
      if (!alive()) return;
      const t = { alive };
      this.terminating.add(t);
      signalAll("SIGTERM");
      const timer = setTimeout(() => {
        // Los que nacieron entre la lectura y la señal (o siguen colgando del padre).
        for (const [pid, start] of processTree(proc.pid!)) tracked.set(pid, start);
        if (alive()) {
          this.counters.killed++;
          this.opts.logger("warn", "proceso sin salir tras SIGTERM: SIGKILL", { process: name });
          signalAll("SIGKILL");
        }
        this.terminating.delete(t);
      }, grace);
      timer.unref?.();
      return;
    }
    // Procesos inyectados (pruebas): sólo el propio proceso.
    const exited = () => (proc.exitCode !== undefined && proc.exitCode !== null) || !!proc.signalCode;
    if (exited()) return;
    let done = false;
    const t = { alive: () => !done };
    proc.once("exit", () => {
      done = true;
    });
    this.terminating.add(t);
    try {
      proc.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      if (!done) {
        this.counters.killed++;
        this.opts.logger("warn", "proceso sin salir tras SIGTERM: SIGKILL", { process: name });
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      this.terminating.delete(t);
    }, grace);
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
    if (!this.opts.renderProbe) {
      this.launchFfmpeg();
      return;
    }
    // #256 · ffmpeg (y el relé) sólo cuando el Xvfb muestre la página pintada.
    this.renderState_ = "waiting";
    void this.awaitRenderReady(this.generation);
  }

  /** Una lectura del Xvfb; `null` si la sonda falla (cuenta como no visible). */
  private async readFrame(): Promise<FrameVerdict | "error"> {
    let verdict: FrameVerdict | "error" = "error";
    let stats: LumaStats | null = null;
    try {
      stats = await this.opts.renderProbe!();
      verdict = classifyFrame(stats);
    } catch {
      verdict = "error";
    }
    this.renderFrame_ = {
      verdict,
      lumaMean: stats ? Number(stats.mean.toFixed(2)) : null,
      lumaStddev: stats ? Number(stats.stddev.toFixed(2)) : null,
      at: new Date(this.now()).toISOString(),
    };
    return verdict;
  }

  private describeFrame(): string {
    const f = this.renderFrame_;
    if (!f) return "sin lectura";
    return f.verdict === "error"
      ? "no se pudo leer el display"
      : `frame ${f.verdict === "white" ? "BLANCO" : f.verdict === "uniform" ? "UNIFORME" : "visible"} (luma media ${f.lumaMean}, desviación ${f.lumaStddev})`;
  }

  private sleepMs(ms: number): Promise<void> {
    const sleep = this.opts.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t)));
    return sleep(ms);
  }

  /** BROADCAST_RENDER_READY: sondea el Xvfb hasta N frames visibles seguidos o el plazo. */
  private async awaitRenderReady(gen: number): Promise<void> {
    const timeout = this.opts.renderReadyTimeoutMs ?? RENDER_READY_TIMEOUT_MS;
    const poll = this.opts.renderPollMs ?? RENDER_POLL_MS;
    const deadline = this.now() + timeout;
    let seen = 0;
    for (;;) {
      if (gen !== this.generation || this.state_ !== "streaming") return;
      const v = await this.readFrame();
      if (gen !== this.generation || this.state_ !== "streaming") return;
      seen = v === "visible" ? seen + 1 : 0;
      if (seen >= RENDER_READY_CONSECUTIVE) {
        this.renderState_ = "ready";
        this.opts.logger("info", "render listo: la página está pintada en el display", {
          lumaMean: this.renderFrame_?.lumaMean,
          lumaStddev: this.renderFrame_?.lumaStddev,
        });
        this.launchFfmpeg();
        void this.watchRender(gen);
        return;
      }
      if (this.now() >= deadline) {
        this.renderState_ = "blank";
        this.renderBlankEvents++;
        this.setError(
          `render_not_ready: la página no se pintó en ${Math.round(timeout / 1000)} s; ${this.describeFrame()}`,
        );
        this.opts.logger("warn", "render no listo: no se emite y se relanza Chromium", {
          detail: this.describeFrame(),
        });
        void this.retry();
        return;
      }
      await this.sleepMs(poll);
    }
  }

  /** Vigilante con la emisión en marcha: una pantalla que se queda en blanco corta y relanza. */
  private async watchRender(gen: number): Promise<void> {
    const every = this.opts.renderWatchIntervalMs ?? RENDER_WATCH_INTERVAL_MS;
    let strikes = 0;
    for (;;) {
      await this.sleepMs(every);
      if (gen !== this.generation || this.state_ !== "streaming") return;
      const v = await this.readFrame();
      if (gen !== this.generation || this.state_ !== "streaming") return;
      strikes = v === "visible" ? 0 : strikes + 1;
      if (strikes >= RENDER_BLANK_STRIKES) {
        this.renderState_ = "blank";
        this.renderBlankEvents++;
        this.setError(`render_blank: la pantalla de emisión dejó de verse; ${this.describeFrame()}`);
        this.opts.logger("warn", "pantalla de emisión en blanco: se corta y se relanza", {
          detail: this.describeFrame(),
        });
        void this.retry();
        return;
      }
    }
  }

  private launchChromium(): void {
    const gen = this.generation;
    const args = buildChromiumArgs(this.effectiveConfig, this.broadcastUrl);
    const chromium = this.opts.spawner(this.opts.chromiumBin ?? "chromium-browser", args);
    this.chromium = chromium;
    // STREAMER-2 (H1) · stdout y stderr de Chromium se LEEN SIEMPRE y se
    // descartan. Un pipe sin lector se llena (64 KiB del kernel + el búfer de
    // Node) y Chromium se bloquea en write(): la emisión seguiría «streaming»
    // con la imagen congelada y sin ninguna alerta. El lector no aplica
    // backpressure (no pausa nunca) y sólo guarda una cola acotada del stderr
    // para el log de una caída; se redacta al registrarla (logger).
    let tail = Buffer.alloc(0);
    const keepTail = (chunk: string | Buffer) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      tail = Buffer.concat([tail, b]);
      if (tail.length > CHROMIUM_OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - CHROMIUM_OUTPUT_TAIL_BYTES);
    };
    chromium.stdout?.on("data", () => {});
    chromium.stderr?.on("data", keepTail);
    chromium.stdout?.on("error", () => {});
    chromium.stderr?.on("error", () => {});
    chromium.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      // Chromium caído = pantalla negra: cuenta como corte y se relanza junto a ffmpeg.
      this.setError(`chromium terminó (código ${String(code)})`);
      this.opts.logger("warn", "chromium terminó; se relanza", {
        code,
        outputTail: Buffer.from(tail).toString("utf8").trim(),
      });
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
      let target = this.currentTarget();
      const role = this.ingestRole_;
      const key = role === "backup" ? this.backupKey : this.key;
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
      const pub = new RtmpPublisher({ target, streamKey: key!, dial: this.opts.dial });
      publisher = pub;
      this.publisher = pub;
      pub.on("error", (e: Error & { code?: string }) => {
        if (gen !== this.generation || this.state_ === "stopped") return;
        this.setError(e.message);
        this.ingestErrors_[role] = this.secrets.redact(e.message).slice(0, 200);
        this.noteIngestFailure(role, e.code ?? "", pub.appConnected);
        this.opts.logger("warn", "relé RTMP: corte de la ingesta", { detail: e.message, ingest: role });
        void this.retry();
      });
      pub.on("publishing", () => {
        if (gen !== this.generation) return;
        this.connectFailures = 0;
        this.ingestErrors_[role] = null;
        this.opts.logger("info", "relé RTMP publicando", { target: target.display, ingest: role });
      });
      publisher.start().catch(() => {
        /* el mismo fallo llega por 'error' */
      });
    }

    const child = this.opts.spawner(this.opts.ffmpegBin ?? "ffmpeg", plan.args, { mediaFd: cfg.mode === "rtmps" });
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
      const tap = this.opts.tap ?? null;
      tap?.beginStream();
      media.on("data", (chunk: Buffer) => {
        const accepting = publisher!.writeFlv(chunk);
        // DIAG · el tap observa DESPUÉS del relé y no decide nada: su resultado no
        // existe para el control de flujo (sólo `accepting` pausa a ffmpeg).
        if (tap) {
          try {
            tap.observe(chunk);
          } catch {
            /* observe() no lanza; defensa en profundidad: el relé nunca se entera */
          }
        }
        if (!accepting) media.pause();
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
      // STREAMER-2 (H2) · guarda de generación: lo que ffmpeg escribe DESPUÉS de
      // que esta emisión se diera por cortada (la parada que sigue a un rechazo
      // de la ingesta: «Terminated», «Nothing was written into output file…»)
      // se registra, pero NO sustituye la causa raíz en `lastError`.
      const current = gen === this.generation && this.state_ !== "stopped";
      if (current) this.setError(`ffmpeg: ${detail}`);
      this.opts.logger("error", "ffmpeg stderr", current ? { detail } : { detail, superseded: true });
    });
    child.on("exit", (code: unknown) => {
      if (gen !== this.generation || this.state_ === "stopped") return;
      this.setError(`ffmpeg terminó (código ${String(code)})`);
      this.opts.logger("warn", "ffmpeg terminó", { code });
      void this.retry();
    });
  }

  /**
   * STREAMING-UX (§23) · cuenta un fallo del relé y, si toca, pasa al respaldo para el
   * resto de la sesión. Ver FAILOVER_AFTER / FAILOVER_CODES.
   */
  private noteIngestFailure(role: IngestRole, code: string, appConnected: boolean): void {
    const network = !appConnected && FAILOVER_CODES.has(code);
    if (!network) {
      // Clave, autorización, certificado o configuración: no es de red, no se cambia
      // de ingesta y la racha se corta (no son «fallos seguidos de conexión»).
      this.connectFailures = 0;
      return;
    }
    this.connectFailures++;
    if (role === "primary" && this.backupAvailable && this.connectFailures >= FAILOVER_AFTER) {
      this.ingestRole_ = "backup";
      this.failedOver_ = true;
      this.connectFailures = 0;
      this.opts.logger("warn", "ingesta principal no disponible: se pasa al respaldo para esta sesión", {
        failures: FAILOVER_AFTER,
        target: this.plan?.backupIngest?.display ?? null,
      });
    }
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

/** Campos de /proc/<pid>/stat tras el nombre: [estado, ppid, …, starttime (índice 19)]. */
function statFields(pid: number): string[] | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    return st.slice(st.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** ¿El pid sigue siendo EL MISMO proceso (mismo arranque) y no es un zombi? */
function sameProcess(pid: number, start: string): boolean {
  const f = statFields(pid);
  return !!f && f[19] === start && f[0] !== "Z";
}

/** `root` y todos sus descendientes vivos (pid → instante de arranque), leídos de /proc. */
export function processTree(root: number): Map<number, string> {
  const children = new Map<number, number[]>();
  const starts = new Map<number, string>();
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    entries = [];
  }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    const f = statFields(Number(d));
    if (!f || f[0] === "Z") continue;
    const pid = Number(d);
    const ppid = Number(f[1]);
    starts.set(pid, f[19]);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out = new Map<number, string>();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    const start = starts.get(pid);
    if (start === undefined || out.has(pid)) continue;
    out.set(pid, start);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}
