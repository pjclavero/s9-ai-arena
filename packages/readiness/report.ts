/**
 * R17 · Render del informe. Texto plano, apto para consola y para pegar en un
 * parte de incidencia. Regla dura: NUNCA imprime valores de claves secretas, y
 * el recuento de estados va siempre completo (un `not_exercised` escondido es
 * cómo se cuela un "skipped" como aprobado).
 */
import type { ConfigResolution } from "./config.ts";
import type { ReadinessReport } from "./engine.ts";
import type { FirstRunPlan } from "./first-run.ts";

const ICON = { verified: "OK ", failed: "FAIL", not_exercised: "??? " } as const;

export function renderReport(report: ReadinessReport, resolution?: ConfigResolution, plan?: FirstRunPlan): string {
  const lines: string[] = [];
  lines.push(`VEREDICTO: ${report.verdict}`);
  lines.push(
    `Recuento: verificadas=${report.counts.verified} fallidas=${report.counts.failed} no-ejercidas=${report.counts.not_exercised}`,
  );
  lines.push("(no-ejercida NO es aprobada)");
  lines.push("");

  if (resolution) {
    lines.push("── Configuración ──");
    for (const [k, v] of Object.entries(resolution.effective)) lines.push(`  ${k} = ${v}`);
    for (const p of resolution.problems) {
      lines.push(`  [${p.severity === "error" ? "ERROR" : "aviso"}] ${p.message}`);
    }
    lines.push("");
  }

  lines.push("── Comprobaciones ──");
  for (const { check, outcome } of report.results) {
    lines.push(`  [${ICON[outcome.status]}] ${check.id} · ${check.title}`);
    lines.push(`        efecto: ${outcome.evidence}`);
    lines.push(`        demuestra: ${check.proves}`);
    lines.push(`        NO demuestra: ${check.doesNotProve}`);
    if (outcome.remedy) lines.push(`        acción: ${outcome.remedy}`);
  }

  if (report.blockers.length > 0) {
    lines.push("");
    lines.push("── Bloqueantes ──");
    for (const b of report.blockers) lines.push(`  - ${b}`);
  }

  if (plan) {
    lines.push("");
    lines.push("── Primer arranque ──");
    for (const s of plan.steps) lines.push(`  [${s.state}] ${s.title}: ${s.action}`);
  }

  return lines.join("\n");
}
