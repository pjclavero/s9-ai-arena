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
  availableMib: number;
  cpus: number;
  cpuCap: number;
  fits: boolean;
}

interface FitOptions {
  /** Servicios con emisión activa (si no, el streamer sólo cuenta su RAM de reposo). */
  streaming: boolean;
  /** Bots y streamer en su TECHO de cgroup (peor caso teórico parcial) en vez de la cifra de escenario. */
  ceilings?: boolean;
  /** Pico transitorio de CPU del worker (arranque/cierre de una batalla); excluye el sandbox de build. */
  transient?: boolean;
}

/**
 * Modelo del escenario. RAM = servicios en marcha (cifra de ESCENARIO = pico medido × margen) + batallas
 * extra del motor + bots + sandbox de build a su techo + reserva del sistema; debe dejar
 * `safety.min_available_mib` libres. CPU = servicios esperados + motor y bots + sandbox + reserva.
 * `battles` = nº de batallas simultáneas por tipo.
 */
export function scenarioFit(b: any, battles: Partial<Record<Size, number>>, o: FitOptions): Fit {
  let ram = 0;
  let cpu = 0;
  for (const s of Object.values<any>(b.services)) {
    if (!s.running) continue;
    if (s.streaming && !o.streaming) {
      ram += s.ram_idle_mib;
      continue;
    }
    ram += o.ceilings && s.streaming ? s.limit.mem_mib : s.ram_scenario_mib;
    cpu += s.cpu_expected;
  }
  let n = 0;
  let bots = 0;
  for (const [size, count] of Object.entries(battles)) {
    n += count!;
    bots += count! * b.concurrency.bots[size];
  }
  const botRam = o.ceilings ? b.bot.mem_mib : b.bot.ram_scenario_mib;
  ram += Math.max(0, n - 1) * b.battle.worker_extra_ram_mib + bots * botRam;
  cpu += n * b.battle.cpu_planning + bots * b.bot.cpu_planning;
  if (n > 0 && o.transient) cpu += b.battle.cpu_transient_peak - b.battle.cpu_planning;
  ram += b.scenario.build_sandboxes * b.bot.mem_mib; // sandbox de build: siempre a su techo (no medido)
  if (!o.transient) cpu += b.scenario.build_sandboxes * b.bot.cpus;
  ram += b.reserve.ram_mib;
  cpu += b.reserve.cpus;
  const available = b.host.ram_mib - ram;
  const margin = o.ceilings ? 0 : b.safety.min_available_mib;
  return {
    ramMib: ram,
    ramCapMib: b.host.ram_mib,
    availableMib: available,
    cpus: cpu,
    cpuCap: b.host.vcpus,
    fits: available >= margin && cpu <= b.host.vcpus,
  };
}

/** Cabe en el modelo medio Y con el pico transitorio de CPU. */
function fitsAll(b: any, battles: Partial<Record<Size, number>>, streaming: boolean): boolean {
  return scenarioFit(b, battles, { streaming }).fits && scenarioFit(b, battles, { streaming, transient: true }).fits;
}

/** Mayor nº de batallas de un tipo que caben (una sola clase de batalla a la vez). */
export function maxFitting(b: any, size: Size, streaming: boolean): number {
  let n = 0;
  while (n < 32 && fitsAll(b, { [size]: n + 1 }, streaming)) n++;
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

describe("D-OP-32 · medido, escenario (medido + margen) y techo teórico no se mezclan", () => {
  it("RB-5: escenario ≤ límite; ≥ pico medido; si es `measured`, ≥ pico × margen; el streamer sin AVX2 es `estimated` y pendiente", () => {
    const factor = budget.safety.service_peak_factor;
    for (const [name, s] of running) {
      expect(s.ram_scenario_mib, `${name}: escenario vs límite`).toBeLessThanOrEqual(s.limit.mem_mib);
      expect(s.ram_scenario_mib, `${name}: escenario por debajo de lo ya medido`).toBeGreaterThanOrEqual(
        s.ram_peak_measured_mib,
      );
      if (s.basis === "measured") {
        expect(s.ram_scenario_mib, `${name}: escenario < pico medido × ${factor}`).toBeGreaterThanOrEqual(
          Math.ceil(s.ram_peak_measured_mib * factor) - 1,
        );
      }
      expect(s.cpu_expected, `${name}: CPU esperada vs cpus`).toBeLessThanOrEqual(s.limit.cpus);
      expect(["measured", "estimated"]).toContain(s.basis);
    }
    // El streamer emitiendo con AVX2 NO está medido: no puede figurar como medido.
    const st = budget.services.streamer;
    expect(st.pending_avx2_measurement).toBe(true);
    expect(st.basis).toBe("estimated");
  });

  it("RB-6: el límite de memoria no es una holgura absurda (≤ 12× el escenario) ni asfixia (≥ 1,2×)", () => {
    for (const [name, s] of running) {
      const r = s.limit.mem_mib / s.ram_scenario_mib;
      expect(r, `${name}: límite/escenario = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(1.2);
      expect(r, `${name}: límite/escenario = ${r.toFixed(2)}`).toBeLessThanOrEqual(12);
    }
  });
});

describe("D-OP-32 · el escenario de pico simultáneo cabe en 6 vCPU y 6,84 GB con margen", () => {
  it("RB-7: la concurrencia declarada, con emisión, cabe en CPU (media y transitoria) y deja ≥ margen mínimo de RAM disponible", () => {
    for (const size of SIZES) {
      const n = budget.concurrency.while_streaming[size];
      const f = scenarioFit(budget, { [size]: n }, { streaming: true });
      expect(f.availableMib, `${size}×${n} con emisión: disponible ${f.availableMib} MiB`).toBeGreaterThanOrEqual(
        budget.safety.min_available_mib,
      );
      expect(f.cpus, `${size}×${n} con emisión: CPU ${f.cpus.toFixed(2)} de ${f.cpuCap}`).toBeLessThanOrEqual(f.cpuCap);
      const t = scenarioFit(budget, { [size]: n }, { streaming: true, transient: true });
      expect(t.cpus, `${size}×${n} con emisión y pico transitorio: CPU ${t.cpus.toFixed(2)}`).toBeLessThanOrEqual(
        t.cpuCap,
      );
    }
  });

  it("RB-8: lo mismo sin emisión (streamer parado: sólo su RAM de reposo)", () => {
    for (const size of SIZES) {
      const n = budget.concurrency.without_streaming[size];
      expect(fitsAll(budget, { [size]: n }, false), `${size}×${n} sin emisión`).toBe(true);
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

  it("RB-10: sobreasignación teórica: Σ techos / capacidad ≤ tope, y `all_limits_exceed_vm` es verdad (el riesgo no se oculta)", () => {
    const ramLimits = running.reduce((a, [, s]) => a + s.limit.mem_mib, 0);
    const cpuLimits = running.reduce((a, [, s]) => a + s.limit.cpus, 0);
    const maxBots = Math.max(...SIZES.map((z) => budget.concurrency.while_streaming[z] * budget.concurrency.bots[z]));
    const extraCpu = (maxBots + budget.scenario.build_sandboxes) * budget.bot.cpus;
    expect(ramLimits / budget.host.ram_mib, `Σ mem_limit ${ramLimits} MiB`).toBeLessThanOrEqual(
      budget.overcommit.max_ram_ratio,
    );
    expect((cpuLimits + extraCpu) / budget.host.vcpus, `Σ cpus ${cpuLimits + extraCpu}`).toBeLessThanOrEqual(
      budget.overcommit.max_cpu_ratio,
    );
    const everyCeiling =
      ramLimits + (maxBots + budget.scenario.build_sandboxes) * budget.bot.mem_mib + budget.reserve.ram_mib;
    expect(everyCeiling > budget.host.ram_mib, `todos los techos a la vez: ${everyCeiling} MiB`).toBe(
      budget.overcommit.all_limits_exceed_vm,
    );
  });

  it("RB-14: el margen mínimo de RAM disponible exigido no baja de 1 GiB (criterio del operador)", () => {
    expect(budget.safety.min_available_mib).toBeGreaterThanOrEqual(1024);
  });

  it("RB-13: peor caso teórico parcial (bots y streamer en su techo de cgroup) no supera el límite duro de la VM y cada bot tiene límite propio", () => {
    // Sólo se puede afirmar porque cada contenedor de bot nace con Memory = MemorySwap = DEFAULT_LIMITS.
    expect(DEFAULT_LIMITS.memoryBytes).toBeGreaterThan(0);
    for (const size of SIZES) {
      const n = budget.concurrency.while_streaming[size];
      const f = scenarioFit(budget, { [size]: n }, { streaming: true, ceilings: true });
      expect(f.availableMib, `${size}×${n}: peor caso ${f.ramMib} MiB de ${f.ramCapMib}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("D-OP-32 · el modelo SE PONE ROJO (control negativo)", () => {
  it("RB-11: más batallas, un margen mínimo mayor, un streamer mayor o más CPU hacen que el escenario deje de caber", () => {
    const clone = () => structuredClone(budget);
    const on = { streaming: true };
    expect(scenarioFit(budget, { "4v4": 1 }, on).fits).toBe(true); // línea base
    expect(scenarioFit(budget, { "4v4": 12 }, on).fits).toBe(false);
    // La RAM crece exactamente con el motor extra y los bots de la batalla añadida.
    const r1 = scenarioFit(budget, { "4v4": 1 }, on).ramMib;
    const r2 = scenarioFit(budget, { "4v4": 2 }, on).ramMib;
    expect(r2 - r1).toBe(budget.battle.worker_extra_ram_mib + 8 * budget.bot.ram_scenario_mib);
    const margin = clone();
    margin.safety.min_available_mib = 5000;
    expect(scenarioFit(margin, { "4v4": 1 }, on).fits).toBe(false);
    const heavyStreamer = clone();
    heavyStreamer.services.streamer.ram_scenario_mib = 4096;
    expect(scenarioFit(heavyStreamer, { "4v4": 1 }, on).fits).toBe(false);
    const cpuStreamer = clone();
    cpuStreamer.services.streamer.cpu_expected = 5;
    expect(scenarioFit(cpuStreamer, { "1v1": 1 }, on).fits).toBe(false);
    const spike = clone();
    spike.battle.cpu_transient_peak = 4;
    expect(scenarioFit(spike, { "4v4": 1 }, { streaming: true, transient: true }).fits).toBe(false);
  });

  it("RB-12: memToMib interpreta los sufijos del compose y rechaza lo que no entiende", () => {
    expect(memToMib("256M")).toBe(256);
    expect(memToMib("1G")).toBe(1024);
    expect(memToMib("512m")).toBe(512);
    expect(() => memToMib("mucho")).toThrow();
  });
});
