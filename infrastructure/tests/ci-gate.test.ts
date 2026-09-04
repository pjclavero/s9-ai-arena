// Tests del semáforo de la CI (R2.2, ERR-GES-05).
// DoD: una ejecución que omite staging por falta de secreto es AMARILLA (no
// verde); un fallo de seguridad (scan) es ROJO y bloquea; todo camino no
// verificable (job ausente, resultado desconocido, éxito sin evidencia) falla
// cerrado y se reporta como omitido, nunca como aprobado.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error módulo .mjs sin tipos
import { evaluarSemaforo, resumenMarkdown, JOBS_CI } from "../scripts/ci-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, "..", "scripts", "ci-gate.mjs");

type Needs = Record<string, { result?: string; outputs?: Record<string, string> }>;

/** needs con todas las etapas obligatorias en success. */
function baseNeeds(overrides: Needs = {}): Needs {
  const needs: Needs = {};
  for (const job of JOBS_CI) needs[job.id] = { result: "success", outputs: {} };
  // SEMÁNTICA DEL SCAN: el job `scan` ya no se juzga por su `result` sino por el
  // ESTADO que declara. El escenario nominal es un escaneo que corrió y no
  // encontró nada; un `success` mudo es fail-closed y tiene su propio test.
  needs["scan"] = { result: "success", outputs: { estado: "CLEAN", readiness: "verified" } };
  return { ...needs, ...overrides };
}

const MAIN = { mainRun: true };
const PR = { mainRun: false };

describe("ci-gate · semáforo verde/amarillo/rojo (R2.2)", () => {
  it("PR con todo en verde y staging skipped (solo main) → VERDE, staging 'no aplica'", () => {
    const v = evaluarSemaforo(
      baseNeeds({ "deploy-staging": { result: "skipped" }, "smoke-and-promote": { result: "skipped" } }),
      PR,
    );
    expect(v.color).toBe("verde");
    const staging = v.filas.find((f: any) => f.id === "deploy-staging");
    expect(staging.color).toBe("no-aplica");
  });

  it("DoD: en main, staging omitido por falta de STAGING_HOST → AMARILLO, nunca verde", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        "deploy-staging": { result: "success", outputs: { resultado: "omitido" } },
        "smoke-and-promote": { result: "success", outputs: { resultado: "omitido" } },
      }),
      MAIN,
    );
    expect(v.color).toBe("amarillo");
    expect(v.filas.find((f: any) => f.id === "deploy-staging").motivo).toMatch(/OMITIDO/);
  });

  it("en main, despliegue y promoción con evidencia real → VERDE", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        "deploy-staging": { result: "success", outputs: { resultado: "desplegado" } },
        "smoke-and-promote": { result: "success", outputs: { resultado: "promocionado" } },
      }),
      MAIN,
    );
    expect(v.color).toBe("verde");
  });

  it("fail-closed: en main, deploy en success SIN output de evidencia → AMARILLO (omitido), no verde", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        "deploy-staging": { result: "success", outputs: {} },
        "smoke-and-promote": { result: "success", outputs: { resultado: "promocionado" } },
      }),
      MAIN,
    );
    expect(v.color).toBe("amarillo");
    expect(v.filas.find((f: any) => f.id === "deploy-staging").motivo).toMatch(/sin evidencia/);
  });

  it("en main, jobs de staging skipped (p. ej. cadena rota) → AMARILLO como mínimo", () => {
    const v = evaluarSemaforo(
      baseNeeds({ "deploy-staging": { result: "skipped" }, "smoke-and-promote": { result: "skipped" } }),
      MAIN,
    );
    expect(v.color).toBe("amarillo");
  });

  it("DoD: fallo del job de seguridad (scan) → ROJO con motivo de seguridad, aunque staging esté amarillo", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        scan: { result: "failure", outputs: { estado: "FINDINGS", detalle: "1 CRITICAL" } },
        "deploy-staging": { result: "skipped" },
        "smoke-and-promote": { result: "skipped" },
      }),
      MAIN,
    );
    expect(v.color).toBe("rojo");
    expect(v.filas.find((f: any) => f.id === "scan").motivo).toMatch(/SEGURIDAD/);
  });

  it("fallo funcional (unit) en PR → ROJO", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        unit: { result: "failure" },
        "deploy-staging": { result: "skipped" },
        "smoke-and-promote": { result: "skipped" },
      }),
      PR,
    );
    expect(v.color).toBe("rojo");
  });

  it("fail-closed: job obligatorio skipped → ROJO (no puede contar como aprobado)", () => {
    const v = evaluarSemaforo(baseNeeds({ "e2e-mvp": { result: "skipped" } }), MAIN);
    expect(v.color).toBe("rojo");
  });

  it("fail-closed: job obligatorio cancelado → ROJO", () => {
    const v = evaluarSemaforo(baseNeeds({ contracts: { result: "cancelled" } }), PR);
    expect(v.color).toBe("rojo");
  });

  it("fail-closed: job esperado ausente del contexto needs → ROJO", () => {
    const needs = baseNeeds();
    delete needs["scan"];
    expect(evaluarSemaforo(needs, PR).color).toBe("rojo");
  });

  it("fail-closed: resultado desconocido → ROJO", () => {
    const v = evaluarSemaforo(baseNeeds({ unit: { result: "lo-que-sea" } }), PR);
    expect(v.color).toBe("rojo");
  });

  it("fallo del propio deploy en main (no omisión: error real) → ROJO", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        "deploy-staging": { result: "failure" },
        "smoke-and-promote": { result: "skipped" },
      }),
      MAIN,
    );
    expect(v.color).toBe("rojo");
  });

  it("el resumen Markdown declara el color y lista cada job con su motivo", () => {
    const v = evaluarSemaforo(
      baseNeeds({
        "deploy-staging": { result: "success", outputs: { resultado: "omitido" } },
        "smoke-and-promote": { result: "success", outputs: { resultado: "omitido" } },
      }),
      MAIN,
    );
    const md = resumenMarkdown(v);
    expect(md).toMatch(/AMARILLO/);
    expect(md).toMatch(/\| `deploy-staging` \|/);
    expect(md).toMatch(/OMITIDO/);
  });
});

describe("ci-gate · CLI (como lo invoca el job semaforo de ci.yml)", () => {
  function runCli(needs: Needs, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
    const out = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEEDS_JSON: JSON.stringify(needs),
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: summary,
          ...env,
        },
      });
    } catch (e: any) {
      stdout = String(e.stdout ?? "");
      status = e.status ?? 1;
    }
    return { stdout, status, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
  }

  it("verde en PR: exit 0, color=verde en GITHUB_OUTPUT y summary escrito", () => {
    const r = runCli(
      baseNeeds({ "deploy-staging": { result: "skipped" }, "smoke-and-promote": { result: "skipped" } }),
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/23/merge" },
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain("color=verde");
    expect(r.summary).toMatch(/VERDE/);
  });

  it("DoD: amarillo en main (staging omitido): exit 0 PERO color=amarillo y anotación ::warning::", () => {
    const r = runCli(
      baseNeeds({
        "deploy-staging": { result: "success", outputs: { resultado: "omitido" } },
        "smoke-and-promote": { result: "success", outputs: { resultado: "omitido" } },
      }),
      { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain("color=amarillo");
    expect(r.stdout).toMatch(/::warning::.*OMITIDO/);
  });

  it("rojo por seguridad: exit 1 y anotación ::error::", () => {
    const r = runCli(baseNeeds({ scan: { result: "failure", outputs: { estado: "FINDINGS" } } }), {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/23/merge",
    });
    expect(r.status).toBe(1);
    expect(r.output).toContain("color=rojo");
    expect(r.stdout).toMatch(/::error::.*SEGURIDAD/);
  });

  it("fail-closed: NEEDS_JSON inválido → exit 1 (rojo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
    const out = join(dir, "output.txt");
    writeFileSync(out, "");
    let status = 0;
    try {
      execFileSync(process.execPath, [GATE], {
        encoding: "utf8",
        env: { ...process.env, NEEDS_JSON: "esto no es json", GITHUB_OUTPUT: out },
      });
    } catch (e: any) {
      status = e.status ?? 1;
    }
    expect(status).toBe(1);
  });
});

describe("ci-gate · SEMÁNTICA DEL SCAN: el job `scan` se juzga por el estado que declara", () => {
  // En PR, staging y promoción no corren: se declaran skipped como en el resto
  // de la suite, para que el color del run lo decida SÓLO el job `scan`.
  const conScan = (outputs: Record<string, string>, result = "success") =>
    baseNeeds({
      scan: { result, outputs },
      "deploy-staging": { result: "skipped" },
      "smoke-and-promote": { result: "skipped" },
    });

  it("control POSITIVO: CLEAN declarado y job en success → VERDE", () => {
    const v = evaluarSemaforo(conScan({ estado: "CLEAN", readiness: "verified" }), PR);
    expect(v.color).toBe("verde");
    expect(v.filas.find((f: any) => f.id === "scan").color).toBe("verde");
  });

  it("EL INCIDENTE: SOURCE_UNAVAILABLE ya NO se llama «fallo de seguridad»", () => {
    const v = evaluarSemaforo(
      conScan({ estado: "SOURCE_UNAVAILABLE", detalle: "audit endpoint returned an error" }, "failure"),
      PR,
    );
    const scan = v.filas.find((f: any) => f.id === "scan");
    expect(v.color).toBe("rojo"); // bloquea igual...
    expect(scan.motivo).toMatch(/SEGURIDAD NO COMPROBADA/); // ...pero con otro nombre
    expect(scan.motivo).not.toMatch(/HALLAZGOS DE SEGURIDAD/);
    expect(scan.motivo).toMatch(/REINTENTAR/);
  });

  it("EL FALLO SIMÉTRICO: SCAN_ERROR (respuesta degradada) NO puede salir verde", () => {
    const v = evaluarSemaforo(conScan({ estado: "SCAN_ERROR", detalle: "informe vacío" }), PR);
    expect(v.color).toBe("rojo");
    expect(v.filas.find((f: any) => f.id === "scan").motivo).toMatch(/NO COMPROBADA/);
  });

  it("garantía 5: hallazgo y no-comprobado bloquean los dos, con motivos DISTINTOS", () => {
    const hallazgo = evaluarSemaforo(conScan({ estado: "FINDINGS" }, "failure"), PR).filas.find(
      (f: any) => f.id === "scan",
    );
    const caida = evaluarSemaforo(conScan({ estado: "SOURCE_UNAVAILABLE" }, "failure"), PR).filas.find(
      (f: any) => f.id === "scan",
    );
    expect(hallazgo.color).toBe("rojo");
    expect(caida.color).toBe("rojo");
    expect(hallazgo.motivo).toMatch(/HALLAZGOS DE SEGURIDAD/);
    expect(hallazgo.motivo).not.toBe(caida.motivo);
  });

  it("fail-closed: `success` sin declarar estado → ROJO (no se deduce un verde del código de salida)", () => {
    const v = evaluarSemaforo(conScan({}), PR);
    expect(v.color).toBe("rojo");
    expect(v.filas.find((f: any) => f.id === "scan").motivo).toMatch(/no declaró/);
  });

  it("fail-closed: CLEAN declarado por un job que se cayó → ROJO", () => {
    const v = evaluarSemaforo(conScan({ estado: "CLEAN" }, "failure"), PR);
    expect(v.color).toBe("rojo");
  });

  it("fail-closed: `skipped` → ROJO por no comprobado, no por hallazgo", () => {
    const v = evaluarSemaforo(conScan({}, "skipped"), PR);
    expect(v.color).toBe("rojo");
    expect(v.filas.find((f: any) => f.id === "scan").motivo).toMatch(/NO COMPROBADA/);
  });

  it("garantía 4: un estado inventado NO cae al camino permisivo", () => {
    for (const estado of ["OK", "clean", "PASSED", ""]) {
      const v = evaluarSemaforo(conScan({ estado }), PR);
      expect(v.color, `estado=${estado}`).toBe("rojo");
    }
  });
});
