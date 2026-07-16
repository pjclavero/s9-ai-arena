# Servicio backup (T10.4): restic + pg_dump + cron dentro del stack.
# Contexto de build: raíz del repo.
FROM alpine:3.20

RUN apk add --no-cache bash restic postgresql16-client coreutils findutils

COPY infrastructure/backup/backup.sh /usr/local/bin/backup.sh
COPY infrastructure/backup/restore.sh /usr/local/bin/restore.sh
COPY infrastructure/backup/entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /entrypoint.sh

# crond necesita root en alpine; el contenedor va sin privilegios adicionales,
# sin puertos y solo en las redes data(+public para alcanzar el NAS).
ENTRYPOINT ["/entrypoint.sh"]
