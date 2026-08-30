/**
 * R17 · CLI de readiness / primer arranque.
 *
 *   npx tsx scripts/readiness.ts            informe con sondas locales honestas
 *   npx tsx scripts/readiness.ts --selftest escenario nominal (autodiagnóstico
 *                                           del propio motor; NO dice nada de
 *                                           tu instalación)
 *
 * Código de salida: 0 sólo si el veredicto es READY. Un "no se pudo comprobar"
 * sale distinto de cero a propósito: no aprobamos por omisión.
 */
import { READINESS_CHECKS } from "../packages/readiness/checks.ts";
import { resolveConfig } from "../packages/readiness/config.ts";
import { runReadiness } from "../packages/readiness/engine.ts";
import { planFirstRun } from "../packages/readiness/first-run.ts";
import { nominalContext } from "../packages/readiness/mutations.ts";
import { localProbes } from "../packages/readiness/probes-local.ts";
import { renderReport } from "../packages/readiness/report.ts";

const selftest = process.argv.includes("--selftest");
const ctx = selftest ? nominalContext() : { env: process.env, probes: localProbes() };

const report = await runReadiness(READINESS_CHECKS, ctx);
const resolution = resolveConfig(ctx.env);
const plan = planFirstRun(ctx.env, report);

console.log(renderReport(report, resolution, plan));
if (selftest) {
  console.log("\n(--selftest: escenario sintético. No dice nada sobre esta instalación.)");
}
process.exit(report.verdict === "READY" && resolution.ok ? 0 : 1);
