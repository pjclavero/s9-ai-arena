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

export class TournamentWorker {
  readonly workerId: string;
  private running = false;
  private loops: Promise<void>[] = [];

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
      if (!hadWork && this.running) {
        if (this.config.signal) {
          await this.config.signal.wait("jobs", Math.ceil(pollMs / 1000)).catch(() => undefined);
        } else {
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }
}
