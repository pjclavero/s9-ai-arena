#!/usr/bin/env node
/**
 * Semáforo de la CI (R2.2, ERR-GES-05): clasifica el resultado de un run en
 * VERDE / AMARILLO / ROJO a partir del contexto `needs` del job final.
 *
 *   - VERDE    todo lo obligatorio se ejecutó y aprobó y, en main, staging se
 *              desplegó y se le pasó el humo DE VERDAD (con evidencia declarada
 *              vía outputs.resultado).
 *   - AMARILLO las pruebas están bien pero algo NO SE PUDO ejecutar por falta
 *              de entorno externo (p. ej. STAGING_HOST sin configurar): el
 *              trabajo se reporta como OMITIDO, nunca como aprobado.
 *   - ROJO     fallo funcional o de seguridad, o un job obligatorio que no se
 *              ejecutó: la promoción queda bloqueada.
 *
 * Regla de oro de la Ronda 2: todo camino no verificable falla cerrado. Un
 * resultado desconocido, un job esperado que falta en `needs` o un despliegue
 * "en verde" sin evidencia NO cuentan como verde.
 *
 * Materialización en GitHub Actions (documentado en el reporte R2.2): Actions
 * no permite que un job de workflow termine con conclusión "neutral", así que
 * el amarillo se materializa como (1) título y summary del job `semaforo` con
 * el estado explícito, (2) anotaciones ::warning:: por cada omisión y (3) un
 * check-run "Semáforo CI" con conclusión `neutral` creado vía API por el
 * workflow a partir del output `color` de este script. El rojo hace fallar el
 * job (exit 1).
 *
 * Uso en CI:   NEEDS_JSON='${{ toJSON(needs) }}' node infrastructure/scripts/ci-gate.mjs
 * Tests:       infrastructure/tests/ci-gate.test.ts
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERDE = "verde";
export const AMARILLO = "amarillo";
export const ROJO = "rojo";

/**
 * Jobs de ci.yml que el semáforo espera. `clase`:
 *   - "obligatorio": debe ejecutarse y aprobar SIEMPRE; skipped/cancelled → rojo.
 *   - "seguridad":   igual que obligatorio, pero el motivo se marca como fallo
 *                    de seguridad (escáner de Compose, Trivy, npm audit).
 *   - "solo-main":   solo corre en push a main. En PR su skipped es "no aplica".
 *                    En main: skipped u output `resultado=omitido` → amarillo;
 *                    éxito sin evidencia (sin output) → amarillo (fail-closed);
 *                    solo un éxito con `resultado` en `evidencia` es verde.
 */
export const JOBS_CI = [
  { id: "lint-format-types", clase: "obligatorio" },
  { id: "unit", clase: "obligatorio" },
  { id: "contracts", clase: "obligatorio" },
  { id: "regression-battles", clase: "obligatorio" },
  { id: "build-images", clase: "obligatorio" },
  { id: "scan", clase: "seguridad" },
  { id: "e2e-mvp", clase: "obligatorio" },
  { id: "deploy-staging", clase: "solo-main", evidencia: ["desplegado"] },
  { id: "smoke-and-promote", clase: "solo-main", evidencia: ["promocionado"] },
];

/**
 * Evalúa el semáforo.
 * @param {Record<string, {result?: string, outputs?: Record<string,string>}>} needs
 *        Contexto `needs` del job final (toJSON(needs) en el workflow).
 * @param {{mainRun?: boolean}} ctx  mainRun=true en push a main (staging aplica).
 * @param {typeof JOBS_CI} jobs      Catálogo de jobs esperados (inyectable en tests).
 * @returns {{color: string, filas: {id: string, resultado: string, color: string, motivo: string}[]}}
 */
export function evaluarSemaforo(needs, ctx = {}, jobs = JOBS_CI) {
  const mainRun = ctx.mainRun === true;
  const filas = [];

  for (const job of jobs) {
    const entrada = needs?.[job.id];
    const resultado = entrada?.result;

    // Fail-closed: un job esperado que no aparece en `needs` es rojo.
    if (!entrada || typeof resultado !== "string") {
      filas.push(fila(job.id, "ausente", ROJO, "el job esperado no aparece en `needs` (fail-closed)"));
      continue;
    }

    if (job.clase === "solo-main" && !mainRun) {
      if (resultado === "skipped") {
        filas.push(fila(job.id, resultado, "no-aplica", "solo corre en push a main"));
      } else {
        // Si corrió fuera de main se juzga con las reglas de main (no debería pasar).
        filas.push(juzgarSoloMain(job, resultado, entrada.outputs));
      }
      continue;
    }

    if (job.clase === "solo-main") {
      filas.push(juzgarSoloMain(job, resultado, entrada.outputs));
      continue;
    }

    // obligatorio / seguridad
    if (resultado === "success") {
      filas.push(fila(job.id, resultado, VERDE, "ejecutado y aprobado"));
    } else if (resultado === "failure" || resultado === "cancelled") {
      const motivo =
        job.clase === "seguridad"
          ? "FALLO DE SEGURIDAD (escáner de Compose / Trivy crítico / npm audit): bloquea la promoción"
          : `fallo funcional (${resultado})`;
      filas.push(fila(job.id, resultado, ROJO, motivo));
    } else if (resultado === "skipped") {
      filas.push(
        fila(job.id, resultado, ROJO, "job obligatorio sin ejecutar: no puede contar como aprobado (fail-closed)"),
      );
    } else {
      filas.push(fila(job.id, resultado, ROJO, `resultado desconocido "${resultado}" (fail-closed)`));
    }
  }

  let color = VERDE;
  for (const f of filas) {
    if (f.color === ROJO) color = ROJO;
    else if (f.color === AMARILLO && color !== ROJO) color = AMARILLO;
  }
  return { color, filas };
}

function juzgarSoloMain(job, resultado, outputs) {
  if (resultado === "failure" || resultado === "cancelled") {
    return fila(job.id, resultado, ROJO, `fallo en el camino de despliegue (${resultado})`);
  }
  if (resultado === "skipped") {
    return fila(job.id, resultado, AMARILLO, "OMITIDO: el job no llegó a ejecutarse en main");
  }
  if (resultado === "success") {
    const evidencia = outputs?.resultado;
    if (job.evidencia.includes(evidencia)) {
      return fila(job.id, resultado, VERDE, `ejecutado de verdad (resultado=${evidencia})`);
    }
    if (evidencia === "omitido") {
      return fila(
        job.id,
        resultado,
        AMARILLO,
        "OMITIDO: entorno externo no disponible (p. ej. STAGING_HOST sin configurar)",
      );
    }
    return fila(
      job.id,
      resultado,
      AMARILLO,
      `OMITIDO: éxito sin evidencia de ejecución (outputs.resultado=${JSON.stringify(evidencia ?? null)}, fail-closed)`,
    );
  }
  return fila(job.id, resultado, ROJO, `resultado desconocido "${resultado}" (fail-closed)`);
}

function fila(id, resultado, color, motivo) {
  return { id, resultado, color, motivo };
}

const EMOJI = { [VERDE]: "🟢", [AMARILLO]: "🟡", [ROJO]: "🔴", "no-aplica": "⚪" };

/** Tabla Markdown para el step summary y la consola. */
export function resumenMarkdown({ color, filas }) {
  const lineas = [
    `## Semáforo CI: ${EMOJI[color]} ${color.toUpperCase()}`,
    "",
    color === VERDE
      ? "Todo lo obligatorio se ejecutó y aprobó; el camino de despliegue tiene evidencia real."
      : color === AMARILLO
        ? "**Las pruebas están bien, pero hay trabajo OMITIDO por falta de entorno externo.** Nada omitido cuenta como aprobado."
        : "**Fallo funcional o de seguridad, o job obligatorio sin ejecutar.** Promoción bloqueada.",
    "",
    "| Job | Resultado del job | Semáforo | Motivo |",
    "|---|---|---|---|",
  ];
  for (const f of filas) {
    lineas.push(`| \`${f.id}\` | ${f.resultado} | ${EMOJI[f.color] ?? "⚪"} ${f.color} | ${f.motivo} |`);
  }
  lineas.push(
    "",
    "_Regla de oro (Ronda 2): todo camino no verificable falla cerrado y se reporta como omitido, nunca como aprobado._",
  );
  return lineas.join("\n");
}

// ── CLI (lo invoca el job `semaforo` de ci.yml) ──────────────────────────────
function main() {
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS_JSON ?? "");
  } catch {
    console.error("::error::ci-gate: NEEDS_JSON ausente o inválido — fail-closed, semáforo ROJO.");
    process.exit(1);
  }

  const mainRun = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === "refs/heads/main";
  const veredicto = evaluarSemaforo(needs, { mainRun });
  const md = resumenMarkdown(veredicto);

  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `color=${veredicto.color}\n`);

  for (const f of veredicto.filas) {
    if (f.color === ROJO) console.log(`::error::Semáforo ROJO · ${f.id}: ${f.motivo}`);
    else if (f.color === AMARILLO) console.log(`::warning::Semáforo AMARILLO · ${f.id}: ${f.motivo}`);
  }

  // Rojo rompe el job; amarillo NO (el aviso se materializa como warnings,
  // summary y check-run neutral — ver cabecera). Verde sale limpio.
  process.exit(veredicto.color === ROJO ? 1 : 0);
}

// Solo actúa como CLI si se ejecuta directamente (no al importarlo en tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
