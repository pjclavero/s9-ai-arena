/**
 * S9R/1 · Contenedor de sólo adición.
 *
 *   [0..8)  "S9RP" | major u8 | kind u8 ('R'|'V') | algo u8 | reservado u8 (=0)
 *   frames: [type u8][len u32 LE][crc32 u32 LE del payload comprimido][payload comprimido]
 *     1 cabecera (JSON) · 2 fragmento de datos (JSONL) · 3 resultado (JSON) · 9 índice (JSON)
 *   pie fijo de 64 bytes: "S9RF" | flags u32 | indexOffset u64 | indexLen u32 (frame entero)
 *                         | sha256(frame del índice) 32B | reservado 12B (=0)
 *
 * Cadena: chain0 = sha256(frame de cabecera entero);
 *         chainK = sha256(chainK-1 || sha256(payload comprimido del frame K)),
 *         sobre todos los frames 2 y 3 en orden. El índice lleva chainN.
 * Un fichero sin pie válido es un PARCIAL.
 */
import { CorruptReplayError, IncompleteReplayError, UnsupportedFormatError } from "./errors.js";
import { ALGO_BYTE, BYTE_ALGO, type Algo } from "./codec.js";

export const MAGIC = Buffer.from("S9RP");
export const FOOTER_MAGIC = Buffer.from("S9RF");
export const MAJOR = 1;
export const PREAMBLE_LEN = 8;
export const FRAME_HEADER_LEN = 9;
export const FOOTER_LEN = 64;
export const FLAG_COMPLETE = 1;
export const FLAG_TRUNCATED = 2;
export const FT = { header: 1, data: 2, result: 3, index: 9 } as const;
export type Kind = "R" | "V";
/** Tope duro de un frame (comprimido y descomprimido) al leer. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface FragmentEntry {
  type: number;
  offset: number;
  frameLen: number;
  rawLen: number;
  sha256: string;
  firstTick: number | null;
  lastTick: number | null;
  records: number;
}
export interface IndexDoc {
  formatVersion: 1;
  kind: Kind;
  algo: Algo;
  headerFrameLen: number;
  fragments: FragmentEntry[];
  chain: string;
  records: number;
  rawBytes: number;
  truncated: boolean;
}

export function encodePreamble(kind: Kind, algo: Algo): Buffer {
  const b = Buffer.alloc(PREAMBLE_LEN);
  MAGIC.copy(b, 0);
  b[4] = MAJOR;
  b[5] = kind.charCodeAt(0);
  b[6] = ALGO_BYTE[algo];
  b[7] = 0;
  return b;
}

export function decodePreamble(b: Buffer): { kind: Kind; algo: Algo } {
  if (b.length < PREAMBLE_LEN || !b.subarray(0, 4).equals(MAGIC)) throw new CorruptReplayError("bad_magic", "magic S9RP ausente");
  if (b[4] !== MAJOR) throw new UnsupportedFormatError("unsupported_format", `versión mayor ${b[4]} no soportada`);
  const kind = String.fromCharCode(b[5]);
  if (kind !== "R" && kind !== "V") throw new CorruptReplayError("bad_kind", "kind desconocido");
  const algo = BYTE_ALGO[b[6]];
  if (!algo) throw new UnsupportedFormatError("unsupported_algo", `algoritmo ${b[6]} desconocido`);
  if (b[7] !== 0) throw new CorruptReplayError("bad_reserved", "byte reservado distinto de 0");
  return { kind: kind as Kind, algo };
}

export function encodeFrameHeader(type: number, len: number, crc: number): Buffer {
  const b = Buffer.alloc(FRAME_HEADER_LEN);
  b[0] = type;
  b.writeUInt32LE(len, 1);
  b.writeUInt32LE(crc >>> 0, 5);
  return b;
}
export function decodeFrameHeader(b: Buffer): { type: number; len: number; crc: number } {
  return { type: b[0], len: b.readUInt32LE(1), crc: b.readUInt32LE(5) };
}

export interface Footer {
  flags: number;
  indexOffset: number;
  indexLen: number;
  indexSha256: Buffer;
}
export function encodeFooter(f: Footer): Buffer {
  const b = Buffer.alloc(FOOTER_LEN);
  FOOTER_MAGIC.copy(b, 0);
  b.writeUInt32LE(f.flags, 4);
  b.writeBigUInt64LE(BigInt(f.indexOffset), 8);
  b.writeUInt32LE(f.indexLen, 16);
  f.indexSha256.copy(b, 20);
  return b;
}
/** Punto ÚNICO de validación del pie: lo usan el lector y el verificador. */
export function decodeFooter(b: Buffer): Footer {
  if (b.length !== FOOTER_LEN || !b.subarray(0, 4).equals(FOOTER_MAGIC)) {
    throw new IncompleteReplayError("no_footer", "sin pie S9RF válido: fichero parcial");
  }
  const flags = b.readUInt32LE(4);
  if ((flags & FLAG_COMPLETE) === 0) throw new IncompleteReplayError("not_complete", "pie sin bit complete: parcial");
  if ((flags & ~(FLAG_COMPLETE | FLAG_TRUNCATED)) !== 0) throw new CorruptReplayError("bad_flags", "flags desconocidos");
  if (!b.subarray(52, 64).equals(Buffer.alloc(12))) throw new CorruptReplayError("bad_reserved", "reservado del pie distinto de 0");
  const off = b.readBigUInt64LE(8);
  if (off > BigInt(Number.MAX_SAFE_INTEGER)) throw new CorruptReplayError("bad_footer_geometry", "indexOffset fuera de rango");
  return { flags, indexOffset: Number(off), indexLen: b.readUInt32LE(16), indexSha256: Buffer.from(b.subarray(20, 52)) };
}
