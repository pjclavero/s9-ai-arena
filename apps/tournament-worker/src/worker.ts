/**
 * E9 · T9.1 — tournament-worker: bucle de consumo de la cola (cap. 8 + 9.4).
 *
 * Estrategia de procesos del 9.4: UNA batalla por hueco de worker; la
 * concurrencia (número de huecos) se deriva de CPU/RAM configuradas. Cada hueco
 * reclama un trabajo con bloqueo distribuido (queue.ts) y lo procesa entero.
 *
 * Reintentos (19.2): un handler puede terminar en…
 *  - éxito → done.
 *  - SportingFailure → el handler ya registró la derrota deportiva; done, SIN reintento.
 *  - InfrastructureFailure → reintento con límite; agotado → needs_review + onExhausted.
 *  - cualquier otro error (bug) → needs_review directo (solo se reintenta infraestructura).
 */
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import type { Knex } from "knex";
import {
  claimJob,
  completeJob,
  failJobInfrastructure,
  failJobUnclassified,
  JOB_KINDS,
  type JobKind,
  type JobRow,
} from "./queue.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";
import type { RedisSignal } from "./redis-signal.js";

export interface HandlerContext {
  db: Knex;
  workerId: string;
}

export type JobHandler = (job: JobRow, ctx: HandlerContext) => Promise<void>;

export interface WorkerConfig {
  db: Knex;
  handlers: Partial<Record<JobKind, JobHandler>>;
  workerId?: string;
  kinds?: JobKind[];
  /** Huecos de ejecución simultánea (9.4). Por defecto, derivado de CPU/RAM. */
  concurrency?: number;
  lockTimeoutMs?: number;
  pollMs?: number;
  /** Aviso opcional por Redis; sin él, el worker hace polling de la BD. */
  signal?: RedisSignal;
  /**
   * Margen sobre el timeout de BLPOP antes de dar la espera por perdida. Si el
   * canal muere de una forma que no rechaza (socket a medio morir, red que se
   * traga los paquetes), la espera NO puede quedarse colgada: el bucle perdería
   * su único freno... y también su único avance.
   */
  signalGraceMs?: number;
  /** Cada cuánto se reintenta la señal una vez degradado a polling. */
  signalRetryMs?: number;
  /** Se llama en cada fallo del canal de aviso: degradar NO es hacerlo en silencio. */
  onSignalError?: (err: unknown, estado: { degradado: boolean; fallos: number }) => void;
  /** Al agotar reintentos de infraestructura (needs_review): marcado manual. */
  onExhausted?: (job: JobRow, ctx: HandlerContext) => Promise<void>;
}

/**
 * 9.4: una batalla por worker; concurrencia según CPU/RAM configurada.
 * Reserva un núcleo para el motor/SO y presupuesta ~2 GB por batalla.
 */
export function computeConcurrency(env: { cpuCount?: number; memMb?: number } = {}): number {
  const cpuCount = env.cpuCount ?? cpus().length;
  const memMb = env.memMb ?? Math.floor(totalmem() / (1024 * 1024));
  return Math.max(1, Math.min(cpuCount - 1, Math.floor(memMb / 2048)));
}

/** Promesa con vencimiento: ni un `await` del bucle puede durar para siempre. */
export async function conVencimiento<T>(promesa: Promise<T>, ms: number, motivo: string): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_, reject) => {
        temporizador = setTimeout(() => reject(new Error(motivo)), ms);
      }),
    ]);
  } finally {
    if (temporizador) clearTimeout(temporizador);
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TournamentWorker {
  readonly workerId: string;
  private running = false;
  private loops: Promise<void>[] = [];
  /** true = el canal de aviso está caído y el bucle va por polling de la BD. */
  private signalDegradado = false;
  private ultimoReintentoSignal = 0;
  /** Observable a propósito: una degradación silenciosa es una degradación que nadie ve. */
  readonly signalStats = { fallos: 0, vencimientos: 0, pausasDegradadas: 0, reconexiones: 0 };

  /** ¿El bucle está degradado a polling ahora mismo? */
  get degradado(): boolean {
    return this.signalDegradado;
  }

  constructor(private readonly config: WorkerConfig) {
    this.workerId = config.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  }

  private get kinds(): JobKind[] {
    return this.config.kinds ?? JOB_KINDS.filter((k) => this.config.handlers[k]);
  }

  /**
   * Reclama y procesa UN trabajo. Devuelve true si había trabajo.
   * Es la unidad que usan los tests (y el bucle start()).
   */
  async runOnce(now?: Date): Promise<boolean> {
    const { db } = this.config;
    const job = await claimJob(db, {
      workerId: this.workerId,
      kinds: this.kinds,
      lockTimeoutMs: this.config.lockTimeoutMs,
      now,
    });
    if (!job) return false;

    const ctx: HandlerContext = { db, workerId: this.workerId };
    const handler = this.config.handlers[job.kind];
    try {
      if (!handler) throw new Error(`Sin handler para el tipo de trabajo '${job.kind}'`);
      await handler(job, ctx);
      await completeJob(db, job.id);
    } catch (err) {
      if (err instanceof SportingFailure) {
        // Derrota deportiva (19.2): el handler ya la registró como resultado.
        // El trabajo está COMPLETO: no hay nada que reintentar.
        await completeJob(db, job.id, { sportingFailure: err.code });
      } else if (err instanceof InfrastructureFailure) {
        const { parked } = await failJobInfrastructure(db, job, err.code, err.message, { now });
        if (parked) await this.config.onExhausted?.(job, ctx);
      } else {
        await failJobUnclassified(db, job, err instanceof Error ? err.message : String(err));
        await this.config.onExhausted?.(job, ctx);
      }
    }
    return true;
  }

  /** Vacía la cola: procesa hasta que no quede trabajo elegible (para tests y dry-runs). */
  async drain(maxJobs = 1000, now?: Date): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce(now))) n++;
    return n;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const slots = this.config.concurrency ?? computeConcurrency();
    for (let i = 0; i < slots; i++) this.loops.push(this.loop());
  }

  private async loop(): Promise<void> {
    const pollMs = this.config.pollMs ?? 1000;
    while (this.running) {
      let hadWork = false;
      try {
        hadWork = await this.runOnce();
      } catch {
        // Error de BD en el propio claim: espera y reintenta (el trabajo sigue en la tabla).
      }
      if (!hadWork && this.running) await this.pausar(pollMs);
    }
  }

  /**
   * LA PAUSA DEL BUCLE, y por qué es así.
   *
   * MEDIDO en laboratorio aislado (worker real + Redis real, matando el Redis
   * DESPUÉS del arranque), con el código anterior —`signal.wait(...).catch(() =>
   * undefined)`—: BLPOP se quedaba esperando una respuesta que jamás llegaba
   * porque RedisSignal no rechazaba a sus waiters al morir el socket. Resultado
   * en 7 s sin Redis: UNA sola consulta a la BD (frente a 1/s con Redis vivo),
   * 0,1 % de CPU, y CERO consultas en los 8 s posteriores a restaurar Redis. Ni
   * giro sin freno ni degradación limpia: PARÁLISIS PERMANENTE Y SILENCIOSA,
   * con el heartbeat (un setInterval aparte) pintando el healthcheck en verde y
   * `stop()` colgado para siempre.
   *
   * Ahora la pausa garantiza las tres cosas a la vez:
   *   1. NUNCA se pierde el freno: si la señal falla, se duerme lo que le
   *      quedaba a la pausa (sin esto, un rechazo inmediato es un bucle girando
   *      a toda velocidad contra la BD).
   *   2. NUNCA se pierde el avance: la espera tiene vencimiento, así que un
   *      canal que no rechaza tampoco puede parar el bucle.
   *   3. El fallo se cuenta y se notifica (onSignalError), y se reintenta la
   *      reconexión: al volver Redis, el worker vuelve a modo aviso solo.
   */
  private async pausar(pollMs: number): Promise<void> {
    const signal = this.config.signal;
    const inicio = Date.now();

    if (signal && !this.signalDegradado) {
      const timeoutS = Math.max(1, Math.ceil(pollMs / 1000));
      const espera = signal.wait("jobs", timeoutS);
      // Si vence, la promesa de abajo puede rechazar más tarde: se neutraliza
      // aquí para no dejar un unhandledRejection suelto.
      espera.catch(() => undefined);
      try {
        await conVencimiento(espera, timeoutS * 1000 + (this.config.signalGraceMs ?? 2000), "signal.wait vencido");
        return;
      } catch (err) {
        this.signalDegradado = true;
        this.signalStats.fallos++;
        if (String((err as Error)?.message).includes("vencido")) this.signalStats.vencimientos++;
        this.ultimoReintentoSignal = Date.now();
        this.config.onSignalError?.(err, { degradado: true, fallos: this.signalStats.fallos });
      }
    }

    if (signal && this.signalDegradado) {
      this.signalStats.pausasDegradadas++;
      await this.reintentarSignal(signal);
    }

    const restante = pollMs - (Date.now() - inicio);
    if (restante > 0) await dormir(restante);
  }

  /** Reintento de reconexión con freno: como mucho uno cada signalRetryMs. */
  private async reintentarSignal(signal: RedisSignal): Promise<void> {
    const cada = this.config.signalRetryMs ?? 5_000;
    if (Date.now() - this.ultimoReintentoSignal < cada) return;
    this.ultimoReintentoSignal = Date.now();
    try {
      await conVencimiento(signal.connect(), cada, "signal.connect vencido");
      this.signalDegradado = false;
      this.signalStats.reconexiones++;
      this.config.onSignalError?.(null, { degradado: false, fallos: this.signalStats.fallos });
    } catch (err) {
      this.config.onSignalError?.(err, { degradado: true, fallos: this.signalStats.fallos });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }
}
