/**
 * SEMÁNTICA DEL SCAN · el contrato de los cinco estados.
 *
 * Lo que estas pruebas tienen que poder poner en rojo (y las mutaciones de
 * `infrastructure/scripts/scan-status-mutations.mjs` lo comprueban):
 *   1. SOURCE_UNAVAILABLE tratado como CLEAN.
 *   2. SCAN_ERROR tratado como CLEAN.
 *   3. Una respuesta vacía o degradada del endpoint leída como «0 vulnerabilidades».
 *   4. Un estado no contemplado cayendo al camino permisivo.
 *   5. El semáforo perdiendo la distinción entre «hallazgos» y «no comprobado».
 *
 * Cada garantía se prueba con control POSITIVO (el caso bueno sigue saliendo
 * verde) y NEGATIVO (el caso malo bloquea): una prueba que sólo mira un lado no
 * distingue «funciona» de «siempre dice lo mismo».
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs sin tipos
import {
  AVISO_ENDPOINT_RETIRADO,
  ESTADO_SCAN,
  ESTADO_SCAN_A_READINESS,
  POLITICA_SCAN_ERROR,
  READINESS,
  agregarScans,
  bloquea,
  clasificarNpmAudit,
  clasificarScanCompose,
  clasificarTrivy,
  endpointRetirado,
  motivoDeScan,
  pareceFuenteCaida,
  readinessDeScan,
} from "../../packages/readiness/scan-status.mjs";
import { ESTADO_DRIFT_A_READINESS } from "../../packages/readiness/checks.ts";
import type { CheckStatus } from "../../packages/readiness/engine.ts";

// ── Coordinación con packages/readiness (consumir, no reimplementar) ─────────
describe("scan-status · coordinación con packages/readiness", () => {
  it("usa EXACTAMENTE el vocabulario de CheckStatus, no una escala paralela", () => {
    // Comprobación de TIPO: si alguien inventara un cuarto estado o renombrara
    // uno, esto deja de compilar en `npm run typecheck`.
    const verified: CheckStatus = READINESS.VERIFIED;
    const failed: CheckStatus = READINESS.FAILED;
    const notExercised: CheckStatus = READINESS.NOT_EXERCISED;
    expect([verified, failed, notExercised]).toEqual(["verified", "failed", "not_exercised"]);
  });

  it("los destinos de la tabla de scan son los mismos valores que usa ESTADO_DRIFT_A_READINESS", () => {
    const vocabularioDrift = new Set(Object.values(ESTADO_DRIFT_A_READINESS));
    const destinos = Object.values(ESTADO_SCAN_A_READINESS).filter((v) => v !== "segun_politica");
    // Todo destino de scan pertenece al vocabulario de readiness ya existente.
    for (const d of destinos) expect(["verified", "failed", "not_exercised"]).toContain(d);
    // Y el precedente de #138 sigue usando ese mismo vocabulario (control de
    // que no estamos comparando contra una tabla que ya no existe).
    expect(vocabularioDrift.has("not_exercised")).toBe(true);
    expect(vocabularioDrift.has("failed")).toBe(true);
  });

  it("el contrato es un DATO enumerable con los cinco estados, no ramas de un switch", () => {
    expect(Object.keys(ESTADO_SCAN_A_READINESS).sort()).toEqual(
      ["CLEAN", "FINDINGS", "NOT_EXERCISED", "SCAN_ERROR", "SOURCE_UNAVAILABLE"].sort(),
    );
    expect(Object.keys(ESTADO_SCAN).sort()).toEqual(Object.keys(ESTADO_SCAN_A_READINESS).sort());
  });
});

// ── Garantía 1 y 2: nada que no sea CLEAN llega a verified ──────────────────
describe("scan-status · ESTADO → READINESS (regla dura del operador)", () => {
  it("control POSITIVO: CLEAN es el único que llega a verified", () => {
    expect(readinessDeScan(ESTADO_SCAN.CLEAN)).toBe("verified");
    expect(bloquea(readinessDeScan(ESTADO_SCAN.CLEAN))).toBe(false);
  });

  it("control NEGATIVO: FINDINGS → failed y bloquea", () => {
    expect(readinessDeScan(ESTADO_SCAN.FINDINGS)).toBe("failed");
    expect(bloquea("failed")).toBe(true);
  });

  it("DoD: SOURCE_UNAVAILABLE → not_exercised, JAMÁS verified (rate-limit no es «0 vulnerabilidades»)", () => {
    expect(readinessDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE)).toBe("not_exercised");
    expect(readinessDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE)).not.toBe("verified");
    expect(bloquea(readinessDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE))).toBe(true);
  });

  it("DoD: NOT_EXERCISED → not_exercised y bloquea", () => {
    expect(readinessDeScan(ESTADO_SCAN.NOT_EXERCISED)).toBe("not_exercised");
    expect(bloquea(readinessDeScan(ESTADO_SCAN.NOT_EXERCISED))).toBe(true);
  });

  it("DoD: SCAN_ERROR sigue la POLÍTICA DECLARADA, y ninguna de sus opciones es verified", () => {
    expect(readinessDeScan(ESTADO_SCAN.SCAN_ERROR, { herramienta: "npm-audit" })).toBe("not_exercised");
    expect(readinessDeScan(ESTADO_SCAN.SCAN_ERROR, { herramienta: "compose" })).toBe("failed");
    for (const destino of Object.values(POLITICA_SCAN_ERROR)) expect(destino).not.toBe("verified");
  });

  it("SCAN_ERROR de una herramienta SIN política declarada no se aprueba: cae al lado que bloquea", () => {
    expect(readinessDeScan(ESTADO_SCAN.SCAN_ERROR, { herramienta: "herramienta-nueva" })).toBe("not_exercised");
    // Y ni siquiera una política que dijera "verified" puede colar un verde.
    expect(readinessDeScan(ESTADO_SCAN.SCAN_ERROR, { herramienta: "x", politica: { x: "verified" } })).toBe(
      "not_exercised",
    );
  });

  it("DoD (garantía 4): un estado NO contemplado no cae al camino permisivo", () => {
    for (const raro of ["", "clean", "CLEAN_ENOUGH", "OK", "UNKNOWN", null, undefined, 0, {}, []]) {
      expect(readinessDeScan(raro as never)).toBe("not_exercised");
    }
  });
});

// ── Garantía 3: informes vacíos o degradados no son «limpio» ────────────────
describe("clasificarNpmAudit · el informe manda, no el código de salida", () => {
  const informe = (vulns: Record<string, number>) =>
    JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: vulns } });
  const CERO = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };

  it("control POSITIVO: informe completo con 0 altas y exit 0 → CLEAN", () => {
    const r = clasificarNpmAudit({ exitCode: 0, stdout: informe(CERO) });
    expect(r.estado).toBe("CLEAN");
    expect(readinessDeScan(r.estado)).toBe("verified");
  });

  it("control POSITIVO: hay bajas pero ninguna >= high → sigue siendo CLEAN", () => {
    const r = clasificarNpmAudit({ exitCode: 1, stdout: informe({ ...CERO, low: 4, total: 4 }) });
    expect(r.estado).toBe("CLEAN");
  });

  it("control NEGATIVO: una crítica → FINDINGS (y NO source unavailable)", () => {
    const r = clasificarNpmAudit({ exitCode: 1, stdout: informe({ ...CERO, critical: 1, total: 1 }) });
    expect(r.estado).toBe("FINDINGS");
    expect(readinessDeScan(r.estado)).toBe("failed");
  });

  it("EL INCIDENTE: «audit endpoint returned an error» → SOURCE_UNAVAILABLE, no FINDINGS", () => {
    const r = clasificarNpmAudit({
      exitCode: 1,
      stdout: "",
      stderr:
        "npm notice This endpoint is being retired. Use the bulk advisory endpoint instead.\nnpm error audit endpoint returned an error",
    });
    expect(r.estado).toBe("SOURCE_UNAVAILABLE");
    expect(motivoDeScan(r.estado).clase).toBe("no-comprobado");
    expect(motivoDeScan(r.estado).reintentable).toBe(true);
  });

  it("EL FALLO SIMÉTRICO (garantía 3): 200 con cuerpo vacío → SCAN_ERROR, nunca CLEAN", () => {
    for (const cuerpo of ["", "   ", "{}", "null", "[]", '{"metadata":{}}', '{"auditReportVersion":2}']) {
      const r = clasificarNpmAudit({ exitCode: 0, stdout: cuerpo });
      expect(r.estado, `cuerpo=${JSON.stringify(cuerpo)}`).toBe("SCAN_ERROR");
      expect(readinessDeScan(r.estado, { herramienta: "npm-audit" })).not.toBe("verified");
    }
  });

  it("informe con metadata.vulnerabilities vacío (sin severidades) → SCAN_ERROR, no «0 vulnerabilidades»", () => {
    const r = clasificarNpmAudit({
      exitCode: 0,
      stdout: JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: {} } }),
    });
    expect(r.estado).toBe("SCAN_ERROR");
  });

  it("timeout y errores de red del registro → SOURCE_UNAVAILABLE", () => {
    expect(clasificarNpmAudit({ exitCode: null, timedOut: true }).estado).toBe("SOURCE_UNAVAILABLE");
    expect(
      clasificarNpmAudit({ exitCode: 1, stderr: "request to https://registry.npmjs.org/ failed, reason: ETIMEDOUT" })
        .estado,
    ).toBe("SOURCE_UNAVAILABLE");
    expect(clasificarNpmAudit({ exitCode: 1, stderr: "npm error 429 Too Many Requests" }).estado).toBe(
      "SOURCE_UNAVAILABLE",
    );
  });

  it("un error declarado DENTRO del JSON se separa según sea de fuente o de herramienta", () => {
    expect(
      clasificarNpmAudit({
        exitCode: 1,
        stdout: JSON.stringify({ error: { summary: "ENOTFOUND registry.npmjs.org" } }),
      }).estado,
    ).toBe("SOURCE_UNAVAILABLE");
    expect(
      clasificarNpmAudit({ exitCode: 1, stdout: JSON.stringify({ error: { summary: "lockfile corrupto" } }) }).estado,
    ).toBe("SCAN_ERROR");
  });

  it("detecta el aviso de retirada del endpoint sin confundirlo con un veredicto", () => {
    expect(endpointRetirado("npm notice This endpoint is being retired.")).toBe(true);
    expect(AVISO_ENDPOINT_RETIRADO.test("use the bulk advisory endpoint instead")).toBe(true);
    expect(endpointRetirado("todo bien")).toBe(false);
    // El aviso SOLO es un aviso: con un informe legible el veredicto es CLEAN.
    const r = clasificarNpmAudit({
      exitCode: 0,
      stdout: informe(CERO),
      stderr: "npm notice This endpoint is being retired. Use the bulk advisory endpoint instead.",
    });
    expect(r.estado).toBe("CLEAN");
  });

  it("pareceFuenteCaida distingue señal de ruido (positivo y negativo)", () => {
    expect(pareceFuenteCaida("npm error audit endpoint returned an error")).toBe(true);
    expect(pareceFuenteCaida("ECONNRESET")).toBe(true);
    expect(pareceFuenteCaida("found 3 vulnerabilities (2 high, 1 critical)")).toBe(false);
    expect(pareceFuenteCaida("")).toBe(false);
  });
});

describe("clasificarTrivy · informe sin objetivos no es árbol limpio", () => {
  const conObjetivo = (vulns: unknown[]) =>
    JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "package-lock.json", Vulnerabilities: vulns }] });

  it("control POSITIVO: objetivos analizados y sin vulnerabilidades → CLEAN", () => {
    expect(clasificarTrivy({ exitCode: 0, stdout: conObjetivo([]) }).estado).toBe("CLEAN");
  });

  it("control NEGATIVO: una CRITICAL → FINDINGS", () => {
    expect(clasificarTrivy({ exitCode: 0, stdout: conObjetivo([{ Severity: "CRITICAL" }]) }).estado).toBe("FINDINGS");
  });

  it("una MEDIUM no cuenta con el umbral CRITICAL/HIGH → CLEAN", () => {
    expect(clasificarTrivy({ exitCode: 0, stdout: conObjetivo([{ Severity: "MEDIUM" }]) }).estado).toBe("CLEAN");
  });

  it("DoD: informe SIN objetivos (Results ausente o vacío) → SCAN_ERROR, no CLEAN", () => {
    expect(clasificarTrivy({ exitCode: 0, stdout: JSON.stringify({ SchemaVersion: 2, Results: [] }) }).estado).toBe(
      "SCAN_ERROR",
    );
    expect(clasificarTrivy({ exitCode: 0, stdout: JSON.stringify({ SchemaVersion: 2 }) }).estado).toBe("SCAN_ERROR");
    expect(clasificarTrivy({ exitCode: 0, stdout: "{}" }).estado).toBe("SCAN_ERROR");
  });

  it("fallo de descarga de la base de datos (rate-limit de su registro) → SOURCE_UNAVAILABLE", () => {
    expect(
      clasificarTrivy({ exitCode: 1, stdout: "", stderr: "failed to download vulnerability DB: TOOMANYREQUESTS" })
        .estado,
    ).toBe("SOURCE_UNAVAILABLE");
  });
});

describe("clasificarScanCompose · local y determinista, sin SOURCE_UNAVAILABLE", () => {
  it("control POSITIVO: veredicto OK → CLEAN", () => {
    expect(
      clasificarScanCompose({ exitCode: 0, stdout: "OK · infrastructure/docker-compose.yml: sin nada\n" }).estado,
    ).toBe("CLEAN");
  });

  it("control NEGATIVO: infracciones del cap. 28 → FINDINGS", () => {
    const r = clasificarScanCompose({
      exitCode: 1,
      stdout: 'FALLO · c: el servicio "x" infringe el cap. 28 — docker.sock\n',
    });
    expect(r.estado).toBe("FINDINGS");
  });

  it("DoD: exit 0 SIN línea de veredicto → SCAN_ERROR (no hay prueba de que mirara nada)", () => {
    expect(clasificarScanCompose({ exitCode: 0, stdout: "" }).estado).toBe("SCAN_ERROR");
  });

  it("DoD: paso saltado (el `if: hashFiles` de antaño) → NOT_EXERCISED, no verde", () => {
    const r = clasificarScanCompose({ ejecutado: false });
    expect(r.estado).toBe("NOT_EXERCISED");
    expect(readinessDeScan(r.estado)).toBe("not_exercised");
  });

  it("crash del escáner (exit 2 sin FALLO) → SCAN_ERROR y, por política, failed", () => {
    const r = clasificarScanCompose({ exitCode: 2, stderr: "SyntaxError" });
    expect(r.estado).toBe("SCAN_ERROR");
    expect(readinessDeScan(r.estado, { herramienta: "compose" })).toBe("failed");
  });
});

// ── Garantía 5: hallazgos y no-comprobado bloquean, pero con nombre distinto ──
describe("motivoDeScan · bloquear no basta, hay que decir POR QUÉ", () => {
  it("«hallazgos» y «no comprobado» son clases DISTINTAS aunque ambas bloqueen", () => {
    const hallazgo = motivoDeScan(ESTADO_SCAN.FINDINGS);
    const caida = motivoDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE);
    expect(hallazgo.clase).toBe("hallazgos");
    expect(caida.clase).toBe("no-comprobado");
    expect(hallazgo.clase).not.toBe(caida.clase);
    expect(hallazgo.texto).not.toBe(caida.texto);
    expect(bloquea(readinessDeScan(ESTADO_SCAN.FINDINGS))).toBe(true);
    expect(bloquea(readinessDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE))).toBe(true);
  });

  it("sólo la fuente caída se declara reintentable; un hallazgo no se reintenta", () => {
    expect(motivoDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE).reintentable).toBe(true);
    expect(motivoDeScan(ESTADO_SCAN.FINDINGS).reintentable).toBe(false);
    expect(motivoDeScan(ESTADO_SCAN.SCAN_ERROR).reintentable).toBe(false);
  });

  it("un estado no contemplado se nombra como no comprobado (fail-closed), no como aprobado", () => {
    const m = motivoDeScan("INVENTADO");
    expect(m.clase).toBe("no-comprobado");
    expect(m.texto).toMatch(/fail-closed/);
  });

  it("los textos de no-comprobado dicen explícitamente que NO son «0 vulnerabilidades»", () => {
    expect(motivoDeScan(ESTADO_SCAN.SOURCE_UNAVAILABLE).texto).toMatch(/NO significa 0 vulnerabilidades/);
    expect(motivoDeScan(ESTADO_SCAN.SCAN_ERROR).texto).toMatch(/NO significa 0 vulnerabilidades/);
  });
});

describe("agregarScans · el peor manda y el ausente cuenta", () => {
  const limpio = (h: string) => ({ herramienta: h, estado: "CLEAN", detalle: "ok" });

  it("control POSITIVO: los tres limpios → CLEAN/verified", () => {
    const v = agregarScans([limpio("npm-audit"), limpio("compose"), limpio("trivy")]);
    expect(v.estado).toBe("CLEAN");
    expect(v.readiness).toBe("verified");
  });

  it("un CLEAN y un SOURCE_UNAVAILABLE NO se promedian a verde", () => {
    const v = agregarScans([
      limpio("compose"),
      { herramienta: "npm-audit", estado: "SOURCE_UNAVAILABLE", detalle: "429" },
    ]);
    expect(v.estado).toBe("SOURCE_UNAVAILABLE");
    expect(v.readiness).toBe("not_exercised");
    expect(v.detalle).toMatch(/npm-audit/);
  });

  it("un hallazgo se nombra por delante de un no-comprobado, pero los dos aparecen en el detalle", () => {
    const v = agregarScans([
      { herramienta: "trivy", estado: "FINDINGS", detalle: "1 CRITICAL" },
      { herramienta: "npm-audit", estado: "SOURCE_UNAVAILABLE", detalle: "429" },
    ]);
    expect(v.estado).toBe("FINDINGS");
    expect(v.readiness).toBe("failed");
    expect(v.detalle).toMatch(/trivy/);
    expect(v.detalle).toMatch(/npm-audit/);
  });

  it("sin ningún resultado → NOT_EXERCISED (nunca un verde por lista vacía)", () => {
    expect(agregarScans([]).readiness).toBe("not_exercised");
    expect(agregarScans(undefined as never).readiness).toBe("not_exercised");
  });
});
