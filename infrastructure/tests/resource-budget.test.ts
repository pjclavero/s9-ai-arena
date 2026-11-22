// D-OP-32 · Presupuesto de recursos verificable (estático, sin Docker ni daemon).
//
// Cruza infrastructure/resource-budget.yaml con infrastructure/docker-compose.yml y
// con el techo de los contenedores de bot del bot-manager, y comprueba que el
// escenario de pico simultáneo (emisión 1080p30 + batallas + build + el resto de
// servicios) cabe en 6 vCPU y 6,84 GB dejando la reserva del sistema.
//
// Cada comprobación lleva un identificador RB-n que usa scripts/mutants-resource-budget.sh:
// cada mutante debe morir por el test que lo nombra.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_LIMITS } from "../../apps/bot-manager/src/container-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const compose = parse(readFileSync(join(here, "..", "docker-compose.yml"), "utf8"), { merge: true });
const budget = parse(readFileSync(join(here, "..", "resource-budget.yaml"), "utf8"));

type Size = "1v1" | "2v2" | "3v3" | "4v4";
const SIZES: Size[] = ["1v1", "2v2", "3v3", "4v4"];

/** «512M» / «1G» / «256m» → MiB. Lanza si no se entiende (no se asume nada). */
export function memToMib(v: unknown): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG])[bB]?$/.exec(String(v).trim());
  if (!m) throw new Error(`memoria no interpretable: ${String(v)}`);
  const n = Number(m[1]);
  return { k: n / 1024, m: n, g: n * 1024 }[m[2].toLowerCase() as "k" | "m" | "g"];
}

/** Límites declarados por un servicio: deploy.resources.limits o cpus/mem_limit de nivel superior. */
function composeLimit(def: any): { cpus: number; memMib: number } | null {
  const l = def?.deploy?.resources?.limits;
  const cpus = l?.cpus ?? def?.cpus;
  const mem = l?.memory ?? def?.mem_limit;
  if (cpus === undefined || mem === undefined) return null;
  return { cpus: Number(cpus), memMib: memToMib(mem) };
}

interface Fit {
  ramMib: number;
  ramCapMib: number;
  cpus: number;
  cpuCap: number;
  fits: boolean;
}

/**
 * Modelo del escenario: RAM = servicios en marcha (pico esperado) + batallas extra del
 * motor + bots a su TECHO + sandboxes de build a su techo + reserva del sistema.
 * CPU = servicios esperados + motor y bots con su CPU de planificación + sandbox a su
 * techo. `battles` = nº de batallas simultáneas por tipo.
 */
export function scenarioFit(b: any, battles: Partial<Record<Size, number>>, streaming: boolean): Fit {
  let ram = 0;
  let cpu = 0;
  for (const s of Object.values<any>(b.services)) {
    if (!s.running) continue;
    if (s.streaming && !streaming) {
      ram += s.ram_idle_mib;
      continue;
    }
    ram += s.ram_expected_mib;
    cpu += s.cpu_expected;
  }
  let n = 0;
  let bots = 0;
  for (const [size, count] of Object.entries(battles)) {
    n += count!;
    bots += count! * b.concurrency.bots[size];
  }
  ram += Math.max(0, n - 1) * b.battle.worker_extra_ram_mib + bots * b.bot.mem_mib;
  cpu += n * b.battle.cpu_planning + bots * b.bot.cpu_planning;
  ram += b.scenario.build_sandboxes * b.bot.mem_mib;
  cpu += b.scenario.build_sandboxes * b.bot.cpus;
  ram += b.reserve.ram_mib;
  cpu += b.reserve.cpus;
  return {
    ramMib: ram,
    ramCapMib: b.host.ram_mib,
    cpus: cpu,
    cpuCap: b.host.vcpus,
    fits: ram <= b.host.ram_mib && cpu <= b.host.vcpus,
  };
}

/** Mayor nº de batallas de un tipo que caben (una sola clase de batalla a la vez). */
export function maxFitting(b: any, size: Size, streaming: boolean): number {
  let n = 0;
  while (n < 32 && scenarioFit(b, { [size]: n + 1 }, streaming).fits) n++;
  return n;
}

const running = Object.entries<any>(budget.services).filter(([, s]) => s.running);

describe("D-OP-32 · límites del compose cuadran con el presupuesto", () => {
  it("RB-1: cada servicio del compose declara cpus y memoria interpretables y está en el presupuesto (y al revés)", () => {
    const names = Object.keys(compose.services).sort();
    expect(Object.keys(budget.services).sort()).toEqual(names);
    for (const name of names) {
      const l = composeLimit(compose.services[name]);
      expect(l, `${name}: sin cpus o sin límite de memoria`).not.toBeNull();
      expect(l!.cpus, `${name}: cpus`).toBeGreaterThan(0);
      expect(l!.memMib, `${name}: memoria`).toBeGreaterThan(0);
    }
  });

  it("RB-2: el límite de cada servicio en el presupuesto es EXACTAMENTE el del compose", () => {
    for (const [name, s] of Object.entries<any>(budget.services)) {
      const l = composeLimit(compose.services[name])!;
      expect({ cpus: l.cpus, mem_mib: l.memMib }, `${name}: compose vs resource-budget.yaml`).toEqual({
        cpus: s.limit.cpus,
        mem_mib: s.limit.mem_mib,
      });
    }
  });

  it("RB-3: el techo por bot del presupuesto es el DEFAULT_LIMITS del bot-manager", () => {
    expect(budget.bot.cpus).toBe(DEFAULT_LIMITS.cpus);
    expect(budget.bot.mem_mib).toBe(DEFAULT_LIMITS.memoryBytes / 1024 / 1024);
  });

  it("RB-4: `running: false` sólo para servicios de perfiles que no corren en producción (bots, observability)", () => {
    for (const [name, s] of Object.entries<any>(budget.services)) {
      const profiles: string[] = compose.services[name].profiles ?? [];
      const offline = profiles.length > 0 && profiles.every((p) => p === "bots" || p === "observability");
      expect(!!s.running, `${name}: running vs perfiles ${profiles.join(",")}`).toBe(!offline);
    }
  });
});

describe("D-OP-32 · cada pico esperado cabe en su límite y es creíble", () => {
  it("RB-5: pico esperado de RAM ≤ límite; ≥ pico medido; CPU esperada ≤ cpus del servicio", () => {
    for (const [name, s] of running) {
      expect(s.ram_expected_mib, `${name}: RAM esperada vs límite`).toBeLessThanOrEqual(s.limit.mem_mib);
      if (s.ram_peak_measured_mib !== undefined) {
        expect(s.ram_expected_mib, `${name}: RAM esperada por debajo de lo ya medido`).toBeGreaterThanOrEqual(
          s.ram_peak_measured_mib,
        );
      }
      expect(s.cpu_expected, `${name}: CPU esperada vs cpus`).toBeLessThanOrEqual(s.limit.cpus);
      expect(["measured", "estimated"]).toContain(s.basis);
    }
  });

  it("RB-6: el límite de memoria no es una holgura absurda (≤ 8× el pico esperado) ni asfixia (≥ 1,2×)", () => {
    for (const [name, s] of running) {
      const r = s.limit.mem_mib / s.ram_expected_mib;
      expect(r, `${name}: límite/pico = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(1.2);
      expect(r, `${name}: límite/pico = ${r.toFixed(2)}`).toBeLessThanOrEqual(8);
    }
  });
});

describe("D-OP-32 · el escenario de pico simultáneo cabe en 6 vCPU y 6,84 GB", () => {
  it("RB-7: la configuración declarada de concurrencia, con emisión, cabe en RAM y CPU dejando la reserva", () => {
    for (const size of SIZES) {
      const n = budget.concurrency.while_streaming[size];
      const f = scenarioFit(budget, { [size]: n }, true);
      expect(f.ramMib, `${size}×${n} con emisión: RAM ${f.ramMib} MiB de ${f.ramCapMib}`).toBeLessThanOrEqual(
        f.ramCapMib,
      );
      expect(f.cpus, `${size}×${n} con emisión: CPU ${f.cpus.toFixed(2)} de ${f.cpuCap}`).toBeLessThanOrEqual(f.cpuCap);
    }
  });

  it("RB-8: lo mismo sin emisión (streamer parado: sólo su RAM de reposo)", () => {
    for (const size of SIZES) {
      const n = budget.concurrency.without_streaming[size];
      expect(scenarioFit(budget, { [size]: n }, false).fits, `${size}×${n} sin emisión`).toBe(true);
    }
  });

  it("RB-9: la concurrencia declarada es ≥ 1, no supera la que cabe y con emisión nunca excede a la de sin emisión", () => {
    for (const size of SIZES) {
      const w = budget.concurrency.while_streaming[size];
      const wo = budget.concurrency.without_streaming[size];
      expect(w, `${size}: con emisión ≥ 1`).toBeGreaterThanOrEqual(1);
      expect(w, `${size}: con emisión ≤ máximo que cabe`).toBeLessThanOrEqual(maxFitting(budget, size, true));
      expect(wo, `${size}: sin emisión ≤ máximo que cabe`).toBeLessThanOrEqual(maxFitting(budget, size, false));
      expect(w, `${size}: con emisión ≤ sin emisión`).toBeLessThanOrEqual(wo);
    }
  });

  it("RB-10: sobreasignación: suma de techos de los servicios en marcha / capacidad ≤ tope declarado", () => {
    const ramLimits = running.reduce((a, [, s]) => a + s.limit.mem_mib, 0);
    const cpuLimits = running.reduce((a, [, s]) => a + s.limit.cpus, 0);
    // Con los bots de la peor batalla declarada y el sandbox de build a su techo.
    const maxBots = Math.max(...SIZES.map((z) => budget.concurrency.while_streaming[z] * budget.concurrency.bots[z]));
    const extraCpu = (maxBots + budget.scenario.build_sandboxes) * budget.bot.cpus;
    expect(ramLimits / budget.host.ram_mib, `Σ mem_limit ${ramLimits} MiB`).toBeLessThanOrEqual(
      budget.overcommit.max_ram_ratio,
    );
    expect((cpuLimits + extraCpu) / budget.host.vcpus, `Σ cpus ${cpuLimits + extraCpu}`).toBeLessThanOrEqual(
      budget.overcommit.max_cpu_ratio,
    );
  });
});

describe("D-OP-32 · el modelo SE PONE ROJO (control negativo)", () => {
  it("RB-11: con una 4v4 más, con el streamer sin tope de RAM o sin reserva el escenario deja de caber", () => {
    const clone = () => structuredClone(budget);
    expect(scenarioFit(clone(), { "4v4": 2 }, true).fits).toBe(false);
    const noReserve = clone();
    noReserve.reserve = { cpus: 0, ram_mib: 0 };
    noReserve.host.ram_mib = scenarioFit(budget, { "4v4": 1 }, true).ramMib - 1 - budget.reserve.ram_mib;
    expect(scenarioFit(noReserve, { "4v4": 1 }, true).fits).toBe(false);
    const heavyStreamer = clone();
    heavyStreamer.services.streamer.ram_expected_mib = 4096;
    expect(scenarioFit(heavyStreamer, { "4v4": 1 }, true).fits).toBe(false);
    const cpuStreamer = clone();
    cpuStreamer.services.streamer.cpu_expected = 5;
    expect(scenarioFit(cpuStreamer, { "1v1": 1 }, true).fits).toBe(false);
  });

  it("RB-12: memToMib interpreta los sufijos del compose y rechaza lo que no entiende", () => {
    expect(memToMib("256M")).toBe(256);
    expect(memToMib("1G")).toBe(1024);
    expect(memToMib("512m")).toBe(512);
    expect(() => memToMib("mucho")).toThrow();
  });
});
