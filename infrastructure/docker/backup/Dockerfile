# Servicio backup (T10.4): restic + pg_dump + cron dentro del stack.
# Contexto de build: raíz del repo.
FROM alpine:3.20

# fix/backup-sftp-scheduled-runtime: el backend `sftp:` de restic invoca el
# binario `ssh` (restic no habla SFTP por su cuenta; delega en el cliente
# OpenSSH y su subsistema `sftp`). Sin `openssh-client` en la imagen, el
# backup programado fallaba en EJECUCIÓN con "ssh: command not found" —un
# fallo que un `restic -r … snapshots` lanzado a mano desde el host NUNCA
# reproduce, porque el host sí tiene ssh instalado. Sólo se detecta
# ejecutando esta MISMA imagen (ver infrastructure/tests/backup-sftp-e2e.test.ts).
#
# fix/restic-json-nested-parser: `restic` vuelve a instalarse SIN versión
# fijada, y esta vez la ausencia de pin es una decisión, no un descuido.
#
# El pin `restic=0.16.4-r5` lo introdujo fix/restore-snapshot-selection por
# una razón concreta: `resolve_snapshot()` en restore.sh troceaba
# `restic snapshots --json` con `grep -o '{[^{}]*}'`, que sólo casa objetos
# SIN llaves dentro. restic >=0.17 añadió `"summary":{…}` a cada snapshot,
# así que con esa versión el grep habría devuelto el objeto MÁS INTERNO y
# --snapshot/--latest habrían dejado de funcionar. El pin evitaba ese fallo
# silencioso, pero a cambio ataba la capacidad de restaurar un snapshot
# ELEGIDO a que Alpine 3.20 siguiera publicando esa revisión EXACTA: el día
# que `restic=0.16.4-r5` salga del índice de apk, esta imagen deja de
# construirse — y eso se descubre reconstruyendo, es decir, típicamente
# durante una recuperación.
#
# Ese acoplamiento ya no existe: resolve_snapshot() usa
# json_top_level_elements/json_top_level_field (escaneo por profundidad,
# consciente de cadenas y escapes), que separa el snapshot completo aunque
# anide y lee `short_id`/`tags` del PRIMER nivel. Los tests
# "Supervision #118 (ronda 2): objetos JSON anidados (restic >=0.17)" de
# infrastructure/tests/restore-snapshot-selection.test.ts fijan ese
# contrato con la forma real de restic >=0.17 (incluido un `short_id`
# anidado que intenta suplantar al de primer nivel).
#
# Lo que sigue siendo cierto y hay que respetar al cambiar de versión de
# restic: el AGRUPAMIENTO de `restic forget` (--group-by host,tags, ver
# backup.sh y infrastructure/tests/backup-hostname.test.ts) y el formato de
# `snapshots --json` son contratos observados, no garantizados por restic.
# Antes de dar por buena una versión nueva en producción: reconstruir esta
# imagen, ejecutar la suite de infrastructure/tests y el simulacro de
# docs/recuperacion.md contra el repositorio real.
RUN apk add --no-cache bash restic postgresql16-client coreutils findutils openssh-client

# fix/restore-sftp-bootstrap: setup_ssh vive en lib/ para que backup.sh y
# restore.sh compartan exactamente el mismo bootstrap SSH (ver ese fichero).
# Mismo directorio relativo que en el repo (infrastructure/backup/lib) para
# que la resolución de ruta de cada script (relativa a su propio
# BASH_SOURCE) funcione igual dentro y fuera de la imagen.
COPY infrastructure/backup/backup.sh /usr/local/bin/backup.sh
COPY infrastructure/backup/restore.sh /usr/local/bin/restore.sh
COPY infrastructure/backup/lib/ /usr/local/bin/lib/
COPY infrastructure/backup/entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /entrypoint.sh

# B7 · Siembra del directorio de datos con uid 1000 (el `node` de las imágenes
# node-service, dueño real del volumen). Este contenedor monta `arena_replays`
# en SOLO LECTURA, pero es root y arranca dentro del mismo stack: si fuese el
# primero en montar el volumen, sin esta línea Docker lo crearía root:root y el
# replay-service se quedaría sin poder escribir — exactamente el defecto de
# VM108, que estuvo diez días sin guardar un solo replay.
RUN mkdir -p /data/replays && chown 1000:1000 /data /data/replays

# crond necesita root en alpine; el contenedor va sin privilegios adicionales,
# sin puertos y solo en las redes data(+public para alcanzar el NAS).
ENTRYPOINT ["/entrypoint.sh"]

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
ARG SERVICE_NAME=backup
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    SERVICE_NAME=${SERVICE_NAME}
LABEL org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="${SERVICE_NAME}" \
      org.opencontainers.image.source="https://github.com/pjclavero/s9-ai-arena"
