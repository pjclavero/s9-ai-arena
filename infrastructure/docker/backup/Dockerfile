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
RUN apk add --no-cache bash restic postgresql16-client coreutils findutils openssh-client

COPY infrastructure/backup/backup.sh /usr/local/bin/backup.sh
COPY infrastructure/backup/restore.sh /usr/local/bin/restore.sh
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
