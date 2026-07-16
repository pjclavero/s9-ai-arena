#!/bin/bash
# Entrypoint del servicio backup: programa el cron diario (BACKUP_CRON) y
# ejecuta un dry-run inicial para validar la configuración al arrancar.
set -euo pipefail

: "${BACKUP_CRON:=15 4 * * *}"

echo "$BACKUP_CRON /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
printf '{"level":"info","service":"backup","msg":"cron programado: %s"}\n' "$BACKUP_CRON"

# Validación temprana (no falla el arranque: la alerta BackupTooOld avisará).
/usr/local/bin/backup.sh --dry-run || true

exec crond -f -l 2
