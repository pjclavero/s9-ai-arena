/**
 * OLA2-MF · Observabilidad SENCILLA de memoria por batalla.
 *
 * Cuatro lecturas por batalla, en una línea JSON (`battle_memory`):
 *   RAM_IDLE_BEFORE   antes de reservar nada para la batalla;
 *   RAM_PEAK          máximo muestreado mientras corre (cada `sampleMs`);
 *   RAM_AFTER_FINISH  con el resultado ya calculado, ANTES del teardown;
 *   RAM_AFTER_CLEANUP tras el teardown.
 * De cada lectura: RSS y heap del proceso del worker (BATTLE_RSS: el motor y el
 * ProtocolServer viven aquí) y, si se puede leer, la memoria del cgroup del
 * contenedor del worker y `MemAvailable` del sistema. Nada más: sin agentes, sin
 * series, sin `drop_caches` (prohibido: ocultaría fugas reales).
 *
 * La memoria de los contenedores de bot (BOT_RSS) la mide el banco de VM112 con
 * `docker stats`; desde aquí el proxy sólo deja leer CPU.
 */
import { readFileSync } from "node:fs";

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
  /** memory.current del cgroup del proceso (cgroup v2), o null. */
  cgroupMb: number | null;
  /** MemAvailable del sistema visible, o null. */
  availableMb: number | null;
}

const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

function readNumberFile(path: string): number | null {
  try {
    const v = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function memAvailableMb(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch {
    return null;
  }
}

export function sampleMemory(): MemorySample {
  const u = process.memoryUsage();
  const cg = readNumberFile("/sys/fs/cgroup/memory.current");
  return {
    rssMb: mb(u.rss),
    heapUsedMb: mb(u.heapUsed),
    cgroupMb: cg === null ? null : mb(cg),
    availableMb: memAvailableMb(),
  };
}

export interface BattleMemoryReport {
  battleId: string;
  RAM_IDLE_BEFORE: MemorySample;
  RAM_PEAK: MemorySample;
  RAM_AFTER_FINISH: MemorySample | null;
  RAM_AFTER_CLEANUP: MemorySample | null;
  samples: number;
}

/** Medidor de UNA batalla. `stop()` detiene el muestreo (también lo hace el teardown). */
export class BattleMemoryMeter {
  readonly report: BattleMemoryReport;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    battleId: string,
    private readonly sample: () => MemorySample = sampleMemory,
    sampleMs = 1000,
  ) {
    const first = this.sample();
    this.report = {
      battleId,
      RAM_IDLE_BEFORE: first,
      RAM_PEAK: { ...first },
      RAM_AFTER_FINISH: null,
      RAM_AFTER_CLEANUP: null,
      samples: 1,
    };
    this.timer = setInterval(() => this.tick(), sampleMs);
    this.timer.unref?.();
  }

  get handle(): ReturnType<typeof setInterval> | undefined {
    return this.timer;
  }

  private tick(): MemorySample {
    const s = this.sample();
    this.report.samples++;
    const p = this.report.RAM_PEAK;
    p.rssMb = Math.max(p.rssMb, s.rssMb);
    p.heapUsedMb = Math.max(p.heapUsedMb, s.heapUsedMb);
    if (s.cgroupMb !== null) p.cgroupMb = Math.max(p.cgroupMb ?? 0, s.cgroupMb);
    if (s.availableMb !== null) p.availableMb = Math.min(p.availableMb ?? Infinity, s.availableMb);
    return s;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  markFinished(): void {
    this.report.RAM_AFTER_FINISH = this.tick();
  }

  markCleaned(): BattleMemoryReport {
    this.stop();
    this.report.RAM_AFTER_CLEANUP = this.tick();
    return this.report;
  }
}
