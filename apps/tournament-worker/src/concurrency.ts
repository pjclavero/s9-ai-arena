/**
 * V1 · B1 (AUD2-10) · concurrencia segura del worker.
 *
 * - POR DEFECTO 1 batalla simultánea (`DEFAULT_CONCURRENCY`). Más sólo si el operador
 *   lo pide: entero 1..16 o `auto`.
 * - `auto` calcula con los límites EFECTIVOS del cgroup del proceso (CPU y memoria),
 *   no con los del host (`os.cpus()`/`os.totalmem()`), y presupuesta por el tamaño de
 *   la batalla: una 4v4 son 8 contenedores de bot (0,5 CPU y 256 MiB cada uno, más el
 *   motor en proceso).
 *
 * Todo es puro: el lector del sistema de ficheros se inyecta para simular cgroups.
 */
import { readFileSync } from "node:fs";
import { cpus, totalmem, freemem } from "node:os";

/** Concurrencia por defecto: una batalla por worker (instalaciones nuevas y sin variable). */
export const DEFAULT_CONCURRENCY = 1;
/** Valor explícito que activa el cálculo automático. */
export const AUTO_CONCURRENCY = "auto";
/** CPU que reserva cada contenedor de bot (`DEFAULT_LIMITS.cpus` de bot-manager). */
export const BOT_CPU = 0.5;
/** Memoria (GiB) de cada contenedor de bot (256 MiB). */
export const BOT_MEM_GIB = 0.25;
/** Memoria (GiB) fija por batalla para el motor en proceso, el replay y el stream. */
export const ENGINE_MEM_GIB = 0.5;
/** Bots de la batalla más grande soportada (4v4). */
export const DEFAULT_MAX_BOTS_PER_BATTLE = 8;
/** CPU que se deja libre para el propio worker, Postgres y dockerd. */
export const RESERVED_CPU = 0.5;

export interface Resources {
  /** CPUs efectivas (decimal). */
  cpus: number;
  /** Memoria libre para batallas, en GiB. */
  memGiB: number;
  origen: "cgroup-v2" | "cgroup-v1" | "host";
}

export type FileReader = (path: string) => string | undefined;

export const readFileOrUndefined: FileReader = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (!/^[0-9]+$/.test(t)) return undefined; // "max" o basura ⇒ sin límite
  const n = Number(t);
  // v1 representa «sin límite» con un número enorme (~2^63)
  return n > 2 ** 60 ? undefined : n;
};

/** Límites del cgroup (v2, luego v1). `undefined` en cada campo = sin límite conocido. */
export function readCgroupLimits(read: FileReader = readFileOrUndefined): {
  cpus?: number;
  memBytes?: number;
  memUsedBytes?: number;
  origen: "cgroup-v2" | "cgroup-v1" | "host";
} {
  const cpuMax = read("/sys/fs/cgroup/cpu.max");
  const memMax = read("/sys/fs/cgroup/memory.max");
  if (cpuMax !== undefined || memMax !== undefined) {
    let c: number | undefined;
    if (cpuMax !== undefined) {
      const [q, p] = cpuMax.trim().split(/\s+/);
      const quota = num(q);
      const period = num(p);
      if (quota !== undefined && period !== undefined && period > 0) c = quota / period;
    }
    return {
      cpus: c,
      memBytes: num(memMax),
      memUsedBytes: num(read("/sys/fs/cgroup/memory.current")),
      origen: "cgroup-v2",
    };
  }
  const quota1 = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const mem1 = read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (quota1 !== undefined || mem1 !== undefined) {
    const q = quota1 !== undefined && /^-?\d+$/.test(quota1.trim()) ? Number(quota1.trim()) : -1;
    const p = num(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    return {
      cpus: q > 0 && p ? q / p : undefined,
      memBytes: num(mem1),
      memUsedBytes: num(read("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
      origen: "cgroup-v1",
    };
  }
  return { origen: "host" };
}

export interface HostView {
  cpuCount: number;
  totalMemBytes: number;
  freeMemBytes: number;
}

export const hostView = (): HostView => ({
  cpuCount: cpus().length,
  totalMemBytes: totalmem(),
  freeMemBytes: freemem(),
});

/** Recursos efectivos: el MÍNIMO entre el cgroup y el host (el cgroup nunca da más que el host). */
export function effectiveResources(read: FileReader = readFileOrUndefined, host: HostView = hostView()): Resources {
  const cg = readCgroupLimits(read);
  const GiB = 1024 ** 3;
  const cpu = cg.cpus !== undefined ? Math.min(cg.cpus, host.cpuCount) : host.cpuCount;
  let memBytes: number;
  if (cg.memBytes !== undefined && cg.memBytes < host.totalMemBytes) {
    // Memoria libre DENTRO del cgroup, nunca más que la libre del host.
    memBytes = Math.min(Math.max(0, cg.memBytes - (cg.memUsedBytes ?? 0)), host.freeMemBytes);
  } else {
    memBytes = host.freeMemBytes;
  }
  return { cpus: cpu, memGiB: memBytes / GiB, origen: cg.origen };
}

/**
 * Batallas simultáneas que caben:
 * `min((cpus − 0,5) / (0,5·bots), mem_libre / (0,25 GiB·bots + 0,5 GiB))`, mínimo 1 y tope `cap`.
 * Con `bots` = 8 (4v4), 4 CPU y 8 GiB libres ⇒ 1.
 */
export function computeAutoConcurrency(
  res: Pick<Resources, "cpus" | "memGiB">,
  botsPerBattle: number = DEFAULT_MAX_BOTS_PER_BATTLE,
  cap = 16,
): number {
  // Fallo seguro: una entrada no finita (NaN, Infinity) nunca sube la concurrencia.
  if (
    !Number.isFinite(res.cpus) ||
    !Number.isFinite(res.memGiB) ||
    !Number.isFinite(botsPerBattle) ||
    !Number.isFinite(cap)
  ) {
    return 1;
  }
  const bots = Math.max(1, Math.floor(botsPerBattle));
  const porCpu = Math.floor(Math.max(0, res.cpus - RESERVED_CPU) / (BOT_CPU * bots));
  const porMem = Math.floor(res.memGiB / (BOT_MEM_GIB * bots + ENGINE_MEM_GIB));
  return Math.max(1, Math.min(cap, porCpu, porMem));
}
