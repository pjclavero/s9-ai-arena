#!/usr/bin/env bash
# PRE_0_5_COMPETITIVE_RESET · mutantes del script de reset (revisión #295, rondas 1 y 2).
#
# Cada mutante cambia UNA garantía de scripts/ops/pre-0.5-competitive-reset.ts y ejecuta su
# suite; debe MORIR (vitest rc≠0). Se ejecutan EN SERIE sobre un árbol COMMITEADO (se restaura
# con `git checkout -- <script>` tras cada uno): nunca dos calibradores a la vez en el mismo
# árbol. Un mutante cuyo patrón no aplica es FALLO (NO_APLICADO), no un verde.
#
# Uso (máquina de pruebas, nunca producción):  bash scripts/pre-0.5-reset-mutants.sh
# Salida: una línea por mutante y `MUTANTS_RESULT killed=K survived=S not_applied=N`; rc 0 sólo
# si BASE pasa, todos mueren y ninguno queda sin aplicar.
set -u
cd "$(dirname "$0")/.."
F=scripts/ops/pre-0.5-competitive-reset.ts
T=apps/api/src/db/pre-0.5-competitive-reset.test.ts
OUT=${MUTANTS_OUT:-/tmp/pre05-mutants}
mkdir -p "$OUT"
if ! git diff --quiet -- "$F" "$T"; then
  echo "árbol con cambios sin commitear en $F/$T: commitea antes de calibrar" >&2
  exit 2
fi
run() { npx vitest run "$T" >"$OUT/$1.out" 2>&1; echo $?; }

base_rc=$(run BASE)
echo "BASE VITEST_RC=$base_rc $(grep -E '^ +Tests ' "$OUT/BASE.out" | tr -s ' ')"
[ "$base_rc" = 0 ] || { echo "BASE en rojo: no se calibra"; exit 1; }

killed=0 survived=0 notapplied=0
mut() {
  local name=$1 expr=$2
  perl -0pi -e "$expr" "$F"
  if git diff --quiet -- "$F"; then
    echo "$name NO_APLICADO"
    notapplied=$((notapplied + 1))
  else
    local rc
    rc=$(run "$name")
    if [ "$rc" != 0 ]; then
      killed=$((killed + 1))
      echo "$name MUERTO (rc=$rc) por: $(grep -E '^ +(×|✗|FAIL) ' "$OUT/$name.out" | head -3 | sed -E 's/ +/ /g' | tr '\n' '|')"
    else
      survived=$((survived + 1))
      echo "$name VIVE (rc=0)"
    fi
  fi
  git checkout -- "$F"
}

# --- ronda 1 (revisor) ---
mut M1_hash_sin_bytea 's/const exprs = cols\.map\(/const exprs = cols.filter((c) => c.data_type !== "bytea").map(/'
mut M2_dryrun_commit 's/if \(opts\.mode !== "apply"\) \{\n(\s*)await trx\.rollback\(\);/if (opts.mode !== "apply") {\n$1await trx.commit();/'
mut M3_running_mal_escrito "s/FROM battles WHERE status = 'running'\`/FROM battles WHERE status = 'runing'\`/"
mut M4_replay_sin_uuid 's/const badIds = ids\.some\(\(id\) => !UUID\.test\(id\)\);/const badIds = false;/'
mut M5_postcommit_exit1 's/report\.status = "POST_COMMIT_FAILED";\n(\s*)report\.exitCode = 4;/report.status = "POST_COMMIT_FAILED";\n$1report.exitCode = 1;/'
mut M6_sin_guarda_torneo_vivo 's/if \(t\.liveBattles \|\| t\.activeJobs\) \{/if (false) {/'
mut M7_sin_lock 's/if \(lockable\.length\) await trx\.raw/if (false) await trx.raw/'
mut M8_hash_sin_primera_col 's/const exprs = cols\.map\(/const exprs = cols.slice(1).map(/'
mut M9_replay_acepta_symlink 's/if \(!st\.isFile\(\) \|\| st\.isSymbolicLink\(\) \|\| dirname\(p\) !== dirReal\)/if (false)/'
mut M10_preserve_sin_hash 's/if \(a\.hash !== b\.hash\) fails\.push\(`\$\{table\}: hash de filas cambió \(PRESERVE\)`\);//'
mut M11_sin_guarda_fk_preserve 's/if \(resetSet\.has\(fk\.parent\) && !resetSet\.has\(fk\.child\)\)/if (false)/'
mut M12_sin_check_sha_manifiesto 's/else if \(marks\[0\]\.detail\?\.replayManifestSha256 !== sha\)/else if (false)/'
# --- ronda 2 ---
mut M13_commit_desconocido_exit1 's/report\.status = "COMMIT_UNKNOWN";\n(\s*)report\.exitCode = 4;/report.status = "COMMIT_UNKNOWN";\n$1report.exitCode = 1;/'
mut M14_report_tras_commit_exit1 's/rep\.exitCode = 4;/rep.exitCode = 1;/'
mut M15_sin_validar_rutas_salida 's/const problem = outputPathProblem\(o\);/const problem = null as string | null;/'
mut M16_dryrun_inserta_marca 's/if \(opts\.mode === "apply"\)\n(\s*)await trx\("audit_log"\)/if (true)\n$1await trx("audit_log")/'
mut M17_dryrun_escribe_manifiesto 's/const writeManifest = opts\.mode === "apply" \|\| opts\.writeDryRunManifest === true;/const writeManifest = true;/'
mut M18_running_nominal_aborta 's/if \(t\.liveBattles \|\| t\.activeJobs\) \{/if (t.liveBattles || t.activeJobs || t.state === "running") {/'
mut M19_sin_listado_torneos 's/report\.tournaments = await listTournaments\(trx\);/report.tournaments = [];/'

git diff --quiet -- "$F" || { echo "ÁRBOL NO RESTAURADO" >&2; exit 3; }
echo "MUTANTS_RESULT killed=$killed survived=$survived not_applied=$notapplied"
[ "$survived" = 0 ] && [ "$notapplied" = 0 ]
