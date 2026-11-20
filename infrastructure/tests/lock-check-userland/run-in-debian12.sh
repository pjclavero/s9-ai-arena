#!/usr/bin/env bash
# Corre inner.sh con el mawk POR DEFECTO de Debian 12 y después con gawk (instalado en el
# mismo contenedor). Sale ≠0 si no puede ejecutar alguno de los dos: skipped ≠ PASS.
set -euo pipefail
REPO="$1" CASES="$2"
dpkg-query -W -f='PKG ${Package} ${Version}\n' mawk
echo "DEFAULT_AWK $(readlink -f "$(command -v awk)")"
bash "$REPO/infrastructure/tests/lock-check-userland/inner.sh" "$REPO" "$CASES" mawk
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends gawk >/dev/null
dpkg-query -W -f='PKG ${Package} ${Version}\n' gawk
bash "$REPO/infrastructure/tests/lock-check-userland/inner.sh" "$REPO" "$CASES" gawk
