/**
 * S9R/1 · Lector por cursor y por fragmento. Nunca carga el fichero entero:
 * pie (64 B) + índice + cabecera al abrir; después, un `pread` por fragmento pedido.
 */
import { crc32, decompress, sha256, type Algo } from "./codec.js";
import {
  FOOTER_LEN,
  FRAME_HEADER_LEN,
  FT,
  FLAG_TRUNCATED,
  MAX_FRAME_BYTES,
  PREAMBLE_LEN,
  decodeFooter,
  decodeFrameHeader,
  decodePreamble,
  type FragmentEntry,
  type IndexDoc,
  type Kind,
} from "./format.js";
import { CorruptReplayError, IncompleteReplayError, S9rError, StorageError, toStorageError, UnsupportedFormatError } from "./errors.js";
import { nodeFs, type S9rFile, type S9rFs } from "./io.js";

export interface OpenOptions {
  fs?: S9rFs;
  /** Si se indica, la cabecera debe llevar este battleId. */
  expectBattleId?: string;
}

/** Calcula la cadena de integridad a partir de la cabecera y los sha de los fragmentos. */
export function computeChain(headerFrame: Buffer, shas: string[]): string {
  let chain = sha256(headerFrame);
  for (const s of shas) chain = sha256(chain, Buffer.from(s, "hex"));
  return chain.toString("hex");
}

export class S9rReader {
  /** Número de lecturas de fragmento (para comprobar que no se carga de más). */
  fragmentReads = 0;

  private constructor(
    private readonly file: S9rFile,
    readonly size: number,
    readonly kind: Kind,
    readonly algo: Algo,
    readonly index: IndexDoc,
    readonly header: Record<string, unknown>,
    readonly truncated: boolean,
  ) {}

  static async open(path: string, opts: OpenOptions = {}): Promise<S9rReader> {
    const fs = opts.fs ?? nodeFs;
    let file: S9rFile;
    try {
      file = await fs.openRead(path);
    } catch (e) {
      throw toStorageError(e, "open");
    }
    try {
      return await S9rReader.parse(file, opts);
    } catch (e) {
      await file.close().catch(() => undefined);
      throw e;
    }
  }

  private static async parse(file: S9rFile, opts: OpenOptions): Promise<S9rReader> {
    const size = await file.size();
    if (size < PREAMBLE_LEN + FRAME_HEADER_LEN + FOOTER_LEN) throw new IncompleteReplayError("too_short", "fichero demasiado corto: parcial");
    const footer = decodeFooter(await readExact(file, size - FOOTER_LEN, FOOTER_LEN));
    if (footer.indexOffset + footer.indexLen + FOOTER_LEN !== size || footer.indexLen < FRAME_HEADER_LEN) {
      throw new CorruptReplayError("bad_footer_geometry", "el índice no cuadra con el tamaño del fichero");
    }
    const { kind, algo } = decodePreamble(await readExact(file, 0, PREAMBLE_LEN));
    const indexFrame = await readExact(file, footer.indexOffset, footer.indexLen);
    if (!sha256(indexFrame).equals(footer.indexSha256)) throw new CorruptReplayError("index_sha_mismatch", "sha256 del índice distinto del pie");
    const index = JSON.parse((await decodeFrame(indexFrame, FT.index, algo)).toString("utf8")) as IndexDoc;
    if (index.formatVersion !== 1) throw new UnsupportedFormatError("unsupported_format", `formatVersion ${index.formatVersion}`);
    if (index.kind !== kind || index.algo !== algo) throw new CorruptReplayError("index_preamble_mismatch", "índice y preámbulo discrepan");
    if (((footer.flags & FLAG_TRUNCATED) !== 0) !== index.truncated) throw new CorruptReplayError("flags_index_mismatch", "flags del pie e índice discrepan");
    // Geometría: cabecera, fragmentos contiguos, índice justo detrás.
    let expect = PREAMBLE_LEN + index.headerFrameLen;
    for (const f of index.fragments) {
      if (f.offset !== expect || f.frameLen < FRAME_HEADER_LEN) throw new CorruptReplayError("bad_geometry", "fragmentos no contiguos");
      expect += f.frameLen;
    }
    if (expect !== footer.indexOffset) throw new CorruptReplayError("bad_geometry", "hueco entre el último fragmento y el índice");
    const headerFrame = await readExact(file, PREAMBLE_LEN, index.headerFrameLen);
    const header = JSON.parse((await decodeFrame(headerFrame, FT.header, algo)).toString("utf8"));
    // La cadena ata la cabecera (battleId, semilla, versiones) a todos los fragmentos.
    if (computeChain(headerFrame, index.fragments.map((f) => f.sha256)) !== index.chain) {
      throw new CorruptReplayError("chain_mismatch", "la cadena de integridad no corresponde a esta cabecera");
    }
    if (opts.expectBattleId !== undefined && header.battleId !== opts.expectBattleId) {
      throw new CorruptReplayError("battle_mismatch", "la cabecera pertenece a otra batalla");
    }
    return new S9rReader(file, size, kind, algo, index, header, index.truncated);
  }

  get dataFragments(): { i: number; entry: FragmentEntry }[] {
    const out: { i: number; entry: FragmentEntry }[] = [];
    this.index.fragments.forEach((entry, i) => entry.type === FT.data && out.push({ i, entry }));
    return out;
  }

  /** Lee y valida (crc, sha256) un fragmento por número de índice. Devuelve el contenido descomprimido. */
  async readFragment(i: number): Promise<Buffer> {
    const entry = this.index.fragments[i];
    if (!entry) throw new CorruptReplayError("no_such_fragment", `fragmento ${i} inexistente`);
    this.fragmentReads++;
    const frame = await readExact(this.file, entry.offset, entry.frameLen);
    const h = decodeFrameHeader(frame);
    if (h.type !== entry.type || h.len + FRAME_HEADER_LEN !== entry.frameLen) throw new CorruptReplayError("frame_header_mismatch", `frame ${i}: cabecera distinta del índice`);
    const payload = frame.subarray(FRAME_HEADER_LEN);
    if (crc32(payload) !== h.crc) throw new CorruptReplayError("crc_mismatch", `frame ${i}: crc32 incorrecto`);
    if (sha256(payload).toString("hex") !== entry.sha256) throw new CorruptReplayError("sha_mismatch", `frame ${i}: sha256 distinto del índice`);
    const raw = await decompress(this.algo, payload, MAX_FRAME_BYTES);
    if (raw.length !== entry.rawLen) throw new CorruptReplayError("raw_len_mismatch", `frame ${i}: longitud descomprimida distinta del índice`);
    return raw;
  }

  /** Líneas de un fragmento de datos. */
  async readRecords(i: number): Promise<string[]> {
    const raw = (await this.readFragment(i)).toString("utf8");
    return raw.split("\n").slice(0, -1);
  }

  /** Resultado (frame 3), o null si no se escribió. */
  async readResult(): Promise<Record<string, unknown> | null> {
    const i = this.index.fragments.findIndex((f) => f.type === FT.result);
    if (i < 0) return null;
    return JSON.parse((await this.readFragment(i)).toString("utf8"));
  }

  /** Índices de fragmentos de datos que cubren [fromTick, toTick]. */
  fragmentsForTicks(fromTick: number, toTick: number): number[] {
    const out: number[] = [];
    this.index.fragments.forEach((f, i) => {
      if (f.type === FT.data && f.lastTick! >= fromTick && f.firstTick! <= toTick) out.push(i);
    });
    return out;
  }

  /**
   * Cursor por registros: un fragmento en memoria a la vez. Con rango de ticks sólo
   * lee los fragmentos que lo cubren (el filtrado fino dentro de ellos es del llamador).
   */
  async *records(range?: { fromTick?: number; toTick?: number }): AsyncGenerator<string> {
    const from = range?.fromTick ?? -Infinity;
    const to = range?.toTick ?? Infinity;
    for (const i of this.fragmentsForTicks(from, to)) {
      for (const line of await this.readRecords(i)) yield line;
    }
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}

export async function readExact(file: S9rFile, position: number, length: number): Promise<Buffer> {
  if (length < 0 || length > MAX_FRAME_BYTES + FRAME_HEADER_LEN) throw new CorruptReplayError("bad_length", `longitud ${length} fuera de rango`);
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    let n: number;
    try {
      n = await file.read(buf.subarray(got), position + got);
    } catch (e) {
      throw toStorageError(e, "read");
    }
    if (n === 0) throw new IncompleteReplayError("short_read", "lectura más corta de lo esperado: fichero truncado");
    got += n;
  }
  return buf;
}

/** Valida crc de un frame completo (cabecera+payload) y devuelve el payload descomprimido. */
export async function decodeFrame(frame: Buffer, expectType: number, algo: Algo): Promise<Buffer> {
  const h = decodeFrameHeader(frame);
  if (h.type !== expectType || h.len + FRAME_HEADER_LEN !== frame.length) throw new CorruptReplayError("frame_header_mismatch", `frame tipo ${expectType} mal formado`);
  const payload = frame.subarray(FRAME_HEADER_LEN);
  if (crc32(payload) !== h.crc) throw new CorruptReplayError("crc_mismatch", `frame tipo ${expectType}: crc32 incorrecto`);
  return decompress(algo, payload, MAX_FRAME_BYTES);
}

export { S9rError, StorageError };
