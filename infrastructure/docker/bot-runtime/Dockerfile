# bot-runtime-python (dosier 6.2): plantilla de contenedor efímero de bot.
# Contexto de build: raíz del repo.
#
# E6 (bot-manager/runtimes) es el propietario del contenido final; esta
# plantilla fija el contrato de seguridad (usuario sin privilegios, solo el
# SDK y el código del bot) que exige el Compose (red arena, read_only,
# cap_drop ALL, límites).
FROM python:3.12-alpine

RUN adduser -D bot
WORKDIR /bot

# SDK oficial de Python (E5).
COPY sdks/python /opt/arena-sdk
RUN pip install --no-cache-dir /opt/arena-sdk

USER bot

# bot-manager inyecta /bot/main.py (código del bot) al lanzar el contenedor.
ENV ARENA_WS_URL=ws://arena-engine:8081
CMD ["sh", "-c", "touch /tmp/alive && python /bot/main.py"]

# -- ADR-016 - IDENTIDAD DE BUILD (procedencia de imagen) ---------------------
# Va AL FINAL a proposito: un ARG invalida la cache de todas las capas que le
# siguen, y estos tres valores cambian en CADA build. Puestos aqui, cambiar de
# commit no obliga a repetir `npm ci` ni los COPY.
#
# Por que existe: dos incidentes reales (docs/decisiones/ADR-016-identidad-de-build.md).
# Uno construyo el arbol VIEJO y lo etiqueto con el commit NUEVO; el gate de
# entonces solo comparaba "imagen declarada == imagen desplegada", una
# tautologia cuando la etiqueta miente. Con esto el commit VIAJA DENTRO de la
# imagen: como ENV (lo lee el proceso y lo sirve en /version) y como LABEL OCI
# (lo lee `docker image inspect` sin arrancar nada).
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG SERVICE_NAME=bot-runtime-python
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    SERVICE_NAME=${SERVICE_NAME}
LABEL org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="${SERVICE_NAME}" \
      org.opencontainers.image.source="https://github.com/pjclavero/s9-ai-arena"
