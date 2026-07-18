#!/usr/bin/env bash
# Construye (y opcionalmente publica) la imagen del s9-smoke-bot.
#
# Un `docker build` local NO produce un digest inmutable útil (las capas llevan mtimes;
# ver runtimes-publish.yml / R6.1). Para fijar un DIGEST real hay que PUBLICAR en un
# registro (GHCR) y leer el RepoDigest. El digest resultante es el que se pasa al arnés
# `scripts/e2e-real-battle-smoke.ts` como SMOKE_BOT_DIGEST (nunca un placeholder).
#
# Uso:
#   bash bots/s9-smoke-bot/build.sh            # build local (para probar que construye)
#   bash bots/s9-smoke-bot/build.sh --push     # build + push a GHCR + imprime el digest
#
# Requiere Docker y, para --push, `docker login ghcr.io` con packages:write.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot}"
TAG="${TAG:-0.1.0}"

echo "==> docker build ${IMAGE}:${TAG} (contexto: ${HERE})"
docker build -t "${IMAGE}:${TAG}" "${HERE}"

if [ "${1:-}" = "--push" ]; then
  echo "==> docker push ${IMAGE}:${TAG}"
  docker push "${IMAGE}:${TAG}"
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${IMAGE}:${TAG}")"
  echo "==> DIGEST real (usar como SMOKE_BOT_DIGEST):"
  echo "    ${DIGEST}"
else
  echo "==> build local OK. Para obtener un digest real: vuelve a ejecutar con --push."
fi
