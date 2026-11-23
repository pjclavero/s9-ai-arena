/**
 * V1 REPLAYS PR-4 · Lectura INCREMENTAL de la vista S9R/1 (`.s9v`): snapshots completos y eventos
 * públicos (ids internos), en orden de emisión. El visor y la proyección pública la leen por
 * rangos de ticks: sólo se descomprimen los fragmentos que cubren el rango.
 *
 * El resumen (frame `result` de la vista) trae `snapshotCount` y los keyframes (uno cada 30
 * snapshots) que el índice del visor necesita sin recorrer el fichero.
 */
import { CorruptReplayError } from "./errors.js";
import { S9rReader, type OpenOptions } from "./reader.js";
import { VIEW_CONTENT } from "./recorder.js";

export type ViewRecord = { k: "s"; tick: number; frame: any } | { k: "e"; tick: number; event: any };

export interface ViewSummary {
  snapshotCount: number;
  keyframes: { tick: number; snapshotIndex: number }[];
  lastTick: number;
}

export class ViewReader {
  private constructor(
    private readonly reader: S9rReader,
    readonly header: any,
    readonly summary: ViewSummary,
  ) {}

  static async open(path: string, opts: OpenOptions = {}): Promise<ViewReader> {
    const reader = await S9rReader.open(path, opts);
    try {
      if (reader.kind !== "V") throw new CorruptReplayError("not_a_view", "el fichero no es una vista (.s9v)");
      if (reader.truncated) throw new CorruptReplayError("truncated", "vista truncada");
      const content = (reader.header.s9r as { content?: unknown } | undefined)?.content;
      if (content !== VIEW_CONTENT) throw new CorruptReplayError("bad_header", "contenido de vista desconocido");
      const s = (await reader.readResult()) as Partial<ViewSummary> | null;
      if (!s || !Number.isSafeInteger(s.snapshotCount) || !Array.isArray(s.keyframes)) {
        throw new CorruptReplayError("bad_result", "vista sin resumen");
      }
      return new ViewReader(reader, reader.header, {
        snapshotCount: s.snapshotCount as number,
        keyframes: s.keyframes.map((k: any) => ({
          tick: Number(k.tick) || 0,
          snapshotIndex: Number(k.snapshotIndex) || 0,
        })),
        lastTick: Number(s.lastTick) || 0,
      });
    } catch (e) {
      await reader.close().catch(() => undefined);
      throw e;
    }
  }

  get fragmentReads(): number {
    return this.reader.fragmentReads;
  }

  /** Registros en [fromTick, toTick] (ambos incluidos), en orden; sólo lee los fragmentos que los cubren. */
  async *records(fromTick = -Infinity, toTick = Infinity): AsyncGenerator<ViewRecord> {
    for await (const line of this.reader.records({ fromTick, toTick })) {
      let x: any;
      try {
        x = JSON.parse(line);
      } catch (e) {
        throw new CorruptReplayError("bad_record", "registro de vista no es JSON", { cause: e });
      }
      if (!x || !Number.isSafeInteger(x.t)) throw new CorruptReplayError("bad_record", "registro de vista sin tick");
      if (x.t < fromTick || x.t > toTick) continue;
      if (x.k === "s" && x.f && typeof x.f === "object") yield { k: "s", tick: x.t, frame: x.f };
      else if (x.k === "e" && x.e && typeof x.e === "object") yield { k: "e", tick: x.t, event: x.e };
      else throw new CorruptReplayError("bad_record", "registro de vista desconocido");
    }
  }

  /** Keyframe más cercano por debajo (o igual) de `tick` (el primero si `tick` es anterior). */
  nearestKeyframe(tick: number): { tick: number; snapshotIndex: number } | null {
    const k = this.summary.keyframes;
    if (k.length === 0) return null;
    if (tick < k[0].tick) return k[0];
    let lo = 0;
    let hi = k.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (k[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return k[lo];
  }

  async close(): Promise<void> {
    await this.reader.close();
  }
}
