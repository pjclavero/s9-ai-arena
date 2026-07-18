# Imagen del s9-smoke-bot para la batalla E2E real (R6.2).
#
# FROM el runtime de bots fijado POR DIGEST (nunca tag flotante): el runtime ya trae
# usuario 10001, pip deshabilitado, ENTRYPOINT ["python"], CMD ["/bot/main.py"] y
# WORKDIR /bot. Aquí solo se copia el bot. El digest DEBE coincidir con el de
# runtimes/DIGESTS.lock (columna runtime-image de `python`); si cambias el runtime,
# actualiza este FROM en el mismo cambio.
FROM ghcr.io/pjclavero/s9-ai-arena/bot-runtime-python@sha256:a337716702a710a5d3497c81e422ab08e07ddfab5186eb824efce9940306e6aa

COPY --chown=10001:10001 main.py /bot/main.py
