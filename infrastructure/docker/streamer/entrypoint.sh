#!/bin/bash
# Entrypoint del streamer (E11 aporta la captura real; E10 deja el esqueleto).
set -euo pipefail

echo '{"level":"info","service":"streamer","msg":"esqueleto E10: pendiente de la captura real de E11 (cap. 21)"}'
echo '{"level":"error","service":"streamer","msg":"sin implementación de captura: configurar SERVICE_ENTRY cuando E11 entregue"}'
exit 1
