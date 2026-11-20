#!/usr/bin/env bash
# Se ejecuta DENTRO de debian:12 (fijado por digest) desde lock-check-userland.test.ts.
# Uso: inner.sh <repo> <dir de casos> <mawk|gawk>
# Para cada caso imprime una línea
#   CASE <awk> <caso> lock_check=<rc> check_env=<rc> allowlist_err=<n> reference=<rc>
# donde `lock_check` es la función REAL del instalador (extraída del fichero, no copiada),
# `check_env` el subcomando real con un env cuyo DOCKER_PROXY_IMAGE_ALLOWLIST apunta al caso,
# y `reference` el programa awk ORIGINAL (con {64}) que fija el contrato.
set -uo pipefail
REPO="$1" CASES="$2" AWK="$3"
INSTALLER="$REPO/infrastructure/scripts/install-docker-proxy.sh"
work="$(mktemp -d)"
bin="$(command -v "$AWK")" || {
  echo "FATAL: $AWK no está instalado"
  exit 90
}
ln -s "$bin" "$work/awk"
export PATH="$work:$PATH"
[ "$(readlink -f "$(command -v awk)")" = "$(readlink -f "$bin")" ] || {
  echo "FATAL: awk no resuelve a $AWK"
  exit 91
}
echo "AWK $AWK $(readlink -f "$(command -v awk)")"
if echo aaa | awk '/^a{3}$/ { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "INTERVALS $AWK yes"
else
  echo "INTERVALS $AWK no"
fi

fn="$(sed -n '/^lock_check() {$/,/^}$/p' "$INSTALLER")"
[ -n "$fn" ] || {
  echo "FATAL: lock_check no encontrada en $INSTALLER"
  exit 92
}
eval "$fn"

n=0
for f in "$CASES"/*.lock; do
  name="$(basename "$f" .lock)"
  lock_check "$f"
  lc=$?
  env="$work/env-$name"
  sed "s#^DOCKER_PROXY_IMAGE_ALLOWLIST=.*#DOCKER_PROXY_IMAGE_ALLOWLIST=$f#" \
    "$REPO/infrastructure/systemd/docker-proxy.env.example" >"$env"
  out="$(APP_DIR=/nonexistent-app-dir bash "$INSTALLER" check-env "$env" 2>&1)"
  ce=$?
  ae="$(grep -c 'DOCKER_PROXY_IMAGE_ALLOWLIST' <<<"$out")"
  awk -f "$CASES/reference.awk" "$f" >/dev/null 2>&1
  ref=$?
  echo "CASE $AWK $name lock_check=$lc check_env=$ce allowlist_err=$ae reference=$ref"
  n=$((n + 1))
done
echo "DONE $AWK $n"
