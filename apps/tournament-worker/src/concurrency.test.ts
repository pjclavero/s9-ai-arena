/**
 * V1 · B1 (AUD2-10) · concurrencia segura. Cada test lleva el nombre del mutante que lo
 * mata (scripts/mutants-worker-concurrency.sh).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONCURRENCY,
  computeAutoConcurrency,
  effectiveResources,
  readCgroupLimits,
  type FileReader,
  type HostView,
} from "./concurrency.js";
import { buildLoadConfig } from "./load-config.js";
import { concurrencyFromEnv } from "./worker.js";

const GiB = 1024 ** 3;
const fakeFs =
  (files: Record<string, string>): FileReader =>
  (p) =>
    files[p];
const host = (cpuCount: number, totalGiB: number, freeGiB = totalGiB): HostView => ({
  cpuCount,
  totalMemBytes: totalGiB * GiB,
  freeMemBytes: freeGiB * GiB,
});

describe("defecto 1 (AUD2-10)", () => {
  it("DEFAULT_CONCURRENCY es 1 [M-B1-1: defecto distinto de 1]", () => {
    expect(DEFAULT_CONCURRENCY).toBe(1);
  });
  it("sin variable, la concurrencia efectiva es 1 [M-B1-12: buildLoadConfig usa otro defecto]", () => {
    expect(buildLoadConfig({}).effectiveConcurrency).toBe(1);
    expect(buildLoadConfig({ TOURNAMENT_WORKER_CONCURRENCY: "" }).effectiveConcurrency).toBe(1);
  });
  it("un valor explícito se respeta [M-B1-3: ignora el valor explícito]", () => {
    expect(buildLoadConfig({ TOURNAMENT_WORKER_CONCURRENCY: "3" }).effectiveConcurrency).toBe(3);
    expect(concurrencyFromEnv({ TOURNAMENT_WORKER_CONCURRENCY: "auto" })).toBe("auto");
  });
});

describe("compose: el defecto de instalación es 1 (AUD2-10)", () => {
  const compose = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infrastructure", "docker-compose.yml"),
    "utf8",
  );
  const envExample = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infrastructure", ".env.example"),
    "utf8",
  );
  it("TOURNAMENT_WORKER_CONCURRENCY en compose no puede quedar vacío; defecto 1 [M-B1-4: defecto vacío]", () => {
    const m = compose.match(/^\s*TOURNAMENT_WORKER_CONCURRENCY:\s*(\S+)\s*$/m);
    expect(m, "compose debe declarar la variable").not.toBeNull();
    expect(m![1]).toBe("${TOURNAMENT_WORKER_CONCURRENCY:-1}");
  });
  it(".env.example documenta la variable con el defecto 1 y la opción auto [M-B1-5: sin documentar]", () => {
    expect(envExample).toMatch(/^#?TOURNAMENT_WORKER_CONCURRENCY=1\s*$/m);
    expect(envExample).toMatch(/auto/);
  });
});

describe("lectura de cgroup simulada", () => {
  it("v2: cpu.max 'quota period' y memory.max ⇒ CPUs y bytes [M-B1-6: ignora el cgroup]", () => {
    const l = readCgroupLimits(
      fakeFs({
        "/sys/fs/cgroup/cpu.max": "200000 100000\n",
        "/sys/fs/cgroup/memory.max": String(4 * GiB),
        "/sys/fs/cgroup/memory.current": String(1 * GiB),
      }),
    );
    expect(l).toEqual({ cpus: 2, memBytes: 4 * GiB, memUsedBytes: 1 * GiB, origen: "cgroup-v2" });
  });
  it("v2 sin límite ('max') ⇒ sin cpus ni memoria", () => {
    const l = readCgroupLimits(
      fakeFs({ "/sys/fs/cgroup/cpu.max": "max 100000\n", "/sys/fs/cgroup/memory.max": "max\n" }),
    );
    expect(l.cpus).toBeUndefined();
    expect(l.memBytes).toBeUndefined();
  });
  it("v1: cfs_quota/cfs_period y limit_in_bytes [M-B1-7: no lee v1]", () => {
    const l = readCgroupLimits(
      fakeFs({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(2 * GiB),
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(GiB / 2),
      }),
    );
    expect(l).toMatchObject({ cpus: 1.5, memBytes: 2 * GiB, origen: "cgroup-v1" });
  });
  it("v1 sin límite (-1 y ~2^63) ⇒ sin límites", () => {
    const l = readCgroupLimits(
      fakeFs({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      }),
    );
    expect(l.cpus).toBeUndefined();
    expect(l.memBytes).toBeUndefined();
  });
  it("sin ficheros ⇒ origen host", () => {
    expect(readCgroupLimits(fakeFs({})).origen).toBe("host");
  });
});

describe("recursos efectivos: el cgroup manda, no el host", () => {
  const cg2 = fakeFs({
    "/sys/fs/cgroup/cpu.max": "400000 100000",
    "/sys/fs/cgroup/memory.max": String(2 * GiB),
    "/sys/fs/cgroup/memory.current": String(GiB / 2),
  });
  it("host de 32 CPU / 64 GiB con cgroup de 4 CPU / 2 GiB ⇒ 4 CPU y 1,5 GiB [M-B1-8: usa el host]", () => {
    const r = effectiveResources(cg2, host(32, 64));
    expect(r.cpus).toBe(4);
    expect(r.memGiB).toBeCloseTo(1.5, 5);
    expect(r.origen).toBe("cgroup-v2");
  });
  it("el cgroup nunca da más que el host", () => {
    const r = effectiveResources(
      fakeFs({ "/sys/fs/cgroup/cpu.max": "800000 100000", "/sys/fs/cgroup/memory.max": String(16 * GiB) }),
      host(2, 4, 3),
    );
    expect(r.cpus).toBe(2);
    expect(r.memGiB).toBe(3);
  });
  it("cgroup de 4 GiB y host con 1 GiB libre ⇒ no supera la memoria libre del host [M-B1-O4: sin min con la libre del host]", () => {
    const r = effectiveResources(
      fakeFs({ "/sys/fs/cgroup/cpu.max": "400000 100000", "/sys/fs/cgroup/memory.max": String(4 * GiB) }),
      host(8, 16, 1),
    );
    expect(r.memGiB).toBe(1);
    expect(computeAutoConcurrency(r, 2, 16)).toBe(Math.floor(1 / (0.25 * 2 + 0.5)));
  });
  it("sin cgroup usa la memoria LIBRE del host", () => {
    const r = effectiveResources(fakeFs({}), host(4, 8, 5));
    expect(r).toMatchObject({ cpus: 4, memGiB: 5, origen: "host" });
  });
});

describe("cálculo automático por tamaño de batalla", () => {
  it("el escenario del incidente (4 vCPU, 6,7 GiB) con 4v4 da 1, no 3 [M-B1-9: fórmula antigua vCPU-1]", () => {
    expect(computeAutoConcurrency({ cpus: 4, memGiB: 6.7 })).toBe(1);
  });
  it("una 4v4 (8 bots) necesita 4 CPU + reserva: 9 CPU ⇒ 2; una 1v1 (2 bots) con 9 CPU ⇒ 8 [M-B1-10: ignora nº de bots]", () => {
    expect(computeAutoConcurrency({ cpus: 9, memGiB: 64 }, 8)).toBe(2);
    expect(computeAutoConcurrency({ cpus: 9, memGiB: 64 }, 2)).toBe(8);
  });
  it("limita la memoria: 4v4 cuesta 2,5 GiB; 6 GiB ⇒ 2 aunque sobre CPU [M-B1-11: ignora la memoria]", () => {
    expect(computeAutoConcurrency({ cpus: 64, memGiB: 6 }, 8)).toBe(2);
    expect(computeAutoConcurrency({ cpus: 64, memGiB: 2.4 }, 8)).toBe(1);
  });
  it("entradas no finitas ⇒ 1 (fallo seguro) [M-B1-13: sin guarda isFinite]", () => {
    expect(computeAutoConcurrency({ cpus: Infinity, memGiB: 64 })).toBe(1);
    expect(computeAutoConcurrency({ cpus: 64, memGiB: NaN })).toBe(1);
    expect(computeAutoConcurrency({ cpus: 64, memGiB: Infinity })).toBe(1);
    expect(computeAutoConcurrency({ cpus: 64, memGiB: 64 }, NaN)).toBe(1);
    expect(computeAutoConcurrency({ cpus: 64, memGiB: 64 }, 2, Infinity)).toBe(1);
  });
  it("mínimo 1 y tope", () => {
    expect(computeAutoConcurrency({ cpus: 0.1, memGiB: 0 })).toBe(1);
    expect(computeAutoConcurrency({ cpus: 1000, memGiB: 1000 }, 2)).toBe(16);
  });
});
