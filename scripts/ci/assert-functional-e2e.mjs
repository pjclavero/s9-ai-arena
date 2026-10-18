#!/usr/bin/env node
/**
 * PRC DEV-CI (TD-045) · veredicto INDEPENDIENTE del E2E funcional de navegador.
 *
 * `tests/browser/run.sh` ya sale con rc≠0 si una fase falla. Este script es la
 * segunda llave del job `functional-e2e`: lee lo que el E2E DEJÓ ESCRITO y exige
 * que se ejerciera de verdad. Motivo: un rc 0 de Playwright también sale de una
 * fase que no ejecutó nada (`test.skip`, un grep que no casa con `--pass-with-no-tests`,
 * una fase golden saltada con S9_E2E_SKIP_GOLDEN=1). `skipped` NO es verde.
 *
 * Reglas (todas obligatorias; cualquier incumplimiento → exit 1):
 *   1. summary.txt contiene `BROWSER_E2E_RC=0` (rc real del runner).
 *   2. Para cada fase de FASES: report.json existe, `expected ≥ 1` y
 *      `unexpected = flaky = skipped = 0`.
 *   3. Golden: evidence.json con resultado `battle-result/v1`, `agents=container`
 *      (ejecución real con contenedores), ganador `red`, el Artillero disparó (>0)
 *      y el Pacifista no (0) — prueba de que corrió el CÓDIGO del usuario.
 *   4. Sonda TD-028: 4404 con el secreto compartido y 4401 con uno ajeno.
 *
 * Modo `vitest` (job docker-e2e): el informe JSON de vitest debe contener CADA
 * fichero exigido, en `passed`, con ≥1 test y TODOS sus tests en `passed`: un
 * `describe.skipIf` que se quedara sin la variable opt-in deja el fichero en
 * skipped y aquí FALLA.
 *
 * Uso:    node scripts/ci/assert-functional-e2e.mjs browser <dir-out-del-E2E>
 *         node scripts/ci/assert-functional-e2e.mjs vitest <vitest.json> <fichero.test.ts>...
 * Tests:  infrastructure/tests/functional-e2e-gate.test.ts
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FASES = ["golden", "fase1", "fase2", "fase3"];

function leerJson(path) {
  if (!existsSync(path)) return { error: `falta ${path}` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { error: `JSON inválido en ${path}: ${String(e)}` };
  }
}

/** @returns {{ok: boolean, filas: {comprobacion: string, ok: boolean, detalle: string}[]}} */
export function evaluarE2E(outDir) {
  const filas = [];
  const add = (comprobacion, ok, detalle) => filas.push({ comprobacion, ok, detalle });

  const summaryPath = join(outDir, "summary.txt");
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  const rcLine = summary.match(/BROWSER_E2E_RC=(\d+)[^\n]*/);
  add(
    "rc real de run.sh",
    rcLine?.[1] === "0",
    rcLine ? rcLine[0] : "summary.txt sin BROWSER_E2E_RC (el E2E no llegó al final)",
  );

  for (const fase of FASES) {
    const r = leerJson(join(outDir, fase, "report.json"));
    if (r.error) {
      add(`fase ${fase}`, false, r.error);
      continue;
    }
    const s = r.value?.stats ?? {};
    const expected = Number(s.expected ?? 0);
    const unexpected = Number(s.unexpected ?? 0);
    const flaky = Number(s.flaky ?? 0);
    const skipped = Number(s.skipped ?? 0);
    const ok = expected >= 1 && unexpected === 0 && flaky === 0 && skipped === 0;
    let motivo = `expected=${expected} unexpected=${unexpected} flaky=${flaky} skipped=${skipped}`;
    if (unexpected > 0) motivo += " · tests en ROJO";
    else if (expected < 1) motivo += " · no pasó ningún test: no cuenta como verde";
    if (skipped > 0) motivo += " · skipped NO es verde";
    add(`fase ${fase}`, ok, motivo);
  }

  const ev = leerJson(join(outDir, "golden", "evidence.json"));
  if (ev.error) {
    add("evidencia golden", false, ev.error);
  } else {
    const e = ev.value ?? {};
    const res = e.result ?? {};
    const checks = [
      ["battleId", typeof e.battleId === "string" && e.battleId.length > 0, String(e.battleId)],
      ["schema battle-result/v1", res.schema === "battle-result/v1", String(res.schema)],
      ["ejecución real (agents=container)", res.agents === "container", String(res.agents)],
      ["ganador red", res.winner === "red", String(res.winner)],
      ["Artillero disparó", Number(e.stats?.red) > 0, String(e.stats?.red)],
      ["Pacifista 0 disparos", e.stats?.blue === 0, String(e.stats?.blue)],
    ];
    for (const [n, ok, v] of checks) add(`golden · ${n}`, ok, v);
  }

  const probe = leerJson(join(outDir, "ticket-probe.json"));
  if (probe.error) add("sonda TD-028", false, probe.error);
  else {
    const p = probe.value ?? {};
    add(
      "sonda TD-028",
      p.sharedSecret?.code === 4404 && p.foreignSecret?.code === 4401,
      `compartido=${p.sharedSecret?.code} ajeno=${p.foreignSecret?.code}`,
    );
  }

  return { ok: filas.every((f) => f.ok), filas };
}

/** Modo vitest: cada fichero exigido ejecutado, en passed, sin un solo test saltado. */
export function evaluarVitest(reportPath, ficheros) {
  const filas = [];
  const add = (comprobacion, ok, detalle) => filas.push({ comprobacion, ok, detalle });
  const r = leerJson(reportPath);
  if (r.error) {
    add("informe de vitest", false, r.error);
    return { ok: false, filas };
  }
  const rep = r.value ?? {};
  add(
    "totales de vitest",
    rep.success === true &&
      Number(rep.numFailedTests) === 0 &&
      Number(rep.numPendingTests) === 0 &&
      Number(rep.numTodoTests ?? 0) === 0 &&
      Number(rep.numPassedTests) > 0,
    `success=${rep.success} passed=${rep.numPassedTests} failed=${rep.numFailedTests} pending=${rep.numPendingTests} todo=${rep.numTodoTests ?? 0}`,
  );
  if (ficheros.length === 0) add("ficheros exigidos", false, "no se exigió ningún fichero");
  const resultados = Array.isArray(rep.testResults) ? rep.testResults : [];
  for (const f of ficheros) {
    const tr = resultados.find((t) => typeof t.name === "string" && t.name.endsWith(f));
    if (!tr) {
      add(f, false, "el fichero no aparece en el informe: no se ejecutó");
      continue;
    }
    const asserts = Array.isArray(tr.assertionResults) ? tr.assertionResults : [];
    const noPassed = asserts.filter((a) => a.status !== "passed");
    const ok = tr.status === "passed" && asserts.length > 0 && noPassed.length === 0;
    const estados = {};
    for (const a of asserts) estados[a.status] = (estados[a.status] ?? 0) + 1;
    add(f, ok, `fichero=${tr.status} tests=${asserts.length} ${JSON.stringify(estados)}`);
  }
  return { ok: filas.every((x) => x.ok), filas };
}

export function resumenMarkdown({ ok, filas }) {
  const l = [
    `## functional-e2e: ${ok ? "PASS" : "FAIL"}`,
    "",
    "| Comprobación | Resultado | Detalle |",
    "|---|---|---|",
    ...filas.map(
      (f) => `| ${f.comprobacion} | ${f.ok ? "PASS" : "FAIL"} | ${String(f.detalle).replace(/\|/g, "\\|")} |`,
    ),
  ];
  return l.join("\n");
}

function main() {
  const [modo, objetivo, ...ficheros] = process.argv.slice(2);
  if (!objetivo || (modo !== "browser" && modo !== "vitest")) {
    console.error("uso: assert-functional-e2e.mjs browser <dir-out> | vitest <vitest.json> <fichero>...");
    process.exit(2);
  }
  const v = modo === "browser" ? evaluarE2E(objetivo) : evaluarVitest(objetivo, ficheros);
  const md = resumenMarkdown(v);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  for (const f of v.filas) if (!f.ok) console.log(`::error::functional-e2e · ${f.comprobacion}: ${f.detalle}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
