/**
 * PR C · Muestreo de la CPU de los contenedores de bot durante una batalla.
 *
 * QUÉ SE MIDE Y PARA QUÉ. `participants.cpu_ms`: la CPU que consumió cada bot,
 * leída del contador ACUMULADO del cgroup (`GET /containers/<id>/stats?stream=false`
 * a través del s9-docker-proxy). Es una métrica informativa (estadísticas de la
 * batalla y detalle para el dueño del bot): NO aplica el límite de CPU —eso lo hace
 * el kernel con `NanoCpus` del create— ni detecta abusos, ni decide resultados.
 * El contador vuelve a cero en cuanto el contenedor termina (y el bot termina al
 * recibir SHUTDOWN, justo al acabar), así que se muestrea DURANTE la batalla y se
 * guarda la última lectura positiva: una COTA INFERIOR, nunca una estimación.
 *
 * POR QUÉ CAMBIÓ (diagnóstico de producción 16/17-nov). Con una muestra cada
 * 500 ms por contenedor el dockerd recibía ~11,6 `stats`/s sostenidos (112 102 de
 * 114 048 peticiones al proxy en 5 h), en una VM de 4 vCPU con soft lockups en
 * `runc`. Además el temporizador NO esperaba a la muestra anterior: un `stats` sin
 * `one-shot` tarda ~1 s en el dockerd (espera a su ciclo de recogida) y, con el
 * dockerd lento, las peticiones se APILABAN —más carga justo cuando menos cabía—.
 *
 * AHORA:
 *  - intervalo por defecto 2 s, acotado a [1 s, 10 s] (`boundedCpuSampleMs`);
 *  - como mucho UNA petición en vuelo por contenedor: si la anterior no ha vuelto,
 *    ese contenedor se salta en ese tick (se cuenta en `stats.skipped`);
 *  - la muestra FINAL reutiliza la que esté en vuelo en vez de abrir otra.
 *
 * QUÉ SE PIERDE. Resolución: la cota inferior puede quedarse corta como mucho en lo
 * que el bot consuma entre la última muestra positiva y su salida, ≤ intervalo ×
 * límite de CPU del contenedor (2 s × 0,5 CPU = 1 000 ms de CPU, frente a los
 * ~150 000 ms de una batalla de 300 s al límite). Nada más depende del muestreo.
 */
import type { ContainerHandle } from "../../bot-manager/src/container-runner.js";

/** Intervalo por defecto entre muestras de CPU de un contenedor (ms). */
export const DEFAULT_CPU_SAMPLE_MS = 2_000;
/** Intervalo mínimo admitido: por debajo, la carga sobre el dockerd vuelve a ser la del incidente. */
export const MIN_CPU_SAMPLE_MS = 1_000;
/** Intervalo máximo admitido: por encima, la cota inferior pierde demasiada resolución. */
export const MAX_CPU_SAMPLE_MS = 10_000;
/** Variable de entorno del intervalo (opcional; tournament-worker). */
export const CPU_SAMPLE_ENV = "TOURNAMENT_WORKER_CPU_SAMPLE_MS";

/** Intervalo efectivo: sin valor (o no finito) ⇒ el defecto; fuera de rango ⇒ el borde. */
export function boundedCpuSampleMs(ms?: number): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_CPU_SAMPLE_MS;
  return Math.min(MAX_CPU_SAMPLE_MS, Math.max(MIN_CPU_SAMPLE_MS, Math.round(ms)));
}

/**
 * Lee `TOURNAMENT_WORKER_CPU_SAMPLE_MS`. Ausente o vacía ⇒ el defecto. Un valor que
 * no es un entero decimal en [MIN, MAX] es un ERROR (no se sustituye en silencio:
 * una errata no debe devolver la carga del incidente sin que nadie lo vea).
 */
export function cpuSampleMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[CPU_SAMPLE_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_CPU_SAMPLE_MS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `${CPU_SAMPLE_ENV} inválida (${JSON.stringify(raw)}): entero en ms entre ${MIN_CPU_SAMPLE_MS} y ${MAX_CPU_SAMPLE_MS}`,
    );
  }
  const n = Number(raw);
  if (n < MIN_CPU_SAMPLE_MS || n > MAX_CPU_SAMPLE_MS) {
    throw new Error(`${CPU_SAMPLE_ENV} fuera de rango (${n}): entre ${MIN_CPU_SAMPLE_MS} y ${MAX_CPU_SAMPLE_MS} ms`);
  }
  return n;
}

/** Lecturas vacías consecutivas (tras una positiva) con las que se da el contenedor por terminado. */
export const DEAD_AFTER = 2;

export interface CpuSamplerStats {
  /** Ticks del temporizador. */
  ticks: number;
  /** Peticiones `cpuMs()` lanzadas (incluida la final). */
  requests: number;
  /** Contenedores saltados en un tick porque su muestra anterior seguía en vuelo. */
  skipped: number;
}

/** Muestreador de UNA batalla. `handles` se lee en cada tick (los lanzamientos lo van llenando). */
export class ContainerCpuSampler {
  /** Última lectura positiva y creciente de cada contenedor (ms de CPU), o null. */
  readonly last: (number | null)[];
  readonly stats: CpuSamplerStats = { ticks: 0, requests: 0, skipped: 0 };
  readonly intervalMs: number;
  private readonly inFlight: (Promise<void> | null)[];
  /** Lecturas no positivas seguidas tras haber leído una positiva (contenedor terminado). */
  private readonly deadStreak: number[];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly handles: readonly (ContainerHandle | null)[],
    intervalMs?: number,
  ) {
    this.intervalMs = boundedCpuSampleMs(intervalMs);
    this.last = handles.map(() => null);
    this.inFlight = handles.map(() => null);
    this.deadStreak = handles.map(() => 0);
  }

  /** Un contenedor que ya dio CPU y luego devuelve DEAD_AFTER lecturas vacías seguidas terminó: no se vuelve a consultar. */
  private isDead(i: number): boolean {
    return this.deadStreak[i] >= DEAD_AFTER;
  }

  /** Arranca el temporizador y lo devuelve (para registrarlo en el teardown). */
  start(): ReturnType<typeof setInterval> {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this.timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Un tick: una petición por contenedor que NO tenga ya una en vuelo. */
  tick(): void {
    this.stats.ticks++;
    for (let i = 0; i < this.handles.length; i++) {
      if (this.isDead(i)) continue;
      if (this.inFlight[i]) {
        this.stats.skipped++;
        continue;
      }
      this.sampleOne(i);
    }
  }

  /**
   * Muestra final: para el temporizador y espera una lectura de cada contenedor
   * (la que ya esté en vuelo, o una nueva). Nunca rechaza; el llamador la acota.
   */
  async final(): Promise<void> {
    this.stop();
    await Promise.all(
      this.handles.map((_h, i) => this.inFlight[i] ?? (this.isDead(i) ? Promise.resolve() : this.sampleOne(i))),
    );
  }

  private sampleOne(i: number): Promise<void> {
    const h = this.handles[i];
    if (!h?.cpuMs) return Promise.resolve();
    this.stats.requests++;
    const p = (async () => {
      try {
        const v = (await h.cpuMs!()) ?? null;
        if (typeof v === "number" && v > 0) {
          this.deadStreak[i] = 0;
          if (this.last[i] === null || v > this.last[i]!) this.last[i] = v;
        } else if (this.last[i] !== null) {
          this.deadStreak[i]++;
        }
      } catch {
        /* muestra perdida: se queda la anterior (cota inferior) */
      } finally {
        this.inFlight[i] = null;
      }
    })();
    this.inFlight[i] = p;
    return p;
  }
}
