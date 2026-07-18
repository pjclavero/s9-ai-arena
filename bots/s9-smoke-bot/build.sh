#!/usr/bin/env bash
# Construye (y opcionalmente publica) la imagen del s9-smoke-bot y OBTIENE su digest real.
#
# Un `docker build` local NO produce un digest inmutable útil ni un repo digest (las capas
# llevan mtimes; ver runtimes-publish.yml / R6.1). El docker-proxy exige la imagen fijada
# por un REPO DIGEST canónico (name@sha256:<64hex>), no un tag ni el Image ID pelado. Para
# obtenerlo hay que PUBLICAR en un registro y leer el RepoDigest:
#   - GHCR (--push): requiere `docker login ghcr.io` con packages:write.
#   - Registry LOCAL (--local): útil en VM108 sin login GHCR; efímero en 127.0.0.1:5000.
# El digest resultante se pasa al arnés `scripts/e2e-real-battle-smoke.ts` como
# SMOKE_BOT_DIGEST (nunca un placeholder; nunca un tag).
#
# Uso:
#   bash bots/s9-smoke-bot/build.sh            # build local (comprueba que construye)
#   bash bots/s9-smoke-bot/build.sh --push     # build + push a GHCR + imprime el digest
#   bash bots/s9-smoke-bot/build.sh --local    # build + push a registry LOCAL + imprime el digest
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${TAG:-0.1.0}"
MODE="${1:-}"

if [ "$MODE" = "--local" ]; then
  # Registry local efímero (127.0.0.0/8 es "inseguro" permitido por defecto por Docker).
  REG="${LOCAL_REGISTRY:-127.0.0.1:5000}"
  IMAGE="${REG}/s9-smoke-bot"
  echo "==> registry local en ${REG} (contenedor s9-localreg)"
  docker inspect s9-localreg >/dev/null 2>&1 || \
    docker run -d --restart no -p "127.0.0.1:5000:5000" --name s9-localreg registry:2 >/dev/null
  sleep 1
  echo "==> docker build ${IMAGE}:${TAG} (contexto: ${HERE})"
  docker build -t "${IMAGE}:${TAG}" "${HERE}"
  echo "==> docker push ${IMAGE}:${TAG}"
  docker push "${IMAGE}:${TAG}" >/dev/null
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${IMAGE}:${TAG}")"
  echo "==> DIGEST real (registry local). Úsalo como SMOKE_BOT_DIGEST:"
  echo "    ${DIGEST}"
  echo "    (para retirar el registry al terminar: docker rm -f s9-localreg)"
  exit 0
fi

IMAGE="${IMAGE:-ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot}"
echo "==> docker build ${IMAGE}:${TAG} (contexto: ${HERE})"
docker build -t "${IMAGE}:${TAG}" "${HERE}"

if [ "$MODE" = "--push" ]; then
  echo "==> docker push ${IMAGE}:${TAG}"
  docker push "${IMAGE}:${TAG}"
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${IMAGE}:${TAG}")"
  echo "==> DIGEST real (GHCR). Úsalo como SMOKE_BOT_DIGEST:"
  echo "    ${DIGEST}"
else
  echo "==> build local OK. Para un digest real: --push (GHCR) o --local (registry local)."
fi
