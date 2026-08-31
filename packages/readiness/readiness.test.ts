/**
 * R17 · Suite del motor de readiness.
 *
 * El test que importa es el de MUTACIONES: para cada comprobación se reproduce
 * un fallo real y se exige que la comprobación lo detecte. Una comprobación sin
 * mutación que la ponga roja se considera un defecto de la suite y falla aquí.
 */
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONFIG_MODEL, resolveConfig, isEnabled } from "./config.ts";
import { READINESS_CHECKS } from "./checks.ts";
import { runReadiness, type ReadinessContext } from "./engine.ts";
import { planFirstRun } from "./first-run.ts";
import { MUTATIONS, nominalContext, nominalEnv } from "./mutations.ts";
import { localProbes } from "./probes-local.ts";
import { renderReport } from "./report.ts";

describe("modelo de configuración", () => {
  it("el escenario nominal es válido y sin puertas encendidas", () => {
    const r = resolveConfig(nominalEnv());
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.gatesOn).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("faltar una clave obligatoria es error, no aviso", () => {
    const env = nominalEnv();
    delete env.S9_BACKUP_TARGET;
    const r = resolveConfig(env);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.code === "missing_required" && p.key === "S9_BACKUP_TARGET")).toBe(true);
  });

  it("encender una puerta bloqueada por el operador es ERROR", () => {
    for (const key of ["S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"]) {
      const r = resolveConfig({ ...nominalEnv(), [key]: "1" });
      expect(r.gatesOn).toContain(key);
      expect(r.problems.some((p) => p.code === "gate_blocked" && p.key === key)).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it("las puertas están apagadas por defecto cuando no se declaran", () => {
    const env = nominalEnv();
    delete env.S9_ENABLE_REAL_BATTLE_RUNS;
    delete env.S9_PUBLIC_SPECTATE_ENABLED;
    expect(resolveConfig(env).gatesOn).toEqual([]);
  });

  it("un secreto débil conocido se rechaza sin imprimir el valor", () => {
    const r = resolveConfig({ ...nominalEnv(), S9_JWT_SECRET: "changeme" });
    const problem = r.problems.find((p) => p.code === "forbidden_value" && p.key === "S9_JWT_SECRET");
    expect(problem).toBeDefined();
    expect(problem!.message).not.toContain("changeme");
    expect(r.effective.S9_JWT_SECRET).not.toContain("changeme");
  });

  it("un secreto por entorno en claro genera aviso a favor de *_FILE", () => {
    const r = resolveConfig({ ...nominalEnv(), S9_DB_URL: "postgres://u:p@<internal-db-host>/db" });
    expect(r.problems.some((p) => p.code === "secret_inline" && p.key === "S9_DB_URL")).toBe(true);
  });

  it("una clave S9_* desconocida se señala como configuración fantasma", () => {
    const r = resolveConfig({ ...nominalEnv(), S9_TURBO_MODE: "1" });
    expect(r.problems.some((p) => p.code === "unknown_key" && p.key === "S9_TURBO_MODE")).toBe(true);
  });

  it("S9_DATA_DIR en /tmp es un valor prohibido", () => {
    const r = resolveConfig({ ...nominalEnv(), S9_DATA_DIR: "/tmp" });
    expect(r.ok).toBe(false);
  });

  it("isEnabled interpreta igual todas las formas afirmativas", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) expect(isEnabled(v)).toBe(true);
    for (const v of ["0", "false", "", undefined, "no"]) expect(isEnabled(v)).toBe(false);
  });

  it("toda entrada del modelo declara propósito, y las puertas tienen defecto apagado", () => {
    for (const e of CONFIG_MODEL) {
      expect(e.purpose.length).toBeGreaterThan(10);
      if (e.kind === "gate") expect(isEnabled(e.default)).toBe(false);
      if (e.kind === "safeDefault") expect(e.default).toBeDefined();
    }
  });
});

describe("contrato de las comprobaciones", () => {
  it("toda comprobación declara qué demuestra y qué NO demuestra", () => {
    for (const c of READINESS_CHECKS) {
      expect(c.proves.length).toBeGreaterThan(20);
      expect(c.doesNotProve.length).toBeGreaterThan(20);
      expect(c.proves).not.toEqual(c.doesNotProve);
    }
  });

  it("los identificadores son únicos", () => {
    const ids = READINESS_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hay cobertura de los seis bloques de R17", () => {
    const blocks = new Set(READINESS_CHECKS.map((c) => c.block));
    for (const b of [
      "almacenamiento",
      "copias",
      "puertas-ejecucion",
      "puertas-spectator",
      "seguridad",
      "diagnostico",
    ]) {
      expect(blocks).toContain(b);
    }
  });
});

describe("motor", () => {
  it("el escenario nominal da READY", async () => {
    const report = await runReadiness(READINESS_CHECKS, nominalContext());
    expect(report.verdict).toBe("READY");
    expect(report.counts.verified).toBe(READINESS_CHECKS.length);
    expect(report.blockers).toEqual([]);
  });

  it("una sonda que lanza excepción NO se salta: deja NOT_READY", async () => {
    const ctx = nominalContext();
    ctx.probes.dataDirWrite = async () => {
      throw new Error("boom");
    };
    const report = await runReadiness(READINESS_CHECKS, ctx);
    expect(report.verdict).toBe("NOT_READY");
    const r = report.results.find((x) => x.check.id === "storage.writable")!;
    expect(r.outcome.status).toBe("not_exercised");
  });

  it("no-ejercida nunca cuenta como aprobada", async () => {
    const ctx: ReadinessContext = { env: nominalEnv(), probes: localProbes() };
    const report = await runReadiness(READINESS_CHECKS, ctx);
    expect(report.verdict).toBe("NOT_READY");
    expect(report.counts.not_exercised).toBeGreaterThan(0);
    expect(report.counts.verified).toBeLessThan(READINESS_CHECKS.length);
  });

  it("las sondas locales sí ejercen de verdad la escritura en disco", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r17-"));
    try {
      const ctx: ReadinessContext = { env: { S9_DATA_DIR: dir }, probes: localProbes() };
      const check = READINESS_CHECKS.find((c) => c.id === "storage.writable")!;
      const ok = await check.run(ctx);
      expect(ok.status).toBe("verified");

      // Mutación real sobre el sistema de ficheros: sin permiso de escritura,
      // la misma comprobación debe ponerse roja.
      chmodSync(dir, 0o500);
      const denied = await check.run(ctx);
      if (process.getuid?.() === 0) {
        expect(["verified", "not_exercised"]).toContain(denied.status);
      } else {
        expect(denied.status).toBe("not_exercised");
        expect(denied.evidence).toContain("no se escribió");
      }
    } finally {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* limpieza best-effort */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mutaciones: cada comprobación puede ponerse ROJA", () => {
  it("toda comprobación tiene al menos una mutación que la detecta", () => {
    const cubiertas = new Set(MUTATIONS.map((m) => m.checkId));
    const sinMutacion = READINESS_CHECKS.filter((c) => !cubiertas.has(c.id)).map((c) => c.id);
    expect(sinMutacion).toEqual([]);
  });

  it("toda mutación apunta a una comprobación existente", () => {
    const ids = new Set(READINESS_CHECKS.map((c) => c.id));
    for (const m of MUTATIONS) expect(ids.has(m.checkId)).toBe(true);
  });

  for (const mutation of MUTATIONS) {
    it(`[${mutation.checkId}] detecta: ${mutation.name}`, async () => {
      const ctx = nominalContext();
      mutation.apply(ctx);
      const report = await runReadiness(READINESS_CHECKS, ctx);
      const result = report.results.find((r) => r.check.id === mutation.checkId)!;
      expect(result.outcome.status).not.toBe("verified");
      expect(result.outcome.remedy ?? "").not.toBe("");
      if (result.check.required) expect(report.verdict).toBe("NOT_READY");
    });
  }
});

describe("asistente de primer arranque", () => {
  it("con configuración vacía no deja continuar y pide lo obligatorio", () => {
    const plan = planFirstRun({});
    expect(plan.canProceed).toBe(false);
    const pendientes = plan.steps.filter((s) => s.mandatory && s.state !== "done").map((s) => s.id);
    expect(pendientes).toContain("config.S9_DATA_DIR");
    expect(pendientes).toContain("config.S9_JWT_SECRET");
  });

  it("con el nominal y sin readiness ejecutado, los pasos de config quedan hechos", () => {
    const plan = planFirstRun(nominalEnv());
    expect(plan.canProceed).toBe(true);
    expect(plan.steps.find((s) => s.id === "gate.S9_ENABLE_REAL_BATTLE_RUNS")!.state).toBe("done");
  });

  it("un readiness con comprobaciones no ejercidas deja pasos 'unknown' y bloquea", async () => {
    const report = await runReadiness(READINESS_CHECKS, {
      env: nominalEnv(),
      probes: localProbes(),
    });
    const plan = planFirstRun(nominalEnv(), report);
    expect(plan.canProceed).toBe(false);
    expect(plan.steps.some((s) => s.state === "unknown")).toBe(true);
  });

  it("una puerta bloqueada encendida deja el plan en pendiente", () => {
    const plan = planFirstRun({ ...nominalEnv(), S9_PUBLIC_SPECTATE_ENABLED: "1" });
    expect(plan.canProceed).toBe(false);
  });
});

describe("informe", () => {
  it("incluye veredicto, recuento completo y el 'NO demuestra' de cada comprobación", async () => {
    const report = await runReadiness(READINESS_CHECKS, nominalContext());
    const texto = renderReport(report, resolveConfig(nominalEnv()), planFirstRun(nominalEnv(), report));
    expect(texto).toContain("VEREDICTO: READY");
    expect(texto).toContain("no-ejercidas=");
    for (const c of READINESS_CHECKS) expect(texto).toContain(c.id);
    expect(texto).toContain("NO demuestra:");
  });

  it("nunca imprime el valor de un secreto", async () => {
    const env = { ...nominalEnv(), S9_JWT_SECRET: "valor-super-secreto-42" };
    const report = await runReadiness(READINESS_CHECKS, { env, probes: nominalContext().probes });
    const texto = renderReport(report, resolveConfig(env), planFirstRun(env, report));
    expect(texto).not.toContain("valor-super-secreto-42");
  });
});
