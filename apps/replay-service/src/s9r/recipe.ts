/**
 * V1 REPLAYS PR-4 · Lectura INCREMENTAL de la receta S9R/1 (`.s9r`).
 *
 * `RecipeCursor` implementa `CommandSource` del motor: la re-simulación pide los comandos de cada
 * tick y el cursor los lee por fragmentos (un `pread` + descompresión por fragmento), en orden, y
 * suelta los ticks ya jugados. En memoria, como mucho: los comandos de un fragmento y del
 * siguiente (≈ 1 MiB sin comprimir cada uno), más hashes (≈ 1 650) y checkpoints (≈ 165) a
 * 45 000 ticks. Nunca el replay entero.
 *
 * Registros (los escribe `recorder.ts`):
 *   {"k":"c","t","v","c"} comando · {"k":"c","t","v","=":1} mismo comando que el anterior de ese
 *   vehículo · {"k":"h","t","hash"} hash · {"k":"k","t","hash","components"} checkpoint.
 * Un registro desconocido o mal formado es CORRUPCIÓN (`CorruptReplayError`), nunca se salta.
 */
import { CorruptReplayError } from "./errors.js";
import { S9rReader, type OpenOptions } from "./reader.js";
import type { FragmentEntry } from "./format.js";
import { RECIPE_CONTENT } from "./recorder.js";

export interface RecipeCommand {
  tick: number;
  vehicleId: string;
  command: any;
}

/** Decodifica las líneas de UN fragmento de la receta; `last` arrastra la elisión "=" entre fragmentos. */
function* decodeRecipeLines(
  lines: string[],
  last: Map<string, unknown>,
  i: number,
): Generator<
  | { k: "c"; c: RecipeCommand }
  | { k: "h"; tick: number; hash: string }
  | { k: "k"; tick: number; hash: string; components: Record<string, string> }
> {
  for (const line of lines) {
    let x: any;
    try {
      x = JSON.parse(line);
    } catch (e) {
      throw new CorruptReplayError("bad_record", `fragmento ${i}: registro no es JSON`, { cause: e });
    }
    if (!x || typeof x !== "object" || !Number.isSafeInteger(x.t)) {
      throw new CorruptReplayError("bad_record", `fragmento ${i}: registro sin tick entero`);
    }
    if (x.k === "c") {
      if (typeof x.v !== "string") throw new CorruptReplayError("bad_record", `fragmento ${i}: comando sin vehículo`);
      let command: unknown;
      if (x["="] === 1) {
        if (!last.has(x.v))
          throw new CorruptReplayError("bad_record", `fragmento ${i}: "=" sin comando previo de ${x.v}`);
        command = last.get(x.v);
      } else if ("c" in x) {
        command = x.c;
        last.set(x.v, command);
      } else throw new CorruptReplayError("bad_record", `fragmento ${i}: comando sin cuerpo`);
      yield { k: "c", c: { tick: x.t, vehicleId: x.v, command } };
    } else if (x.k === "h" && typeof x.hash === "string") {
      yield { k: "h", tick: x.t, hash: x.hash };
    } else if (x.k === "k" && typeof x.hash === "string" && x.components && typeof x.components === "object") {
      yield { k: "k", tick: x.t, hash: x.hash, components: x.components };
    } else {
      throw new CorruptReplayError("bad_record", `fragmento ${i}: registro de receta desconocido`);
    }
  }
}

export class RecipeCursor {
  /** Comandos cargados y aún no jugados: tick → vehículo → orden. */
  private readonly window = new Map<number, Map<string, unknown>>();
  private readonly last = new Map<string, unknown>();
  private readonly frags: { i: number; entry: FragmentEntry }[];
  private next = 0;
  /** Último tick de lo ya leído (−1 = nada). */
  private loadedThrough = -1;
  readonly stateHashes: { tick: number; hash: string }[] = [];
  readonly checkpoints: { tick: number; hash: string; components: Record<string, string> }[] = [];
  /** Pico de ticks retenidos en la ventana (métrica y test de memoria). */
  peakWindowTicks = 0;

  private constructor(
    private readonly reader: S9rReader,
    readonly header: any,
    readonly result: any,
  ) {
    this.frags = reader.dataFragments;
  }

  static async open(path: string, opts: OpenOptions = {}): Promise<RecipeCursor> {
    const reader = await S9rReader.open(path, opts);
    try {
      if (reader.kind !== "R") throw new CorruptReplayError("not_a_recipe", "el fichero no es una receta (.s9r)");
      if (reader.truncated) throw new CorruptReplayError("truncated", "receta truncada: no se re-simula como válida");
      const content = (reader.header.s9r as { content?: unknown } | undefined)?.content;
      if (content !== RECIPE_CONTENT) throw new CorruptReplayError("bad_header", "contenido de receta desconocido");
      const result = await reader.readResult();
      if (!result) throw new CorruptReplayError("bad_result", "receta sin resultado");
      return new RecipeCursor(reader, reader.header, result);
    } catch (e) {
      await reader.close().catch(() => undefined);
      throw e;
    }
  }

  /** Fragmentos leídos hasta ahora (comprobación de que no se carga de más). */
  get fragmentReads(): number {
    return this.reader.fragmentReads;
  }

  private async loadNext(keepCommands: boolean): Promise<void> {
    const { i, entry } = this.frags[this.next++];
    for (const r of decodeRecipeLines(await this.reader.readRecords(i), this.last, i)) {
      if (r.k === "c") {
        if (!keepCommands) continue;
        let m = this.window.get(r.c.tick);
        if (!m) this.window.set(r.c.tick, (m = new Map()));
        m.set(r.c.vehicleId, r.c.command);
      } else if (r.k === "h") this.stateHashes.push({ tick: r.tick, hash: r.hash });
      else this.checkpoints.push({ tick: r.tick, hash: r.hash, components: r.components });
    }
    this.loadedThrough = entry.lastTick ?? this.loadedThrough;
    if (this.window.size > this.peakWindowTicks) this.peakWindowTicks = this.window.size;
  }

  /** CommandSource: los comandos de `tick` quedan disponibles; los ticks anteriores se sueltan. */
  async ensure(tick: number): Promise<void> {
    for (const t of this.window.keys()) {
      if (t < tick) this.window.delete(t);
      else break; // Map en orden de inserción = orden de tick
    }
    // `<=`: los comandos de un mismo tick pueden repartirse entre dos fragmentos seguidos.
    while (this.loadedThrough <= tick && this.next < this.frags.length) await this.loadNext(true);
  }

  commandFor(vehicleId: string, tick: number): unknown | null {
    return this.window.get(tick)?.get(vehicleId) ?? null;
  }

  /**
   * Termina de leer lo que quede SIN retener comandos y devuelve lo oficial: hashes,
   * checkpoints y resultado (lo que compara verify).
   */
  async official(): Promise<{ stateHashes: any[]; checkpoints: any[]; result: any }> {
    this.window.clear();
    while (this.next < this.frags.length) await this.loadNext(false);
    return { stateHashes: this.stateHashes, checkpoints: this.checkpoints, result: this.result };
  }

  async close(): Promise<void> {
    this.window.clear();
    await this.reader.close();
  }
}

/** Recorre TODOS los comandos de una receta en orden, un fragmento a la vez (segunda pasada de las estadísticas). */
export async function forEachRecipeCommand(
  path: string,
  cb: (c: RecipeCommand) => void,
  opts: OpenOptions = {},
): Promise<void> {
  const reader = await S9rReader.open(path, opts);
  try {
    const last = new Map<string, unknown>();
    for (const { i } of reader.dataFragments) {
      for (const r of decodeRecipeLines(await reader.readRecords(i), last, i)) if (r.k === "c") cb(r.c);
    }
  } finally {
    await reader.close();
  }
}
