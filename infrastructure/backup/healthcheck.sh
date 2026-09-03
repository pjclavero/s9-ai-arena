#!/usr/bin/env bash
# CARRIL E · Healthcheck del servicio `backup`: mira LA COPIA, no el demonio.
#
# Lo que sustituye:
#
#     healthcheck: ["CMD-SHELL", "pgrep crond >/dev/null"]
#
# `pgrep crond` pasa —y el contenedor sale `healthy`— con la copia fallando
# todas las noches. Este proyecto ya vivió ese incidente exacto: un contenedor
# sano cuyo único trabajo llevaba días sin hacerse. Un healthcheck que no puede
# ponerse rojo cuando el servicio no está haciendo su trabajo no es un
# healthcheck: es un adorno.
#
# QUÉ DEMUESTRA este healthcheck (y sólo esto):
#   - que existe una ejecución de la copia registrada en el textfile collector;
#   - que esa ejecución terminó con código 0, con la fuente crítica postgres en
#     ok y declarando snapshot creado;
#   - que su marca de éxito es RECIENTE (<= BACKUP_MAX_AGE_HOURS).
#
# QUÉ NO DEMUESTRA:
#   - que exista un snapshot en el repositorio: todo lo anterior lo escribe el
#     PRODUCTOR sobre sí mismo. La corroboración independiente (abrir el
#     repositorio, mirar el snapshot, el volcado, el manifest y su checksum)
#     está en `evidence.sh` + packages/readiness/backup-evidence.ts, y NO se
#     hace aquí a propósito: un healthcheck cada 60 s que abre un repositorio
#     remoto por sftp añade carga y un modo de fallo (red del NAS) al estado de
#     salud de un contenedor que sí está sano.
#   - que la copia sea restaurable. BACKED_UP != RECOVERY_VERIFIED.
#
# El demonio sigue mirándose, pero degradado a lo que de verdad es: condición
# NECESARIA y NO SUFICIENTE. Si crond está muerto, nada disparará la copia de
# esta noche y eso es un fallo hoy; pero que esté vivo ya no aprueba nada.
set -uo pipefail

METRICS_DIR="${METRICS_DIR:-/textfile}"
METRICS_FILE="${METRICS_FILE:-$METRICS_DIR/s9_backup.prom}"
# 26 h = periodicidad diaria + margen. Mismo umbral que la alerta BackupTooOld
# y que BACKUP_MAX_AGE_HOURS del motor de readiness: una sola verdad sobre
# cuándo una copia deja de representar el sistema.
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
# Ventana de arranque: un contenedor recién creado todavía no ha ejecutado su
# primer cron, y exigirle métricas sería un falso fallo. Pasada la ventana, la
# AUSENCIA de métricas deja de ser "acaba de arrancar" y pasa a ser el fallo
# que este healthcheck existe para ver: un servicio que nunca hizo su trabajo.
GRACE_HOURS="${BACKUP_HEALTH_GRACE_HOURS:-$MAX_AGE_HOURS}"
# Marca de arranque que escribe entrypoint.sh. No se usa `/proc/uptime` (es el
# del HOST, no el del contenedor) ni la hora de un fichero cualquiera.
BOOT_MARKER="${BACKUP_BOOT_MARKER:-$METRICS_DIR/.container_started}"
# Sonda del planificador. Overrideable SÓLO para que los tests (sin Docker ni
# crond) puedan ejercer las DOS ramas —vivo y muerto— de verdad. En producción
# siempre vale el defecto.
SCHEDULER_PROBE="${BACKUP_SCHEDULER_PROBE:-pgrep crond}"

fail() { printf 'BACKUP UNHEALTHY: %s\n' "$1" >&2; exit 1; }

now=$(date +%s)

# 1 · Necesaria, no suficiente: sin planificador no habrá copia esta noche.
if ! $SCHEDULER_PROBE >/dev/null 2>&1; then
  fail "crond no está vivo: nada disparará la copia (condición necesaria, jamás suficiente)"
fi

# 2 · ¿Hay evidencia de ejecución? Distinguir "aún no tocaba" de "nunca ocurrió".
if [ ! -r "$METRICS_FILE" ]; then
  boot=""
  [ -r "$BOOT_MARKER" ] && boot=$(cat "$BOOT_MARKER" 2>/dev/null)
  case "$boot" in
    ''|*[!0-9]*)
      # Sin marca de arranque no se puede saber si la ventana ha pasado. Se
      # falla en CERRADO: preferimos un rojo honesto a un verde por no saber.
      fail "no hay métricas de la copia y no se puede fechar el arranque del contenedor" ;;
  esac
  age_h=$(( (now - boot) / 3600 ))
  if [ "$age_h" -lt "$GRACE_HOURS" ]; then
    printf 'BACKUP STARTING: sin copia todavía, %sh de %sh de ventana de arranque\n' "$age_h" "$GRACE_HOURS"
    exit 0
  fi
  fail "el contenedor lleva ${age_h}h y NO consta ninguna ejecución de la copia"
fi

metric() {
  # Métricas SIN etiquetas. Se devuelve vacío si la métrica no está, para que
  # "ausente" no se pueda confundir con 0 en la comparación.
  awk -v k="$1" '$1 == k { v = $2 } END { print v }' "$METRICS_FILE"
}

exit_code=$(metric s9_backup_last_exit_code)
run_success=$(metric s9_backup_run_success)
pg_success=$(metric s9_backup_postgres_success)
snap_created=$(metric s9_backup_restic_snapshot_created)
last_success=$(metric s9_backup_last_success_timestamp_seconds)

[ "$exit_code" = "0" ] || fail "la última ejecución terminó con código ${exit_code:-ausente}"
[ "$run_success" = "1" ] || fail "s9_backup_run_success=${run_success:-ausente}: la última ejecución no fue un éxito"
[ "$pg_success" = "1" ] || fail "s9_backup_postgres_success=${pg_success:-ausente}: la fuente crítica falló"
# Una ejecución que sale con 0 sin crear snapshot no es una copia: EXIT 0 !=
# BEHAVIOR EXERCISED.
[ "$snap_created" = "1" ] || fail "s9_backup_restic_snapshot_created=${snap_created:-ausente}: exit 0 sin snapshot no es una copia"

case "$last_success" in
  ''|*[!0-9]*) fail "no hay época de último éxito: un éxito sin fecha no se puede distinguir de uno de hace un mes" ;;
esac
age_h=$(( (now - last_success) / 3600 ))
[ "$age_h" -le "$MAX_AGE_HOURS" ] || fail "el último éxito tiene ${age_h}h (> ${MAX_AGE_HOURS}h): copia rancia"

printf 'BACKUP OK: último éxito hace %sh (exit 0, postgres ok, snapshot creado)\n' "$age_h"
exit 0
