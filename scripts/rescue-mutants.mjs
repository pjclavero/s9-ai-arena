#!/usr/bin/env node
/**
 * Mutantes de los tests rescatados de los PR de revisión (B3, 2026-11).
 *
 * Uso (UNA ejecución de vitest por invocación, para que el orquestador compruebe la
 * presión del hipervisor antes de cada una):
 *   node scripts/rescue-mutants.mjs <id> base          línea base del test candidato (debe pasar)
 *   node scripts/rescue-mutants.mjs <id> mut           con el mutante aplicado (debe morir por `killedBy`)
 *   node scripts/rescue-mutants.mjs <id> ctl <n>       el control n (test ya existente en main) con el mutante
 *   node scripts/rescue-mutants.mjs <id> check         sólo comprueba que `from` aparece UNA vez
 *   node scripts/rescue-mutants.mjs list               ids
 * El fichero mutado se restaura SIEMPRE: en `finally` y también ante SIGINT/SIGTERM/SIGHUP (un SIGKILL
 * no es capturable: si ocurre, `git checkout -- <file>` lo deja limpio).
 * `killedBy` es una lista de nombres COMPLETOS de test (fullName de vitest); se compara por igualdad
 * exacta y el mutante sólo cuenta como muerto si TODOS esos tests fallan.
 * Escribe una línea JSON con el resultado en stdout; el código de salida es el rc real de vitest
 * (en `mut` y `ctl` un rc != 0 es lo esperado: el orquestador interpreta el JSON).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let activeChild = null;
/** Ejecuta un comando y resuelve con su rc (nunca rechaza). El hijo se mata por PID al vencer el plazo. */
function run(cmd, args, { cwd, timeout, env }) {
  return new Promise((resolveRc) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    activeChild = child;
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      resolveRc(code ?? 1);
    });
    child.on("error", () => resolveRc(1));
  });
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// V1-B · MUTANTS_SPEC permite apuntar a otro fichero de mutantes con el mismo formato (relativo a la raíz).
const spec = JSON.parse(
  readFileSync(join(ROOT, process.env.MUTANTS_SPEC ?? join("scripts", "rescue-mutants.json")), "utf8"),
);
const [, , id, phase = "base", arg] = process.argv;

if (id === "list") {
  for (const m of spec.mutants) console.log(m.id);
  process.exit(0);
}
const m = spec.mutants.find((x) => x.id === id);
if (!m) {
  console.error(`mutante desconocido: ${id}`);
  process.exit(2);
}

const target = join(ROOT, m.file);
const original = readFileSync(target, "utf8");
const count = original.split(m.from).length - 1;
if (phase === "check") {
  console.log(JSON.stringify({ id, phase, occurrences: count }));
  process.exit(count === 1 ? 0 : 3);
}
if (count !== 1) {
  console.error(`${id}: 'from' aparece ${count} veces en ${m.file} (debe ser 1)`);
  process.exit(3);
}

const testFile = phase === "ctl" ? m.controls[Number(arg)] : m.test;
if (!testFile) {
  console.error(`${id}: sin test para la fase ${phase} ${arg ?? ""}`);
  process.exit(2);
}

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeFileSync(target, original);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    activeChild?.kill("SIGKILL"); // por PID, nunca pkill -f
    restore();
    process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig]);
  });
}

const dir = mkdtempSync(join(tmpdir(), "rescue-mut-"));
const out = join(dir, "r.json");
let rc = 1;
try {
  if (phase !== "base")
    writeFileSync(
      target,
      original.replace(m.from, () => m.to),
    );
  // spawnSync bloquea el bucle de eventos: los manejadores de señal sólo corren si el hijo termina,
  // así que se usa un hijo asíncrono (spawn) y se espera su cierre.
  const r = await run("npx", ["vitest", "run", testFile, "--maxWorkers=2", "--reporter=json", `--outputFile=${out}`], {
    cwd: ROOT,
    timeout: 900_000,
    env: { ...process.env, ARENA_DEV_INSECURE_SECRETS: "1" },
  });
  rc = r;
} finally {
  restore();
}
let failed = [];
let passed = 0;
let skipped = 0;
if (existsSync(out)) {
  const j = JSON.parse(readFileSync(out, "utf8"));
  for (const f of j.testResults ?? []) {
    for (const t of f.assertionResults ?? []) {
      if (t.status === "failed") failed.push(t.fullName ?? t.title);
      else if (t.status === "passed") passed++;
      else skipped++;
    }
    if (f.status === "failed" && !(f.assertionResults ?? []).some((t) => t.status === "failed")) {
      failed.push(`(fichero) ${f.message ?? ""}`.slice(0, 200));
    }
  }
}
rmSync(dir, { recursive: true, force: true });
const named = [].concat(m.killedBy ?? []);
if (named.length === 0) {
  console.error(`${id}: falta killedBy (nombre completo de test)`);
  process.exit(2);
}
// Igualdad exacta (no subcadena) y TODOS los nombrados deben haber fallado.
const killedByNamed = named.every((n) => failed.includes(n));
console.log(
  JSON.stringify({
    id,
    phase,
    ctl: arg ?? null,
    file: testFile,
    rc,
    passed,
    skipped,
    failedCount: failed.length,
    killedByNamed,
    failed: failed.slice(0, 6),
  }),
);
process.exit(rc);
