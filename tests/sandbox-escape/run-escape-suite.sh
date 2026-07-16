#!/usr/bin/env bash
# E6 · T6.2 — Ejecutor de la suite de escape del sandbox.
#
# REQUIERE DOCKER. ia02 no está en el grupo docker: este script está LISTO pero no se ha
# podido ejecutar en esta máquina (ver docs/entrega-E6.md). Donde haya Docker:
#
#   ./tests/sandbox-escape/run-escape-suite.sh arena/bot-runtime-python@sha256:<digest>
#
# Lanza cada bot malicioso con EXACTAMENTE los flags de la tabla 18.2 (los mismos que
# DockerContainerRunner.buildRunArgs) y falla si algún bot imprime un marcador de escape.
set -euo pipefail

IMAGE="${1:?uso: run-escape-suite.sh <imagen-runtime-python@digest>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SECCOMP="$HERE/../../apps/bot-manager/security/seccomp-bot.json"
NETWORK="${ARENA_NETWORK:-arena}"

# crea la red arena aislada si no existe (sin salida a Internet se garantiza a nivel de
# firewall del host / --internal; aquí se crea como internal)
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --internal "$NETWORK"

fail=0
for bot in "$HERE"/bots/*.py; do
  name="$(basename "$bot" .py)"
  echo "=== $name ==="
  out="$(docker run --rm \
    --name "escape_$name" \
    --user 10001:10001 \
    --security-opt no-new-privileges \
    --security-opt "seccomp=$SECCOMP" \
    --cap-drop ALL \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
    --network "$NETWORK" \
    --dns 0.0.0.0 \
    --cpus 0.5 --memory 256m --memory-swap 256m --pids-limit 64 \
    -v "$bot:/bot.py:ro" \
    "$IMAGE" python /bot.py 2>&1 || true)"
  echo "$out"
  if echo "$out" | grep -qE 'ESCAPE-OK|ESCAPE-CRITICAL|^LEAK '; then
    echo ">>> FALLO: $name logró (o parcialmente) su objetivo"
    fail=1
  else
    echo ">>> OK: $name contenido"
  fi
done

exit "$fail"
