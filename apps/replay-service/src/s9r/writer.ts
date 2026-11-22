/**
 * S9R/1 · Escritor de sólo adición con búfer acotado.
 *
 * Garantías:
 *  - Memoria: como mucho `fragmentBytes` + un registro (`maxRecordBytes`) sin comprimir,
 *    más un fragmento comprimiéndose. `append` es asíncrono y aplica contrapresión: nunca
 *    amplía el búfer si el disco no drena.
 *  - Tope de bytes: se comprueba ANTES de escribir cada fragmento (clase A,
 *    `ReplayLimitExceededError`, no envenena el escritor: el llamador puede cerrar
 *    como truncado usando `emergencyBytes`).
 *  - Fallos de disco (ENOSPC/EIO/otros): `StorageError` tipado; el escritor queda
 *    envenenado y no acepta más datos (clase B).
 *  - El sha256 del fichero entero se calcula mientras se escribe.
 */
import { createHash, type Hash } from "node:crypto";
import { dirname } from "node:path";
import { crc32, compress, sha256, PREFERRED_ALGO, type Algo } from "./codec.js";
import {
  FLAG_COMPLETE,
  FLAG_TRUNCATED,
  FT,
  MAX_RAW_FRAGMENT_BYTES,
  encodeFooter,
  encodeFrameHeader,
  encodePreamble,
  FOOTER_LEN,
  FRAME_HEADER_LEN,
  PREAMBLE_LEN,
  type FragmentEntry,
  type IndexDoc,
  type Kind,
} from "./format.js";
import {
  InvalidRecordError,
  ReplayLimitExceededError,
  StorageError,
  WriterStateError,
  toStorageError,
} from "./errors.js";
import { nodeFs, type S9rFile, type S9rFs } from "./io.js";

export interface WriterOptions {
  kind: Kind;
  /** Cabecera del replay (JSON). Lleva battleId, semilla y versiones: la cadena se ata a ella. */
  header: Record<string, unknown>;
  /** Tope de bytes del fichero (sin contar `emergencyBytes`). */
  maxBytes: number;
  /** Bytes sin comprimir que cierran un fragmento. Por defecto 1 MiB. */
  fragmentBytes?: number;
  /** Tamaño máximo de un registro. Por defecto 256 KiB. */
  maxRecordBytes?: number;
  /** Margen extra sólo para resultado, índice y pie al cerrar. Por defecto 64 KiB. */
  emergencyBytes?: number;
  /** Bytes de registros pendientes en la cola interna si el llamador no espera `append`. Defecto 4 x fragmentBytes. */
  maxQueuedBytes?: number;
  algo?: Algo;
  fs?: S9rFs;
}

export interface WriteSummary {
  path: string;
  bytes: number;
  /** sha256 hex del fichero entero. */
  sha256: string;
  chain: string;
  fragments: number;
  records: number;
  truncated: boolean;
}

export class S9rWriter {
  private lines: string[] = [];
  private bufBytes = 0;
  private bufRecords = 0;
  private firstTick: number | null = null;
  private lastTick: number | null = null;
  private offset = 0;
  private entries: FragmentEntry[] = [];
  private chain: Buffer;
  private fileHash: Hash = createHash("sha256");
  private state: "open" | "closed" | "aborted" | "failed" = "open";
  private failure: StorageError | null = null;
  private totalRecords = 0;
  private totalRaw = 0;
  private resultWritten = false;
  /** Cola interna: las operaciones se ejecutan de una en una y en orden de llamada. */
  private tail: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  /** Se activó el tope de bytes: faltan registros, sólo se puede cerrar con `closeTruncated`. */
  private limitHit = false;
  /** Pico observado del búfer sin comprimir (para métricas y tests). */
  peakBufferBytes = 0;

  private constructor(
    readonly path: string,
    private readonly file: S9rFile,
    private readonly fs: S9rFs,
    private readonly o: Required<Omit<WriterOptions, "fs" | "header">>,
    private readonly headerFrameLen: number,
    chain0: Buffer,
  ) {
    this.chain = chain0;
  }

  static async create(path: string, opts: WriterOptions): Promise<S9rWriter> {
    const fs = opts.fs ?? nodeFs;
    const fragmentBytes = opts.fragmentBytes ?? 1024 * 1024;
    const o = {
      kind: opts.kind,
      maxBytes: opts.maxBytes,
      fragmentBytes,
      maxRecordBytes: opts.maxRecordBytes ?? 256 * 1024,
      emergencyBytes: opts.emergencyBytes ?? 64 * 1024,
      maxQueuedBytes: opts.maxQueuedBytes ?? 4 * fragmentBytes,
      algo: opts.algo ?? PREFERRED_ALGO,
    };
    // Un fragmento sin comprimir nunca supera esto: el lector lo usa como tope de descompresión.
    if (o.fragmentBytes + o.maxRecordBytes > MAX_RAW_FRAGMENT_BYTES) {
      throw new RangeError(`fragmentBytes + maxRecordBytes debe ser <= ${MAX_RAW_FRAGMENT_BYTES}`);
    }
    const comp = await compress(o.algo, Buffer.from(JSON.stringify(opts.header)));
    const frame = Buffer.concat([encodeFrameHeader(FT.header, comp.length, crc32(comp)), comp]);
    const pre = encodePreamble(o.kind, o.algo);
    if (PREAMBLE_LEN + frame.length > o.maxBytes)
      throw new ReplayLimitExceededError(o.maxBytes, PREAMBLE_LEN + frame.length);
    let file: S9rFile;
    try {
      file = await fs.create(path);
    } catch (e) {
      throw toStorageError(e, "create");
    }
    const w = new S9rWriter(path, file, fs, o, frame.length, sha256(frame));
    await w.rawWrite(pre, "write_preamble");
    await w.rawWrite(frame, "write_header");
    return w;
  }

  /** Bytes escritos hasta ahora (sin índice ni pie todavía). */
  get bytesWritten(): number {
    return this.offset;
  }
  /** Bytes sin comprimir pendientes en el búfer. */
  get bufferedBytes(): number {
    return this.bufBytes;
  }

  private assertOpen(): void {
    if (this.state === "failed") throw this.failure!;
    if (this.state !== "open") throw new WriterStateError("writer_closed", `escritor en estado ${this.state}`);
  }

  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = toStorageError(e, op);
      this.state = "failed";
      this.failure = err;
      this.lines = [];
      this.bufBytes = 0;
      throw err;
    }
  }

  private async rawWrite(buf: Buffer, op: string): Promise<void> {
    await this.guard(op, () => this.file.write(buf));
    this.fileHash.update(buf);
    this.offset += buf.length;
  }

  /** Añade un registro (una línea JSON ya serializada o un objeto). Con contrapresión. */
  append(record: string | object, tick: number): Promise<void> {
    const line = typeof record === "string" ? record : JSON.stringify(record);
    // Cota de memoria aunque el llamador no espere cada append: la cola no crece sin límite.
    const bytes = Buffer.byteLength(line) + 1;
    if (this.queuedBytes + bytes > this.o.maxQueuedBytes) {
      return Promise.reject(
        new WriterStateError("backpressure", `cola interna llena (${this.queuedBytes} B): espera cada append`),
      );
    }
    this.queuedBytes += bytes;
    return this.enqueue(async () => {
      this.queuedBytes -= bytes;
      await this.appendInner(line, tick);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendInner(line: string, tick: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(tick)) throw new InvalidRecordError("bad_tick", `tick no entero: ${String(tick)}`);
    this.assertNotLimited();
    if (line.includes("\n"))
      throw new InvalidRecordError("record_has_newline", "un registro no puede contener saltos de línea");
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > this.o.maxRecordBytes)
      throw new InvalidRecordError("record_too_large", `registro de ${bytes} B > ${this.o.maxRecordBytes}`);
    this.lines.push(line);
    this.bufBytes += bytes;
    this.bufRecords++;
    if (this.firstTick === null) this.firstTick = tick;
    this.lastTick = tick;
    if (this.bufBytes > this.peakBufferBytes) this.peakBufferBytes = this.bufBytes;
    if (this.bufBytes >= this.o.fragmentBytes) await this.flushInner();
  }

  /** Cierra el fragmento en curso (útil para alinear fronteras con checkpoints). */
  flushFragment(): Promise<void> {
    return this.enqueue(() => this.flushInner());
  }

  private async flushInner(): Promise<void> {
    this.assertOpen();
    this.assertNotLimited();
    if (this.bufRecords === 0) return;
    const raw = Buffer.from(this.lines.join("\n") + "\n");
    const meta = { firstTick: this.firstTick, lastTick: this.lastTick, records: this.bufRecords };
    // El búfer se vacía antes de comprimir: la memoria retenida es un solo fragmento.
    this.lines = [];
    this.bufBytes = 0;
    this.bufRecords = 0;
    this.firstTick = null;
    this.lastTick = null;
    await this.writeFrame(FT.data, raw, meta, this.o.maxBytes);
    this.totalRecords += meta.records;
  }

  private async writeFrame(
    type: number,
    raw: Buffer,
    meta: { firstTick: number | null; lastTick: number | null; records: number },
    limit: number,
  ): Promise<void> {
    const comp = await this.guard("compress", () => compress(this.o.algo, raw));
    const frameLen = FRAME_HEADER_LEN + comp.length;
    // Tope comprobado en CADA fragmento, antes de escribir.
    if (this.offset + frameLen > limit) {
      this.limitHit = true;
      throw new ReplayLimitExceededError(limit, this.offset + frameLen);
    }
    const frameStart = this.offset;
    await this.rawWrite(Buffer.concat([encodeFrameHeader(type, comp.length, crc32(comp)), comp]), "write_fragment");
    const sha = sha256(comp);
    this.entries.push({
      type,
      offset: frameStart,
      frameLen,
      rawLen: raw.length,
      sha256: sha.toString("hex"),
      firstTick: meta.firstTick,
      lastTick: meta.lastTick,
      records: meta.records,
    });
    this.chain = sha256(this.chain, sha);
    this.totalRaw += raw.length;
  }

  /**
   * Cierra: vuelca el búfer, escribe resultado (opcional), índice y pie, `fsync` y cierra.
   * Resultado, índice y pie pueden usar `emergencyBytes` por encima de `maxBytes`.
   * Si el volcado del último fragmento excede el tope, lanza `ReplayLimitExceededError`
   * y el escritor sigue abierto: el llamador decide (p. ej. `closeTruncated`).
   */
  close(opts: { result?: Record<string, unknown>; truncated?: boolean } = {}): Promise<WriteSummary> {
    return this.enqueue(async () => {
      this.assertOpen();
      // Tras un límite de bytes faltan registros: cerrar como «completo» sería mentir.
      this.assertNotLimited();
      await this.flushInner();
      return this.finish(opts);
    });
  }

  private assertNotLimited(): void {
    if (this.limitHit) {
      throw new WriterStateError(
        "limit_hit",
        "se superó el tope de bytes y se perdieron registros: sólo se puede cerrar con closeTruncated()",
      );
    }
  }

  /** Cierra como truncado descartando el búfer pendiente (tras un límite de clase A). */
  closeTruncated(opts: { result?: Record<string, unknown> } = {}): Promise<WriteSummary> {
    return this.enqueue(async () => {
      this.assertOpen();
      this.lines = [];
      this.bufBytes = 0;
      this.bufRecords = 0;
      return this.finish({ ...opts, truncated: true });
    });
  }

  private async finish(opts: { result?: Record<string, unknown>; truncated?: boolean }): Promise<WriteSummary> {
    const hardLimit = this.o.maxBytes + this.o.emergencyBytes;
    if (opts.result && !this.resultWritten) {
      await this.writeFrame(
        FT.result,
        Buffer.from(JSON.stringify(opts.result)),
        { firstTick: null, lastTick: null, records: 0 },
        hardLimit,
      );
      this.resultWritten = true;
    }
    const doc: IndexDoc = {
      formatVersion: 1,
      kind: this.o.kind,
      algo: this.o.algo,
      headerFrameLen: this.headerFrameLen,
      fragments: this.entries,
      chain: this.chain.toString("hex"),
      records: this.totalRecords,
      rawBytes: this.totalRaw,
      truncated: !!opts.truncated,
    };
    const comp = await this.guard("compress", () => compress(this.o.algo, Buffer.from(JSON.stringify(doc))));
    const indexFrame = Buffer.concat([encodeFrameHeader(FT.index, comp.length, crc32(comp)), comp]);
    if (this.offset + indexFrame.length + FOOTER_LEN > hardLimit) {
      this.limitHit = true;
      throw new ReplayLimitExceededError(hardLimit, this.offset + indexFrame.length + FOOTER_LEN);
    }
    const indexOffset = this.offset;
    await this.rawWrite(indexFrame, "write_index");
    const footer = encodeFooter({
      flags: FLAG_COMPLETE | (opts.truncated ? FLAG_TRUNCATED : 0),
      indexOffset,
      indexLen: indexFrame.length,
      indexSha256: sha256(indexFrame),
    });
    await this.rawWrite(footer, "write_footer");
    await this.guard("fsync", () => this.file.sync());
    await this.guard("close", () => this.file.close());
    this.state = "closed";
    return {
      path: this.path,
      bytes: this.offset,
      sha256: this.fileHash.digest("hex"),
      chain: doc.chain,
      fragments: this.entries.filter((e) => e.type === FT.data).length,
      records: this.totalRecords,
      truncated: doc.truncated,
    };
  }

  /** Descarta: cierra el descriptor y borra el parcial. Idempotente, nunca lanza. */
  async abort(): Promise<void> {
    if (this.state === "closed" || this.state === "aborted") return;
    this.state = "aborted";
    this.lines = [];
    this.bufBytes = 0;
    try {
      await this.file.close();
    } catch {
      /* ya puede estar cerrado o roto */
    }
    try {
      await this.fs.unlink(this.path);
    } catch {
      /* puede no existir */
    }
  }

  /** Directorio del parcial (para `syncDir` tras publicar). */
  get dir(): string {
    return dirname(this.path);
  }
}
