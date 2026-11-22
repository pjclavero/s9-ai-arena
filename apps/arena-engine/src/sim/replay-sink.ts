/**
 * V1 REPLAYS · PR-1 · El motor no posee el replay: emite registros a un `ReplaySink`.
 *
 *  - `ReplaySink`: interfaz síncrona (el bucle del motor lo es). Una implementación de
 *    producción debe tener búfer acotado y política explícita al llenarse (PR-2/PR-3).
 *  - `MemoryReplaySink`: implementación en memoria con TOPES por flujo, para tests y para
 *    el camino por defecto. Al superar un tope lanza `ReplaySinkOverflowError` (falla alto,
 *    nunca descarta en silencio ni crece sin límite).
 *  - `WindowLog`/`FrameLog`: ventana acotada con índices ABSOLUTOS (`base`, `length`) que
 *    sustituye la lectura por índice de `battle.snapshots` del directo (gateway).
 *
 * Nada de esto entra en el hash de estado: el determinismo no depende del sink.
 */

export interface ReplayCommandRecord {
  tick: number;
  vehicleId: string;
  command: any;
}
export interface ReplayHashRecord {
  tick: number;
  hash: string;
}
export interface ReplayCheckpointRecord {
  tick: number;
  hash: string;
  components: Record<string, string>;
}

export interface ReplaySink {
  command(rec: ReplayCommandRecord): void;
  /** Frame INTERNO (ids internos): quien lo persista o emita debe proyectarlo antes. */
  snapshot(frame: any): void;
  /** Evento público con ids internos. */
  event(ev: any): void;
  hash(rec: ReplayHashRecord): void;
  checkpoint(rec: ReplayCheckpointRecord): void;
}

export class ReplaySinkOverflowError extends Error {
  readonly stream: string;
  readonly limit: number;
  constructor(stream: string, limit: number) {
    super(`ReplaySink en memoria: tope de ${limit} registros de "${stream}" superado`);
    this.name = "ReplaySinkOverflowError";
    this.stream = stream;
    this.limit = limit;
  }
}

/** Se lanza al leer `battle.snapshots` etc. si la batalla usa un sink externo. */
export class ReplayNotRetainedError extends Error {
  constructor(what: string) {
    super(`battle.${what}: la batalla emite a un ReplaySink externo y no retiene ese flujo; léelo del sink`);
    this.name = "ReplayNotRetainedError";
  }
}

export interface MemoryReplaySinkLimits {
  maxCommands: number;
  maxSnapshots: number;
  maxEvents: number;
  maxHashes: number;
  maxCheckpoints: number;
}
/** Holgados para una batalla de 45 000 ticks x 8 vehículos, pero finitos. */
export const DEFAULT_MEMORY_LIMITS: MemoryReplaySinkLimits = {
  maxCommands: 2_000_000,
  maxSnapshots: 200_000,
  maxEvents: 200_000,
  maxHashes: 200_000,
  maxCheckpoints: 50_000,
};

export class MemoryReplaySink implements ReplaySink {
  readonly commands: ReplayCommandRecord[] = [];
  readonly snapshots: any[] = [];
  readonly events: any[] = [];
  readonly stateHashes: ReplayHashRecord[] = [];
  readonly checkpoints: ReplayCheckpointRecord[] = [];
  readonly limits: MemoryReplaySinkLimits;
  /** `false` = no retiene ese flujo (verify/estadísticas no leen snapshots ni eventos). */
  private readonly keepSnapshots: boolean;
  private readonly keepEvents: boolean;

  constructor(
    opts: { limits?: Partial<MemoryReplaySinkLimits>; retainSnapshots?: boolean; retainEvents?: boolean } = {},
  ) {
    this.limits = { ...DEFAULT_MEMORY_LIMITS, ...opts.limits };
    this.keepSnapshots = opts.retainSnapshots !== false;
    this.keepEvents = opts.retainEvents !== false;
  }

  command(rec: ReplayCommandRecord): void {
    if (this.commands.length >= this.limits.maxCommands)
      throw new ReplaySinkOverflowError("commands", this.limits.maxCommands);
    this.commands.push(rec);
  }
  snapshot(frame: any): void {
    if (!this.keepSnapshots) return;
    if (this.snapshots.length >= this.limits.maxSnapshots)
      throw new ReplaySinkOverflowError("snapshots", this.limits.maxSnapshots);
    this.snapshots.push(frame);
  }
  event(ev: any): void {
    if (!this.keepEvents) return;
    if (this.events.length >= this.limits.maxEvents) throw new ReplaySinkOverflowError("events", this.limits.maxEvents);
    this.events.push(ev);
  }
  hash(rec: ReplayHashRecord): void {
    if (this.stateHashes.length >= this.limits.maxHashes)
      throw new ReplaySinkOverflowError("hashes", this.limits.maxHashes);
    this.stateHashes.push(rec);
  }
  checkpoint(rec: ReplayCheckpointRecord): void {
    if (this.checkpoints.length >= this.limits.maxCheckpoints)
      throw new ReplaySinkOverflowError("checkpoints", this.limits.maxCheckpoints);
    this.checkpoints.push(rec);
  }
}

/**
 * Ventana deslizante con numeración absoluta. `length` es el total de elementos
 * empujados alguna vez; `base` es el índice absoluto del más antiguo que sigue en la
 * ventana. `get(i)` devuelve `undefined` si `i` ya salió de la ventana o no existe.
 */
export class WindowLog<T> {
  private buf: (T | undefined)[];
  private head = 0; // posición física del más antiguo
  private count = 0;
  private pushed = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("WindowLog: capacity debe ser un entero >= 1");
    this.buf = new Array(capacity);
  }

  push(x: T): void {
    if (this.count < this.capacity) {
      this.buf[(this.head + this.count) % this.capacity] = x;
      this.count++;
    } else {
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
    }
    this.pushed++;
  }
  /** Total absoluto empujado. */
  get length(): number {
    return this.pushed;
  }
  /** Índice absoluto del elemento más antiguo retenido. */
  get base(): number {
    return this.pushed - this.count;
  }
  get(i: number): T | undefined {
    if (i < this.base || i >= this.pushed) return undefined;
    return this.buf[(this.head + (i - this.base)) % this.capacity];
  }
  last(): T | undefined {
    return this.count === 0 ? undefined : this.get(this.pushed - 1);
  }
  /** Elementos retenidos, del más antiguo al más reciente. */
  *window(): IterableIterator<T> {
    for (let i = this.base; i < this.pushed; i++) yield this.get(i) as T;
  }
}

export const DEFAULT_FRAME_WINDOW = 512;
export const DEFAULT_EVENT_WINDOW = 8192;
export type FrameLog = WindowLog<any>;
