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
];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? process.argv[onlyArg + 1].split(",") : [];

function run() {
  const out = join(mkdtempSync(join(tmpdir(), "v1c-mut-")), "r.json");
  const r = spawnSync("npx", ["vitest", "run", TEST, "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`], {
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
const base = run();
console.log(`BASE rc=${base.rc} failed=${base.failed.length}`);
if (base.rc !== 0) process.exit(2);

let bad = 0;
for (const m of MUTANTS.filter((x) => only.length === 0 || only.includes(x.id))) {
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
    res = run();
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
