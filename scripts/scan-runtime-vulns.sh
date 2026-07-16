#!/usr/bin/env bash
# E6 · T6.3 — Escaneo de vulnerabilidades de las imágenes de runtime.
#
# REQUIERE DOCKER + Trivy. Bloquea (exit 1) ante severidad CRÍTICA.
# ia02 no está en el grupo docker: script LISTO, no ejecutado aquí (ver docs/entrega-E6.md).
#
#   ./scripts/scan-runtime-vulns.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"

# Construye las imágenes desde los digests fijados y las escanea.
for runtime in python node; do
  image="arena/bot-runtime-$runtime:ci"
  echo "== build $runtime =="
  docker build -f "$HERE/runtimes/$runtime/Dockerfile" -t "$image" "$HERE"
  echo "== trivy $runtime (bloquea CRITICAL) =="
  trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed "$image"
done

echo "✓ imágenes de runtime sin vulnerabilidades críticas"
