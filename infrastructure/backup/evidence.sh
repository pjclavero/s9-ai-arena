#!/usr/bin/env bash
# CARRIL E · Recolector de EVIDENCIA de la copia — SOLO LECTURA.
#
# Qué demuestra su salida: la CADENA COMPLETA de una copia concreta —snapshot
# real en el repositorio, pg_dump real dentro de ese snapshot, checksum real
# recalculado sobre los bytes almacenados y manifest real leído de dentro—.
# Qué NO demuestra: que esa copia se pueda restaurar (BACKED_UP !=
# RECOVERY_VERIFIED); para eso está el simulacro de docs/recuperacion.md.
#
# Por qué existe: el healthcheck del servicio mira `pgrep crond`. Un demonio
# vivo no es una copia hecha. Este script no pregunta al productor: abre el
# repositorio y mira lo que hay.
#
# INVARIANTE DE SEGURIDAD (el motivo de cada bandera):
#   - TODA consulta a restic lleva `--no-lock`. Sin ella, una consulta toma un
#     lock en el repositorio: dejaría de ser una lectura.
#   - `restic check` NO se ejecuta NUNCA aquí: toma lock exclusivo y escribe.
#     Verificar la integridad de los packs queda deliberadamente fuera.
#   - No se ejecuta `backup`, `forget`, `prune` ni `unlock`.
#   - No se imprime NINGÚN secreto ni la topología del destino: ni
#     RESTIC_REPOSITORY, ni rutas del NAS, ni contenido de /run/secrets.
#
# Salida: un único documento JSON por stdout. La INTERPRETACIÓN vive en
# packages/readiness/backup-evidence.ts (`observationsFromEvidenceJson` +
# `assessBackupEvidence`): aquí sólo se OBSERVA. Esa separación es lo que
# permite poner cada señal roja en los tests sin repositorio ni daemon.
#
# Código de salida: 0 si el documento se pudo emitir (aunque describa una copia
# rota — eso lo dictamina quien interpreta), 2 si ni siquiera se pudo observar.
set -uo pipefail

METRICS_DIR="${METRICS_DIR:-/textfile}"
METRICS_FILE="${METRICS_FILE:-$METRICS_DIR/s9_backup.prom}"
DATA_TAG="${DATA_TAG:-s9-arena-data}"
STAGING_BASENAME="${STAGING_BASENAME:-staging}"
SNAPSHOT_ID="${SNAPSHOT_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) SNAPSHOT_ID="${2:?--snapshot requiere un id}"; shift 2 ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "uso: evidence.sh [--snapshot <id>]" >&2; exit 2 ;;
  esac
done

# json_escape — convierte stdin en el CUERPO de una cadena JSON. Se hace con
# awk y no con jq porque la imagen de backup es alpine sin jq, y añadir una
# dependencia a un script que corre en el camino de un diagnóstico es
# exactamente cómo se rompe un diagnóstico el día que hace falta.
json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      s = $0
      gsub(/\\/, "\\\\", s)
      gsub(/"/, "\\\"", s)
      gsub(/\r/, "\\r", s)
      gsub(/\t/, "\\t", s)
      if (NR > 1) print "\\n"
      print s
    }
  '
}

# ── process_alive · la señal que HOY es el healthcheck ───────────────────────
# Se recoge para poder decir la verdad sobre ella, no para aprobar nada: el
# intérprete la marca explícitamente como no elegible para readiness.
# SCHEDULER_PROBE es overrideable SÓLO para que los tests puedan ejercer las
# dos ramas sin crond. En producción siempre vale `pgrep crond`.
SCHEDULER_PROBE="${BACKUP_SCHEDULER_PROBE:-pgrep crond}"
if $SCHEDULER_PROBE >/dev/null 2>&1; then process_running=true; else process_running=false; fi

# ── métricas del PRODUCTOR ───────────────────────────────────────────────────
metrics_present=false
metrics_values=""
if [ -r "$METRICS_FILE" ]; then
  metrics_present=true
  # Sólo métricas SIN etiquetas: las `{source="…"}` son por fuente y no
  # deciden el veredicto global. Se emiten como objeto JSON de números.
  metrics_values=$(awk '
    /^#/ { next }
    /^[a-zA-Z_][a-zA-Z0-9_]*[ \t]+-?[0-9.eE+-]+$/ {
      if (n++) printf ","
      printf "\"%s\":%s", $1, $2
    }
  ' "$METRICS_FILE")
fi

# ── repositorio: ¿se puede abrir y listar? ───────────────────────────────────
# rc EXPLÍCITO, nunca el $? de una tubería: en `a | b` el $? es el de `b`, y
# este proyecto ya se comió ese fallo.
repo_accessible=false
repo_reason=""
snapshot_count=0
snapshots_json=""
if ! command -v restic >/dev/null 2>&1; then
  repo_reason="restic no está instalado en este entorno"
else
  snapshots_json=$(restic snapshots --no-lock --json 2>"/tmp/.evidence-err.$$")
  rc=$?
  if [ "$rc" -eq 0 ]; then
    repo_accessible=true
    # Cuenta de snapshots por el campo de PRIMER nivel `"id":"<64 hex>"`, que
    # es único por snapshot: `parent` usa otra clave y los objetos anidados
    # que restic >=0.17 añadió (`summary`) no traen un `id` de 64 hex. Es el
    # mismo criterio de "campo de primer nivel" del parser de restore.sh, sin
    # duplicar aquel escáner completo: aquí sólo hace falta contar y elegir.
    snapshot_count=$(printf '%s' "$snapshots_json" | grep -o '"id":"[0-9a-f]\{64\}"' | wc -l | tr -d ' ')
  else
    repo_reason="no se pudo listar el repositorio (rc=$rc)"
  fi
  rm -f "/tmp/.evidence-err.$$"
fi

# ── el snapshot de datos más reciente ────────────────────────────────────────
snap_probed=false
snap_id=""
snap_time=""
snap_files=""
snap_reason=""
if [ "$repo_accessible" = true ]; then
  snap_probed=true
  if [ -z "$SNAPSHOT_ID" ]; then
    # NO se usa `--latest 1`. Defecto reproducido contra el repositorio REAL
    # (2026-08-30, documentado en resolve_snapshot de restore.sh): `--latest 1`
    # no devuelve UN snapshot, sino el más reciente DE CADA GRUPO (host,paths),
    # y el repositorio de producción arrastra tres hostnames históricos. Con
    # `head -1` sobre esa salida se elige un snapshot arbitrario: en la primera
    # ejecución REAL de este recolector devolvió uno del 13 de agosto teniendo
    # el del 2 de septiembre delante — es decir, la señal de frescura habría
    # mentido en la dirección peligrosa.
    #
    # Tampoco se acota con `--host "$RESTIC_HOSTNAME"`: la imagen desplegada
    # hoy en producción es anterior a fix/restic-stable-hostname y escribe con
    # el ID del contenedor como hostname, así que ese filtro no encontraría
    # NADA y el resultado sería "no hay copias" con 35 copias delante.
    #
    # Se listan TODOS los snapshots del tag y se elige el de fecha MÁXIMA.
    latest_json=$(restic snapshots --no-lock --json --tag "$DATA_TAG" 2>/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ]; then
      snap_reason="no se pudo listar los snapshots del tag $DATA_TAG (rc=$rc)"
    else
      # Cada elemento de primer nivel de `restic snapshots --json` empieza por
      # la clave `time`; los objetos ANIDADOS que restic >=0.17 añadió
      # (`summary`) no. Se trocea por ahí y de cada elemento se leen su fecha y
      # su `id` de 64 hex — sin reimplementar un parser JSON completo, y sin
      # que un campo anidado pueda suplantar a uno de primer nivel. La
      # comparación de fechas es lexicográfica y eso es correcto AQUÍ porque
      # restic emite siempre ISO-8601 en UTC con sufijo Z (misma longitud de
      # campo y mismo huso); con husos mezclados no lo sería.
      elegido=$(printf '%s' "$latest_json" \
        | sed 's|{"time":"|\n{"time":"|g' \
        | awk '
            /^\{"time":"/ {
              t = $0; sub(/^\{"time":"/, "", t); sub(/".*$/, "", t)
              id = ""
              # Sin intervalos {64} en la ERE: el awk de busybox (alpine) no
              # los admite de forma fiable. Se casa el campo y se comprueba la
              # longitud después, que es equivalente y portable.
              if (match($0, /"id":"[0-9a-f]+"/)) {
                cand = substr($0, RSTART + 6, RLENGTH - 7)
                if (length(cand) == 64) id = cand
              }
              if (id != "" && t > best_t) { best_t = t; best_id = id }
            }
            END { if (best_id != "") print best_t "|" best_id }
          ')
      SNAPSHOT_ID="${elegido#*|}"
      snap_time="${elegido%%|*}"
      if [ -z "$elegido" ]; then
        SNAPSHOT_ID=""
        snap_time=""
        snap_reason="el tag $DATA_TAG no tiene ningún snapshot"
      fi
    fi
  fi
  snap_id="$SNAPSHOT_ID"
  if [ -n "$snap_id" ] && [ -z "$snap_time" ]; then
    # Snapshot pedido a mano: su fecha también se lee del repositorio, no se
    # infiere de nada local.
    snap_time=$(restic snapshots --no-lock --json "$snap_id" 2>/dev/null \
      | grep -o '"time":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi
  if [ -n "$snap_id" ]; then
    # Rutas RELATIVAS a la raíz del staging: es la jerarquía que describe el
    # manifest y la que se restaura. Comparar contra rutas absolutas del
    # origen fue el defecto real de #112.
    # `--json` porque hace falta el TIPO de cada nodo. En el listado de texto
    # un DIRECTORIO (p. ej. `replays/`) es indistinguible de un fichero, y
    # contarlo como fichero hacía fallar la cobertura del manifest con "1 sin
    # checksum": un FALSO FALLO observado contra el repositorio REAL de
    # producción, sobre un manifest que estaba perfecto. Cada línea del
    # listado es un objeto JSON de un nodo.
    ls_out=$(restic ls --no-lock --json "$snap_id" 2>/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ]; then
      snap_reason="no se pudo listar el contenido del snapshot (rc=$rc)"
    else
      solo_ficheros=$(printf '%s\n' "$ls_out" | grep '"type":"file"' \
        | grep -o '"path":"[^"]*"' | cut -d'"' -f4)
      snap_files=$(printf '%s\n' "$solo_ficheros" \
        | grep "/$STAGING_BASENAME/" \
        | sed "s|^.*/$STAGING_BASENAME/||" \
        | grep -v '^$' \
        | awk '{ if (n++) printf ","; printf "\"%s\"", $0 }')
      # La raíz del staging se DERIVA de una ruta de FICHERO, no de una entrada
      # de directorio: así el mismo código sirve tanto si el listado trae
      # directorios como si no.
      staging_root=$(printf '%s\n' "$solo_ficheros" \
        | grep -m1 "/$STAGING_BASENAME/" \
        | sed "s|\(/$STAGING_BASENAME\)/.*|\1|")
    fi
  fi
fi

# ── manifest y checksum del volcado, LEÍDOS DE DENTRO del snapshot ───────────
man_probed=false
man_json=""
man_sha=""
man_reason=""
dump_probed=false
dump_sha=""
dump_bytes=0
dump_reason=""
if [ -n "${staging_root:-}" ] && [ -n "$snap_id" ]; then
  man_probed=true
  # rc capturado con `if`, no con un `$?` que la siguiente orden pisaría.
  if ! raw_json=$(restic dump --no-lock "$snap_id" "$staging_root/manifest.json" 2>/dev/null); then
    man_reason="manifest.json ausente o ilegible en el snapshot"
    raw_json=""
  fi
  if ! raw_sha=$(restic dump --no-lock "$snap_id" "$staging_root/manifest.sha256" 2>/dev/null); then
    man_reason="${man_reason:+$man_reason; }manifest.sha256 ausente o ilegible en el snapshot"
    raw_sha=""
  fi
  man_json=$(printf '%s' "$raw_json" | json_escape)
  man_sha=$(printf '%s\n' "$raw_sha" | json_escape)

  # El volcado: se recalcula su sha256 leyendo los BYTES ALMACENADOS, no los
  # del disco local. Creer al manifest sin leer el fichero sería creer otra
  # vez al productor.
  dump_rel=$(printf '%s\n' "$snap_files" | tr ',' '\n' | tr -d '"' | grep -m1 '^pgdump-.*\.dump$')
  if [ -n "$dump_rel" ]; then
    dump_probed=true
    tmp_dump="/tmp/.evidence-dump.$$"
    if restic dump --no-lock "$snap_id" "$staging_root/$dump_rel" > "$tmp_dump" 2>/dev/null; then
      dump_sha=$(sha256sum < "$tmp_dump" | cut -d' ' -f1)
      dump_bytes=$(wc -c < "$tmp_dump" | tr -d ' ')
    else
      dump_reason="no se pudieron leer los bytes del volcado desde el snapshot"
    fi
    rm -f "$tmp_dump"
  else
    dump_reason="no hay pgdump-*.dump en la raíz del staging de este snapshot"
  fi
fi

printf '{'
printf '"schemaVersion":1,'
printf '"process":{"probed":true,"running":%s},' "$process_running"
printf '"metrics":{"probed":true,"present":%s,"values":{%s}},' "$metrics_present" "$metrics_values"
printf '"repository":{"probed":true,"accessible":%s,"snapshotCount":%s,"reason":"%s"},' \
  "$repo_accessible" "${snapshot_count:-0}" "$repo_reason"
printf '"snapshot":{"probed":%s,"id":"%s","time":"%s","files":[%s],"reason":"%s"},' \
  "$snap_probed" "$snap_id" "$snap_time" "$snap_files" "$snap_reason"
printf '"manifest":{"probed":%s,"json":"%s","sha256":"%s","reason":"%s"},' \
  "$man_probed" "$man_json" "$man_sha" "$man_reason"
printf '"pgDump":{"probed":%s,"sha256":"%s","bytes":%s,"reason":"%s"}' \
  "$dump_probed" "$dump_sha" "${dump_bytes:-0}" "$dump_reason"
printf '}\n'
