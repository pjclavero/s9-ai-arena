/**
 * T8.1 · Formato de replay ALMACENADO (E8.M: "JSONL+zstd con keyframes cada N ticks").
 *
 * El contenido lógico es EXACTAMENTE el JSONL de E2 (apps/arena-engine/src/replay.ts):
 * este servicio no inventa otro formato, añade la CAPA DE ALMACENAMIENTO:
 *   - compresión (zstd preferido; ver nota de entorno abajo),
 *   - checksum sha256 del archivo comprimido (detección de manipulación byte a byte),
 *   - índice lateral con keyframes para salto temporal sin decodificar todo,
 *   - metadatos de retención (política 23.1: los temporales caducan, los oficiales no).
 *
 * NOTA DE ENTORNO (honestidad): `node:zlib` solo trae zstd desde Node >= 22.15. En el
 * entorno de desarrollo actual (Node 20) se usa gzip como algoritmo de RESERVA, y el
 * algoritmo queda registrado en el índice y es detectable por bytes mágicos. El formato
 * canónico de producción sigue siendo zstd (lo fija E8.M y lo mide replay-golden.test.ts
 * de E2, que en Node 20 falla por este mismo motivo). Cuando el runtime sea Node >= 22.15
 * este módulo usa zstd sin cambiar ni una línea.
 */
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";

export type CompressionAlgo = "zstd" | "gzip";

type ZstdCapable = {
  zstdCompressSync?: (b: Buffer) => Buffer;
  zstdDecompressSync?: (b: Buffer) => Buffer;
};

const z = zlib as unknown as ZstdCapable;

/** zstd si el runtime lo trae (Node >= 22.15); si no, gzip como reserva documentada. */
export const PREFERRED_ALGO: CompressionAlgo = typeof z.zstdCompressSync === "function" ? "zstd" : "gzip";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export function compress(data: Buffer): { algo: CompressionAlgo; bytes: Buffer } {
  if (PREFERRED_ALGO === "zstd") return { algo: "zstd", bytes: z.zstdCompressSync!(data) };
  return { algo: "gzip", bytes: zlib.gzipSync(data) };
}

/** Descomprime detectando el algoritmo por bytes mágicos (el índice puede faltar). */
export function decompress(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    if (typeof z.zstdDecompressSync !== "function") {
      throw new Error("Replay comprimido con zstd pero este runtime (Node < 22.15) no trae zstd");
    }
    return z.zstdDecompressSync(bytes);
  }
  if (bytes.subarray(0, 2).equals(GZIP_MAGIC)) return zlib.gunzipSync(bytes);
  throw new Error("Formato de compresión desconocido (ni zstd ni gzip)");
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------- índice

export interface Keyframe {
  /** Tick del snapshot completo. Los snapshots de E2 son estado íntegro, no deltas. */
  tick: number;
  /** Posición en el array de snapshots del replay decodificado. */
  snapshotIndex: number;
}

export interface StoredReplayIndex {
  formatVersion: 1;
  battleId: string;
  /** Algoritmo REAL con el que se comprimió este archivo. */
  algo: CompressionAlgo;
  /** sha256 (hex) del archivo COMPRIMIDO: cualquier byte alterado lo invalida. */
  sha256: string;
  sizeBytes: number;
  official: boolean;
  createdAt: string;
  /** null = se conserva para siempre (oficiales, política 23.1). */
  expiresAt: string | null;
  ticks: number;
  snapshotCount: number;
  /** Versiones registradas en la cabecera del replay (motor, física, reglas, protocolo). */
  versions: Record<string, string>;
  mapChecksum: string;
  keyframes: Keyframe[];
  /** Resultado oficial (T8.3: el reproductor compara su marcador final contra esto). */
  result: { winner: string; ticks: number; score: Record<string, number>; finalStateHash: string };
  /**
   * T8.3 · ¿Permite el dueño abrir las capas de depuración (comandos grabados) a
   * todos en el reproductor? En directo exigen rol; en replay son opt-in del dueño.
   */
  debugOpen: boolean;
}

/** Un keyframe cada N snapshots (a 10 Hz de snapshot, N=30 ≈ un keyframe cada 3 s). */
export const KEYFRAME_EVERY_N_SNAPSHOTS = 30;

export function buildKeyframes(snapshots: { tick: number }[], everyN = KEYFRAME_EVERY_N_SNAPSHOTS): Keyframe[] {
  const out: Keyframe[] = [];
  for (let i = 0; i < snapshots.length; i += everyN) {
    out.push({ tick: snapshots[i].tick, snapshotIndex: i });
  }
  return out;
}

/** Keyframe más cercano por debajo (o igual) del tick pedido. Búsqueda binaria. */
export function nearestKeyframe(keyframes: Keyframe[], tick: number): Keyframe | null {
  if (keyframes.length === 0) return null;
  let lo = 0;
  let hi = keyframes.length - 1;
  if (tick < keyframes[0].tick) return keyframes[0];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keyframes[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return keyframes[lo];
}
