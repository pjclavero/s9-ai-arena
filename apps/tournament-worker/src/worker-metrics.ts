/**
 * V1-P0 · Métricas Prometheus del tournament-worker (heap/RSS, reintentos, trabajos aparcados,
 * batallas huérfanas). Mismo patrón que `apps/api/src/metrics.ts` y `apps/streamer/src/metrics.ts`:
 * registro en memoria, formato de texto a mano (sin `prom-client`) y CAPABILITY apagada por
 * defecto (`S9_METRICS_ENABLED=1`). El worker no expone HTTP de negocio: este servidor sólo sirve
 * `GET /metrics` en `WORKER_METRICS_PORT` (def. 8086), dentro de la red interna.
 *
 * Contadores (counter) que mantiene el propio proceso:
 *   s9_worker_job_retries_total               reclamos de un trabajo con attempts > 1
 *   s9_worker_jobs_parked_total               huérfanos con intentos agotados → needs_review
 *   s9_worker_orphans_requeued_total          batallas huérfanas reencoladas por el barrido
 *   s9_worker_orphans_failed_total            batallas huérfanas pasadas a `failed` por el barrido
 *   s9_worker_orphan_containers_removed_total contenedores de bot retirados por el reaper
 * Gauges de BD (los fija el barrido, cada pasada):
 *   s9_worker_jobs_needs_review               trabajos en revisión manual
 *   s9_worker_battles_lease_expired           batallas `running` con el lease vencido
 * Gauges de proceso (se leen al renderizar):
 *   s9_worker_heap_used_bytes, s9_worker_heap_limit_bytes, s9_worker_rss_bytes
 */
import { createServer, type Server } from "node:http";
import { getHeapStatistics } from "node:v8";

export type WorkerCounter =
  | "job_retries_total"
  | "jobs_parked_total"
  | "orphans_requeued_total"
  | "orphans_failed_total"
  | "orphan_containers_removed_total";
export type WorkerGauge = "jobs_needs_review" | "battles_lease_expired";

const COUNTERS: Record<WorkerCounter, string> = {
  job_retries_total: "Trabajos reclamados por segunda vez o mas (reintentos)",
  jobs_parked_total: "Trabajos huerfanos con intentos agotados pasados a needs_review",
  orphans_requeued_total: "Batallas huerfanas (lease vencido) reencoladas por el barrido",
  orphans_failed_total: "Batallas huerfanas (lease vencido) pasadas a failed por el barrido",
  orphan_containers_removed_total: "Contenedores de bot huerfanos retirados por el reaper",
};
const GAUGES: Record<WorkerGauge, string> = {
  jobs_needs_review: "Trabajos en needs_review (revision manual)",
  battles_lease_expired: "Batallas running con el lease vencido",
};

export class WorkerMetrics {
  private counters = new Map<WorkerCounter, number>();
  private gauges = new Map<WorkerGauge, number>();

  inc(name: WorkerCounter, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  set(name: WorkerGauge, value: number): void {
    if (Number.isFinite(value)) this.gauges.set(name, value);
  }
  counter(name: WorkerCounter): number {
    return this.counters.get(name) ?? 0;
  }
  gauge(name: WorkerGauge): number | undefined {
    return this.gauges.get(name);
  }
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }

  render(): string {
    const out: string[] = [];
    const mem = process.memoryUsage();
    const proc: [string, string, number][] = [
      ["s9_worker_up", "El worker esta en marcha", 1],
      ["s9_worker_heap_used_bytes", "Heap de V8 usado", mem.heapUsed],
      [
        "s9_worker_heap_limit_bytes",
        "Limite del heap de V8 (--max-old-space-size)",
        getHeapStatistics().heap_size_limit,
      ],
      ["s9_worker_rss_bytes", "RSS del proceso", mem.rss],
    ];
    for (const [n, help, v] of proc) out.push(`# HELP ${n} ${help}`, `# TYPE ${n} gauge`, `${n} ${v}`);
    for (const k of Object.keys(COUNTERS) as WorkerCounter[]) {
      out.push(
        `# HELP s9_worker_${k} ${COUNTERS[k]}`,
        `# TYPE s9_worker_${k} counter`,
        `s9_worker_${k} ${this.counter(k)}`,
      );
    }
    for (const k of Object.keys(GAUGES) as WorkerGauge[]) {
      const v = this.gauges.get(k);
      if (v === undefined) continue; // sin medir no es 0: las alertas no deben ver un 0 inventado
      out.push(`# HELP s9_worker_${k} ${GAUGES[k]}`, `# TYPE s9_worker_${k} gauge`, `s9_worker_${k} ${v}`);
    }
    return out.join("\n") + "\n";
  }
}

/** Singleton del proceso (mismo patron que `defaultBattleResources`). */
export const workerMetrics = new WorkerMetrics();

/** S9_METRICS_ENABLED === "1" | "true". Apagada por defecto. */
export function workerMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.S9_METRICS_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** Sirve `GET /metrics`. Devuelve el servidor (para cerrarlo). */
export function startMetricsServer(port: number, metrics: WorkerMetrics = workerMetrics): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metrics.render());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  server.unref();
  return server;
}
