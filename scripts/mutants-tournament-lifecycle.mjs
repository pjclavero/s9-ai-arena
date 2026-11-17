// B (release 0.5.0) · Mutantes del ciclo de vida del torneo con batallas `failed`.
// Uso (SOLO en VM111, nunca en ia02): node scripts/mutants-tournament-lifecycle.mjs <raiz> [salida.json]
// Cada mutante sustituye UNA cadena de producción, ejecuta tournament-lifecycle-failed.test.ts con el
// reporter JSON y exige que MUERA POR el test etiquetado [Mx] (atribución por nombre). Línea base verde
// antes y árbol limpio después. Commitea antes de lanzarlo: el harness restaura los ficheros.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R = process.argv[2] ?? process.cwd();
const OUT = process.argv[3] ?? "mutantes-lifecycle.json";
const TEST = "apps/tournament-worker/src/tournament-lifecycle-failed.test.ts";
const RES = join(R, "apps/tournament-worker/src/results.ts");
const API = join(R, "apps/api/src/routes/tournaments.ts");

// id: [descripción, fichero, original, mutado, etiqueta del test que debe matarlo]
const M = {
  M1: [
    "una batalla failed sigue bloqueando el torneo (failed deja de ser terminal)",
    RES,
    'const CLOSED_BATTLE_STATES = ["finished", "failed"];',
    'const CLOSED_BATTLE_STATES = ["finished"];',
    "[M1]",
  ],
  M2: [
    "un match sin resultado puntúa (se cierra como finished sin ganador = empate)",
    RES,
    '        state: "failed",\n        winner_bot_id: !isTeams ? advances : null,',
    '        state: "finished",\n        winner_bot_id: !isTeams ? advances : null,',
    "[M2]",
  ],
  M3: ["se quita el mínimo de participantes de close-entries", API, "if (count < 2) {", "if (count < 0) {", "[M3]"],
  M4: [
    "el rescate no es idempotente (vuelve a procesar torneos ya terminados)",
    RES,
    '    .where({ state: "running" })\n    .whereNotExists(',
    '    .whereIn("state", ["running", "finished"])\n    .whereNotExists(',
    "[M4]",
  ],
};
// M4 necesita además quitar la guarda de estado dentro de la transacción.
const EXTRA = {
  M4: [RES, 'if (!t || t.state !== "running") return; // otro trabajo ya lo resolvió', "if (!t) return;"],
};

const run = (filtro) => {
  const j = join(R, ".lifecycle-vitest.json");
  const args = ["vitest", "run", "--config", "vitest.db.config.ts", TEST, "--reporter=json", `--outputFile=${j}`];
  if (filtro) args.push("-t", filtro);
  const r = spawnSync("npx", args, { cwd: R, encoding: "utf8" });
  let fallos = [];
  let total = 0;
  try {
    const o = JSON.parse(readFileSync(j, "utf8"));
    for (const f of o.testResults) {
      for (const a of f.assertionResults) {
        total++;
        if (a.status === "failed") fallos.push(a.fullName);
      }
    }
  } catch {
    /* sin informe: rc manda */
  }
  return { rc: r.status, fallos, total };
};

const base = run();
console.log(`BASE rc=${base.rc} tests=${base.total} fallos=${base.fallos.length}`);
if (base.rc !== 0 || base.total === 0) process.exit(2);

const res = {};
let vivos = 0;
for (const [id, [desc, f, de, a, tag]] of Object.entries(M)) {
  const orig = readFileSync(f, "utf8");
  const extra = EXTRA[id];
  const origExtra = extra ? readFileSync(extra[0], "utf8") : null;
  if (!orig.includes(de) || (extra && !origExtra.includes(extra[1]))) {
    res[id] = { desc, estado: "NO_APLICABLE" };
    console.log(`${id} NO_APLICABLE ${desc}`);
    vivos++;
    continue;
  }
  try {
    writeFileSync(f, orig.replace(de, a));
    if (extra) writeFileSync(extra[0], readFileSync(extra[0], "utf8").replace(extra[1], extra[2]));
    const { rc, fallos } = run();
    const muerePorSuTest = fallos.some((n) => n.includes(tag));
    const estado = rc !== 0 && muerePorSuTest ? "MUERE" : rc === 0 ? "SOBREVIVE" : "MUERE_POR_OTRO_TEST";
    if (estado !== "MUERE") vivos++;
    res[id] = { desc, estado, rc, tag, mataron: fallos.slice(0, 4), total: fallos.length };
    console.log(
      `${id} rc=${rc} ${estado} (${fallos.length} fallos) ${desc}\n     <- ${fallos.slice(0, 3).join(" || ")}`,
    );
  } finally {
    writeFileSync(f, orig);
    if (extra) writeFileSync(extra[0], origExtra);
  }
}
const st = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: R,
  encoding: "utf8",
}).stdout.trim();
console.log(`vivos=${vivos} arbol_limpio=${st === ""}`);
writeFileSync(OUT, JSON.stringify({ vivos, arbol_limpio: st === "", res }, null, 1));
process.exit(vivos === 0 && st === "" ? 0 : 1);
