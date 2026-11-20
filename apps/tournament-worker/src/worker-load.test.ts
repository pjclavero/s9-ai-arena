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
import { DEFAULT_CONCURRENCY } from "./concurrency.js";
import { computeConcurrency, concurrencyFromEnv, MAX_CONFIGURED_CONCURRENCY, TournamentWorker } from "./worker.js";
import type { ContainerHandle } from "../../bot-manager/src/container-runner.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrencyFromEnv", () => {
  it("ausente o vacía ⇒ undefined (el worker usa DEFAULT_CONCURRENCY = 1)", () => {
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
  it('`auto` (cualquier caja) ⇒ "auto"; el automático ya no mide el host sino cgroup + batalla', () => {
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: "auto" })).toBe("auto");
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: " AUTO " })).toBe("auto");
    expect(computeConcurrency({ cpuCount: 4, memGiB: 8 })).toBe(1);
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
  it("sin concurrencia configurada ⇒ 1 bucle [M-B1-2: el worker arranca con más de 1] (B1: el defecto es 1, no el automático)", async () => {
    expect(await claimsIniciales(undefined)).toBe(DEFAULT_CONCURRENCY);
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
    for (const v of ["500", "10001", "2s", "-5", "1500.5"]) {
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
    const lecturas = [3000, 10, null, 5];
    const s = new ContainerCpuSampler([handle(async () => lecturas.shift() ?? null)]);
    for (let i = 0; i < 4; i++) {
      s.tick();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(s.last[0]).toBe(3000);
  });

  it("stop() limpia el temporizador y es idempotente (N4: stop sin clearInterval)", () => {
    vi.useFakeTimers();
    const s = new ContainerCpuSampler([handle(async () => 1)]);
    s.start();
    expect(vi.getTimerCount()).toBe(1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("la muestra final reutiliza la que está en vuelo y fija el valor", async () => {
    let llamadas = 0;
    const s = new ContainerCpuSampler([handle(async () => (++llamadas, 777))]);
    s.tick();
    await s.final();
    expect(llamadas).toBe(1);
    expect(s.last[0]).toBe(777);
  });

  it("sólo contenedores vivos: handles nulos o CONFIRMADOS terminados no generan peticiones (M-C9)", async () => {
    let vivo = 0;
    let muerto = 0;
    const lecturas = [900, 0, 0];
    const terminado = { running: false, exitCode: 0, oomKilled: false, gone: false };
    const s = new ContainerCpuSampler([
      null,
      handle(async () => (vivo++, 5000)),
      {
        cpuMs: async () => (muerto++, lecturas[Math.min(muerto - 1, 2)]),
        state: async () => terminado,
      } as unknown as ContainerHandle,
    ]);
    for (let i = 0; i < 6; i++) {
      s.tick();
      await Promise.resolve();
      await dormir(5);
    }
    expect(vivo).toBe(6);
    expect(muerto).toBe(2); // 900, luego 0 + inspect «!running» ⇒ terminado: ya no se consulta
    expect(s.last[0]).toBeNull();
    expect(s.last[2]).toBe(900);
    await s.final();
    expect(muerto).toBe(2);
  });

  it("P3-2 · un contenedor que muere ANTES de dar una lectura positiva también se deja de muestrear", async () => {
    let n = 0;
    const s = new ContainerCpuSampler([
      {
        cpuMs: async () => (n++, null),
        state: async () => ({ running: false, exitCode: 1, oomKilled: false, gone: true }),
      } as unknown as ContainerHandle,
    ]);
    for (let i = 0; i < 5; i++) {
      s.tick();
      await dormir(5);
    }
    expect(n).toBe(1);
  });
});

describe("ContainerCpuSampler · fallo transitorio ≠ contenedor terminado (P2-1)", () => {
  it("positiva, 2+ nulos con el contenedor VIVO, luego lecturas crecientes: last sigue creciendo (M-D1: null = muerte)", async () => {
    const lecturas: (number | null)[] = [1000, null, null, null, 2000, 3000];
    let estado = 0;
    const s = new ContainerCpuSampler([
      {
        cpuMs: async () => lecturas.shift() ?? null,
        state: async () => (estado++, { running: true, exitCode: null, oomKilled: false, gone: false }),
      } as unknown as ContainerHandle,
    ]);
    const vistos: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      s.tick();
      await dormir(5);
      vistos.push(s.last[0]);
    }
    expect(vistos).toEqual([1000, 1000, 1000, 1000, 2000, 3000]);
    expect(estado).toBe(3);
  });

  it("si el inspect también falla (null o excepción) NO se da por terminado (M-D2: inspect null = muerte)", async () => {
    const lecturas: (number | null)[] = [500, null, null, null, 900];
    let k = 0;
    const s = new ContainerCpuSampler([
      {
        cpuMs: async () => lecturas.shift() ?? null,
        state: async () => {
          if (k++ % 2) throw new Error("proxy 502");
          return null;
        },
      } as unknown as ContainerHandle,
    ]);
    for (let i = 0; i < 5; i++) {
      s.tick();
      await dormir(5);
    }
    expect(s.last[0]).toBe(900);
  });

  it("con 404/`gone` o `!running` SÍ se da por terminado (M-D3: nunca marca terminado)", async () => {
    for (const st of [
      { running: false, exitCode: 0, oomKilled: false, gone: true },
      { running: false, exitCode: 137, oomKilled: true, gone: false },
    ]) {
      let n = 0;
      const s = new ContainerCpuSampler([
        { cpuMs: async () => (n++, n === 1 ? 700 : null), state: async () => st } as unknown as ContainerHandle,
      ]);
      for (let i = 0; i < 5; i++) {
        s.tick();
        await dormir(5);
      }
      expect(n).toBe(2);
      expect(s.last[0]).toBe(700);
    }
  });
});

describe("ContainerCpuSampler · vencimiento de la petición (P2-2)", () => {
  afterEach(() => vi.useRealTimers());

  it("un cpuMs que nunca resuelve: tras el vencimiento (2×intervalo) el sampler vuelve a pedir (M-D4: sin vencimiento)", async () => {
    vi.useFakeTimers();
    let llamadas = 0;
    const s = new ContainerCpuSampler([
      { cpuMs: () => (llamadas++, new Promise<number | null>(() => {})) } as unknown as ContainerHandle,
    ]);
    s.start();
    await vi.advanceTimersByTimeAsync(3_900); // < 2×2000 desde la 1ª petición (t=2000 ⇒ vence 6000)
    expect(llamadas).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    s.stop();
    expect(llamadas).toBeGreaterThan(1);
    expect(s.stats.timeouts).toBeGreaterThan(0);
  });

  it("un state() colgado tras una lectura vacía también vence", async () => {
    vi.useFakeTimers();
    let llamadas = 0;
    const s = new ContainerCpuSampler([
      { cpuMs: async () => (llamadas++, null), state: () => new Promise(() => {}) } as unknown as ContainerHandle,
    ]);
    s.start();
    await vi.advanceTimersByTimeAsync(12_000);
    s.stop();
    expect(llamadas).toBeGreaterThan(1);
  });

  it("final() con una petición colgada vuelve en ≤ 2×intervalo", async () => {
    vi.useFakeTimers();
    const s = new ContainerCpuSampler([
      { cpuMs: () => new Promise<number | null>(() => {}) } as unknown as ContainerHandle,
    ]);
    s.tick();
    let listo = false;
    void s.final().then(() => (listo = true));
    await vi.advanceTimersByTimeAsync(s.timeoutMs + 1);
    expect(listo).toBe(true);
  });

  it("una respuesta tardía de una petición abandonada no libera la petición vigente", async () => {
    vi.useFakeTimers();
    let resolverViejo: (v: number) => void = () => {};
    let vuelo = 0;
    let max = 0;
    let k = 0;
    const s = new ContainerCpuSampler([
      {
        cpuMs: () => {
          vuelo++;
          max = Math.max(max, vuelo);
          k++;
          if (k === 1) return new Promise<number>((r) => (resolverViejo = (v) => (vuelo--, r(v))));
          return new Promise<number>((r) => setTimeout(() => (vuelo--, r(4000)), 100_000));
        },
      } as unknown as ContainerHandle,
    ]);
    s.start();
    await vi.advanceTimersByTimeAsync(9_000); // 1ª vence a los 6000 ⇒ 2ª en vuelo (≤ 8000)
    expect(k).toBe(2);
    resolverViejo(10);
    await vi.advanceTimersByTimeAsync(10);
    const antes = k;
    await vi.advanceTimersByTimeAsync(400); // la 2ª sigue en vuelo (vence ≥ 10000) ⇒ no se abre otra
    expect(k).toBe(antes);
    s.stop();
  });
});
