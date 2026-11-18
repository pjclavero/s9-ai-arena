// B (release 0.5.0) · Mutantes del ciclo de vida del torneo con batallas `failed`.
// Uso (SOLO en VM111, nunca en ia02): node scripts/mutants-tournament-lifecycle.mjs <raiz> [salida.json]
// Cada mutante sustituye UNA cadena de producción, ejecuta tournament-lifecycle-failed.test.ts con el
// reporter JSON y exige que MUERA POR el test etiquetado [Tag] (atribución por nombre). Línea base verde
// antes y árbol limpio después. Commitea antes de lanzarlo: el harness restaura los ficheros.
// El mutante etiquetado "EQUIVALENTE" (R10) NO debe morir: son equivalentes documentados.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R = process.argv[2] ?? process.cwd();
const OUT = process.argv[3] ?? "mutantes-lifecycle.json";
const TEST = "apps/tournament-worker/src/tournament-lifecycle-failed.test.ts";
const RES = join(R, "apps/tournament-worker/src/results.ts");
const API = join(R, "apps/api/src/routes/tournaments.ts");
const BF = join(R, "apps/tournament-worker/src/battle-failure.ts");
const SWISS_GUARD = '.whereNotIn("state", [...CLOSED_MATCH_STATES])\n    .first();\n  if (unfinished) return false;';

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
  // ---- mutantes del revisor independiente (R1-R12); R10 es equivalente documentado
  R1: [
    "sin cerrojo por torneo (lockTournament no-op)",
    RES,
    'await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tournament-settle:${tournamentId}`]);',
    "void tournamentId; void trx;",
    "[R1]",
  ],
  R2: [
    "finishTournamentIfDone resucita un torneo cancelado (quita la guarda state=running)",
    RES,
    '.where({ id: tournamentId, state: "running" })',
    ".where({ id: tournamentId })",
    "[R2]",
  ],
  R3: [
    "una final failed corona por tabla (quita return null)",
    RES,
    'if (finalMatch?.state === "failed") return null;',
    "",
    "[R3]",
  ],
  R4: [
    "eliminatoria: un match failed no hace avanzar a nadie",
    RES,
    'const advances = p.bracket !== "main" ? p.home : null;',
    "const advances = null;",
    "[R4]",
  ],
  R5: ["teams: cuenta inscripciones en vez de equipos", API, "count = teams.size;", "count = entries.length;", "[R5]"],
  R6: [
    "onBattleJobExhausted no avanza el torneo (no llama a settleFailedBattle)",
    BF,
    'await settleFailedBattle(ctx.db as Knex, String(job.payload.battleId ?? ""));',
    "",
    "[R6]",
  ],
  R7: [
    "suizo: un match failed bloquea la ronda siguiente",
    RES,
    SWISS_GUARD,
    SWISS_GUARD.replace('.whereNotIn("state", [...CLOSED_MATCH_STATES])', '.whereNot({ state: "finished" })'),
    "[R7]",
  ],
  R8: [
    "leagueTable puntúa un match failed como empate",
    RES,
    'if (m.state !== "finished") continue;\n    const p = pairingOf(m);\n    const winner',
    'if (m.state === "scheduled") continue;\n    const p = pairingOf(m);\n    const winner',
    "[R8]",
  ],
  R9: [
    "campeón de liga con todo failed (quita la guarda de 0 partidos)",
    RES,
    "if (!table[0] || table[0].wins + table[0].draws + table[0].losses === 0) return null;",
    "if (!table[0]) return null;",
    "[R9]",
  ],
  R10: [
    "EQUIVALENTE · el rescate también selecciona torneos cancelados/closed (la guarda interna `t.state !== running` los descarta igual)",
    RES,
    '    .where({ state: "running" })\n    .whereNotExists(',
    '    .whereIn("state", ["running", "cancelled", "closed"])\n    .whereNotExists(',
    "EQUIVALENTE",
  ],
  R11: [
    "resolveDependents ignora matches failed (no avanza dependientes)",
    RES,
    "if (!finished || !isClosedMatch(finished.state)) return;",
    'if (!finished || finished.state !== "finished") return;',
    "[R11]",
  ],
  R12: [
    "settleMatch cierra la serie sin esperar a todos los juegos",
    RES,
    "if (games.some((g) => !CLOSED_BATTLE_STATES.includes(g.status))) return false; // la serie sigue en juego",
    "",
    "[R12]",
  ],
  // ---- ronda 2
  S1: [
    "leagueTableDetailed cuenta los juegos failed (vuelve el empate de la serie failed+technical_limit)",
    RES,
    '(b: Record<string, unknown>) => b.status !== "failed",',
    "() => true,",
    "[S1]",
  ],
  S2: [
    "el rescate no encola update_standings de las batallas finished del match que cierra",
    RES,
    "for (const b of done) {",
    "for (const b of done.slice(0, 0)) {",
    "[S2]",
  ],
  S3: [
    "onBattleJobExhausted no registra el evento esperado al tragar el error",
    BF,
    'msg: "settle_failed_battle_error"',
    'msg: "otro"',
    "[S3]",
  ],
  S4: [
    "la API expone de nuevo winnerBotId en un match failed",
    API,
    'winnerBotId: winnerHidden || m.state === "failed" ? null',
    "winnerBotId: winnerHidden ? null",
    "[S4]",
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
    let estado = rc !== 0 && muerePorSuTest ? "MUERE" : rc === 0 ? "SOBREVIVE" : "MUERE_POR_OTRO_TEST";
    if (tag === "EQUIVALENTE") estado = rc === 0 ? "EQUIVALENTE_OK" : "EQUIVALENTE_MUERE(revisar)";
    if (estado !== "MUERE" && estado !== "EQUIVALENTE_OK") vivos++;
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
