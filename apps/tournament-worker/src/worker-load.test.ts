/**
 * PR C · carga de la VM de batallas: concurrencia configurable y muestreo de CPU
 * espaciado. Cada test lleva el nombre del mutante que lo mata
 * (scripts/mutants-worker-load.sh).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedCpuSampleMs,
  ContainerCpuSampler,
  cpuSampleMsFromEnv,
  DEFAULT_CPU_SAMPLE_MS,
  MAX_CPU_SAMPLE_MS,
  MIN_CPU_SAMPLE_MS,
} from "./cpu-sampler.js";
import { computeConcurrency, concurrencyFromEnv, MAX_CONFIGURED_CONCURRENCY, TournamentWorker } from "./worker.js";
import type { ContainerHandle } from "../../bot-manager/src/container-runner.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrencyFromEnv", () => {
  it("ausente o vacía ⇒ undefined (el worker usa computeConcurrency)", () => {
    expect(concurrencyFromEnv({})).toBeUndefined();
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: "" })).toBeUndefined();
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: "  " })).toBeUndefined();
  });
  it("entero válido ⇒ ese entero (M-C1: ignora la variable)", () => {
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: "2" })).toBe(2);
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: " 1 " })).toBe(1);
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: String(MAX_CONFIGURED_CONCURRENCY) })).toBe(
      MAX_CONFIGURED_CONCURRENCY,
    );
  });
  it("0, negativo, sobre el tope, decimal o basura ⇒ error (M-C2: sin tope, M-C3: admite 0)", () => {
    for (const v of ["0", "-1", String(MAX_CONFIGURED_CONCURRENCY + 1), "1.5", "2x", "abc", "1e1", "0x2"]) {
      expect(() => concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: v }), v).toThrow(
        /TOURNAMENT_WORKER_CONCURRENCY/,
      );
    }
  });
  it("el automático sigue siendo computeConcurrency (no cambia)", () => {
    expect(computeConcurrency({ cpuCount: 4, memMb: 8192 })).toBe(3);
  });
});

describe("TournamentWorker respeta la concurrencia configurada", () => {
  const vivos: TournamentWorker[] = [];
  afterEach(async () => {
    await Promise.all(vivos.splice(0).map((w) => w.stop()));
  });
  async function claimsIniciales(concurrency: number | undefined): Promise<number> {
    let claims = 0;
    const db: any = {
      raw: async () => {
        claims++;
        return { rows: [] };
      },
    };
    const w = new TournamentWorker({ db, handlers: {}, pollMs: 1000, ...(concurrency ? { concurrency } : {}) } as any);
    vivos.push(w);
    w.start();
    await dormir(300);
    return claims;
  }
  it("2 bucles ⇒ 2 reclamaciones simultáneas; 1 ⇒ 1 (M-C4: ignora config.concurrency)", async () => {
    expect(await claimsIniciales(2)).toBe(2);
    expect(await claimsIniciales(1)).toBe(1);
  });
});

describe("intervalo de muestreo acotado", () => {
  it("defecto 2 s y acotado a [1 s, 10 s] (M-C5: defecto 500, M-C6: sin cota)", () => {
    expect(DEFAULT_CPU_SAMPLE_MS).toBe(2000);
    expect(boundedCpuSampleMs()).toBe(2000);
    expect(boundedCpuSampleMs(500)).toBe(MIN_CPU_SAMPLE_MS);
    expect(boundedCpuSampleMs(1)).toBe(MIN_CPU_SAMPLE_MS);
    expect(boundedCpuSampleMs(60_000)).toBe(MAX_CPU_SAMPLE_MS);
    expect(boundedCpuSampleMs(NaN)).toBe(2000);
    expect(boundedCpuSampleMs(1500)).toBe(1500);
  });
  it("el entorno: válido pasa, fuera de rango o basura falla (no vuelve al 500 ms en silencio)", () => {
    expect(cpuSampleMsFromEnv({})).toBe(2000);
    expect(cpuSampleMsFromEnv({ TOURNAMENT_WORKER_CPU_SAMPLE_MS: "1000" })).toBe(1000);
    for (const v of ["500", "10001", "2s", "-5"]) {
      expect(() => cpuSampleMsFromEnv({ TOURNAMENT_WORKER_CPU_SAMPLE_MS: v }), v).toThrow(/CPU_SAMPLE_MS/);
    }
  });
});

describe("ContainerCpuSampler · la métrica sigue funcionando con menos carga", () => {
  afterEach(() => vi.useRealTimers());
  const handle = (read: () => Promise<number | null>): ContainerHandle =>
    ({ cpuMs: read }) as unknown as ContainerHandle;

  it("a 2 s por contenedor hace ~1/4 de peticiones que a 500 ms y conserva la última lectura (M-C5)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const s = new ContainerCpuSampler([handle(async () => (n += 100))]);
    s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    s.stop();
    expect(s.stats.requests).toBe(5); // 10 s / 2 s; con 500 ms serían 20
    expect(s.last[0]).toBe(500);
  });

  it("una sola petición en vuelo por contenedor: no se apilan (M-C7)", async () => {
    vi.useFakeTimers();
    let vuelo = 0;
    let max = 0;
    const lenta = async () => {
      vuelo++;
      max = Math.max(max, vuelo);
      await new Promise((r) => setTimeout(r, 5_000));
      vuelo--;
      return 1000;
    };
    const s = new ContainerCpuSampler([handle(lenta)]);
    s.start();
    await vi.advanceTimersByTimeAsync(12_000);
    s.stop();
    expect(max).toBe(1);
    expect(s.stats.skipped).toBeGreaterThan(0);
  });

  it("conserva la cota inferior: una lectura menor o nula no la rebaja (M-C8)", async () => {
    vi.useFakeTimers();
    const lecturas = [3000, null, 0, 10];
    const s = new ContainerCpuSampler([handle(async () => lecturas.shift() ?? null)]);
    for (let i = 0; i < 4; i++) {
      s.tick();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(s.last[0]).toBe(3000);
  });

  it("la muestra final reutiliza la que está en vuelo y fija el valor", async () => {
    let llamadas = 0;
    const s = new ContainerCpuSampler([handle(async () => (++llamadas, 777))]);
    s.tick();
    await s.final();
    expect(llamadas).toBe(1);
    expect(s.last[0]).toBe(777);
  });

  it("sólo contenedores vivos: handles nulos o ya terminados no generan peticiones (M-C9)", async () => {
    let vivo = 0;
    let muerto = 0;
    const lecturas = [900, 0, 0];
    const s = new ContainerCpuSampler([
      null,
      handle(async () => (vivo++, 5000)),
      handle(async () => (muerto++, lecturas[Math.min(muerto - 1, 2)])),
    ]);
    for (let i = 0; i < 6; i++) {
      s.tick();
      await Promise.resolve();
      await dormir(5);
    }
    expect(vivo).toBe(6);
    expect(muerto).toBe(3); // 900, 0, 0 ⇒ terminado: ya no se consulta
    expect(s.last[0]).toBeNull();
    expect(s.last[2]).toBe(900);
    await s.final();
    expect(muerto).toBe(3);
  });
});
