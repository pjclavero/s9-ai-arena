/**
 * PR C · cableado puro de la carga del worker (testeable sin arrancar main.ts).
 *
 * `main.ts` es un script con efectos (BD, Redis, señales): no se puede importar en un
 * test. Todo lo que decide QUÉ valor llega a cada pieza vive aquí, y `main.ts` sólo
 * esparce estos objetos (`load-config.test.ts` comprueba, por AST, que lo hace).
 * Un valor inválido LANZA (no se degrada al defecto: una errata no debe devolver la
 * carga del incidente sin que nadie lo vea).
 */
import { cpuSampleMsFromEnv } from "./cpu-sampler.js";
import { DEFAULT_CONCURRENCY } from "./concurrency.js";
import { computeConcurrency, concurrencyFromEnv } from "./worker.js";

export interface LoadConfig {
  /** Concurrencia pedida por entorno; `undefined` ⇒ defecto seguro (1); `"auto"` ⇒ por cgroup. */
  concurrency: number | "auto" | undefined;
  /** Concurrencia que realmente aplicará el worker (para el log de arranque). */
  effectiveConcurrency: number;
  /** Intervalo del muestreo de CPU (ms), ya validado. */
  cpuSampleMs: number;
}

export function buildLoadConfig(env: Record<string, string | undefined>): LoadConfig {
  const concurrency = concurrencyFromEnv(env);
  return {
    concurrency,
    effectiveConcurrency:
      concurrency === "auto" ? computeConcurrency() : (concurrency ?? DEFAULT_CONCURRENCY),
    cpuSampleMs: cpuSampleMsFromEnv(env),
  };
}

/** Parte de la config de `TournamentWorker` que depende de la carga. */
export function workerLoadOptions(cfg: LoadConfig): { concurrency: number } {
  return { concurrency: cfg.effectiveConcurrency };
}

/** Parte de las opciones de `containerAgents` que depende de la carga. */
export function executorLoadOptions(cfg: LoadConfig): { cpuSampleMs: number } {
  return { cpuSampleMs: cfg.cpuSampleMs };
}
