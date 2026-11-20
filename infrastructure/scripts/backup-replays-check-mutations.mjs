#!/usr/bin/env node
/**
 * V1-OPS · harness de MUTACIÓN de backup.sh (AUD2-02 y AUD2-03).
 *
 * Estropea backup.sh DE VERDAD y exige que un test concreto y nombrado de
 * `infrastructure/tests/backup.test.ts` se ponga ROJO. Línea base en verde
 * primero; el original se restaura siempre (también ante SIGINT/SIGTERM) y el
 * árbol queda limpio. Commitea antes de lanzarlo.
 *
 * Uso: node infrastructure/scripts/backup-replays-check-mutations.mjs
 * rc=0 si TODAS mueren con el test esperado; rc=1 si alguna sobrevive.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBJETIVO = join(RAIZ, "infrastructure", "backup", "backup.sh");
const SUITE = "infrastructure/tests/backup.test.ts";
const RESPALDO = OBJETIVO + ".mutation-backup";

const MUTACIONES = {
  M1: {
    desc: "vuelve el corte fijo a 180 días (AUD2-03)",
    muere: "por defecto un replay de 250 días SÍ entra en el backup",
    cambios: [['REPLAY_BACKUP_MAX_AGE_DAYS="${REPLAY_BACKUP_MAX_AGE_DAYS:-0}"', 'REPLAY_BACKUP_MAX_AGE_DAYS="${REPLAY_BACKUP_MAX_AGE_DAYS:-180}"']],
  },
  M2: {
    desc: "restic check vuelve a ser sólo de estructura (AUD2-02)",
    muere: "restic check se invoca con --read-data-subset=n/7",
    cambios: [["  restic check ${args[@]+\"${args[@]}\"}", "  restic check"]],
  },
  M3: {
    desc: "el fallo de restic check se ignora",
    muere: "repositorio corrupto: el check con datos falla",
    cambios: [["  run_restic_check || status=1", "  run_restic_check || true"]],
  },
  M4: {
    desc: "la franja deja de rotar (siempre 1)",
    muere: "la franja rotativa cubre las 7 partes",
    cambios: [["$(( ($(date +%s) / 86400) % RESTIC_CHECK_SUBSET_PARTS + 1 ))", "1"]],
  },
  M5: {
    desc: "la métrica check_ok miente (siempre 1)",
    muere: "repositorio corrupto: el check con datos falla",
    cambios: [['echo "s9_backup_check_ok $CHECK_OK"', 'echo "s9_backup_check_ok 1"']],
  },
  M6: {
    desc: "RESTIC_CHECK_MODE=all deja de leer todo",
    muere: "RESTIC_CHECK_MODE=all usa --read-data completo",
    cambios: [["    all) args=(--read-data); CHECK_FRACTION=1 ;;", "    all) args=(); CHECK_FRACTION=1 ;;"]],
  },
  M7: {
    desc: "REPLAY_RETENTION_DAYS obsoleta deja de avisarse",
    muere: "REPLAY_RETENTION_DAYS (obsoleta) se ignora y se avisa",
    cambios: [['  log warn "REPLAY_RETENTION_DAYS está OBSOLETA', '  : "REPLAY_RETENTION_DAYS está OBSOLETA']],
  },
  M8: {
    desc: "REPLAY_BACKUP_MAX_AGE_DAYS no se valida",
    muere: "REPLAY_BACKUP_MAX_AGE_DAYS inválido: exit 1",
    cambios: [['if ! [[ "$REPLAY_BACKUP_MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then', "if false; then"]],
  },
  M9: {
    desc: "la política opcional N>0 deja de excluir replays viejos",
    muere: "REPLAY_BACKUP_MAX_AGE_DAYS=N excluye replays antiguos",
    cambios: [['if [ "$REPLAY_BACKUP_MAX_AGE_DAYS" != 0 ]; then', "if false; then"]],
  },
  M10: {
    desc: "la política N>0 deja de respetar official/ (lo recorta también)",
    muere: "REPLAY_BACKUP_MAX_AGE_DAYS NO se aplica dentro de official/",
    cambios: [['\\( -path "$REPLAYS_DIR/official/*" -o -mtime "-$REPLAY_BACKUP_MAX_AGE_DAYS" \\)', '\\( -mtime "-$REPLAY_BACKUP_MAX_AGE_DAYS" \\)']],
  },
  M11: {
    desc: "la fracción leída se declara 1 siempre (mentiría sobre «datos leídos»)",
    muere: "RESTIC_CHECK_MODE=none sólo valida estructura",
    cambios: [["    none) CHECK_FRACTION=0 ;;", "    none) CHECK_FRACTION=1 ;;"]],
  },
};

function vitest() {
  return spawnSync("npx", ["vitest", "run", SUITE, "--maxWorkers=1", "--reporter=verbose"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const original = readFileSync(OBJETIVO, "utf8");
copyFileSync(OBJETIVO, RESPALDO);
const restaurar = () => {
  try {
    copyFileSync(RESPALDO, OBJETIVO);
    unlinkSync(RESPALDO);
  } catch {}
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restaurar(); process.exit(130); });

let fallo = false;
try {
  const base = vitest();
  console.log(`BASE rc=${base.status}`);
  if (base.status !== 0) {
    console.log((base.stdout + base.stderr).slice(-2000));
    fallo = true;
  } else {
    for (const [id, m] of Object.entries(MUTACIONES)) {
      let s = original;
      for (const [de, a] of m.cambios) {
        if (!s.includes(de)) { console.log(`${id}: NO SE PUDO APLICAR (${m.desc})`); fallo = true; s = null; break; }
        s = s.replace(de, a);
      }
      if (s === null) continue;
      writeFileSync(OBJETIVO, s);
      const r = vitest();
      const salida = r.stdout + r.stderr;
      const rojos = salida.split("\n").filter((l) => /^\s*(×|✗|FAIL)\s/.test(l) || /\sFAIL\s/.test(l));
      const murio = r.status !== 0 && salida.includes(m.muere) && rojos.some((l) => l.includes(m.muere));
      console.log(`${id}: ${murio ? "MUERTO" : "SOBREVIVE"} rc=${r.status} por «${m.muere}» (${m.desc})`);
      if (!murio) fallo = true;
      copyFileSync(RESPALDO, OBJETIVO);
    }
  }
} finally {
  restaurar();
}
const limpio = readFileSync(OBJETIVO, "utf8") === original;
console.log(`ARBOL_RESTAURADO=${limpio}`);
process.exit(fallo || !limpio ? 1 : 0);
