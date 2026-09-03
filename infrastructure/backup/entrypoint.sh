#!/bin/bash
# Entrypoint del servicio backup: programa el cron diario (BACKUP_CRON) y
# ejecuta un dry-run inicial para validar la configuración al arrancar.
set -euo pipefail

: "${BACKUP_CRON:=15 4 * * *}"
# CRONTAB_FILE es overrideable SÓLO para que los tests (sin Docker) puedan
# ejecutar este entrypoint de verdad contra un directorio temporal en vez de
# /etc/crontabs/root (que no existe fuera de la imagen alpine). En producción
# siempre vale el valor por defecto.
: "${CRONTAB_FILE:=/etc/crontabs/root}"
# Idéntica razón de ser que CRONTAB_FILE: permite a los tests apuntar a un
# backup.sh de prueba sin Docker. En producción siempre vale el valor por
# defecto (el real, instalado por el Dockerfile).
: "${BACKUP_SH:=/usr/local/bin/backup.sh}"

echo "$BACKUP_CRON /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > "$CRONTAB_FILE"

# CARRIL E: marca de arranque para healthcheck.sh. Sin ella, un contenedor
# recién creado (que aún no ha ejecutado su primer cron) no se puede
# distinguir de uno que lleva días sin hacer una sola copia — y el segundo es
# exactamente el fallo que el healthcheck debe ver. No sirve `/proc/uptime`:
# dentro del contenedor es el del HOST. Se escribe con `|| true` porque no
# poder fechar el arranque no debe impedir arrancar: healthcheck.sh falla en
# cerrado si la marca no está, que es la respuesta segura.
: "${METRICS_DIR:=/textfile}"
: "${BACKUP_BOOT_MARKER:=$METRICS_DIR/.container_started}"
mkdir -p "$METRICS_DIR" 2>/dev/null || true
date +%s > "$BACKUP_BOOT_MARKER" 2>/dev/null || true
printf '{"level":"info","service":"backup","msg":"cron programado: %s"}\n' "$BACKUP_CRON"

# Validación temprana de arranque.
# fix/backup-sftp-scheduled-runtime: este dry-run comprueba que 'ssh' esté
# instalado y que RESTIC_SSH_KEY_FILE/RESTIC_SSH_KNOWN_HOSTS_FILE estén
# presentes cuando RESTIC_REPOSITORY usa el backend sftp:.
#
# Dos clases de fallo, dos respuestas distintas (revisión del operador tras
# el primer intento de este fix):
#   - config "de bootstrap" incompleta (p.ej. RESTIC_REPOSITORY aún sin
#     definir, el día 1 antes de terminar `.env`): NO se aborta el arranque
#     — la alerta BackupTooOld ya avisa a las 26 h, y bloquear el contenedor
#     entero por una variable que el operador va a rellenar en un momento
#     sería peor que el problema que resuelve.
#   - backend sftp CONFIGURADO pero roto (ssh ausente de la imagen, o falta
#     la clave/el known_hosts, o el known_hosts está vacío): esto no es un
#     estado transitorio, es un defecto de imagen/despliegue — exactamente
#     el que motivó este fix. backup.sh señala este caso con el código de
#     salida 3 (ver backup.sh). Dejar que el contenedor arranque igual sólo
#     pospone el descubrimiento del fallo al primer cron, 24 h después: el
#     contenedor se NIEGA a arrancar y lo dice con un mensaje claro.
set +e
"$BACKUP_SH" --dry-run
dry_run_status=$?
set -e
if [ "$dry_run_status" -eq 3 ]; then
  printf '{"level":"error","service":"backup","msg":"ARRANQUE ABORTADO: backend sftp mal configurado (ssh ausente y/o clave/known_hosts faltante o vacío) — ver el log de backup.sh justo arriba para el detalle exacto"}\n' >&2
  exit 1
fi

exec crond -f -l 2
