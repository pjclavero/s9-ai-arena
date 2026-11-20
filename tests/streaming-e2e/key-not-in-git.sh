#!/usr/bin/env bash
# STREAMING-UX · KEY_NOT_IN_GIT · la clave de PRUEBA del E2E (centinela aleatorio, generado en
# un fichero 0600 de $S9_STREAM_E2E_STATE) no está en el repositorio: ni en el árbol de trabajo
# (incluidos los no rastreados), ni en el índice, ni en ningún commit alcanzable, ni en los
# objetos sueltos. La clave NUNCA se imprime: sólo recuentos.
#
#   S9_STREAM_E2E_STATE=<dir> tests/streaming-e2e/key-not-in-git.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="${S9_STREAM_E2E_STATE:?define S9_STREAM_E2E_STATE}/stream_key"
[ -s "$KEY_FILE" ] || { echo "no hay centinela en $KEY_FILE"; exit 2; }
cd "$REPO" || exit 2
total=0
count() { # $1 etiqueta; stdin = contenido
  local n
  n=$(grep -cF -f "$KEY_FILE" || true)
  echo "$1: $n"
  total=$((total + n))
}
# Árbol de trabajo (rastreado y no rastreado, sin node_modules).
count "árbol" < <(git ls-files -co --exclude-standard -z | grep -zv '^node_modules' | xargs -0 cat 2>/dev/null)
# Índice.
count "índice" < <(git ls-files -s | awk '{print $2}' | xargs -r -n 200 git cat-file -p 2>/dev/null)
# Todo el historial alcanzable (parches de todas las ramas y tags locales).
count "historial" < <(git log --all -p --no-color 2>/dev/null)
# Objetos sueltos o inalcanzables (p. ej. un `git add` que nunca se commiteó).
count "objetos" < <(git fsck --unreachable --no-reflogs 2>/dev/null | awk '/blob/{print $3}' | xargs -r -n 200 git cat-file -p 2>/dev/null)
echo "KEY_NOT_IN_GIT total=$total"
[ "$total" = 0 ]
