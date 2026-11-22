/**
 * S9R/1 · validación de la FORMA de cabecera e índice. Un fichero con crc/sha/pie válidos
 * puede aun así ser hostil o estar fabricado: nada de `TypeError`/`SyntaxError`, sólo
 * errores tipados del contrato (`CorruptReplayError`, `UnsupportedFormatError`).
 */
import { FT, FRAME_HEADER_LEN, MAX_FRAME_BYTES, type FragmentEntry, type IndexDoc } from "./format.js";
import { CorruptReplayError, UnsupportedFormatError } from "./errors.js";

const HEX64 = /^[0-9a-f]{64}$/;
const isUint = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isTick = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);

export function parseJson(buf: Buffer, what: string): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new CorruptReplayError("bad_json", `${what}: JSON inválido`, { cause: e });
  }
}

export function validateHeader(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new CorruptReplayError("bad_header", "la cabecera no es un objeto JSON");
  }
  return x as Record<string, unknown>;
}

export function validateIndex(x: unknown, maxRawBytes: number): IndexDoc {
  const bad = (why: string): never => {
    throw new CorruptReplayError("bad_index", `índice mal formado: ${why}`);
  };
  if (typeof x !== "object" || x === null || Array.isArray(x)) return bad("no es un objeto");
  const d = x as Record<string, unknown>;
  if (d.formatVersion !== 1) {
    throw new UnsupportedFormatError("unsupported_format", `formatVersion ${String(d.formatVersion)}`);
  }
  if (d.kind !== "R" && d.kind !== "V") return bad("kind");
  if (d.algo !== "zstd" && d.algo !== "gzip") return bad("algo");
  if (
    !isUint(d.headerFrameLen) ||
    d.headerFrameLen < FRAME_HEADER_LEN ||
    d.headerFrameLen > MAX_FRAME_BYTES + FRAME_HEADER_LEN
  )
    return bad("headerFrameLen");
  if (typeof d.chain !== "string" || !HEX64.test(d.chain)) return bad("chain");
  if (!isUint(d.records) || !isUint(d.rawBytes)) return bad("contadores");
  if (typeof d.truncated !== "boolean") return bad("truncated");
  if (!Array.isArray(d.fragments)) return bad("fragments");
  let records = 0;
  let raw = 0;
  for (const f of d.fragments as unknown[]) {
    if (typeof f !== "object" || f === null) return bad("fragmento no es un objeto");
    const e = f as Record<string, unknown>;
    if (e.type !== FT.data && e.type !== FT.result) return bad("type de fragmento");
    if (
      !isUint(e.offset) ||
      !isUint(e.frameLen) ||
      e.frameLen < FRAME_HEADER_LEN ||
      e.frameLen > MAX_FRAME_BYTES + FRAME_HEADER_LEN
    )
      return bad("offset/frameLen");
    if (!isUint(e.rawLen) || e.rawLen > maxRawBytes) return bad("rawLen fuera de tope");
    if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return bad("sha256 de fragmento");
    if (!isUint(e.records)) return bad("records de fragmento");
    if (e.type === FT.data) {
      if (!isTick(e.firstTick) || !isTick(e.lastTick) || e.records < 1) return bad("ticks/records de datos");
      records += e.records;
    } else if (e.firstTick !== null || e.lastTick !== null || e.records !== 0) {
      return bad("el frame de resultado no lleva ticks ni registros");
    }
    raw += e.rawLen;
  }
  if (records !== d.records) return bad("records no suma los fragmentos");
  if (raw !== d.rawBytes) return bad("rawBytes no suma los fragmentos");
  return d as unknown as IndexDoc;
}

export type { FragmentEntry };
