#!/usr/bin/env bash
# E6 · T6.3 / R6.1 — Escaneo de vulnerabilidades de las imágenes de runtime.
#
# REQUIERE DOCKER + Trivy. Bloquea (exit 1) ante severidad CRÍTICA.
#
#   ./scripts/scan-runtime-vulns.sh
#
# R6.1 — dos correcciones, ambas descubiertas al abrir el `digests-gate` (mientras hubo
# placeholders este job se saltaba, así que nunca se ejecutó y nadie vio que no funcionaba):
#
#   1. El script decía en su comentario "construye las imágenes desde los digests fijados",
#      pero hacía `docker build`: NO usaba los digests fijados en absoluto. Escaneaba una
#      imagen recién construida, no la que está pineada en DIGESTS.lock y es la que se
#      ejecuta de verdad. Como las imágenes no son reproducibles bit a bit (medido en R6.1),
#      la imagen escaneada podía no ser la desplegada: el escaneo no garantizaba nada sobre
#      lo que corre. Ahora se DESCARGA por digest y se escanea ESA.
#   2. Trivy no estaba instalado en el runner (`trivy: command not found`, exit 127). El
#      workflow lo instala ahora explícitamente.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$HERE/runtimes/DIGESTS.lock"

if ! command -v trivy >/dev/null 2>&1; then
  echo "ERROR: trivy no está instalado. Sin escáner no hay escaneo: esto NO puede dar verde." >&2
  exit 2
fi

for runtime in python node; do
  image="$(awk -v r="$runtime" '$1 == r { print $3 }' "$LOCK" | head -1)"
  if [ -z "$image" ]; then
    echo "ERROR: no hay imagen de runtime '$runtime' en $LOCK" >&2
    exit 2
  fi

  # El guard del repo: nunca escanear (ni dar por bueno) un digest placeholder.
  if ! npx tsx "$HERE/scripts/assert-real-digest.ts" "$image" "escaneo de vulnerabilidades"; then
    echo "ERROR: digest placeholder para $runtime: $image" >&2
    exit 2
  fi

  echo "== descargando $runtime: $image =="
  if ! docker pull "$image"; then
    echo "ERROR: no se pudo descargar $image. La imagen fijada en DIGESTS.lock tiene que" >&2
    echo "       estar publicada (workflow runtimes-publish.yml)." >&2
    exit 1
  fi

  echo "== trivy $runtime (bloquea CRITICAL) =="
  trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed "$image"
done

echo "✓ imágenes de runtime sin vulnerabilidades críticas"
