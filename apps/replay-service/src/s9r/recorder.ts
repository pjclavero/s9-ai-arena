/**
 * V1 REPLAYS · PR-3 · Adaptador `ReplaySink` (motor, síncrono) → dos `S9rWriter` (asíncronos).
 *
 * Una batalla escribe DOS parciales identificados por batalla, intento y titular:
 *   `<dir>/.partial/<battleId>.<attempt>.<owner8>.s9r.part`  receta: comandos, hashes, checkpoints, resultado
 *   `<dir>/.partial/<battleId>.<attempt>.<owner8>.s9v.part`  vista: snapshots y eventos públicos
 * y, sólo si el cierre de la fila casa, se publican como `<dir>/<battleId>.<attempt>.s9v` y
 * `<dir>/<battleId>.<attempt>.s9r` (`artifacts.ts`). El intento va en el nombre final para que un
 * replay huérfano de un intento anterior (COMMIT fallido tras publicar) nunca choque con el
 * reintento (la publicación no sobrescribe: `final_exists`).
 *
 * COLA ACOTADA. El motor llama al sink de forma síncrona y el escritor es asíncrono: entre medias
 * hay, por flujo, un contador de bytes encolados y no escritos (`pending`). Si un registro no cabe
 * (`pending + bytes > maxPendingBytes`) el método del sink LANZA `RecordingBackpressureError`; el
 * motor lo captura, fija `battle.recordingFault` y termina la batalla (contrato de #333). NUNCA se
 * amplía la cola ni se guarda en RAM como alternativa. Un fallo asíncrono del escritor (ENOSPC,
 * EIO, tope de bytes, registro rechazado) queda como `fault` y la SIGUIENTE llamada del sink lanza:
 * desde el primer fallo el grabador no acepta nada más y `finish()` lo rechaza.
 *
 * Memoria por batalla, como máximo: por flujo `maxPendingBytes` + un fragmento sin comprimir
 * (`fragmentBytes` + un registro) + un fragmento comprimiéndose. Con los valores por defecto
 * (receta 1 MiB / cola 2 MiB, vista 2 MiB / cola 4 MiB) ≈ 12 MiB.
 *
 * Formato de los registros (JSONL dentro de cada fragmento; S9R/1 transporta líneas opacas):
 *   receta  {"k":"c","t":tick,"v":vehicleId,"c":command}   comando
 *           {"k":"c","t":tick,"v":vehicleId,"=":1}          mismo comando que el anterior de ese vehículo
 *           {"k":"h","t":tick,"hash":…}                     hash de estado
 *           {"k":"k","t":tick,"hash":…,"components":…}      checkpoint
 *           frame `result`: el BattleResult del motor
 *   vista   {"k":"s","t":tick,"f":frame}                     snapshot COMPLETO (keyframes+deltas: PR-4)
 *           {"k":"e","t":tick,"e":event}                     evento público (ids internos)
 * Un tick sin registro de comando de un vehículo = el bot no respondió (semántica de ReplayAgent).
 *
 * Este módulo no depende del motor: implementa la interfaz `ReplaySink` por estructura.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { S9rError, WriterStateError } from "./errors.js";
import { discardPartial } from "./publish.js";
import { S9rWriter, type WriteSummary } from "./writer.js";
import type { Algo } from "./codec.js";
import type { S9rFs } from "./io.js";

/** Versión del CONTENIDO (continúa la numeración del JSONL v2). */
export const S9R_CONTENT_VERSION = 3;
export const RECIPE_CONTENT = "s9.replay.recipe/v1";
export const VIEW_CONTENT = "s9.replay.view.snapshots/v1";
export const PARTIAL_DIR = ".partial";
/** Un keyframe del índice del visor cada N snapshots (como el índice v1: ≈ 3 s a 10 Hz). */
export const KEYFRAME_EVERY = 30;

/** El sink rechazó un registro porque la cola hacia el disco está llena. */
export class RecordingBackpressureError extends S9rError {
  constructor(stream: string, pending: number, limit: number) {
    super("recording_backpressure", `cola de grabación de ${stream} llena (${pending} B pendientes, tope ${limit} B)`);
  }
}

/** El escritor no drenó nada durante `stallMs` (disco atascado): fallo de almacenamiento. */
export class RecordingStallError extends S9rError {
  constructor(stallMs: number) {
    super("recording_stall", `la grabación no avanzó en ${stallMs} ms (escritor atascado)`);
  }
}

/** Primeros 8 hex del sha256 del titular: identifica el intento sin publicar el nombre del worker. */
export function owner8(owner: string): string {
  return createHash("sha256").update(owner, "utf8").digest("hex").slice(0, 8);
}

/** Nombres de los ficheros de un intento. Fuente ÚNICA (recorder, publicación, janitor y tests). */
export function recordingPaths(dir: string, battleId: string, attempt: number, owner: string) {
  if (!/^[0-9A-Za-z_-]+$/.test(battleId)) throw new RangeError("battleId con caracteres no admitidos en un nombre");
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RangeError("attempt debe ser un entero >= 0");
  const base = `${battleId}.${attempt}.${owner8(owner)}`;
  return {
    partialDir: join(dir, PARTIAL_DIR),
    recipePartial: join(dir, PARTIAL_DIR, `${base}.s9r.part`),
    viewPartial: join(dir, PARTIAL_DIR, `${base}.s9v.part`),
    recipeFinal: join(dir, `${battleId}.${attempt}.s9r`),
    viewFinal: join(dir, `${battleId}.${attempt}.s9v`),
  };
}

export interface RecorderOptions {
  /** Directorio de replays (`REPLAYS_DIR`). Los parciales van en su `.partial/` (mismo sistema de ficheros). */
  dir: string;
  battleId: string;
  /** `battles.run_attempts` del intento en curso. */
  attempt: number;
  /** `battles.claimed_by` del intento (sólo su sha8 llega al nombre). */
  owner: string;
  /** Cabecera de la receta (la del motor: semilla, ruleset, mapa, participantes, versiones…). */
  recipeHeader: Record<string, unknown>;
  /** Cabecera de la vista (meta pública). */
  viewHeader: Record<string, unknown>;
  /** Cadencia de checkpoints de la batalla: la receta cierra fragmento cada 3 checkpoints. */
  checkpointEveryNTicks?: number;
  maxRecipeBytes?: number;
  maxViewBytes?: number;
  recipeFragmentBytes?: number;
  viewFragmentBytes?: number;
  /** Tope de la cola por flujo. Defecto: 2 x fragmentBytes del flujo. */
  recipeMaxPendingBytes?: number;
  viewMaxPendingBytes?: number;
  /** `drain()` sin ningún progreso durante este tiempo = escritor atascado (fallo). Defecto 30 s. */
  stallMs?: number;
  algo?: Algo;
  fs?: S9rFs;
}

const MiB = 1024 * 1024;
/** Topes por defecto del fichero (PR-5 los lee de la configuración). Muy por encima de lo estimado a 45 000 ticks. */
export const DEFAULT_MAX_RECIPE_BYTES = 128 * MiB;
export const DEFAULT_MAX_VIEW_BYTES = 512 * MiB;

interface Stream {
  name: "recipe" | "view";
  writer: S9rWriter;
  pending: number;
  maxPending: number;
  peakPending: number;
  records: number;
}

export interface ClosedRecording {
  battleId: string;
  attempt: number;
  owner: string;
  recipe: { partial: string; final: string; summary: WriteSummary };
  view: { partial: string; final: string; summary: WriteSummary };
  ticks: number;
}

export class ReplayRecorder {
  private fault: Error | null = null;
  private readonly lastCmd = new Map<string, string>();
  private lastTick = 0;
  private finished = false;
  /** Vista: nº de snapshots y keyframes (uno cada KEYFRAME_EVERY snapshots) para el índice del visor. */
  private snapshotCount = 0;
  private readonly keyframes: { tick: number; snapshotIndex: number }[] = [];
  private waiters: (() => void)[] = [];

  private constructor(
    readonly paths: ReturnType<typeof recordingPaths>,
    private readonly o: RecorderOptions,
    private readonly recipe: Stream,
    private readonly view: Stream,
  ) {}

  static async create(o: RecorderOptions): Promise<ReplayRecorder> {
    const paths = recordingPaths(o.dir, o.battleId, o.attempt, o.owner);
    // El directorio de parciales vive DENTRO del de replays (mismo sistema de ficheros: `link` atómico).
    await mkdir(paths.partialDir, { recursive: true, mode: 0o750 });
    const rFrag = o.recipeFragmentBytes ?? 1 * MiB;
    const vFrag = o.viewFragmentBytes ?? 2 * MiB;
    const rPend = o.recipeMaxPendingBytes ?? 2 * rFrag;
    const vPend = o.viewMaxPendingBytes ?? 2 * vFrag;
    const vRecord = 1 * MiB;
    // `battleId` de la cabecera = el de la simulación (el motor lo usa al re-simular); en producción
    // coincide con la fila `battles`. `s9r.battleId` es siempre el de la batalla que lo grabó.
    const header = (h: Record<string, unknown>, content: string) => ({
      ...h,
      s9r: { contentVersion: S9R_CONTENT_VERSION, content, battleId: o.battleId, attempt: o.attempt },
      battleId: typeof h.battleId === "string" ? h.battleId : o.battleId,
    });
    const recipeW = await S9rWriter.create(paths.recipePartial, {
      kind: "R",
      header: header(o.recipeHeader, RECIPE_CONTENT),
      maxBytes: o.maxRecipeBytes ?? DEFAULT_MAX_RECIPE_BYTES,
      fragmentBytes: rFrag,
      // La cola del escritor nunca debe rechazar antes que la nuestra (que es la que se mide).
      maxQueuedBytes: rPend + 256 * 1024,
      ...(o.algo ? { algo: o.algo } : {}),
      ...(o.fs ? { fs: o.fs } : {}),
    });
    let viewW: S9rWriter;
    try {
      viewW = await S9rWriter.create(paths.viewPartial, {
        kind: "V",
        header: header(o.viewHeader, VIEW_CONTENT),
        maxBytes: o.maxViewBytes ?? DEFAULT_MAX_VIEW_BYTES,
        fragmentBytes: vFrag,
        maxRecordBytes: vRecord,
        maxQueuedBytes: vPend + vRecord,
        ...(o.algo ? { algo: o.algo } : {}),
        ...(o.fs ? { fs: o.fs } : {}),
      });
    } catch (e) {
      await recipeW.abort();
      await discardPartial(paths.recipePartial, { fs: o.fs }).catch(() => undefined);
      throw e;
    }
    const stream = (name: Stream["name"], writer: S9rWriter, maxPending: number): Stream => ({
      name,
      writer,
      pending: 0,
      maxPending,
      peakPending: 0,
      records: 0,
    });
    return new ReplayRecorder(paths, o, stream("recipe", recipeW, rPend), stream("view", viewW, vPend));
  }

  /** Primer fallo de la grabación (backpressure, disco, tope, registro inválido) o null. */
  get recordingError(): Error | null {
    return this.fault;
  }

  /** Métricas: pico de la cola por flujo y registros aceptados. */
  get stats() {
    return {
      recipe: { peakPendingBytes: this.recipe.peakPending, records: this.recipe.records },
      view: { peakPendingBytes: this.view.peakPending, records: this.view.records },
    };
  }

  private setFault(e: unknown): void {
    if (!this.fault) this.fault = e instanceof Error ? e : new Error(String(e));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Encola una línea; SÍNCRONO. Lanza si hay un fallo previo o si la cola está llena. */
  private push(s: Stream, line: string, tick: number): void {
    if (this.fault) throw this.fault;
    if (this.finished) throw new WriterStateError("writer_closed", "grabador ya cerrado");
    const bytes = Buffer.byteLength(line) + 1;
    if (s.pending + bytes > s.maxPending) {
      this.setFault(new RecordingBackpressureError(s.name, s.pending, s.maxPending));
      throw this.fault;
    }
    s.pending += bytes;
    if (s.pending > s.peakPending) s.peakPending = s.pending;
    s.records++;
    s.writer.append(line, tick).then(
      () => {
        s.pending -= bytes;
        this.wake();
      },
      (e) => {
        s.pending -= bytes;
        this.setFault(e);
        this.wake();
      },
    );
  }

  private tickOf(x: unknown): number {
    const t = (x as { tick?: unknown } | null)?.tick;
    if (typeof t === "number" && Number.isSafeInteger(t)) {
      this.lastTick = t;
      return t;
    }
    return this.lastTick;
  }

  // ---------------------------------------------------------------- ReplaySink
  command(rec: { tick: number; vehicleId: string; command: unknown }): void {
    const t = this.tickOf(rec);
    const c = JSON.stringify(rec.command ?? null);
    const same = this.lastCmd.get(rec.vehicleId) === c;
    this.lastCmd.set(rec.vehicleId, c);
    const v = JSON.stringify(rec.vehicleId);
    this.push(this.recipe, same ? `{"k":"c","t":${t},"v":${v},"=":1}` : `{"k":"c","t":${t},"v":${v},"c":${c}}`, t);
  }
  snapshot(frame: unknown): void {
    const t = this.tickOf(frame);
    this.push(this.view, `{"k":"s","t":${t},"f":${JSON.stringify(frame)}}`, t);
    if (this.snapshotCount % KEYFRAME_EVERY === 0) this.keyframes.push({ tick: t, snapshotIndex: this.snapshotCount });
    this.snapshotCount++;
  }
  event(ev: unknown): void {
    const t = this.tickOf(ev);
    this.push(this.view, `{"k":"e","t":${t},"e":${JSON.stringify(ev)}}`, t);
  }
  hash(rec: { tick: number; hash: string }): void {
    const t = this.tickOf(rec);
    this.push(this.recipe, JSON.stringify({ k: "h", t, hash: rec.hash }), t);
  }
  checkpoint(rec: { tick: number; hash: string; components: Record<string, string> }): void {
    const t = this.tickOf(rec);
    this.push(this.recipe, JSON.stringify({ k: "k", t, hash: rec.hash, components: rec.components }), t);
    // Fronteras de fragmento de la receta en múltiplos de 3 checkpoints (≈ 900 ticks).
    const every = (this.o.checkpointEveryNTicks ?? 300) * 3;
    if (every > 0 && t > 0 && t % every === 0) {
      this.recipe.writer.flushFragment().catch((e) => this.setFault(e));
    }
  }
  // ---------------------------------------------------------------------------

  /**
   * Espera a que la cola baje de la mitad de su tope (o a un fallo). Sólo la usan drivers que
   * avanzan el motor más rápido que el reloj (en proceso); el directo real va a ritmo de reloj.
   */
  async drain(): Promise<void> {
    const stallMs = this.o.stallMs ?? 30_000;
    const busy = () =>
      !this.fault && (this.recipe.pending > this.recipe.maxPending / 2 || this.view.pending > this.view.maxPending / 2);
    while (busy()) {
      let timer: NodeJS.Timeout | undefined;
      const progressed = await new Promise<boolean>((resolve) => {
        this.waiters.push(() => resolve(true));
        timer = setTimeout(() => resolve(false), stallMs);
      });
      clearTimeout(timer);
      if (!progressed) this.setFault(new RecordingStallError(stallMs));
    }
  }

  /**
   * Cierra los dos ficheros (resultado en la receta) y devuelve las PRUEBAS de cierre. Si hubo
   * cualquier fallo antes o durante el cierre, descarta los parciales y lanza: nunca hay una
   * grabación «cerrada» con registros perdidos.
   */
  async finish(result: Record<string, unknown>): Promise<ClosedRecording> {
    if (this.finished) throw new WriterStateError("writer_closed", "grabador ya cerrado");
    this.finished = true;
    if (this.fault) {
      await this.discard();
      throw this.fault;
    }
    const [r, v] = await Promise.allSettled([
      this.recipe.writer.close({ result }),
      this.view.writer.close({ result: this.viewSummary() }),
    ]);
    if (this.fault || r.status === "rejected" || v.status === "rejected") {
      this.setFault(r.status === "rejected" ? r.reason : v.status === "rejected" ? v.reason : this.fault);
      await this.discard();
      throw this.fault;
    }
    return {
      battleId: this.o.battleId,
      attempt: this.o.attempt,
      owner: this.o.owner,
      recipe: { partial: this.paths.recipePartial, final: this.paths.recipeFinal, summary: r.value },
      view: { partial: this.paths.viewPartial, final: this.paths.viewFinal, summary: v.value },
      ticks: Number(result.ticks ?? this.lastTick),
    };
  }

  /**
   * Resumen de la VISTA (frame `result` del `.s9v`): lo que el índice del visor necesita sin
   * recorrer el fichero. Los keyframes caben de sobra (≈ 500 a 45 000 ticks).
   */
  private viewSummary(): Record<string, unknown> {
    return {
      content: VIEW_CONTENT,
      snapshotCount: this.snapshotCount,
      keyframeEvery: KEYFRAME_EVERY,
      keyframes: this.keyframes,
      lastTick: this.lastTick,
    };
  }

  /** Descarta los parciales del intento (cerrados o no). Idempotente; nunca lanza. */
  async discard(): Promise<void> {
    this.finished = true;
    await this.recipe.writer.abort();
    await this.view.writer.abort();
    await discardRecordingFiles(this.paths, this.o.fs);
  }
}

/** Borra los `.part` (y `.failed`) de un intento. Idempotente; nunca lanza. */
export async function discardRecordingFiles(
  paths: { recipePartial: string; viewPartial: string },
  fs?: S9rFs,
): Promise<void> {
  for (const p of [paths.recipePartial, paths.viewPartial]) {
    for (const f of [p, `${p}.failed`]) await discardPartial(f, { fs }).catch(() => undefined);
  }
}
