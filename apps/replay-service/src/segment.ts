/**
 * T8.1/T8.3 · Lectura de índice y segmentos de un replay almacenado, SIN HTTP.
 *
 * PRC (TD-004) · Antes esta lógica vivía dentro de las rutas Express del
 * replay-service, que el gateway publicaba a anónimos. Ahora la usa también la
 * API (`apps/api/src/routes/replays.ts`), que es la ÚNICA autoridad que entrega
 * replays al navegador: decide quién puede leer y sólo entonces llama aquí. Un
 * solo código para «qué es un segmento», dos consumidores (API autorizada y el
 * replay-service interno), nunca dos implementaciones que diverjan.
 */
import { existsSync, readFileSync } from "node:fs";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { decompress, nearestKeyframe, sha256, type StoredReplayIndex } from "./format.js";

/** Índice que acompaña a un archivo de replay: `<archivo>.json` (ver store.ts, indexPath). */
export function indexFileFor(replayFile: string): string {
  return `${replayFile}.json`;
}

export function readIndexFile(indexFile: string): StoredReplayIndex | null {
  if (!existsSync(indexFile)) return null;
  return JSON.parse(readFileSync(indexFile, "utf8")) as StoredReplayIndex;
}

export interface DecodedReplay {
  sha: string;
  snapshots: any[];
  events: any[];
  commands: any[];
}

/**
 * Decodifica el archivo comprimido y comprueba su integridad contra el índice.
 * `null` si falta, si el sha no coincide o si no se puede decodificar: un
 * replay manipulado NUNCA se sirve por segmentos.
 */
export function decodeReplayFile(replayFile: string, index: StoredReplayIndex): DecodedReplay | null {
  if (!existsSync(replayFile)) return null;
  const bytes = readFileSync(replayFile);
  if (sha256(bytes) !== index.sha256) return null;
  try {
    const r = fromJsonl(decompress(bytes).toString("utf8"));
    if (r.header.battleId !== index.battleId) return null;
    return { sha: index.sha256, snapshots: r.snapshots, events: r.events, commands: r.commands };
  } catch {
    return null;
  }
}

/**
 * Cache ACOTADA de replays decodificados (decodificar 9000 ticks por cada salto
 * sería absurdo). Clave = id de batalla; se invalida si cambia el sha del índice.
 * Acotada (LRU simple) porque en la API vive en un proceso de larga duración.
 */
export class DecodedReplayCache {
  private readonly entries = new Map<string, DecodedReplay>();
  constructor(private readonly max = 8) {}

  get(key: string, replayFile: string, index: StoredReplayIndex): DecodedReplay | null {
    const hit = this.entries.get(key);
    if (hit && hit.sha === index.sha256) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const decoded = decodeReplayFile(replayFile, index);
    if (!decoded) return null;
    this.entries.set(key, decoded);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    return decoded;
  }
}

export type SegmentResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: "bad_range" };

/**
 * Segmento por ticks (salto temporal): arranca en el keyframe anterior a
 * `fromTick` para que el reproductor aterrice con estado completo. Los comandos
 * grabados sólo salen si el dueño abrió la depuración del replay (debugOpen).
 */
export function sliceSegment(
  index: StoredReplayIndex,
  decoded: DecodedReplay,
  fromTickRaw: unknown,
  toTickRaw: unknown,
): SegmentResult {
  const fromTick = Number(fromTickRaw ?? 0);
  const toTick = Number(toTickRaw ?? index.ticks);
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || fromTick > toTick) {
    return { ok: false, error: "bad_range" };
  }
  const kf = nearestKeyframe(index.keyframes, fromTick);
  const startIdx = kf ? kf.snapshotIndex : 0;
  const snapshots: any[] = [];
  for (let i = startIdx; i < decoded.snapshots.length && decoded.snapshots[i].tick <= toTick; i++) {
    snapshots.push(decoded.snapshots[i]);
  }
  const fromKf = kf?.tick ?? 0;
  const events = decoded.events.filter((e: any) => e.tick >= fromKf && e.tick <= toTick);
  return {
    ok: true,
    body: {
      battleId: index.battleId,
      fromKeyframeTick: fromKf,
      snapshots,
      events,
      ...(index.debugOpen
        ? { commands: decoded.commands.filter((c: any) => c.tick >= fromKf && c.tick <= toTick) }
        : {}),
    },
  };
}
