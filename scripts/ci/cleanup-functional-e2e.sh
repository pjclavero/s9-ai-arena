#!/usr/bin/env bash
# PRC DEV-CI (TD-045) · limpieza SIEMPRE (if: always()) del E2E funcional en CI.
#
# Uso: cleanup-functional-e2e.sh <S9_E2E_TAG> <S9_E2E_STATE>
#
# Borra SÓLO lo propio: contenedores con el prefijo del run (<tag>-web/-gw/-tls/-pw-*),
# contenedores de bot residuales (`bot-*`, AutoRemove debería haberlos quitado),
# volúmenes anónimos que hayan dejado y el directorio de estado temporal. Los
# services (postgres, redis) los retira el propio runner. La red `arena` NO se borra
# (regla común: en máquinas compartidas es de todos; en el runner efímero muere con él).
set -uo pipefail
TAG=${1:?uso: cleanup-functional-e2e.sh <tag> <state>}
STATE=${2:?uso: cleanup-functional-e2e.sh <tag> <state>}
case "$TAG" in
  "" | *[!A-Za-z0-9_.-]*)
    echo "tag inválido: $TAG" >&2
    exit 2
    ;;
esac
mapfile -t OWN < <(docker ps -aq --filter "name=^${TAG}-")
mapfile -t BOTS < <(docker ps -aq --filter 'name=^bot-')
[ ${#OWN[@]} -gt 0 ] && docker rm -f -v "${OWN[@]}" >/dev/null
[ ${#BOTS[@]} -gt 0 ] && docker rm -f -v "${BOTS[@]}" >/dev/null
# El estado lo escribe en parte el contenedor de Playwright (root en Docker rootful).
if [ -d "$STATE" ]; then
  rm -rf "$STATE" 2>/dev/null || sudo -n rm -rf "$STATE" 2>/dev/null || true
fi
LEFT=$(docker ps -aq --filter "name=^${TAG}-" | wc -l)
echo "limpieza: ${#OWN[@]} contenedores propios y ${#BOTS[@]} de bot retirados; restantes con el prefijo: $LEFT; estado $( [ -d "$STATE" ] && echo 'NO borrado' || echo borrado)"
[ "$LEFT" -eq 0 ]
