#!/usr/bin/env bash
# PRC DEV-CI (TD-045) · prepara la evidencia del E2E funcional para subirla como
# artifact de CI, SIN secretos.
#
# Uso: collect-functional-evidence.sh <S9_E2E_STATE> <destino>
#
# Copia SÓLO:
#   logs/   logs de cada servicio (api, worker, build-worker, docker-proxy, replay,
#           vite, gw, tls, sonda) y logs/containers/ (docker ps -a + docker logs de los
#           contenedores propios y de bots, volcados por run.sh antes de borrarlos)
#   out/    summary.txt (rc por fase), report.json y playwright.log de cada fase,
#           test-results/ (trace.zip y capturas de Playwright en fallo), shots/,
#           golden/battle.json + evidence.json (resultado de la batalla),
#           db-evidence.json (builds con sus etapas = logs de build, versiones, batallas)
# NUNCA copia secrets/, certs/, pw.env ni db.url. Además BUSCA el contenido de cada
# secreto efímero dentro de lo copiado: si aparece, borra ese fichero de la
# evidencia y sale con rc 1 (una fuga en logs es un fallo, no un aviso).
set -uo pipefail
STATE=${1:?uso: collect-functional-evidence.sh <state> <destino>}
DEST=${2:?uso: collect-functional-evidence.sh <state> <destino>}
rm -rf "$DEST"
mkdir -p "$DEST"
if [ ! -d "$STATE" ]; then
  echo "sin estado del E2E en $STATE (el E2E no llegó a arrancar)" >"$DEST/NO-STATE.txt"
  exit 0
fi
for d in logs out; do
  [ -d "$STATE/$d" ] && cp -a "$STATE/$d" "$DEST/$d"
done
# Los resultados de Playwright los escribe el contenedor (root en rootful): legibles.
chmod -R a+rX "$DEST" 2>/dev/null || true

# Patrones a buscar: cada línea con material (sin cabeceras PEM) de los secretos
# efímeros que genera run.sh (JWT propio y ajeno, clave de firma, clave TLS). La URL
# de BD no lleva secreto: en CI el service usa trust sin contraseña y el embebido usa
# la constante pública del repo (apps/api/src/testing/test-db.ts).
PATTERNS=$(mktemp)
trap 'rm -f "$PATTERNS"' EXIT
for f in "$STATE"/secrets/* "$STATE/certs/tls.key"; do
  [ -f "$f" ] || continue
  grep -v -e '^-----' -e '^[[:space:]]*$' "$f" | awk 'length($0) >= 16' >>"$PATTERNS"
done

RC=0
if [ -s "$PATTERNS" ]; then
  while IFS= read -r hit; do
    echo "::error::evidencia: material secreto en ${hit#"$DEST"/}; se retira del artifact"
    rm -f "$hit"
    RC=1
  done < <(grep -rlF -f "$PATTERNS" "$DEST" 2>/dev/null || true)
fi
echo "evidencia preparada en $DEST ($(find "$DEST" -type f | wc -l) ficheros, rc=$RC)"
exit $RC
