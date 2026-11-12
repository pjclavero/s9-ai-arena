/**
 * DIAG · Tap PASIVO de la señal de ingesta (sólo diagnóstico, OFF por defecto).
 *
 * Para qué: demostrar QUÉ fotograma estaba enviando S9 de verdad hacia la ingesta
 * sin depender del framebuffer de Chromium (el Xvfb puede no coincidir con lo que
 * codificó ffmpeg y salió por el relé).
 *
 * De dónde copia: del MISMO flujo FLV que ffmpeg escribe por el fd 3 y que recibe
 * el relé (`RtmpPublisher.writeFlv`), ANTES del TLS. El supervisor le entrega cada
 * trozo DESPUÉS de habérselo dado al relé y sin mirar lo que devuelve el tap.
 *
 * Garantías (cada una con su prueba y su mutante, ver stream-tap.test.ts):
 *  - OFF por defecto: sólo con `STREAM_TAP_ENABLED=true` existe el objeto.
 *  - NO modifica la señal: nunca escribe en el trozo que recibe (sólo lee y COPIA
 *    lo que guarda), `observe()` no devuelve nada que el supervisor use y nunca
 *    lanza (todo error lo desactiva a él, no al relé).
 *  - NUNCA aplica backpressure: la escritura en disco es asíncrona, como mucho UNA
 *    en vuelo; si el disco va lento o se cuelga, las capturas siguientes se
 *    DESCARTAN (`dropped`) del lado del tap. Memoria acotada: sólo guarda la última
 *    secuencia AVC, el último onMetaData y el último keyframe (cada uno con tope).
 *  - Sin segunda codificación: no decodifica ni codifica nada en continuo. Guarda
 *    el keyframe H.264 tal cual llegó (más la secuencia AVC) como un .flv mínimo
 *    decodificable. Pasarlo a JPG es una decodificación PUNTUAL a demanda
 *    (`decodeTapJpeg`, un ffmpeg de un fotograma) fuera del camino de emisión.
 *  - Sin secretos: el tap no recibe la clave (no está en el flujo FLV: ffmpeg no la
 *    conoce) y sus nombres de fichero, metadatos y logs sólo llevan contadores,
 *    tiempos y tamaños.
 *  - Almacenamiento limitado y rotado: como mucho `maxFiles` capturas y `maxBytes`
 *    en total; se borran las más antiguas (sólo ficheros con el nombre del tap).
 */
import { spawn } from "node:child_process";
import { promises as fsp, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TapConfig {
  enabled: boolean;
  /** Directorio de las capturas (volumen del streamer o tmpfs). */
  dir: string;
  /** Cada cuánto se escribe la última captura (si hay un keyframe nuevo). */
  intervalMs: number;
  /** Máximo de capturas conservadas. */
  maxFiles: number;
  /** Máximo de bytes en total (flv + json). */
  maxBytes: number;
}

export const TAP_DEFAULTS: TapConfig = {
  enabled: false,
  dir: "/tmp/s9-stream-tap",
  intervalMs: 10_000,
  maxFiles: 10,
  maxBytes: 32 * 1024 * 1024,
};

/** Tope de una etiqueta que el tap copia: lo que pase de aquí no se guarda (se salta). */
export const TAP_MAX_TAG_BYTES = 8 * 1024 * 1024;
/** Tope del onMetaData guardado. */
const TAP_MAX_META_BYTES = 64 * 1024;

/** Nombre de una captura: sólo secuencia y fecha (nunca datos del destino). */
export const TAP_FILE = /^tap-\d{8}-\d{8}T\d{6}Z\.(flv|json)$/;
export const TAP_LATEST = "latest.json";

function boundedInt(v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Lee la configuración del tap. Sólo `STREAM_TAP_ENABLED=true` (o `1`) lo enciende. */
export function loadTapConfig(env: Record<string, string | undefined>): TapConfig {
  const flag = (env.STREAM_TAP_ENABLED ?? "").trim().toLowerCase();
  return {
    enabled: flag === "true" || flag === "1",
    dir: env.STREAM_TAP_DIR?.trim() || TAP_DEFAULTS.dir,
    intervalMs: boundedInt(env.STREAM_TAP_INTERVAL_SEC, TAP_DEFAULTS.intervalMs / 1000, 1, 3600) * 1000,
    maxFiles: boundedInt(env.STREAM_TAP_MAX_FILES, TAP_DEFAULTS.maxFiles, 1, 200),
    maxBytes: boundedInt(env.STREAM_TAP_MAX_MB, TAP_DEFAULTS.maxBytes / (1024 * 1024), 1, 512) * 1024 * 1024,
  };
}

/**
 * Crea el tap SÓLO si está encendido. Apagado (por defecto) devuelve `null`: no
 * existe objeto, ni temporizador, ni directorio, ni coste en el camino de emisión.
 */
export function createTapFromEnv(
  env: Record<string, string | undefined>,
  log?: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void,
): IngestTap | null {
  const config = loadTapConfig(env);
  if (!config.enabled) return null;
  return new IngestTap(config, { log });
}

/** Metadatos de una captura (sidecar `.json` y respuesta del endpoint). */
export interface TapCapture {
  seq: number;
  /** Fichero .flv (sólo el nombre). */
  file: string;
  /** Instante (reloj de pared) en que el keyframe pasó por el tap = por el relé. */
  capturedAt: string;
  writtenAt: string;
  /** Sello FLV del keyframe (DTS, ms del flujo). */
  flvTimestampMs: number;
  /** cts del NALU AVC (ms). */
  compositionTimeMs: number;
  /** PTS del fotograma en el flujo = DTS + cts (ms). */
  ptsMs: number;
  keyframeBytes: number;
  fileBytes: number;
  /** Número de flujo FLV (cada lanzamiento de ffmpeg empieza uno nuevo). */
  stream: number;
  /** Bytes del flujo vistos por el tap ANTES del trozo que completó el keyframe (posición aproximada). */
  streamOffset: number;
  hasAvcSequenceHeader: boolean;
}

export interface TapStats {
  enabled: boolean;
  streams: number;
  chunks: number;
  bytesSeen: number;
  keyframes: number;
  written: number;
  /** Capturas descartadas porque había una escritura en vuelo (disco lento o colgado). */
  dropped: number;
  writeErrors: number;
  /** El tap dejó de analizar el flujo actual (FLV ilegible para él); el relé no se entera. */
  parserDisabled: boolean;
  rotatedFiles: number;
}

/** Escritura inyectable (pruebas: disco lento, colgado o roto). */
export interface TapFs {
  writeFile(path: string, data: Buffer | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const realFs: TapFs = {
  writeFile: (p, d) => fsp.writeFile(p, d, { mode: 0o640 }),
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
};

interface StoredTag {
  bytes: Buffer; // etiqueta completa (11 de cabecera + cuerpo), COPIA propia
  dts: number;
  cts: number;
  at: number;
  offset: number;
}

type Phase = "flvHeader" | "tagHeader" | "body";

/**
 * Lector FLV del tap: incremental, sin concatenar el flujo. Sólo COPIA las
 * etiquetas que le interesan (onMetaData, secuencia AVC y keyframes AVC); el resto
 * lo salta contando bytes.
 */
export class IngestTap {
  private phase: Phase = "flvHeader";
  private head: Buffer[] = [];
  private headLen = 0;
  private need = 13; // cabecera FLV (9) + PreviousTagSize0 (4); se ajusta al leerla
  private tagType = 0;
  private tagSize = 0;
  private tagDts = 0;
  private bodyLeft = 0; // bytes del cuerpo + PreviousTagSize que faltan
  private keep: Buffer[] | null = null;
  private keepHeader: Buffer | null = null;
  private keepKind: "meta" | "seq" | "key" | null = null;
  private keepCts = 0;
  private disabled = false;

  private meta: Buffer | null = null;
  private seq: Buffer | null = null;
  private lastKey: StoredTag | null = null;
  private lastKeySeq = 0;
  private writtenKeySeq = 0;
  private writing = false;
  private inflight: Promise<void> | null = null;
  private nextSeq = 1;
  private files: { name: string; bytes: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private latest_: TapCapture | null = null;
  private readonly fs: TapFs;
  readonly stats: TapStats;

  constructor(
    readonly config: TapConfig,
    private readonly deps: {
      fs?: TapFs;
      now?: () => number;
      log?: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.fs = deps.fs ?? realFs;
    this.stats = {
      enabled: config.enabled,
      streams: 0,
      chunks: 0,
      bytesSeen: 0,
      keyframes: 0,
      written: 0,
      dropped: 0,
      writeErrors: 0,
      parserDisabled: false,
      rotatedFiles: 0,
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Prepara el directorio, recoge las capturas previas (la rotación las incluye) y arma el temporizador. */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    try {
      mkdirSync(this.config.dir, { recursive: true, mode: 0o750 });
      const names = readdirSync(this.config.dir)
        .filter((n) => TAP_FILE.test(n))
        .sort();
      for (const name of names) {
        try {
          const st = lstatSync(join(this.config.dir, name));
          if (!st.isFile()) continue;
          this.files.push({ name, bytes: st.size });
          const m = /^tap-(\d{8})-/.exec(name);
          if (m) this.nextSeq = Math.max(this.nextSeq, Number(m[1]) + 1);
        } catch {
          /* desapareció entre readdir y lstat */
        }
      }
    } catch (e) {
      this.deps.log?.("warn", "tap de ingesta: directorio no utilizable; no se guardarán capturas", {
        reason: (e as NodeJS.ErrnoException)?.code ?? "error",
      });
    }
    this.timer = setInterval(() => this.flush(), this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un lanzamiento nuevo de ffmpeg empieza un flujo FLV nuevo (cabecera incluida). */
  beginStream(): void {
    this.phase = "flvHeader";
    this.head = [];
    this.headLen = 0;
    this.need = 13;
    this.keep = null;
    this.keepHeader = null;
    this.keepKind = null;
    this.bodyLeft = 0;
    this.disabled = false;
    this.stats.parserDisabled = false;
    this.meta = null;
    this.seq = null;
    this.stats.streams++;
  }

  get latest(): TapCapture | null {
    return this.latest_;
  }

  /**
   * Observa un trozo del flujo FLV que YA recibió el relé. Sólo lee `chunk`; lo que
   * guarda lo copia. Nunca lanza y no devuelve nada: no puede frenar ni alterar al relé.
   */
  observe(chunk: Buffer): void {
    if (!this.config.enabled || this.disabled) return;
    try {
      this.stats.chunks++;
      this.consume(chunk);
      this.stats.bytesSeen += chunk.length;
    } catch {
      // Cualquier sorpresa del análisis apaga el tap para ESTE flujo; el relé sigue igual.
      this.disabled = true;
      this.stats.parserDisabled = true;
      this.keep = null;
      this.head = [];
    }
  }

  private takeHead(chunk: Buffer, pos: number): number {
    const want = this.need - this.headLen;
    const n = Math.min(want, chunk.length - pos);
    if (n > 0) {
      this.head.push(chunk.subarray(pos, pos + n));
      this.headLen += n;
    }
    return pos + n;
  }

  private headBuf(): Buffer {
    // Copia (≤ 32 bytes): nunca se conserva una vista del trozo del relé.
    const b = Buffer.concat(this.head, this.headLen);
    this.head = [];
    this.headLen = 0;
    return b;
  }

  private consume(chunk: Buffer): void {
    let pos = 0;
    while (pos < chunk.length) {
      if (this.phase === "flvHeader") {
        pos = this.takeHead(chunk, pos);
        if (this.headLen < this.need) return;
        const h = this.headBuf();
        if (h.toString("latin1", 0, 3) !== "FLV") throw new Error("no FLV");
        const headerSize = h.readUInt32BE(5);
        if (headerSize < 9 || headerSize > 1024) throw new Error("cabecera FLV");
        // Bytes de cabecera extendida + PreviousTagSize0 que aún faltan: se saltan.
        this.bodyLeft = headerSize + 4 - 13;
        this.keep = null;
        this.keepKind = null;
        this.phase = this.bodyLeft > 0 ? "body" : "tagHeader";
        this.need = 11;
        continue;
      }
      if (this.phase === "tagHeader") {
        pos = this.takeHead(chunk, pos);
        if (this.headLen < this.need) return;
        if (this.need === 11) {
          // Cabecera de etiqueta leída: en vídeo hace falta mirar 5 bytes del cuerpo.
          const h = Buffer.concat(this.head, this.headLen);
          this.tagType = h[0] & 0x1f;
          this.tagSize = h.readUIntBE(1, 3);
          this.tagDts = (h.readUIntBE(4, 3) | (h[7] << 24)) >>> 0;
          if (this.tagType === 9 && this.tagSize >= 5) {
            this.need = 16;
            continue;
          }
        }
        const h = this.headBuf();
        this.need = 11;
        this.startBody(h);
        continue;
      }
      // body
      const n = Math.min(this.bodyLeft, chunk.length - pos);
      if (this.keep && n > 0) this.keep.push(Buffer.from(chunk.subarray(pos, pos + n))); // COPIA
      this.bodyLeft -= n;
      pos += n;
      if (this.bodyLeft === 0) {
        this.finishBody();
        this.phase = "tagHeader";
      }
    }
  }

  private startBody(h: Buffer): void {
    const peeked = h.length - 11; // 0 o 5 bytes del cuerpo ya leídos
    let kind: "meta" | "seq" | "key" | null = null;
    if (this.tagType === 18 && this.tagSize <= TAP_MAX_META_BYTES) kind = "meta";
    else if (this.tagType === 9 && peeked === 5) {
      const frameType = h[11] >> 4;
      const codec = h[11] & 0x0f;
      const pkt = h[12];
      if (codec === 7 && pkt === 0) kind = "seq";
      else if (codec === 7 && pkt === 1 && frameType === 1) {
        kind = "key";
        this.keepCts = (((h[13] << 16) | (h[14] << 8) | h[15]) << 8) >> 8; // SI24
      }
    }
    if (kind && this.tagSize > TAP_MAX_TAG_BYTES) kind = null; // demasiado grande: se salta, no se guarda
    this.keepKind = kind;
    this.keepHeader = kind ? h : null;
    this.keep = kind ? [] : null;
    // Resto del cuerpo (sin lo ya leído) + PreviousTagSize (4).
    this.bodyLeft = this.tagSize - peeked + 4;
    if (this.bodyLeft < 4) throw new Error("etiqueta FLV corta");
  }

  private finishBody(): void {
    const kind = this.keepKind;
    const parts = this.keep;
    const header = this.keepHeader;
    this.keep = null;
    this.keepHeader = null;
    this.keepKind = null;
    if (!kind || !parts || !header) return;
    // Etiqueta = cabecera (11) + cuerpo (tagSize); se quita el PreviousTagSize.
    const full = Buffer.concat([header, ...parts]);
    const tag = full.subarray(0, 11 + this.tagSize);
    if (kind === "meta") this.meta = Buffer.from(tag);
    else if (kind === "seq") this.seq = Buffer.from(tag);
    else {
      this.stats.keyframes++;
      this.lastKeySeq++;
      this.lastKey = {
        bytes: Buffer.from(tag),
        dts: this.tagDts,
        cts: this.keepCts,
        at: this.now(),
        offset: this.stats.bytesSeen,
      };
    }
  }

  /**
   * Escribe la última captura si hay un keyframe nuevo. Como mucho UNA escritura en
   * vuelo: si la anterior no ha terminado (disco lento o colgado) se descarta esta.
   */
  flush(): void {
    if (!this.config.enabled || !this.lastKey || this.lastKeySeq === this.writtenKeySeq) return;
    if (this.writing) {
      this.stats.dropped++;
      return;
    }
    const key = this.lastKey;
    const keySeq = this.lastKeySeq;
    const flv = buildMiniFlv(this.meta, this.seq, key.bytes);
    const seq = this.nextSeq++;
    const stamp = new Date(this.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const base = `tap-${String(seq).padStart(8, "0")}-${stamp}`;
    const capture: TapCapture = {
      seq,
      file: `${base}.flv`,
      capturedAt: new Date(key.at).toISOString(),
      writtenAt: new Date(this.now()).toISOString(),
      flvTimestampMs: key.dts,
      compositionTimeMs: key.cts,
      ptsMs: key.dts + key.cts,
      keyframeBytes: key.bytes.length - 11,
      fileBytes: flv.length,
      stream: this.stats.streams,
      streamOffset: key.offset,
      hasAvcSequenceHeader: !!this.seq,
    };
    const json = `${JSON.stringify(capture)}\n`;
    this.writing = true;
    this.writtenKeySeq = keySeq;
    this.inflight = this.write(base, flv, capture, json).finally(() => {
      this.writing = false;
      this.inflight = null;
    });
  }

  /** Espera a que termine la escritura en vuelo (pruebas y parada ordenada). */
  async whenIdle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  private async write(base: string, flv: Buffer, capture: TapCapture, json: string): Promise<void> {
    const dir = this.config.dir;
    try {
      await this.fs.writeFile(join(dir, `${base}.flv.tmp`), flv);
      await this.fs.rename(join(dir, `${base}.flv.tmp`), join(dir, `${base}.flv`));
      await this.fs.writeFile(join(dir, `${base}.json`), json);
      this.files.push(
        { name: `${base}.flv`, bytes: flv.length },
        { name: `${base}.json`, bytes: Buffer.byteLength(json) },
      );
      await this.fs.writeFile(join(dir, `${TAP_LATEST}.tmp`), json);
      await this.fs.rename(join(dir, `${TAP_LATEST}.tmp`), join(dir, TAP_LATEST));
      this.latest_ = capture;
      this.stats.written++;
      await this.rotate();
    } catch (e) {
      this.stats.writeErrors++;
      if (this.stats.writeErrors <= 3 || this.stats.writeErrors % 100 === 0) {
        this.deps.log?.("warn", "tap de ingesta: no se pudo guardar la captura (se descarta)", {
          reason: (e as NodeJS.ErrnoException)?.code ?? "error",
          writeErrors: this.stats.writeErrors,
        });
      }
    }
  }

  /** Borra las capturas más antiguas hasta cumplir `maxFiles` (capturas) y `maxBytes`. */
  private async rotate(): Promise<void> {
    const captures = (): string[] => [...new Set(this.files.map((f) => f.name.replace(/\.(flv|json)$/, "")))];
    const total = () => this.files.reduce((a, f) => a + f.bytes, 0);
    let list = captures().sort();
    while (list.length > 1 && (list.length > this.config.maxFiles || total() > this.config.maxBytes)) {
      const victim = list[0];
      for (const ext of ["flv", "json"]) {
        const name = `${victim}.${ext}`;
        if (!TAP_FILE.test(name)) continue;
        try {
          await this.fs.unlink(join(this.config.dir, name));
        } catch {
          /* ya no estaba */
        }
        this.stats.rotatedFiles++;
      }
      this.files = this.files.filter((f) => !f.name.startsWith(`${victim}.`));
      list = captures().sort();
    }
  }
}

/** FLV mínimo decodificable: cabecera + [onMetaData] + secuencia AVC + keyframe, todo con sello 0. */
export function buildMiniFlv(meta: Buffer | null, seq: Buffer | null, key: Buffer): Buffer {
  const header = Buffer.from([0x46, 0x4c, 0x56, 1, 0x01, 0, 0, 0, 9, 0, 0, 0, 0]); // FLV v1, sólo vídeo
  const parts: Buffer[] = [header];
  for (const t of [meta, seq, key]) {
    if (!t) continue;
    const c = Buffer.from(t); // copia: se reescribe el sello
    c.writeUIntBE(0, 4, 3);
    c[7] = 0;
    const prev = Buffer.alloc(4);
    prev.writeUInt32BE(c.length, 0);
    parts.push(c, prev);
  }
  return Buffer.concat(parts);
}

/** Lee la última captura del directorio (sin el objeto vivo: sirve tras un reinicio). */
export function readLatestCapture(dir: string): { capture: TapCapture; flvPath: string } | null {
  try {
    const capture = JSON.parse(readFileSync(join(dir, TAP_LATEST), "utf8")) as TapCapture;
    if (!capture || typeof capture.file !== "string" || !TAP_FILE.test(capture.file)) return null;
    const flvPath = join(dir, capture.file);
    if (!lstatSync(flvPath).isFile()) return null;
    return { capture, flvPath };
  } catch {
    return null;
  }
}

/**
 * Decodificación PUNTUAL de UNA captura a JPG (a demanda; nunca en continuo ni en
 * el camino de emisión). Un ffmpeg de un fotograma, un hilo y con plazo.
 */
export function decodeTapJpeg(ffmpegBin: string, flvPath: string, timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-i",
        flvPath,
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGKILL");
      else out.push(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && size > 0) resolve(Buffer.concat(out));
      else reject(new Error(`decodificación fallida (código ${String(code)})`));
    });
  });
}
