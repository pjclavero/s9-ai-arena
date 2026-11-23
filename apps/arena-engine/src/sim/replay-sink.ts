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
 *
 * CONTRATO DE FALLO DEL SINK (lo aplica `Battle`, no el sink):
 *  - Un método del sink PUEDE lanzar (tope de memoria `ReplaySinkOverflowError`, disco lleno
 *    o EIO en un adaptador de PR-3, etc.). `Battle` captura la excepción dentro de `step()`,
 *    deja de llamar al sink, guarda `battle.recordingFault = { cause, stream, tick }` y
 *    termina la batalla de forma limpia AL FINAL de ese tick (nunca a mitad de un paso):
 *    `winner: null`, hash final válido, sin lanzar. El motivo se identifica por
 *    `battle.recordingFault` (no se amplía `BattleResult.endReason`: es contrato de
 *    battle-result/v1 y lo decide PR-5, D-3).
 *  - PR-5 mapea `recordingFault` a `recording_limit` (clase A: tope de la batalla) o a
 *    `InfrastructureFailure("storage_unavailable")` (clase B: entorno) según `cause`.
 *  - Si el fallo ocurre dentro de `finish()` (p. ej. el snapshot final), el resultado es el
 *    normal pero `recordingFault` queda fijado: el replay está incompleto y quien lo cierra
 *    debe tratarlo como tal.
 *  - Los frames y eventos que se entregan al sink los comparte la ventana del directo: el sink
 *    NO debe mutarlos.
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
/**
 * Topes derivados de los parámetros REALES de la batalla (con 10 % de margen y unos
 * registros de holgura para el snapshot y el checkpoint finales): lo que una batalla que
 * respeta su límite de ticks puede producir como máximo. Una batalla de 45 000 ticks x 8
 * vehículos con snapshot cada 3, hash cada 30 y checkpoint cada 300 da ≈ 396 000 comandos,
 * 16 500 snapshots, 1 650 hashes y 165 checkpoints (no los 2 M / 200 k de antes).
 */
export function memoryLimitsFor(p: {
  maxTicks: number;
  vehicles: number;
  snapshotEvery: number;
  hashEvery: number;
  checkpointEvery: number;
}): MemoryReplaySinkLimits {
  // Falla CERRADO: un parámetro no finito (NaN, Infinity) o absurdo nunca produce topes
  // infinitos o NaN (una comparación con NaN es siempre falsa y dejaría el sink sin tope).
  const pos = (x: number, def: number, max: number) => (Number.isFinite(x) && x > 0 ? Math.min(x, max) : def);
  const ticks = Math.ceil(pos(p.maxTicks, 45_000, 10_000_000));
  const vehicles = Math.ceil(pos(p.vehicles, 8, 1_000));
  const cadence = (every: number, def: number) => (Number.isFinite(every) ? every : def);
  const per = (every0: number, def: number) => {
    const every = cadence(every0, def);
    return every > 0 ? Math.ceil((ticks / every) * 1.1) + 4 : 4;
  };
  return {
    maxCommands: Math.ceil(ticks * vehicles * 1.1) + 16,
    maxSnapshots: per(p.snapshotEvery, 3),
    // eventos públicos: bajas, minas, prórroga…; <= 1 por tick de media + holgura
    maxEvents: ticks + 1024,
    maxHashes: per(p.hashEvery, 30),
    maxCheckpoints: per(p.checkpointEvery, 300),
  };
}
/** Sin parámetros de batalla (uso suelto del sink): los de una batalla de 45 000 ticks x 8 vehículos. */
export const DEFAULT_MEMORY_LIMITS: MemoryReplaySinkLimits = memoryLimitsFor({
  maxTicks: 45_000,
  vehicles: 8,
  snapshotEvery: 3,
  hashEvery: 30,
  checkpointEvery: 300,
});

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

  private evictCbs: ((absIndex: number, item: T) => void)[] = [];

  /**
   * Avisa SÍNCRONAMENTE de cada elemento que sale de la ventana (antes de perderse). Permite
   * a un consumidor lento procesar lo que va a perder sin que el motor retenga memoria.
   * Un fallo del callback no afecta al motor. Devuelve la función para darse de baja.
   */
  onEvict(cb: (absIndex: number, item: T) => void): () => void {
    this.evictCbs.push(cb);
    return () => {
      this.evictCbs = this.evictCbs.filter((c) => c !== cb);
    };
  }

  push(x: T): void {
    if (this.count < this.capacity) {
      this.buf[(this.head + this.count) % this.capacity] = x;
      this.count++;
    } else {
      const old = this.buf[this.head] as T;
      const idx = this.pushed - this.count;
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
      for (const cb of this.evictCbs) {
        try {
          cb(idx, old);
        } catch {
          /* un consumidor roto no puede romper el motor */
        }
      }
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
