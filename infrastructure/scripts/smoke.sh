#!/usr/bin/env bash
# Humo post-despliegue (etapa 8 de la CI y paso 3 de docs/despliegue.md).
# Uso: smoke.sh <base_url>   p. ej. smoke.sh https://arena.seccionnueve.duckdns.org
set -euo pipefail

BASE="${1:?uso: smoke.sh <base_url>}"
fail=0

check() {
  local path="$1" expect="${2:-200}"
  local code
  code=$(curl -kso /dev/null -w "%{http_code}" --max-time 10 "$BASE$path" || echo 000)
  if [ "$code" = "$expect" ]; then
    echo "OK  $BASE$path → $code"
  else
    echo "FALLO $BASE$path → $code (esperado $expect)"
    fail=1
  fi
}

check /healthz
check /api/healthz
check /
check /replays/healthz

exit $fail
