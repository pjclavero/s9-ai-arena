#!/usr/bin/env bash
# PR C · mutantes de la carga del worker (ronda 1 + ronda 2 + los N1-N13 del revisor).
# Cada mutante debe morir por un test NOMBRADO. Requisitos: árbol LIMPIO y commiteado
# (el harness hace git checkout al final); ejecutar SÓLO en VM111 (npm ci hecho).
# Uso: bash scripts/mutants-worker-load.sh
set -u
case "$(hostname)" in ia-server) echo "STOP: sólo en VM111"; exit 1;; esac
cd "$(dirname "$0")/.."
D=apps/tournament-worker/src
FILES="$D/worker-load.test.ts $D/load-config.test.ts $D/container-agents-load.test.ts"
export NO_COLOR=1 FORCE_COLOR=0
RUN="npx vitest run $FILES --reporter=verbose"
[ -z "$(git status --porcelain)" ] || { echo "árbol sucio"; exit 2; }
$RUN >/tmp/mut-base.log 2>&1 || { echo "BASE ROJA"; tail -30 /tmp/mut-base.log; exit 3; }
echo "BASE verde: $(grep -E '^ +Tests ' /tmp/mut-base.log)"
fail=0
mut() { # id fichero sed-expr test-asesino
  local id=$1 f=$2 expr=$3 killer=$4
  sed -i -E "$expr" "$f"
  if git diff --quiet -- "$f"; then echo "$id: el sed no cambió nada"; fail=1; return; fi
  out=$($RUN 2>&1); rc=$?
  git checkout -q -- "$f"
  if echo "$out" | grep -q "Transform failed"; then echo "$id: INVÁLIDO (el mutante no compila)"; fail=1
  elif [ $rc -ne 0 ] && echo "$out" | grep -E '^\s*(×|FAIL)' | grep -qF "$killer"; then echo "$id: MUERTO por «$killer»"
  else echo "$id: SUPERVIVIENTE o muerto por otro test (rc=$rc, esperado «$killer»)"; fail=1; fi
}
W=$D/worker.ts
C=$D/cpu-sampler.ts
A=$D/container-agents.ts
M=$D/main.ts
L=$D/load-config.ts
# --- ronda 1
mut M-C1 $W '/function concurrencyFromEnv/,/^}/ s/  return n;/  return 3;/' "entero válido"
mut M-C2 $W 's/n < 1 \|\| n > MAX_CONFIGURED_CONCURRENCY/n < 1/' "0, negativo, sobre el tope"
mut M-C3 $W 's/n < 1 \|\| n > MAX/n < 0 || n > MAX/' "0, negativo, sobre el tope"
mut M-C4 $W 's/this\.config\.concurrency \?\? computeConcurrency\(\)/computeConcurrency()/' "respeta la concurrencia configurada"
mut M-C5 $C 's/DEFAULT_CPU_SAMPLE_MS = 2_000/DEFAULT_CPU_SAMPLE_MS = 500/' "intervalo de muestreo acotado"
mut M-C6 $C 's/Math.max\(MIN_CPU_SAMPLE_MS, Math.round\(ms\)\)/Math.round(ms)/' "intervalo de muestreo acotado"
mut M-C7 $C 's/if \(this\.inFlight\[i\]\) \{/if (false) {/' "no se apilan"
mut M-C8 $C 's/this\.last\[i\] === null \|\| v > this\.last\[i\]!/true/' "conserva la cota inferior"
mut M-C9 $C 's/if \(this\.isDead\(i\)\) continue;//' "sólo contenedores vivos"
# --- ronda 2 · P2-1 (fallo transitorio ≠ terminado), P2-2 (vencimiento)
mut M-D1 $C 's/if \(st && \(st\.gone \|\| !st\.running\)\) this\.terminated\[i\] = true;/this.terminated[i] = true;/' "positiva, 2+ nulos"
mut M-D2 $C 's/if \(st && \(st\.gone \|\| !st\.running\)\)/if (!st || st.gone || !st.running)/' "si el inspect también falla"
mut M-D3 $C 's/this\.terminated\[i\] = true;/void 0;/' "con 404/"
mut M-D4 $C 's/\}, this\.timeoutMs\);/}, 2e9);/' "nunca resuelve"
mut M-D5 $C 's/this\.inFlight\[i\] = null;$/this.inFlight[i] = this.inFlight[i];/' "nunca resuelve"
# --- ronda 2 · P2-3 (cableado)
mut M-E1 $L 's/return cfg\.concurrency !== undefined \? \{ concurrency: cfg\.concurrency \} : \{\};/return {};/' "con variables"
mut M-E2 $L 's/cpuSampleMs: cfg\.cpuSampleMs \}/cpuSampleMs: 2000 }/' "con variables"
mut M-E3 $L 's/cpuSampleMs: cpuSampleMsFromEnv\(env\),/cpuSampleMs: 2000,/' "con variables"
mut M-E4 $M 's/buildLoadConfig\(process\.env\)/buildLoadConfig({})/' "loadConfig = buildLoadConfig"
# --- N1-N13 del revisor (N3/N8/N9 de DEAD_AFTER/deadStreak ya no existen: sustituidos por M-D1..D3)
mut N1 $C 's/this\.stats\.skipped\+\+;//' "no se apilan"
mut N2 $C 's/this\.inFlight\[i\] \?\? \(this\.isDead\(i\) \? Promise\.resolve\(\) : this\.sampleOne\(i\)\)/this.sampleOne(i)/' "la muestra final reutiliza"
mut N4 $C 's/if \(this\.timer\) clearInterval\(this\.timer\);//' "stop() limpia el temporizador"
mut N5 $C 's/Math\.min\(MAX_CPU_SAMPLE_MS, (Math\.max\(MIN_CPU_SAMPLE_MS, Math\.round\(ms\)\))\)/\1/' "intervalo de muestreo acotado"
mut N6 $W 's#/\^\[0-9\]\+\$/#/^[0-9.]+$/#' "0, negativo, sobre el tope"
mut N6b $C 's#/\^\[0-9\]\+\$/#/^[0-9.]+$/#' "el entorno: válido pasa"
mut N7 $C 's/n < MIN_CPU_SAMPLE_MS \|\| n > MAX_CPU_SAMPLE_MS/n > MAX_CPU_SAMPLE_MS/' "el entorno: válido pasa"
mut N10 $A 's/new ContainerCpuSampler\(handles, opts\.cpuSampleMs\)/new ContainerCpuSampler(handles)/' "usa opts.cpuSampleMs"
mut N11 $A 's/cpuSamplerImpl\.stop\(\);//' "usa opts.cpuSampleMs"
mut N12 $M 's/\.\.\.workerLoadOptions\(loadConfig\),//' "new TournamentWorker"
mut N13 $M 's/\.\.\.executorLoadOptions\(loadConfig\),//' "containerAgents({...})"
git diff --quiet && echo "árbol limpio" || { echo "ÁRBOL SUCIO"; fail=1; }
exit $fail
