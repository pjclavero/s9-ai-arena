#!/usr/bin/env node
/**
 * OLA 2 · Equipo ME · runner de mutantes de calibración (baseline + contratos).
 *
 * SÓLO EN VM112 (laboratorio), en un worktree desechable con el árbol COMMITEADO y
 * limpio, y bajo `flock -o /srv/s9-test/heavy.lock`. Nunca en ia02 ni en producción.
 *
 *   node scripts/hardening/me-mutants.mjs [--manifest scripts/hardening/me-mutants.json]
 *        [--out /tmp/me-mutants] [--only ID,ID] [--dry-run]
 *
 * Tres clases de mutante (campo `kind`):
 *   - kill:     muta producción; los tests de BASELINE indicados deben ponerse en ROJO
 *               y el fallo debe estar en un test cuyo nombre case con `expect`.
 *   - fix:      muta producción para «implementar» mínimamente un contrato; con
 *               S9_CONTRACT_ENFORCE=<team> el test de contrato indicado debe pasar a
 *               VERDE (prueba que el contrato no está rojo por una razón equivocada).
 *   - identity: mutación sin efecto semántico; la suite debe seguir VERDE (control del
 *               runner contra falsos rojos).
 *
 * Veredictos: ROJA_OK, VERDE_OK (fix), SOBREVIVE, ROJO_ERRONEO (falla otra cosa o no
 * compila), ROTO (ancla ausente o repetida), TIMEOUT. El rc es 0 sólo si todos los
 * mutantes dan su veredicto esperado. Juzga por el reporter JSON de vitest, no por texto.
 * Tras cada mutante restaura el fichero y comprueba su sha256; si no coincide, aborta.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { hostname } from "node:os";

if (hostname() === "ia-server") {
  console.error("STOP: los mutantes no se ejecutan en ia02 (DO_NOT_RUN_HEAVY_TESTS_ON_IA02)");
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const DRY = args.includes("--dry-run");
const manifestPath = resolve(opt("--manifest", "scripts/hardening/me-mutants.json"));
const outDir = resolve(opt("--out", "/tmp/me-mutants"));
const only = opt("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sha = (s) => createHash("sha256").update(s).digest("hex");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const mutants = manifest.mutants.filter((m) => only.length === 0 || only.includes(m.id));

function git(...a) {
  return spawnSync("git", a, { encoding: "utf8" });
}
const dirty = git("status", "--porcelain").stdout.trim();
if (!DRY && dirty) {
  console.error("ÁRBOL SUCIO: commitea antes de calibrar (un restore mal hecho borraría trabajo)\n" + dirty);
  process.exit(3);
}
mkdirSync(outDir, { recursive: true });

function countOccurrences(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Ejecuta vitest con reporter JSON y devuelve los resultados por test. */
function runVitest(m, tag) {
  const out = join(outDir, `${m.id}.${tag}.json`);
  if (existsSync(out)) rmSync(out);
  const vargs = ["vitest", "run", ...m.tests, "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`];
  if (m.testNamePattern) vargs.push("-t", m.testNamePattern);
  const env = { ...process.env, ...(m.env ?? {}) };
  const r = spawnSync("npx", vargs, { encoding: "utf8", env, timeout: (m.timeoutSec ?? 240) * 1000 });
  if (r.error && r.error.code === "ETIMEDOUT") return { timeout: true };
  if (!existsSync(out)) return { rc: r.status, noReport: true, stderr: (r.stderr ?? "").slice(-2000) };
  const rep = JSON.parse(readFileSync(out, "utf8"));
  const tests = [];
  for (const f of rep.testResults ?? []) {
    for (const a of f.assertionResults ?? []) tests.push({ file: f.name, name: a.fullName, status: a.status });
    // Fichero que no carga (error de import/compilación): cuenta como error, no como test.
    if ((f.assertionResults ?? []).length === 0 && f.status === "failed") tests.push({ file: f.name, name: "<suite-error>", status: "failed" });
  }
  return { rc: r.status, tests };
}

function judge(m, res) {
  if (res.timeout) return "TIMEOUT";
  if (res.noReport) return "ROJO_ERRONEO";
  const failed = res.tests.filter((t) => t.status === "failed");
  const passed = res.tests.filter((t) => t.status === "passed");
  const re = m.expect ? new RegExp(m.expect) : null;
  if (m.kind === "identity") return failed.length === 0 && passed.length > 0 ? "SOBREVIVE" : "ROJO_ERRONEO";
  if (m.kind === "kill") {
    if (failed.length === 0) return "SOBREVIVE";
    if (failed.some((t) => t.name === "<suite-error>")) return "ROJO_ERRONEO";
    return re && !failed.some((t) => re.test(t.name)) ? "ROJO_ERRONEO" : "ROJA_OK";
  }
  if (m.kind === "fix") {
    const target = res.tests.filter((t) => (re ? re.test(t.name) : true));
    if (target.length === 0) return "ROJO_ERRONEO";
    return target.every((t) => t.status === "passed") ? "VERDE_OK" : "SOBREVIVE";
  }
  return "ROJO_ERRONEO";
}

const EXPECTED = { kill: "ROJA_OK", fix: "VERDE_OK", identity: "SOBREVIVE" };
const summary = [];
let allOk = true;

for (const m of mutants) {
  const originals = new Map();
  let broken = null;
  for (const e of m.edits) {
    const src = originals.get(e.file) ?? readFileSync(e.file, "utf8");
    originals.set(e.file, src);
    const n = countOccurrences(src, e.from);
    if (n !== 1) broken = `ancla ${n === 0 ? "ausente" : `repetida ×${n}`} en ${e.file}`;
  }
  if (broken || DRY) {
    const verdict = broken ? "ROTO" : "ANCLA_OK";
    summary.push({ id: m.id, kind: m.kind, verdict, detail: broken ?? "" });
    if (broken) allOk = false;
    console.log(`${m.id.padEnd(22)} ${verdict} ${broken ?? ""}`);
    continue;
  }
  const hashes = new Map([...originals].map(([f, s]) => [f, sha(s)]));
  const t0 = Date.now();
  let res;
  try {
    const current = new Map(originals);
    for (const e of m.edits) current.set(e.file, current.get(e.file).replace(e.from, e.to));
    for (const [f, s] of current) writeFileSync(f, s);
    res = runVitest(m, "mut");
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
    for (const [f, h] of hashes) {
      if (sha(readFileSync(f, "utf8")) !== h) {
        console.error(`RESTAURACIÓN FALLIDA en ${f}: abortando la batería`);
        process.exit(5);
      }
    }
  }
  const verdict = judge(m, res);
  const ok = verdict === EXPECTED[m.kind];
  if (!ok) allOk = false;
  const failedNames = (res.tests ?? []).filter((t) => t.status === "failed").map((t) => t.name);
  const passedNames = (res.tests ?? []).filter((t) => t.status === "passed").map((t) => t.name);
  summary.push({
    id: m.id,
    kind: m.kind,
    team: m.team,
    contract: m.contract,
    verdict,
    expected: EXPECTED[m.kind],
    ok,
    vitestRc: res.rc ?? null,
    failed: failedNames,
    passedCount: passedNames.length,
    ...(m.kind === "fix" ? { passed: passedNames } : {}),
    seconds: Math.round((Date.now() - t0) / 1000),
  });
  console.log(`${m.id.padEnd(22)} ${verdict.padEnd(13)} ${ok ? "OK" : "<<< NO ESPERADO"} (${failedNames.length} rojos, rc=${res.rc ?? "-"})`);
}

const head = git("rev-parse", "HEAD").stdout.trim();
writeFileSync(
  join(outDir, "resumen.json"),
  JSON.stringify({ head, node: process.version, manifest: manifestPath, allOk, mutants: summary }, null, 2) + "\n",
);
if (!DRY && git("status", "--porcelain").stdout.trim()) {
  console.error("El árbol quedó sucio tras la batería");
  process.exit(6);
}
console.log(`RESUMEN allOk=${allOk} head=${head} → ${join(outDir, "resumen.json")}`);
process.exit(allOk ? 0 : 1);
