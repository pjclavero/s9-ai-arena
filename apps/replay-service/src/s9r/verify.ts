/**
 * S9R/1 · Verificador de integridad y recorrido forense de parciales.
 *
 * `verifyFile` hace UNA pasada secuencial en streaming (un frame en memoria a la vez):
 * revisa preámbulo, pie, crc de cada frame, sha256 de cada fragmento contra el índice,
 * la cadena atada a la cabecera, la geometría completa y calcula el sha256 del fichero
 * entero (el que va a la BD). No lanza por corrupción: devuelve `ok:false` con el error tipado.
 */
import { createHash } from "node:crypto";
import { crc32, decompress, sha256 } from "./codec.js";
import {
  FOOTER_LEN,
  FRAME_HEADER_LEN,
  FT,
  MAX_FRAME_BYTES,
  PREAMBLE_LEN,
  decodeFooter,
  decodeFrameHeader,
  decodePreamble,
  type IndexDoc,
} from "./format.js";
import { CorruptReplayError, S9rError } from "./errors.js";
import { nodeFs, type S9rFs } from "./io.js";
import { S9rReader, computeChain, readExact } from "./reader.js";

export interface VerifyResult {
  ok: boolean;
  error?: S9rError;
  bytes: number;
  sha256?: string;
  fragments?: number;
  records?: number;
  truncated?: boolean;
}

export async function verifyFile(path: string, opts: { fs?: S9rFs; expectSha256?: string; expectBattleId?: string } = {}): Promise<VerifyResult> {
  const fs = opts.fs ?? nodeFs;
  let reader: S9rReader | undefined;
  let bytes = 0;
  try {
    // 1) Estructura (pie, índice, cadena, geometría) con el mismo código que el lector.
    reader = await S9rReader.open(path, { fs, expectBattleId: opts.expectBattleId });
    bytes = reader.size;
    const index: IndexDoc = reader.index;
    // 2) Pasada secuencial: crc y sha de cada frame; sha256 del fichero entero.
    const file = await fs.openRead(path);
    try {
      const h = createHash("sha256");
      const pre = await readExact(file, 0, PREAMBLE_LEN);
      decodePreamble(pre);
      h.update(pre);
      let pos = PREAMBLE_LEN;
      const walk = async (type: number, expectSha: string | null, expectLen: number | null, rawLen: number | null) => {
        const hdr = await readExact(file, pos, FRAME_HEADER_LEN);
        const fh = decodeFrameHeader(hdr);
        if (fh.type !== type) throw new CorruptReplayError("frame_type_mismatch", `frame en ${pos}: tipo ${fh.type}, esperado ${type}`);
        if (fh.len > MAX_FRAME_BYTES || (expectLen !== null && fh.len + FRAME_HEADER_LEN !== expectLen)) {
          throw new CorruptReplayError("frame_len_mismatch", `frame en ${pos}: longitud ${fh.len} no esperada`);
        }
        const payload = await readExact(file, pos + FRAME_HEADER_LEN, fh.len);
        if (crc32(payload) !== fh.crc) throw new CorruptReplayError("crc_mismatch", `frame en ${pos}: crc32 incorrecto`);
        if (expectSha !== null && sha256(payload).toString("hex") !== expectSha) throw new CorruptReplayError("sha_mismatch", `frame en ${pos}: sha256 distinto del índice`);
        const raw = await decompress(reader!.algo, payload, MAX_FRAME_BYTES);
        if (rawLen !== null && raw.length !== rawLen) throw new CorruptReplayError("raw_len_mismatch", `frame en ${pos}: longitud descomprimida distinta del índice`);
        h.update(hdr);
        h.update(payload);
        pos += FRAME_HEADER_LEN + fh.len;
      };
      await walk(FT.header, null, index.headerFrameLen, null);
      for (const f of index.fragments) {
        if (pos !== f.offset) throw new CorruptReplayError("bad_geometry", "desplazamiento de fragmento incoherente");
        await walk(f.type, f.sha256, f.frameLen, f.rawLen);
      }
      // índice (ya validado por el lector) y pie, para completar el sha del fichero
      const tail = await readExact(file, pos, bytes - pos);
      decodeFooter(tail.subarray(tail.length - FOOTER_LEN));
      h.update(tail);
      const sha = h.digest("hex");
      if (opts.expectSha256 !== undefined && sha !== opts.expectSha256) throw new CorruptReplayError("file_sha_mismatch", "sha256 del fichero distinto del esperado");
      return { ok: true, bytes, sha256: sha, fragments: index.fragments.filter((f) => f.type === FT.data).length, records: index.records, truncated: index.truncated };
    } finally {
      await file.close().catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof S9rError) return { ok: false, error: e, bytes };
    throw e;
  } finally {
    await reader?.close().catch(() => undefined);
  }
}

/**
 * Recorrido forense de un PARCIAL (sin índice ni pie): cuenta los frames cuyo crc cuadra.
 * Sirve para diagnóstico; jamás para publicar.
 */
export async function scanPartial(path: string, opts: { fs?: S9rFs } = {}): Promise<{ frames: number; dataFragments: number; validBytes: number; clean: boolean }> {
  const fs = opts.fs ?? nodeFs;
  const file = await fs.openRead(path);
  try {
    const size = await file.size();
    let pos = PREAMBLE_LEN;
    let frames = 0;
    let data = 0;
    if (size < PREAMBLE_LEN) return { frames: 0, dataFragments: 0, validBytes: 0, clean: false };
    decodePreamble(await readExact(file, 0, PREAMBLE_LEN));
    while (pos + FRAME_HEADER_LEN <= size) {
      const fh = decodeFrameHeader(await readExact(file, pos, FRAME_HEADER_LEN));
      if (fh.type === FT.index) break;
      if (fh.len > MAX_FRAME_BYTES || pos + FRAME_HEADER_LEN + fh.len > size) break;
      const payload = await readExact(file, pos + FRAME_HEADER_LEN, fh.len);
      if (crc32(payload) !== fh.crc) break;
      frames++;
      if (fh.type === FT.data) data++;
      pos += FRAME_HEADER_LEN + fh.len;
    }
    return { frames, dataFragments: data, validBytes: pos, clean: pos === size };
  } finally {
    await file.close().catch(() => undefined);
  }
}

export { computeChain };
