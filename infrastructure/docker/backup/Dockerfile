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
# fix/restore-snapshot-selection (supervisión hostil de #118): `restic`
# fijado a una versión EXACTA, a propósito — el resto de paquetes de esta
# línea siguen sin fijar. `resolve_snapshot()` en restore.sh parsea la
# salida de `restic snapshots --json` con un `grep -o '{[^{}]*}'` que
# asume que los objetos de snapshot son PLANOS (sólo escalares y arrays de
# escalares en sus campos, nunca un objeto anidado) — verificado contra el
# restic real de producción (VM108, 0.16.4): hoy es cierto. Pero restic
# ≥0.17 añadió un campo `"summary":{…}` (objeto anidado) a la salida de
# `snapshots --json`, y `apk add --no-cache restic` SIN versión fijada
# habría quedado a merced de lo que trajera Alpine en la siguiente
# reconstrucción de esta imagen: una subida de versión de restic (aunque
# fuera un parche menor de Alpine, no una decisión de este repo) haría que
# ese `grep` casara el objeto MÁS INTERNO (`summary`) en vez del snapshot
# completo, y `resolve_snapshot()` fallaría cerrado con "no se pudo
# extraer short_id … (formato inesperado)" — --snapshot y --latest, la
# funcionalidad que este PR añade, dejarían de funcionar por completo, sin
# que nadie lo hubiera decidido ni se hubiera enterado hasta el primer
# intento real de restauración.
#
# Subir esta versión exige, ANTES de tocar esta línea: (1) comprobar si la
# nueva versión de restic anida objetos en `snapshots --json` (el
# CHANGELOG de restic lo documenta por versión), y (2) si los anida,
# revisar/reescribir el parseo de resolve_snapshot() en restore.sh (ver
# infrastructure/tests/restore-snapshot-selection.test.ts, describe
# "Supervision #118 (ronda 2): objetos JSON anidados") ANTES de fijar la
# nueva versión aquí — nunca al revés.
RUN apk add --no-cache bash restic=0.16.4-r5 postgresql16-client coreutils findutils openssh-client

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
