/**
 * V1 REPLAYS · PR-5 · Presupuesto de almacenamiento de UNA grabación (cuota, reserva y tope por batalla).
 *
 * Se consulta ANTES de cada fragmento de datos que cualquiera de los dos escritores (receta, vista)
 * va a escribir (`WriterOptions.admit`), no sólo al empezar ni al terminar. DOS clases de fallo, con
 * política distinta (decisión D-PR3-3):
 *
 *  - CLASE A · el límite es de la PROPIA batalla (`maxBytesPerBattle`, receta + vista juntas):
 *    `ReplayLimitExceededError`. Es determinista (la misma batalla vuelve a superarlo), así que NO se
 *    reintenta: el grabador cierra el replay como TRUNCADO y la batalla termina sin resultado
 *    deportivo (`recording_limit`).
 *  - CLASE B · el límite es del ENTORNO (reserva de espacio físico libre o cuota lógica del volumen):
 *    `RecordingBudgetError` (un `StorageError`): envenena el escritor, se borran los parciales y la
 *    batalla se reintenta como `storage_unavailable` con la política existente.
 *
 * Orden: primero el entorno (B) y después la batalla (A). Si el volumen no admite escribir, no se
 * sella nada «truncado» en él; es el reintento (con espacio) el que decide si la batalla supera su tope.
 *
 * Valores EN CALIENTE: `limits()` se lee en CADA fragmento (cuota y reserva cambian al siguiente
 * fragmento). El tope por batalla se FIJA al empezar el intento (`maxBytesPerBattle`): un intento en
 * curso conserva el valor con el que empezó.
 *
 * El CIERRE (`ctx.closing`: último fragmento de datos) no aplica la reserva ni la cuota: el replay ya
 * está casi completo y la reserva existe, precisamente, para poder cerrarlo. Resultado, índice y pie
 * usan `emergencyBytes` del escritor y no pasan por aquí.
 */
import { ReplayLimitExceededError, StorageError } from "./errors.js";

/** Valores vigentes de las tres claves `replays.*` (ya validadas y recortadas al techo del entorno). */
export interface ReplayLimits {
  /** Cuota lógica máxima del volumen de replays. */
  quotaMaxBytes: number;
  /** Reserva mínima de espacio físico libre. */
  minFreeBytes: number;
  /** Tope de un intento (receta + vista). */
  maxBytesPerBattle: number;
}

/** Cómo mide el presupuesto el volumen. La implementación real (statfs + BD) vive en el worker. */
export interface StorageProbe {
  /** Bytes FÍSICOS libres en el volumen de replays. */
  freeBytes(): Promise<number>;
  /**
   * Bytes ya ocupados por el volumen que NO son de este intento: publicados y en papelera (BD) más
   * parciales ajenos. `excludePartials` son los parciales del propio intento (sus bytes entran por
   * `own`, que se conoce con exactitud).
   */
  usedBytes(excludePartials: readonly string[]): Promise<number>;
}

export type BudgetDenial = "quota_exceeded" | "free_space_low";

/** Clase B: el volumen no admite escribir. Es un `StorageError`, así que envenena al escritor. */
export class RecordingBudgetError extends StorageError {
  readonly denial: BudgetDenial;
  readonly phase: "preflight" | "fragment";
  constructor(denial: BudgetDenial, phase: "preflight" | "fragment", detail: string) {
    super(denial, phase === "preflight" ? "preflight" : "admit", new Error(detail));
    this.denial = denial;
    this.phase = phase;
  }
}

export interface RecordingBudgetOptions {
  /** Síncrona y en caliente: se llama en cada fragmento. */
  limits: () => ReplayLimits;
  /** Sin sonda (sólo tests): no hay reserva ni cuota del volumen, sólo el tope por batalla. */
  probe?: StorageProbe;
  /** Rutas de los parciales de este intento (se excluyen del uso ajeno). */
  ownPartials: readonly string[];
}

/** Comprobación de la compuerta previa: ¿cabe, como mínimo, una batalla entera de tamaño máximo? */
export async function preflightCheck(o: { limits: ReplayLimits; probe: StorageProbe }): Promise<void> {
  const { limits, probe } = o;
  const free = await probe.freeBytes();
  if (free - limits.maxBytesPerBattle < limits.minFreeBytes) {
    throw new RecordingBudgetError(
      "free_space_low",
      "preflight",
      `libre ${free} B: no queda hueco para ${limits.maxBytesPerBattle} B de batalla y la reserva de ${limits.minFreeBytes} B`,
    );
  }
  const used = await probe.usedBytes([]);
  if (used + limits.maxBytesPerBattle > limits.quotaMaxBytes) {
    throw new RecordingBudgetError(
      "quota_exceeded",
      "preflight",
      `usado ${used} B: no cabe una batalla de ${limits.maxBytesPerBattle} B en la cuota de ${limits.quotaMaxBytes} B`,
    );
  }
}

export class RecordingBudget {
  /** Tope por batalla FIJADO al empezar el intento. */
  readonly maxBytesPerBattle: number;

  constructor(private readonly o: RecordingBudgetOptions) {
    this.maxBytesPerBattle = o.limits().maxBytesPerBattle;
  }

  /**
   * Admite (o no) escribir `frameBytes` más. `own` = bytes ya escritos por este intento (receta + vista).
   * Lanza `RecordingBudgetError` (clase B) o `ReplayLimitExceededError` (clase A); si no lanza, se escribe.
   */
  async admit(frameBytes: number, ctx: { closing: boolean }, own: number): Promise<void> {
    if (!ctx.closing && this.o.probe) {
      const l = this.o.limits(); // EN CALIENTE: cuota y reserva del momento
      const free = await this.o.probe.freeBytes();
      if (free - frameBytes < l.minFreeBytes) {
        throw new RecordingBudgetError(
          "free_space_low",
          "fragment",
          `libre ${free} B: escribir ${frameBytes} B dejaría el volumen por debajo de la reserva de ${l.minFreeBytes} B`,
        );
      }
      const used = await this.o.probe.usedBytes(this.o.ownPartials);
      if (used + own + frameBytes > l.quotaMaxBytes) {
        throw new RecordingBudgetError(
          "quota_exceeded",
          "fragment",
          `usado ${used + own} B (+${frameBytes} B) superaría la cuota de ${l.quotaMaxBytes} B`,
        );
      }
    }
    if (own + frameBytes > this.maxBytesPerBattle) {
      throw new ReplayLimitExceededError(this.maxBytesPerBattle, own + frameBytes);
    }
  }
}
