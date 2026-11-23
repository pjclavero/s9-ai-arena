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
 *  - Si `fsync`/`close` fallan tras escribir el pie, el fichero se deja SIN PIE (ftruncate; si no,
 *    pwrite sobre el pie; si no, se intenta borrar) y se aparta a `.failed`. Si TODO falla a la
 *    vez (fsync, ftruncate, pwrite, rename y unlink) el original puede conservar un pie válido con
 *    nombre `.part`: el escritor queda `failed` y el llamante NO debe publicar (sin `summary` de
 *    cierre). `publish*` con `requireProof` + `expectSha256` lo impide.
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
  S9rError,
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

/**
 * Marca de cierre correcto: sólo los `WriteSummary` que emite un escritor al cerrar bien están
 * en este WeakSet (congelados). Una copia, un objeto fabricado o un sha obtenido de otro modo
 * (p. ej. `verifyFile` sobre un parcial dañado) NO pasan `isIssuedSummary`.
 */
const ISSUED = new WeakSet<object>();
export function isIssuedSummary(x: unknown): x is WriteSummary {
  return typeof x === "object" && x !== null && ISSUED.has(x);
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
  /** Numeración de los `append` en orden de llamada (también los rechazados). */
  private seq = 0;
  /**
   * Primer `append` que se PERDIÓ (contrapresión, registro inválido, tick no entero): desde
   * ahí el fichero no puede sellarse como completo; sólo cabe `closeTruncated`. Los registros
   * aceptados antes de la pérdida se escriben (el resultado es un prefijo).
   */
  private lostFromSeq: number | null = null;
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
    const seq = this.seq++;
    if (this.lostFromSeq !== null) return Promise.reject(this.lossError());
    // Cualquier registro que no se pueda serializar (undefined, circular, BigInt, función…) es un
    // registro PERDIDO: mismo tratamiento que el resto de rechazos, y siempre una promesa rechazada.
    let line: string;
    try {
      const l = typeof record === "string" ? record : JSON.stringify(record);
      if (typeof l !== "string") throw new TypeError("el registro no es serializable a JSON");
      line = l;
    } catch (cause) {
      this.markLoss(seq);
      return Promise.reject(new InvalidRecordError("bad_record", "registro no serializable", { cause }));
    }
    // Cota de memoria aunque el llamador no espere cada append: la cola no crece sin límite.
    const bytes = Buffer.byteLength(line) + 1;
    if (this.queuedBytes + bytes > this.o.maxQueuedBytes) {
      // El registro se pierde: el fichero ya no puede sellarse como completo.
      this.markLoss(seq);
      return Promise.reject(
        new WriterStateError("backpressure", `cola interna llena (${this.queuedBytes} B): espera cada append`),
      );
    }
    this.queuedBytes += bytes;
    return this.enqueue(async () => {
      this.queuedBytes -= bytes;
      await this.appendInner(line, tick, seq);
    });
  }

  private markLoss(seq: number): void {
    if (this.lostFromSeq === null || seq < this.lostFromSeq) this.lostFromSeq = seq;
  }
  private lossError(): WriterStateError {
    return new WriterStateError(
      "records_dropped",
      "se rechazó al menos un registro: el fichero no puede sellarse como completo; sólo closeTruncated()",
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Una excepción inesperada dentro de una operación (no tipada) deja el escritor FALLIDO:
    // nunca se sigue como si nada con un estado interno dudoso.
    const guarded = async (): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof S9rError) throw e;
        const err = toStorageError(e, "internal");
        this.state = "failed";
        this.failure = err;
        this.lines = [];
        this.bufBytes = 0;
        throw err;
      }
    };
    const run = this.tail.then(guarded);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendInner(line: string, tick: number, seq: number): Promise<void> {
    this.assertOpen();
    this.assertNoLimit();
    // Tras una pérdida, los registros posteriores se rechazan para conservar el prefijo.
    if (this.lostFromSeq !== null && seq >= this.lostFromSeq) throw this.lossError();
    const reject = (e: InvalidRecordError): never => {
      this.markLoss(seq);
      throw e;
    };
    if (!Number.isSafeInteger(tick)) reject(new InvalidRecordError("bad_tick", `tick no entero: ${String(tick)}`));
    if (line.includes("\n"))
      reject(new InvalidRecordError("record_has_newline", "un registro no puede contener saltos de línea"));
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > this.o.maxRecordBytes)
      reject(new InvalidRecordError("record_too_large", `registro de ${bytes} B > ${this.o.maxRecordBytes}`));
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
    this.assertNoLimit();
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
  close(opts: { result?: Record<string, unknown> } = {}): Promise<WriteSummary> {
    return this.enqueue(async () => {
      this.assertOpen();
      this.assertOptions(opts);
      // La ÚNICA forma de marcar un fichero como truncado es `closeTruncated()`. Cualquier opción
      // `truncated` en `close()` se rechaza y el escritor queda sin sellar (sigue abierto).
      if ("truncated" in (opts as object)) {
        throw new WriterStateError("use_close_truncated", "close() no admite `truncated`: usa closeTruncated()");
      }
      // Tras un límite de bytes faltan registros: cerrar como «completo» sería mentir.
      this.assertNotLimited();
      await this.flushInner();
      // Sólo `closeTruncated()` puede sellar un fichero como truncado: no hay segunda vía.
      return this.finish({ result: opts.result, truncated: false });
    });
  }

  /** Opciones de cierre: un objeto (nada de null ni primitivos); error tipado, no TypeError. */
  private assertOptions(opts: unknown): void {
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
      throw new WriterStateError("bad_options", "las opciones de cierre deben ser un objeto");
    }
  }

  /** Falla si ya se superó el tope de bytes (no se puede escribir más). */
  private assertNoLimit(): void {
    if (this.limitHit) {
      throw new WriterStateError(
        "limit_hit",
        "se superó el tope de bytes y se perdieron registros: sólo se puede cerrar con closeTruncated()",
      );
    }
  }

  /** Falla si se perdió algún registro (tope o rechazo): impide sellar como completo. */
  private assertNotLimited(): void {
    if (this.lostFromSeq !== null) throw this.lossError();
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
      this.assertOptions(opts);
      // Se conserva el prefijo aceptado: lo pendiente en el búfer se vuelca salvo que el tope lo impida.
      if (!this.limitHit) {
        try {
          await this.flushInner();
        } catch (e) {
          if (!(e instanceof ReplayLimitExceededError)) throw e;
        }
      }
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
    // Desde aquí empieza el pie: si el fsync/close falla se recorta justo en este offset.
    this.footerOffset = this.offset;
    const footer = encodeFooter({
      flags: FLAG_COMPLETE | (opts.truncated ? FLAG_TRUNCATED : 0),
      indexOffset,
      indexLen: indexFrame.length,
      indexSha256: sha256(indexFrame),
    });
    await this.rawWrite(footer, "write_footer");
    // El pie ya está escrito: si el fsync/close falla, el fichero parecería completo sin serlo.
    // Se aparta (renombrado a `.failed`) para que no pueda publicarse ni verificarse con su nombre.
    try {
      await this.guard("fsync", () => this.file.sync());
      await this.guard("close", () => this.file.close());
    } catch (e) {
      await this.quarantine();
      throw e;
    }
    this.state = "closed";
    const summary: WriteSummary = Object.freeze({
      path: this.path,
      bytes: this.offset,
      sha256: this.fileHash.digest("hex"),
      chain: doc.chain,
      fragments: this.entries.filter((e) => e.type === FT.data).length,
      records: this.totalRecords,
      truncated: doc.truncated,
    });
    ISSUED.add(summary);
    return summary;
  }

  private failedPath: string | null = null;
  private footerOffset = -1;
  /**
   * El fsync/close falló con el pie ya escrito. La defensa está en el CONTENIDO, no en el nombre:
   *  1. ftruncate hasta el offset del pie -> el fichero queda SIN PIE (incompleto para cualquier lector);
   *  2. si no se puede, pwrite de ceros sobre el pie (magic invalidado);
   *  3. si tampoco, se intenta borrarlo.
   * Después se intenta apartarlo a `.failed` (y los lectores rechazan ese nombre).
   */
  private async quarantine(): Promise<void> {
    let invalid = false;
    if (this.footerOffset >= 0) {
      try {
        await this.file.truncate(this.footerOffset);
        invalid = true;
      } catch {
        try {
          await this.file.writeAt(Buffer.alloc(FOOTER_LEN), this.footerOffset);
          invalid = true;
        } catch {
          /* se intentará borrar */
        }
      }
      if (invalid) {
        try {
          await this.file.sync();
        } catch {
          /* best effort */
        }
      }
    }
    try {
      await this.file.close();
    } catch {
      /* puede estar ya cerrado o roto */
    }
    try {
      await this.fs.rename(this.path, this.path + ".failed");
      this.failedPath = this.path + ".failed";
    } catch {
      if (!invalid) {
        try {
          await this.fs.unlink(this.path);
        } catch {
          /* sin más recursos: abort() lo intentará de nuevo */
        }
      }
    }
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
    for (const f of [this.path, this.failedPath]) {
      if (f === null) continue;
      try {
        await this.fs.unlink(f);
      } catch {
        /* puede no existir */
      }
    }
  }

  /** Directorio del parcial (para `syncDir` tras publicar). */
  get dir(): string {
    return dirname(this.path);
  }
}
