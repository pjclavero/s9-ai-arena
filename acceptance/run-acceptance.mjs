#!/usr/bin/env node
/**
 * E12 · T12.2 — Pipeline de aceptación del capítulo 28.
 *
 * Ejecuta los 10 criterios (acceptance/criteria.mjs) como jobs secuenciales,
 * cada uno con resultado BINARIO, y publica:
 *   - docs/aceptacion/ultimo-informe.md  (tabla verde/roja legible por el operador)
 *   - acceptance/report.json             (evidencia máquina, artefacto de CI)
 *
 * Regla de promoción (DoD): el proceso sale con código != 0 si CUALQUIER
 * criterio está en rojo — el workflow de aceptación es la puerta del hito M5 y
 * bloquea la promoción a producción.
 *
 * Uso:  node acceptance/run-acceptance.mjs [--only=motor,replay]
 * Env:  DETERMINISM_RUNS=1000 (nightly) · ACCEPTANCE_MAX_WORKERS
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITERIA } from "./criteria.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",");
const jobs = only ? CRITERIA.filter((c) => only.includes(c.id)) : CRITERIA;

const results = [];
for (const c of jobs) {
  const started = Date.now();
  process.stdout.write(`\n═══ [${c.id}] ${c.nombre}\n`);
  const r = spawnSync(c.comando[0], c.comando.slice(1), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 30 * 60_000,
  });
  const ok = r.status === 0;
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  // Cola del log como evidencia enlazable (el log completo va al artefacto de CI).
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
  results.push({ ...c, ok, seconds, exitCode: r.status, logTail: tail });
  process.stdout.write(`${ok ? "VERDE" : "ROJO"} · ${seconds}s (exit ${r.status})\n`);
  if (!ok) process.stdout.write(tail + "\n");
}

const verdes = results.filter((r) => r.ok).length;
const allGreen = verdes === results.length;

// ---------------------------------------------------------------- informe md
const now = new Date().toISOString();
const md = `# Informe de aceptación — capítulo 28 del dosier técnico

**Fecha:** ${now} · **Resultado global:** ${allGreen ? "🟢 VERDE" : "🔴 ROJO"} (${verdes}/${results.length} criterios en verde)
**Regla de promoción:** un criterio en rojo bloquea la promoción a producción (puerta del hito M5).

Este informe lo genera \`node acceptance/run-acceptance.mjs\` (equipo E12). No hace
falta conocer el código: la columna *Resultado* es la decisión, *Evidencia* dice qué
se comprobó y *Cobertura en este runner* declara honestamente qué parte del criterio
exige un entorno con Docker/staging y dónde está implementada.

| # | Criterio | Resultado | Duración | Evidencia | Cobertura en este runner |
|---|---|---|---|---|---|
${results
  .map(
    (r, i) =>
      `| ${i + 1} | **${r.id}** — ${r.nombre} | ${r.ok ? "🟢 VERDE" : "🔴 ROJO"} | ${r.seconds}s | ${r.evidencia} | ${r.cobertura} |`,
  )
  .join("\n")}

## Cómo re-ejecutar

- Bajo demanda: \`node acceptance/run-acceptance.mjs\` (o \`--only=motor,replay\`).
- Nightly y manual: workflow \`acceptance\` (.github/workflows/acceptance.yml), que
  sube este informe y \`acceptance/report.json\` como artefactos. En nightly,
  \`DETERMINISM_RUNS=1000\` para el criterio *motor* (DoD del cap. 28).

## Nota del entorno

Generado en un runner sin privilegios Docker: los criterios marcados "parcial"
ejecutan la parte lógica/configuración REAL de su suite; la verificación
containerizada correspondiente está implementada y documentada por E6/E10 y se
ejecuta en la puerta M5 sobre staging (docs/despliegue.md, docs/entrega-E6.md).
`;

mkdirSync(join(ROOT, "docs", "aceptacion"), { recursive: true });
writeFileSync(join(ROOT, "docs", "aceptacion", "ultimo-informe.md"), md);
writeFileSync(
  join(ROOT, "acceptance", "report.json"),
  JSON.stringify({ generatedAt: now, allGreen, verdes, total: results.length, results }, null, 2),
);

process.stdout.write(
  `\n${allGreen ? "🟢" : "🔴"} ${verdes}/${results.length} criterios en verde. Informe: docs/aceptacion/ultimo-informe.md\n`,
);
process.exit(allGreen ? 0 : 1);
