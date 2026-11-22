#!/usr/bin/env bash
# Aviso del nightly (V1-OPS · AUD2-01 / D-OP-13).
# Abre o actualiza UN issue cuando el nightly falla y lo cierra cuando vuelve a verde.
# Sólo usa `gh` con GITHUB_TOKEN (permiso `issues: write`); ningún servicio externo.
#
# Entorno:
#   RESULT    failure | success   resultado agregado del nightly (obligatorio)
#   RUN_URL   enlace a la ejecución
#   SHA       commit evaluado
#   GH_REPO   owner/repo (lo pone Actions; gh lo usa solo)
#   TITLE     título del issue (defecto: «Nightly en rojo»)
#   LABEL     etiqueta que identifica al issue (defecto: nightly-fallido)
#   DETAIL    texto opcional con el detalle por job
set -uo pipefail

RESULT="${RESULT:-}"
RUN_URL="${RUN_URL:-}"
SHA="${SHA:-desconocido}"
TITLE="${TITLE:-Nightly en rojo}"
LABEL="${LABEL:-nightly-fallido}"
DETAIL="${DETAIL:-}"

case "$RESULT" in
  failure | success) ;;
  *)
    echo "RESULT='$RESULT' no válido (failure|success)" >&2
    exit 2
    ;;
esac

# Un error de API NO se interpreta como «no hay issue»: se aborta (el job queda rojo, visible).
if ! lista="$(gh issue list --label "$LABEL" --state open --json number,title --jq "map(select(.title == \"$TITLE\")) | .[0].number // empty")"; then
  echo "gh issue list falló: no se puede decidir; abortando" >&2
  exit 1
fi
numero="$lista"

if [ "$RESULT" = failure ]; then
  cuerpo="El nightly ha fallado.

- Ejecución: ${RUN_URL}
- Commit: ${SHA}
${DETAIL}
Este issue se actualiza en cada fallo y se cierra solo cuando el nightly vuelve a verde."
  if [ -n "$numero" ]; then
    gh issue comment "$numero" --body "$cuerpo" || exit 1
    echo "issue #$numero actualizado"
  else
    gh label create "$LABEL" --description "Aviso automático del nightly" --color B60205 >/dev/null 2>&1 || true
    gh issue create --title "$TITLE" --label "$LABEL" --body "$cuerpo" || exit 1
    echo "issue creado"
  fi
else
  if [ -n "$numero" ]; then
    gh issue comment "$numero" --body "El nightly ha vuelto a verde (${RUN_URL}, commit ${SHA}). Se cierra el aviso." || exit 1
    gh issue close "$numero" || exit 1
    echo "issue #$numero cerrado"
  else
    echo "nightly en verde y sin issue abierto: nada que hacer"
  fi
fi
