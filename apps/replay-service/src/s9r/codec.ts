import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { CorruptReplayError, UnsupportedFormatError } from "./errors.js";

export type Algo = "zstd" | "gzip";
export const ALGO_BYTE: Record<Algo, number> = { zstd: 1, gzip: 2 };
export const BYTE_ALGO: Record<number, Algo> = { 1: "zstd", 2: "gzip" };

type Cb = (e: Error | null, r: Buffer) => void;
type Z = {
  zstdCompress?: (b: Buffer, cb: Cb) => void;
  zstdDecompress?: (b: Buffer, o: object, cb: Cb) => void;
};
const z = zlib as unknown as Z;

/** zstd si el runtime lo trae (Node >= 22.15); si no, gzip. El algoritmo va en la cabecera. */
export const PREFERRED_ALGO: Algo = typeof z.zstdCompress === "function" ? "zstd" : "gzip";

export function algoAvailable(algo: Algo): boolean {
  return algo === "gzip" || typeof z.zstdCompress === "function";
}

function need(algo: Algo): void {
  if (!algoAvailable(algo))
    throw new UnsupportedFormatError("unsupported_algo", `algoritmo ${algo} no disponible en este runtime`);
}

/** Compresión asíncrona (fuera del event loop: pool de zlib). */
export async function compress(algo: Algo, raw: Buffer): Promise<Buffer> {
  need(algo);
  if (algo === "zstd") return promisify(z.zstdCompress!)(raw) as Promise<Buffer>;
  return promisify(zlib.gzip)(raw);
}

/** Descompresión con tope de salida (anti bomba de descompresión). */
export async function decompress(algo: Algo, comp: Buffer, maxOutput: number): Promise<Buffer> {
  need(algo);
  try {
    if (algo === "zstd")
      return await (promisify(z.zstdDecompress!) as (b: Buffer, o: object) => Promise<Buffer>)(comp, {
        maxOutputLength: maxOutput,
      });
    return await (
      promisify(zlib.gunzip as unknown as (b: Buffer, o: object, cb: Cb) => void) as (
        b: Buffer,
        o: object,
      ) => Promise<Buffer>
    )(comp, { maxOutputLength: maxOutput });
  } catch (e) {
    throw new CorruptReplayError("decompress_failed", `descompresión fallida: ${(e as Error).message}`, { cause: e });
  }
}

// ---- crc32 (IEEE) sin depender de la versión del runtime
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
