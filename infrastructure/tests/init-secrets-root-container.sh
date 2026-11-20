#!/usr/bin/env bash
# TD-064 · ejecuta el fixture de escenarios de root con root REAL en un contenedor
# desechable SIN RED (para runners sin user namespaces, como VM111). Escribe la
# salida del fixture en <salida>; después el test la consume:
#   bash infrastructure/tests/init-secrets-root-container.sh <script-bajo-prueba> <salida>
#   INIT_SECRETS_ROOT_OUTPUT=<salida> npx vitest run infrastructure/tests/init-secrets-nofollow.test.ts
# La imagen es debian:stable-slim con openssl y ssh-keygen del host montados en sólo lectura
# (sin instalar nada y sin red). Sólo en VM111, nunca en ia02.
set -uo pipefail
case "$(hostname)" in ia-server) echo "STOP: sólo en VM111"; exit 1 ;; esac
SUT=$(readlink -f "$1"); OUT=$2
FIX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/init-secrets-root-scenarios.sh
docker run --rm --network none --cap-drop ALL \
  --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID --cap-add DAC_READ_SEARCH \
  -v /usr:/hostusr:ro -v /etc/ssl:/etc/ssl:ro -v "$FIX":/fixture.sh:ro -v "$SUT":/sut.sh:ro \
  debian:stable-slim bash -c '
export PATH=$PATH:/hostusr/bin LD_LIBRARY_PATH=/hostusr/lib/x86_64-linux-gnu OPENSSL_CONF=/etc/ssl/openssl.cnf
mkdir -p /b; chmod 0755 /b; bash /fixture.sh /sut.sh /b' >"$OUT" 2>"$OUT.err"
echo "CONTAINER_RC=$?"
