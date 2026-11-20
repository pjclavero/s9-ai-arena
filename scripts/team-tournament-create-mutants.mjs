#!/usr/bin/env node
/**
 * V1-T1 · Mutantes de calibración de apps/web/tests/team-tournament-create.test.tsx.
 * Cada mutante rompe una línea de TournamentsPage.tsx y DEBE caer por el test nombrado
 * (un rojo por otra razón no cuenta). Línea base verde y árbol limpio al final.
 * Commitea antes de lanzarlo: el harness restaura el fichero con el contenido original.
 * Uso (en el laboratorio): node scripts/team-tournament-create-mutants.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "apps/web/src/pages/TournamentsPage.tsx";
const TEST = "apps/web/tests/team-tournament-create.test.tsx";
const orig = readFileSync(FILE, "utf8");

const MUTANTS = [
  {
    id: "M1-no-fija-modo",
    from: 'if (f === "teams") setMode(TEAM_TOURNAMENT_MODE)',
    to: 'if (f === "teams") setMode(mode)',
    killedBy: "V1T1_DEFAULT_MODE",
  },
  {
    id: "M2-todos-los-modos",
    from: 'const modeOptions = format === "teams" ? [TEAM_TOURNAMENT_MODE] : MODES;',
    to: "const modeOptions = MODES;",
    killedBy: "V1T1_ONLY_TDM",
  },
  {
    id: "M3-no-restaura-modo",
    from: 'else if (mode === TEAM_TOURNAMENT_MODE && format === "teams") setMode("deathmatch");',
    to: ";",
    killedBy: "V1T1_LEAVE_TEAMS",
  },
  {
    id: "R2-pisa-modo-no-teams",
    from: 'else if (mode === TEAM_TOURNAMENT_MODE && format === "teams") setMode("deathmatch");',
    to: 'else setMode("deathmatch");',
    killedBy: "V1T1_KEEP_MODE",
  },
  {
    id: "R8-reglas-sin-comprobar-formato",
    from: 'const teamRules = format === "teams" && mode === TEAM_TOURNAMENT_MODE;',
    to: "const teamRules = mode === TEAM_TOURNAMENT_MODE;",
    killedBy: "V1T1_TDM_NO_TEAMS_NO_RULES",
  },
];

function run() {
  const r = spawnSync("npx", ["vitest", "run", TEST, "--maxWorkers=1", "--reporter=verbose"], { encoding: "utf8" });
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
}

let bad = 0;
try {
  const base = run();
  console.log(`BASE rc=${base.rc}`);
  if (base.rc !== 0) {
    console.log(base.out.slice(-2000));
    process.exit(1);
  }
  for (const m of MUTANTS) {
    if (!orig.includes(m.from)) {
      console.log(`${m.id}: patrón no encontrado`);
      bad++;
      continue;
    }
    writeFileSync(FILE, orig.replace(m.from, m.to));
    const r = run();
    const failedNames = r.out.split("\n").filter((l) => /(✗|×|FAIL).*V1T1_/.test(l));
    const killed = r.rc !== 0 && failedNames.some((l) => l.includes(m.killedBy));
    console.log(`${m.id}: rc=${r.rc} ${killed ? "MUERTO por " + m.killedBy : "SUPERVIVIENTE/otra causa"}`);
    if (!killed) bad++;
  }
} finally {
  writeFileSync(FILE, orig);
}
console.log(bad === 0 ? "MUTANTS_OK" : `MUTANTS_FAIL(${bad})`);
process.exit(bad === 0 ? 0 : 1);
