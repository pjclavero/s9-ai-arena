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
