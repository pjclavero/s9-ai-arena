#!/usr/bin/env bash
# E6 · T6.2 / R1.6 — Ejecutor de la suite de escape del sandbox.
#
#   ./tests/sandbox-escape/run-escape-suite.sh [imagen-runtime-python@sha256:<digest>]
#
# Sin argumento, la imagen se toma de runtimes/DIGESTS.lock (fuente única de verdad).
#
# ERR-SEC-04: este script daba SIEMPRE verde sin probar nada. Cada `docker run` llevaba
# `|| true`, así que un contenedor que ni arrancaba (imagen @sha256:PENDIENTE) producía
# una salida sin marcador de escape y se declaraba "OK: contenido". Ahora:
#
#   1. Se rechaza cualquier digest placeholder o referencia sin @sha256 (digest-guard).
#   2. Se exige que la imagen exista ANTES de empezar.
#   3. Se captura el código de salida de `docker run` por separado: si el contenedor no
#      llegó a ejecutarse (125/126/127), el vector se marca NO PROBADO y la suite falla.
#   4. Cada bot debe emitir su marcador POSITIVO de bloqueo ("SANDBOX-BLOCKED <id>"), o
#      morir con uno de los killExitCodes declarados en manifest.json (OOM/pids). El
#      silencio ya NO cuenta como contención.
#   5. Cualquier marcador de escape (ESCAPE-OK/ESCAPE-CRITICAL/LEAK) falla la suite.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SECCOMP="$ROOT/apps/bot-manager/security/seccomp-bot.json"
MANIFEST="$HERE/manifest.json"
NETWORK="${ARENA_NETWORK:-arena-escape}"

# --- imagen: del argumento o de DIGESTS.lock ---------------------------------
IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="$(awk '$1 == "python" { print $3 }' "$ROOT/runtimes/DIGESTS.lock" | head -1)"
fi
if [ -z "$IMAGE" ]; then
  echo "ERROR: no hay imagen de runtime python en runtimes/DIGESTS.lock" >&2
  exit 2
fi

# --- 1. el digest debe ser real (mismo guard que el resto del repo) -----------
if ! npx tsx "$ROOT/scripts/assert-real-digest.ts" "$IMAGE" "suite de escape"; then
  echo "ERROR: la suite NO se ejecuta con un digest placeholder: $IMAGE" >&2
  echo "       Construye los runtimes y fija los digests reales (T6.3/R6.1)." >&2
  exit 2
fi

# --- 2. la imagen tiene que existir de verdad --------------------------------
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: la imagen $IMAGE no está disponible en este host." >&2
  echo "       Sin imagen no hay prueba: la suite NO puede dar verde." >&2
  exit 2
fi

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --internal "$NETWORK" >/dev/null

# killExitCodes: códigos con los que el contenedor puede morir siendo eso, precisamente,
# la prueba de que el límite funcionó (OOM killer, pids-limit).
kill_codes_for() {
  python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
manifest, bot_id = sys.argv[1], sys.argv[2]
bots = json.load(open(manifest))["bots"]
bot = next((b for b in bots if b["id"] == bot_id), None)
print(" ".join(str(c) for c in (bot or {}).get("killExitCodes", [])))
PY
}

fail=0
probados=0
for bot in "$HERE"/bots/*.py; do
  name="$(basename "$bot" .py)"
  echo "=== $name ==="

  # Sin `|| true`: el código de salida es parte de la evidencia.
  set +e
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
    "$IMAGE" python /bot.py 2>&1)"
  rc=$?
  set -e
  echo "$out"
  echo "--- exit=$rc"

  # 3. ¿llegó a ejecutarse? 125 = el daemon no pudo crear el contenedor;
  #    126/127 = el comando no es ejecutable / no existe.
  if [ "$rc" -eq 125 ] || [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo ">>> NO PROBADO: el contenedor no llegó a ejecutarse (exit $rc). Esto NO es contención."
    fail=1
    continue
  fi

  # 5. marcador de escape = fallo inmediato
  if echo "$out" | grep -qE 'ESCAPE-OK|ESCAPE-CRITICAL|^LEAK '; then
    echo ">>> FALLO: $name logró (o parcialmente) su objetivo"
    fail=1
    continue
  fi

  # 4. prueba positiva: marcador de bloqueo, o muerte por un límite declarado
  killed_ok=0
  for code in $(kill_codes_for "$name"); do
    [ "$rc" -eq "$code" ] && killed_ok=1
  done
  if echo "$out" | grep -q "SANDBOX-BLOCKED $name"; then
    echo ">>> OK: $name intentó el ataque y fue contenido (marcador presente)"
    probados=$((probados + 1))
  elif [ "$killed_ok" -eq 1 ]; then
    echo ">>> OK: $name contenido por límite del runtime (exit $rc declarado en manifest)"
    probados=$((probados + 1))
  else
    echo ">>> NO PROBADO: $name no emitió 'SANDBOX-BLOCKED $name' ni murió por un límite declarado."
    echo "    El silencio no prueba contención (ERR-SEC-04)."
    fail=1
  fi
done

total="$(ls "$HERE"/bots/*.py | wc -l)"
echo
echo "=== vectores contenidos con prueba: $probados/$total"
if [ "$fail" -ne 0 ]; then
  echo "=== SUITE EN ROJO"
else
  echo "=== SUITE EN VERDE (todos los vectores probados y contenidos)"
fi
exit "$fail"
