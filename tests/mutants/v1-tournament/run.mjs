#!/usr/bin/env node
/**
 * V1-C · Mutantes de calibración del E2E de torneos
 * (apps/tournament-worker/src/v1-tournament-cycle.e2e.test.ts).
 *
 * Cada mutante rompe UNA línea real del producto; el test indicado en `dies` (etiqueta V1C_*)
 * DEBE aparecer entre los que fallan. Línea base en verde y árbol limpio antes y después.
 * COMMITEA antes de lanzarlo: el script revierte con `git checkout -- <fichero>`.
 *
 * Uso (en el laboratorio, bajo flock):  node tests/mutants/v1-tournament/run.mjs --only M1,M2
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST = "apps/tournament-worker/src/v1-tournament-cycle.e2e.test.ts";
const MUTANTS = [
  {
    id: "M1",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_TDM_standings",
    why: "leagueTable: la victoria deja de valer 3 puntos",
    find: "    if (winner === p.home) {\n      home.points += 3;",
    repl: "    if (winner === p.home) {\n      home.points += 2;",
  },
  {
    id: "M2",
    file: "apps/tournament-worker/src/standings.ts",
    dies: "V1C_RR_standings",
    why: "clasificación de temporada: un empate deja de contar como empate",
    find: "      home.draws++;\n      away.draws++;",
    repl: "      home.draws++;",
  },
  {
    id: "M3",
    file: "apps/tournament-worker/src/scheduler.ts",
    dies: "V1C_TDM_roster",
    why: "asignación de equipos: el rival entra en el mismo bando que el local",
    find: "bot_id: e.botId, version: e.version, team: awayTeam }",
    repl: "bot_id: e.botId, version: e.version, team: homeTeam }",
  },
  {
    id: "M4",
    file: "apps/tournament-worker/src/scheduler.ts",
    dies: "V1C_TDM_roster",
    why: "asignación de equipos: sólo el primer bot de cada plantilla llega a la batalla",
    find: "return team.roster.map((botId)",
    repl: "return team.roster.slice(0, 1).map((botId)",
  },
  {
    id: "M5",
    file: "apps/tournament-worker/src/standings.ts",
    dies: "V1C_RR_elo",
    why: "el Elo de la batalla no se aplica",
    find: "if (battleId) await applyBattleRating(db, battleId);",
    repl: "if (false) await applyBattleRating(db, battleId);",
  },
  {
    id: "M6",
    file: "apps/tournament-worker/src/ratings.ts",
    dies: "V1C_RR_elo",
    why: "Elo: escala de la curva logística 400 a 300",
    find: "return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));",
    repl: "return 1 / (1 + 10 ** ((ratingB - ratingA) / 300));",
  },
  {
    id: "M7",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_SW_cycle",
    why: "suizo: no se programa la ronda siguiente",
    find: 'if (mctx.tournament.format === "swiss") await maybeScheduleNextSwissRound(mctx);',
    repl: "",
  },
  {
    id: "M8",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_SE_cycle",
    why: "eliminatoria: avanza el perdedor en lugar del ganador",
    find: 'p[side] = src.take === "winner" ? winner : loser;',
    repl: 'p[side] = src.take === "winner" ? loser : winner;',
  },
  {
    id: "M9",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_RR_standings",
    why: "campeon = ultimo de la tabla",
    find: "  return table[0].id;",
    repl: "  return table[table.length - 1].id;",
  },
  {
    id: "M10",
    file: "apps/tournament-worker/src/battle-runner.ts",
    dies: "V1C_RR_cycle",
    why: "el replay no se guarda",
    find: "if (execution.replayJsonl && replaysDir) {",
    repl: "if (false) {",
  },
  {
    id: "M11",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_TDM_standings",
    why: "orden de la tabla invertido por puntos",
    find: "      b.points - a.points ||",
    repl: "      a.points - b.points ||",
  },
  {
    id: "M12",
    file: "apps/api/src/routes/tournaments.ts",
    dies: "V1C_RR_cycle",
    why: "el cierre de inscripciones no congela las versiones",
    find: 'if (v.state !== "published") continue;',
    repl: "continue;",
  },
  {
    id: "X1",
    file: "apps/api/src/routes/tournaments.ts",
    dies: "V1C_TDM_standings",
    why: "team-standings: el rank se desplaza una posición",
    find: "        rank: i + 1,",
    repl: "        rank: i + 2,",
  },
  {
    id: "X1b",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_TDM_standings",
    why: "tabla: desempate por semilla invertido",
    find: "      a.seed - b.seed ||",
    repl: "      b.seed - a.seed ||",
  },
  {
    id: "X1c",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_TDM_standings",
    why: "tabla: se anula el criterio de puntos",
    find: "      b.points - a.points ||",
    repl: "      0 ||",
  },
  {
    id: "X2",
    file: "apps/tournament-worker/src/formats.ts",
    dies: "V1C_SW_pairing",
    why: "suizo: se empareja por semilla en lugar de por puntos",
    find: "b.points - a.points || a.seed - b.seed);\n  const pairKey",
    repl: "a.seed - b.seed);\n  const pairKey",
  },
  {
    id: "X3b",
    file: "apps/tournament-worker/src/results.ts",
    dies: "V1C_SE_cycle",
    why: "eliminatoria: al bracket avanza siempre el local, no el ganador",
    find: "const winner = isTeams ? finished.winner_team_id : finished.winner_bot_id;",
    repl: "const winner = isTeams ? finished.winner_team_id : fp.home;",
  },
  // ---- D-OP-24 · semántica del bye (tests propios: BYE_*; el contrato E2E es V1C_TDM_bye_contract)
  {
    id: "B1",
    test: "apps/tournament-worker/src/bye-semantics.test.ts",
    file: "apps/tournament-worker/src/results.ts",
    dies: "BYE_table",
    why: "tabla: el bye cuenta como victoria jugada",
    find: "if (r) r.byes++;",
    repl: "if (r) (r.byes++, r.wins++);",
  },
  {
    id: "B2",
    test: "apps/tournament-worker/src/bye-semantics.test.ts",
    file: "apps/tournament-worker/src/results.ts",
    dies: "BYE_table",
    why: "tabla: el bye vuelve a dar 3 puntos",
    find: "if (r) r.byes++;",
    repl: "if (r) (r.byes++, (r.points += 3));",
  },
  {
    id: "B3",
    test: "apps/tournament-worker/src/bye-semantics.test.ts",
    file: "apps/tournament-worker/src/results.ts",
    dies: "BYE_swiss_zero",
    why: "suizo: el bye vuelve a dar 3 puntos",
    find: "byeCount.set(p.home, (byeCount.get(p.home) ?? 0) + 1);",
    repl: "byeCount.set(p.home, (byeCount.get(p.home) ?? 0) + 1);\n      points.set(p.home, (points.get(p.home) ?? 0) + 3);",
  },
  {
    id: "B4",
    test: "apps/tournament-worker/src/formats.test.ts",
    file: "apps/tournament-worker/src/formats.ts",
    dies: "BYE_swiss_no_repeat",
    why: "suizo: DESCANSO REPETIDO (se ignora cuántos byes lleva cada uno)",
    find: "count(s) === fewest",
    repl: "true",
  },
  {
    id: "B5",
    test: "apps/tournament-worker/src/formats.test.ts",
    file: "apps/tournament-worker/src/formats.ts",
    dies: "BYE_swiss_feasible",
    why: "suizo: el bye ignora si fuerza un rival repetido",
    find: "byeId = (feasible ?? candidates[0]).id;",
    repl: "byeId = candidates[0].id;",
  },
  {
    id: "B6",
    test: "apps/tournament-worker/src/bye-semantics.test.ts",
    file: "apps/tournament-worker/src/ratings.ts",
    dies: "BYE_no_elo",
    why: "Elo: una batalla colgada de un bye vuelve a puntuar",
    find: "(pairing as { bye?: unknown } | null | undefined)?.bye === true) return false;",
    repl: "(pairing as { bye?: unknown } | null | undefined)?.bye === 12345) return false;",
  },
  {
    id: "B7",
    test: "apps/tournament-worker/src/bye-semantics.test.ts",
    file: "apps/tournament-worker/src/results.ts",
    dies: "BYE_technical",
    why: "tabla: los resultados técnicos dejan de contarse",
    find: "      if (h && a) {\n        h.technical++;",
    repl: "      if (h && a) {\n        h.technical += 0;",
  },
  {
    id: "B8",
    file: "apps/api/src/routes/tournaments.ts",
    dies: "V1C_TDM_bye_contract",
    why: "API: la columna byes deja de exponerse",
    find: "byes: row.byes,",
    repl: "byes: 0,",
  },
];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? process.argv[onlyArg + 1].split(",") : [];

function run(test = TEST) {
  const out = join(mkdtempSync(join(tmpdir(), "v1c-mut-")), "r.json");
  const r = spawnSync("npx", ["vitest", "run", test, "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`], {
    encoding: "utf8",
  });
  let failed = [];
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    failed = j.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.title));
  } catch {
    /* sin json: error de compilación */
  }
  return { rc: r.status, failed };
}

if (sh("git", ["status", "--porcelain", "--untracked-files=no"]) !== "") {
  console.error("ARBOL SUCIO: commitea antes");
  process.exit(2);
}
const baseOf = new Set();
const baseFor = (t) => {
  if (baseOf.has(t)) return;
  const base = run(t);
  console.log(`BASE ${t} rc=${base.rc} failed=${base.failed.length}`);
  if (base.rc !== 0) process.exit(2);
  baseOf.add(t);
};

let bad = 0;
for (const m of MUTANTS.filter((x) => only.length === 0 || only.includes(x.id))) {
  baseFor(m.test ?? TEST);
  const src = readFileSync(m.file, "utf8");
  const n = src.split(m.find).length - 1;
  if (n !== 1) {
    console.log(`${m.id} ANCLA NO UNICA (${n}) ${m.file}`);
    bad++;
    continue;
  }
  writeFileSync(m.file, src.replace(m.find, m.repl));
  let res;
  try {
    res = run(m.test ?? TEST);
  } finally {
    sh("git", ["checkout", "--", m.file]);
  }
  const killed = res.failed.some((t) => t.includes(m.dies));
  console.log(
    `${m.id} ${killed ? "MUERTO" : "SUPERVIVIENTE"} por ${m.dies} rc=${res.rc} fallan=[${res.failed.map((t) => t.split(" ")[0]).join(",")}] :: ${m.why}`,
  );
  if (!killed) bad++;
}
const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"]);
console.log(dirty === "" ? "ARBOL LIMPIO" : `ARBOL SUCIO:\n${dirty}`);
process.exit(bad || dirty ? 1 : 0);
