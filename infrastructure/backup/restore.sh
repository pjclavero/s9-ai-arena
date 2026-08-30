#!/usr/bin/env bash
# Restauración desde el último backup restic (runbook: docs/recuperacion.md).
#
#   restore.sh --list                  lista snapshots disponibles
#   restore.sh --restore <destino> [--snapshot <id> | --latest]
#                                       restaura datos (por defecto, el último)
#   restore.sh --restore-secrets <destino> [--snapshot <id> | --latest]
#   restore.sh --verify <dir>          verifica manifest.sha256 restaurado
#   restore.sh --dry-run               plan sin tocar nada (probado por vitest)
#
# fix/restore-snapshot-selection: hasta esta rama, --restore/--restore-secrets
# sólo sabían restaurar `latest` — sin forma de fijar un snapshot conocido
# bueno. En el simulacro de restauración del 2026-08-18 esto se materializó
# de verdad: se decidió restaurar el snapshot 76a13494, pasaron dos días, el
# cron nocturno añadió snapshots nuevos, y restore.sh restauró 4fac59f8 (otro
# distinto) porque nunca hubo forma de pedir uno concreto. Se identificó por
# evidencia externa, no porque el script lo hiciera visible. Si el más
# reciente estuviera corrupto o incompleto en un desastre real, no había
# manera de retroceder.
#
# Decisión de comportamiento por defecto (sin --snapshot ni --latest): se
# mantiene `latest` por compatibilidad con el runbook y los E2E existentes,
# PERO el ID exacto que se resuelve a partir de "latest" se registra en el
# log JSON, antes de restaurar (qué se pidió) y después (qué se resolvió) —
# ver resolve_snapshot() más abajo. Nunca más debe quedar ambigüedad sobre
# qué snapshot se restauró de verdad: eso es lo mínimo que el simulacro
# exigió y lo que este cambio cierra, sin forzar a cada operador a mirar el
# ID a mano en cada restauración de rutina.
#
# Lo más importante de este cambio: un --snapshot con un ID que no existe, o
# que existe pero no tiene el tag pedido (p.ej. pedir un snapshot de
# secretos para --restore, o viceversa), FALLA CERRADO con un mensaje claro
# — nunca cae en silencio a `latest`. Restaurar el snapshot equivocado sin
# que nadie se entere es exactamente el defecto que motivó este cambio.
#
# fix/restore-sftp-bootstrap: hasta esta rama, este script no sabía NADA del
# backend `sftp:` de restic — cero menciones a ssh/sftp/setup_ssh. En
# producción "funcionaba" de rebote porque el contenedor de backup PROGRAMADO
# ya había dejado ~/.ssh listo (lo prepara backup.sh, ver setup_ssh en
# lib/setup-ssh.sh) en la capa de escritura de ESE contenedor. Un contenedor
# de RECUPERACIÓN nuevo — el escenario real de docs/recuperacion.md, que
# nunca ejecutó backup.sh — no tiene ~/.ssh, ningún known_hosts y ninguna
# clave: `restic snapshots`/`restore`/`--restore-secrets` fallaban con
# "Host key verification failed" hasta hacer el bootstrap SSH a mano, algo
# que el runbook automatizado no puede exigir en un simulacro cronometrado.
#
# Contrato de entrada para el backend sftp: (mismo patrón que backup.sh)
#   RESTIC_REPOSITORY             sftp:usuario@host:<backup-path>
#   RESTIC_PASSWORD / RESTIC_PASSWORD_FILE   contraseña del repositorio restic
#   RESTIC_SSH_KEY_FILE           ruta a la clave privada SSH (secreto, NUNCA
#                                  argv; p.ej. /run/secrets/restic_ssh_key)
#   RESTIC_SSH_KNOWN_HOSTS_FILE   ruta al known_hosts con la huella YA
#                                  verificada del host de respaldo (p.ej.
#                                  /run/secrets/restic_ssh_known_hosts)
#
# RIESGO DE CUSTODIA (documentado, NO resuelto aquí — ver docs/recuperacion.md
# "Riesgos conocidos"): este script recibe la clave privada, nunca la genera
# ni la custodia. Si esa clave viviera ÚNICAMENTE dentro de VM108 (o del host
# que sea, en cada despliegue), un desastre que se lleve por delante esa
# máquina se lleva también el único medio de alcanzar el backup — "el backup
# existe" y "el backup es alcanzable" dejan de ser la misma afirmación. La
# custodia fuera del servidor (gestor de secretos del operador, doble
# custodia) es un problema OPERATIVO independiente de este script.
set -euo pipefail

# D2/D2-R3a (rondas 3-4 de #112, ver backup.sh): mismo escape antes de
# interpolar en el JSON del log — este script también interpola rutas
# (p.ej. $dir, que viene de un argumento de línea de comandos, o nombres de
# fichero listados por `find` en --verify) en el mensaje. Saneado de UTF-8
# inválido con `iconv -c` + escape de TODO carácter de control 0x00–0x1F
# como \u00XX (no sólo \n \r \t), igual que en backup.sh.
json_escape() {
  local s="$1"
  if command -v iconv >/dev/null 2>&1; then
    s="$(printf '%s' "$s" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
  fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  local LC_ALL=C out="" i len c code
  len=${#s}
  for ((i = 0; i < len; i++)); do
    c="${s:i:1}"
    printf -v code '%d' "'$c"
    if [ "$code" -lt 32 ]; then
      printf -v c '\\u%04x' "$code"
    fi
    out+="$c"
  done
  printf '%s' "$out"
}
log() { printf '{"ts":"%s","level":"%s","service":"restore","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$(json_escape "$2")"; }

# ── Configuración (mismos nombres de variable que backup.sh, D0 deliberado:
# un contenedor de recuperación recibe los secretos por la MISMA vía que el
# contenedor de backup programado — ver docs/recuperacion.md Fase 2). ──────
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-}"
RESTIC_SSH_KEY_FILE="${RESTIC_SSH_KEY_FILE:-}"
RESTIC_SSH_KNOWN_HOSTS_FILE="${RESTIC_SSH_KNOWN_HOSTS_FILE:-}"
: "${HOME:=/root}"
export HOME

# fix/restore-sftp-bootstrap: setup_ssh compartida con backup.sh — ver
# lib/setup-ssh.sh para el incidente, el contrato de entrada y por qué NUNCA
# se sustituye StrictHostKeyChecking por "no".
# shellcheck source=lib/setup-ssh.sh
# Expansión de parámetros pura de bash: ver el mismo comentario en backup.sh.
_s9_restore_dir="${BASH_SOURCE[0]%/*}"
[ "$_s9_restore_dir" = "${BASH_SOURCE[0]}" ] && _s9_restore_dir="."
source "$_s9_restore_dir/lib/setup-ssh.sh"
unset _s9_restore_dir

# preflight_sftp — mismo chequeo que backup.sh antes de tocar restic: en un
# contenedor de recuperación FRESCO, "RESTIC_REPOSITORY=sftp:… configurado
# pero sin ssh/clave/known_hosts" no es un estado transitorio de arranque,
# es un defecto de preparación del propio simulacro — mejor fallar aquí, con
# un mensaje que dice exactamente qué falta, que dejar que ssh/restic fallen
# más abajo con un error genérico.
preflight_sftp() {
  [[ "$RESTIC_REPOSITORY" == sftp:* ]] || return 0
  if ! command -v ssh >/dev/null 2>&1; then
    log error "RESTIC_REPOSITORY usa el backend sftp pero 'ssh' (openssh-client) no está instalado en esta imagen"
    return 1
  fi
  if [ -z "$RESTIC_SSH_KEY_FILE" ]; then
    log error "backend sftp: falta RESTIC_SSH_KEY_FILE (secreto con la clave privada SSH)"
    return 1
  elif [ ! -r "$RESTIC_SSH_KEY_FILE" ]; then
    log error "backend sftp: RESTIC_SSH_KEY_FILE=$RESTIC_SSH_KEY_FILE no es legible"
    return 1
  fi
  if [ -z "$RESTIC_SSH_KNOWN_HOSTS_FILE" ]; then
    log error "backend sftp: falta RESTIC_SSH_KNOWN_HOSTS_FILE (huella verificada; NUNCA StrictHostKeyChecking=no)"
    return 1
  elif [ ! -s "$RESTIC_SSH_KNOWN_HOSTS_FILE" ]; then
    log error "backend sftp: RESTIC_SSH_KNOWN_HOSTS_FILE=$RESTIC_SSH_KNOWN_HOSTS_FILE está vacío o no es legible"
    return 1
  fi
  return 0
}

# bootstrap_sftp — preflight + setup_ssh, en ese orden, para las tres
# subórdenes que invocan restic directamente contra el repositorio remoto
# (--list, --restore, --restore-secrets). --verify NO la necesita: opera
# sobre un directorio YA restaurado en local, sin tocar la red.
bootstrap_sftp() {
  preflight_sftp || return 1
  if ! setup_ssh; then
    log error "no se pudo preparar ~/.ssh para el backend sftp"
    return 1
  fi
  return 0
}

# ── Parseo JSON mínimo pero CONSCIENTE DEL ANIDAMIENTO ────────────────────
# fix/restic-json-nested-parser: hasta este cambio, resolve_snapshot()
# troceaba la salida de `restic snapshots --json` con
# `grep -o '{[^{}]*}'`, que por construcción sólo casa objetos SIN llaves
# dentro. Eso obligó a fijar `restic=0.16.4-r5` en
# infrastructure/docker/backup/Dockerfile: restic >=0.17 añadió el campo
# `"summary":{…}` a cada snapshot, y ese grep habría casado el objeto MÁS
# INTERNO (el summary) en vez del snapshot, dejando --snapshot/--latest
# fallando en cerrado. El pin evitaba el fallo silencioso, pero convertía
# la capacidad de restaurar un snapshot ELEGIDO en rehén de que Alpine
# siguiera publicando esa versión exacta: el día que `restic=0.16.4-r5`
# desaparezca del índice de apk, la imagen de backup deja de construirse
# —y eso ocurre en la reconstrucción, no en la restauración, así que se
# descubre en el peor momento posible.
#
# Estas dos funciones sustituyen el grep por un escaneo por PROFUNDIDAD,
# consciente de cadenas y escapes. Siguen sin ser un parser JSON completo
# (no interpretan números, ni \u, ni validan el documento) — son
# deliberadamente lo mínimo para lo único que hace falta aquí: separar los
# elementos del array raíz y leer campos del PRIMER nivel de cada
# elemento. Lo que se gana: un objeto anidado (summary, o cualquier otro
# que restic añada mañana) deja de romper el troceado, y un campo anidado
# que se llame igual que uno de primer nivel ya no puede suplantarlo.
#
# json_top_level_elements — lee un array JSON por stdin y escribe cada
# elemento del PRIMER nivel en UNA línea (el espacio en blanco fuera de
# cadenas se descarta: es insignificante en JSON, y una cadena JSON nunca
# contiene saltos de línea crudos).
json_top_level_elements() {
  awk '
    { all = all $0 "\n" }
    END {
      depth = 0; instr = 0; esc = 0; buf = ""; started = 0
      n = length(all)
      for (i = 1; i <= n; i++) {
        c = substr(all, i, 1)
        if (instr) {
          if (started) buf = buf c
          if (esc) { esc = 0 }
          else if (c == "\\") { esc = 1 }
          else if (c == "\"") { instr = 0 }
          continue
        }
        # Espacio en blanco FUERA de cadena: insignificante en JSON. Se
        # descarta aqui para que cada elemento salga en UNA sola linea
        # (dentro de una cadena JSON no puede haber saltos de linea
        # crudos: van escapados como \n, y esos no se tocan). Asi el
        # troceado no necesita separador NUL, que `printf "%c", 0` no
        # emite de forma portable en el awk de busybox (Alpine).
        if (c == " " || c == "\t" || c == "\n" || c == "\r") continue
        if (c == "\"") { instr = 1; if (started) buf = buf c; continue }
        if (c == "{" || c == "[") {
          depth++
          if (depth == 2) { started = 1; buf = c }
          else if (depth > 2 && started) { buf = buf c }
          continue
        }
        if (c == "}" || c == "]") {
          depth--
          if (depth == 1 && started) { print buf c; buf = ""; started = 0 }
          else if (depth >= 2 && started) { buf = buf c }
          continue
        }
        if (started) buf = buf c
      }
    }
  '
}

# json_top_level_field CLAVE — lee UN objeto JSON por stdin y escribe el
# valor de CLAVE si aparece en su PRIMER nivel: sin las comillas
# delimitadoras si es cadena, literal (corchetes/llaves incluidos) si es
# array u objeto. No escribe nada si la clave solo existe dentro de un
# valor anidado — que es exactamente el punto: un `"short_id"` que viva
# dentro de `"summary"` no puede hacerse pasar por el del snapshot.
#
# Los escapes JSON dentro de una cadena se devuelven TAL CUAL (`\n` sigue
# siendo la secuencia de dos caracteres, no un salto de linea). Los campos
# que este script lee — short_id, tags — son hexadecimal y etiquetas
# ASCII, asi que no hay nada que desescapar; y devolverlos crudos garantiza
# que el valor nunca introduce saltos de linea en la sustitucion de
# comandos que lo captura.
json_top_level_field() {
  awk -v want="$1" '
    { all = all $0 "\n" }
    END {
      depth = 0; instr = 0; esc = 0
      tok = ""; key = ""; expectval = 0
      n = length(all)
      for (i = 1; i <= n; i++) {
        c = substr(all, i, 1)
        if (instr) {
          if (esc) { esc = 0; tok = tok c; continue }
          if (c == "\\") { esc = 1; tok = tok c; continue }
          if (c == "\"") {
            instr = 0
            if (expectval && depth == 1) { print tok; exit }
            if (depth == 1) { key = tok }
            continue
          }
          tok = tok c
          continue
        }
        if (c == "\"") { instr = 1; tok = ""; continue }
        if (c == "{" || c == "[") {
          if (expectval && depth == 1) {
            d = 0; out = ""; instr2 = 0; esc2 = 0
            for (j = i; j <= n; j++) {
              cc = substr(all, j, 1)
              if (instr2) {
                out = out cc
                if (esc2) { esc2 = 0 }
                else if (cc == "\\") { esc2 = 1 }
                else if (cc == "\"") { instr2 = 0 }
                continue
              }
              if (cc == " " || cc == "\t" || cc == "\n" || cc == "\r") continue
              out = out cc
              if (cc == "\"") { instr2 = 1; continue }
              if (cc == "{" || cc == "[") { d++ }
              else if (cc == "}" || cc == "]") { d--; if (d == 0) break }
            }
            print out; exit
          }
          depth++; continue
        }
        if (c == "}" || c == "]") { depth--; expectval = 0; continue }
        if (c == ":") { if (depth == 1 && key == want) { expectval = 1 }; continue }
        if (c == ",") { if (depth == 1) { expectval = 0; key = "" }; continue }
      }
    }
  '
}

# resolve_snapshot — fix/restore-snapshot-selection: resuelve "$2" (tag
# restic, p.ej. s9-arena-data) + "$3" (ID solicitado, o el literal "latest")
# al ID de snapshot que se va a restaurar de verdad, dejando constancia en el
# log ANTES (qué se pidió) y DESPUÉS (qué se resolvió) — nunca sólo uno de
# los dos, que es justo lo que dejaba ambiguo el simulacro del 2026-08-18.
#
# No usa `$(resolve_snapshot …)` para devolver el ID: log() escribe en
# stdout (igual que en el resto del script), así que capturar la salida de
# esta función por sustitución de comandos mezclaría las líneas de log JSON
# con el ID — el ID quedaría corrompido. Se devuelve en la variable global
# RESOLVED_SNAPSHOT; el valor de retorno (0/1) es la única señal de éxito.
#
# Fallo cerrado, con causa concreta (nunca cae a `latest` en silencio):
#   1. ID solicitado que restic no reconoce en absoluto → FALLA.
#   2. ID que restic sí reconoce pero no tiene el tag pedido (p.ej. pedir un
#      snapshot de secretos para --restore, o de datos para
#      --restore-secrets) → FALLA. Restaurar el snapshot equivocado sin que
#      nadie se entere es el defecto que este cambio existe para cerrar.
#   3. "latest" sin ningún snapshot con ese tag en el repositorio → FALLA
#      (repositorio vacío o tag inexistente no es "nada que restaurar en
#      silencio": es un estado que el operador debe ver).
resolve_snapshot() {
  local tag="$1" requested="$2" json count obj id tags_field
  log info "snapshot solicitado: $requested (tag=$tag)"
  if [ "$requested" = "latest" ]; then
    if ! json="$(restic snapshots --tag "$tag" --latest 1 --json 2>&1)"; then
      log error "no se pudo listar snapshots para tag=$tag: $(printf '%s' "$json" | tr '\n' ' ')"
      return 1
    fi
  else
    if ! json="$(restic snapshots "$requested" --json 2>&1)"; then
      log error "el snapshot '$requested' no existe en el repositorio (restic: $(printf '%s' "$json" | tr '\n' ' '))"
      return 1
    fi
  fi

  # Supervisión hostil de #118 (HALLAZGOS 1+2, misma causa): la versión
  # anterior hacía `grep -q "\"$tag\""` sobre el JSON COMPLETO devuelto por
  # `restic snapshots`, y en la rama explícita devolvía literalmente
  # "$requested" como ID resuelto sin leer nada del JSON. Dos roturas
  # reales de restic tumbaban ambas cosas a la vez:
  #   (a) IDs abreviados: restic acepta un PREFIJO de short_id. Un prefijo
  #       que casa a la vez con un snapshot de datos Y uno de secretos hace
  #       que `restic snapshots <prefijo> --json` devuelva un array de DOS
  #       objetos — el `grep` sobre el JSON entero encontraba "s9-arena-data"
  #       en cualquiera de los dos y aceptaba, aunque el snapshot que restic
  #       fuera a restaurar de verdad con ese mismo prefijo pudiera ser el
  #       de secretos.
  #   (b) subcadena, no campo: un snapshot con tags:["s9-arena-secrets"]
  #       cuyo hostname (u otro campo cualquiera) contuviera literalmente
  #       "s9-arena-data" como subcadena pasaba el `grep` igual — el
  #       chequeo nunca miraba el campo `tags`, miraba el documento entero.
  #   (c) (HALLAZGO 2) con un ID abreviado, el log archivaba el PREFIJO
  #       tecleado por el operador, no el short_id real que restic resolvió
  #       — la misma ambigüedad del simulacro del 2026-08-18 ("¿qué se
  #       restauró de verdad?"), reaparecida por otra puerta.
  #
  # Fix único para los tres: aislar cada elemento TOP-LEVEL del array JSON
  # y exigir EXACTAMENTE UNO. Con exactamente un objeto, leer `short_id`
  # (nunca lo tecleado) y comprobar el tag SÓLO dentro del campo
  # `"tags":[...]` de ESE objeto, ambos leídos del PRIMER NIVEL.
  #
  # fix/restic-json-nested-parser: el troceado ya no es
  # `grep -o '{[^{}]*}'` (que sólo casaba objetos sin llaves dentro y por
  # eso obligaba a fijar restic a 0.16.4), sino
  # json_top_level_elements/json_top_level_field — escaneo por
  # profundidad, consciente de cadenas y escapes. Un `"summary":{…}`
  # (restic >=0.17) o cualquier otro campo anidado que restic añada en el
  # futuro deja de romper la selección de snapshot, y un `"short_id"`
  # ANIDADO no puede suplantar al del snapshot.
  mapfile -t snap_objs < <(printf '%s' "$json" | json_top_level_elements)
  count="${#snap_objs[@]}"
  if [ "$count" -eq 0 ]; then
    if [ "$requested" = "latest" ]; then
      log error "no hay ningún snapshot con tag=$tag en el repositorio: nada que restaurar"
    else
      log error "'$requested' no devolvió ningún snapshot (respuesta vacía o formato inesperado): se niega a restaurar"
    fi
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    log error "'$requested' es AMBIGUO: coincide con $count snapshots distintos (prefijo compartido, posiblemente entre datos y secretos); usa un ID más largo o el ID completo — nunca se adivina cuál restaurar"
    return 1
  fi
  obj="${snap_objs[0]}"

  id="$(printf '%s' "$obj" | json_top_level_field short_id)"
  if [ -z "$id" ]; then
    # fix/restic-json-nested-parser: antes, un objeto anidado en la salida
    # de restic (el `summary` de restic >=0.17) hacía que el troceado por
    # grep devolviera el objeto MÁS INTERNO y este `if` se disparara
    # SIEMPRE con esa versión de restic. Ya no: json_top_level_elements
    # separa el snapshot completo aunque anide, y json_top_level_field lee
    # el `short_id` del PRIMER NIVEL. Llegar aquí ya sólo significa lo que
    # dice: ese snapshot no trae `short_id` de primer nivel. Fallo cerrado
    # igual — nunca se sustituye por el ID tecleado.
    log error "no se pudo extraer short_id del snapshot devuelto por restic (formato inesperado, sin 'short_id' de primer nivel): $obj"
    return 1
  fi

  # El campo tags DE ESTE snapshot, no una búsqueda de subcadena sobre todo
  # el objeto (ver (b) arriba).
  tags_field="$(printf '%s' "$obj" | json_top_level_field tags)"
  if ! printf '%s' "$tags_field" | grep -q "\"$tag\""; then
    log error "el snapshot '$id' existe pero no tiene el tag '$tag' (tags reales: ${tags_field:-ninguno}): se niega a restaurar (posible mezcla de datos y secretos)"
    return 1
  fi

  log info "snapshot resuelto: $id (tag=$tag)"
  RESOLVED_SNAPSHOT="$id"
}

# snapshot_selector_or_die — interpreta los argumentos opcionales que siguen
# al destino en --restore/--restore-secrets: sin nada (compat, "latest"),
# "--latest" explícito, o "--snapshot <id>". Cualquier otra cosa es un uso
# incorrecto (exit 2, igual que el resto de errores de uso de este script).
# $1 = "$3" del invocador (lo que viene tras el destino, o vacío).
# $2 = "$4" del invocador (el ID, sólo si $1 es --snapshot).
# $3 = texto de uso para el mensaje de error.
# Deja el selector resuelto ("latest" o el ID pedido) en SNAPSHOT_SELECTOR.
snapshot_selector_or_die() {
  local opt="$1" val="$2" extra="$3" usage="$4"
  case "$opt" in
    "")
      # Sin selector: "$val"/"$extra" no deberían poder tener nada aquí
      # (no hay $3/$4 tras el destino), pero se comprueba igual — silencio
      # ante argumentos sobrantes es justo lo que este script no se puede
      # permitir (HALLAZGO 3 del supervisor de #118).
      if [ -n "$val" ]; then
        echo "$usage" >&2
        exit 2
      fi
      SNAPSHOT_SELECTOR="latest"
      ;;
    --latest)
      # HALLAZGO 3 (supervisor #118): `--latest <basura>` aceptaba en
      # silencio y restauraba el más reciente IGNORANDO lo que viniera
      # detrás — `restore.sh --restore <dest> --latest 76a13494` restauraba
      # el snapshot más nuevo, no 76a13494, con EXIT=0 y ningún aviso. Un
      # operador que mezclara las dos formas de invocación se llevaba un
      # snapshot distinto del que creía haber nombrado. `--latest` no
      # acepta ID: cualquier cosa después es un error de uso, nunca datos
      # ignorados en silencio.
      if [ -n "$val" ]; then
        echo "$usage" >&2
        exit 2
      fi
      SNAPSHOT_SELECTOR="latest"
      ;;
    --snapshot)
      if [ -z "$val" ]; then
        echo "$usage" >&2
        exit 2
      fi
      # Misma lógica que --latest: basura tras el ID (p.ej. un segundo
      # argumento sobrante) es un error de uso, no algo que se descarta
      # callado.
      if [ -n "$extra" ]; then
        echo "$usage" >&2
        exit 2
      fi
      SNAPSHOT_SELECTOR="$val"
      ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
}

case "${1:---dry-run}" in
  --dry-run)
    log info "DRY-RUN: plan de restauración"
    echo "PLAN 1 · restic snapshots --tag s9-arena-data (elegir snapshot)"
    echo "PLAN 2 · restic restore <snapshot resuelto: --snapshot <id> o latest> --target <destino>"
    echo "PLAN 3 · pg_restore -c -h \$PGHOST -U \$PGUSER -d \$PGDATABASE <destino>/…/pgdump-*.dump"
    echo "PLAN 4 · copiar mapas/fuentes/replays a los volúmenes y restic restore --tag s9-arena-secrets"
    echo "PLAN 5 · restore.sh --verify <destino> (manifest.sha256) + migraciones al día"
    echo "CONFIG $( [ -n "${RESTIC_REPOSITORY:-}" ] && echo OK || echo "INCOMPLETA: falta RESTIC_REPOSITORY" )"
    if [[ "${RESTIC_REPOSITORY:-}" == sftp:* ]]; then
      echo "SFTP · ssh $(command -v ssh >/dev/null 2>&1 && echo presente || echo AUSENTE), known_hosts verificado (StrictHostKeyChecking yes, nunca 'no')"
      if preflight_sftp; then
        echo "SFTP CONFIG OK"
      else
        echo "SFTP CONFIG INCOMPLETA (ver el error de log JSON justo arriba para el detalle exacto)"
      fi
    fi
    ;;
  --list)
    bootstrap_sftp || exit 1
    restic snapshots
    ;;
  --restore)
    dest="${2:?uso: restore.sh --restore <destino> [--snapshot <id> | --latest]}"
    snapshot_selector_or_die "${3:-}" "${4:-}" "${5:-}" \
      "uso: restore.sh --restore <destino> [--snapshot <id> | --latest]"
    bootstrap_sftp || exit 1
    resolve_snapshot s9-arena-data "$SNAPSHOT_SELECTOR" || exit 1
    restic restore "$RESOLVED_SNAPSHOT" --target "$dest"
    log info "datos restaurados en $dest (snapshot=$RESOLVED_SNAPSHOT); siga el runbook docs/recuperacion.md"
    ;;
  --restore-secrets)
    dest="${2:?uso: restore.sh --restore-secrets <destino> [--snapshot <id> | --latest]}"
    snapshot_selector_or_die "${3:-}" "${4:-}" "${5:-}" \
      "uso: restore.sh --restore-secrets <destino> [--snapshot <id> | --latest]"
    bootstrap_sftp || exit 1
    umask 077
    resolve_snapshot s9-arena-secrets "$SNAPSHOT_SELECTOR" || exit 1
    restic restore "$RESOLVED_SNAPSHOT" --target "$dest"
    log info "secretos restaurados en $dest (snapshot=$RESOLVED_SNAPSHOT; permisos restrictivos; NO volcarlos a logs)"
    ;;
  --verify)
    dir="${2:?uso: restore.sh --verify <dir-restaurado>}"
    # Ronda 6 (hueco encontrado por el supervisor al enumerar caminos): con
    # `set -euo pipefail` activo, `find` sobre un $dir INEXISTENTE sale con
    # exit != 0 dentro de `manifests="$(find …)"` y el script moría ahí
    # mismo, SIN emitir ninguna línea de log JSON — la alertería no ve nada,
    # sólo el stderr crudo de `find`. Comprobado explícitamente antes.
    if [ ! -d "$dir" ]; then
      log error "el directorio $dir no existe: nada que verificar"
      exit 1
    fi
    # #110b: `find | head -1` aceptaba en silencio 0 manifests (verificación
    # que no verifica nada, exit 0 falso) y elegía uno arbitrario si había
    # más de uno (snapshots mezclados). Fallar en cerrado en ambos casos.
    #
    # D1-R6/D2-R6 (ronda 7, HALLAZGO DEL SUPERVISOR — el mismo patrón por
    # sexta vez): este `find` seguía siendo `-name` sin anclar (los otros
    # tres ya se habían migrado a `-path` en la ronda 6) Y contaba con
    # `grep -c .` (líneas), el último conteo por líneas superviviente. Un
    # fichero llamado literalmente "manifest.sha256" DENTRO de maps/,
    # bot_sources/, assets/ o replays/ se contaba como un SEGUNDO manifest
    # y disparaba el guard de ambigüedad sobre un backup perfecto —
    # reproducido 4 de 4, una por fuente. Fix: excluir del `find` cualquier
    # coincidencia anidada bajo esas cuatro subcarpetas conocidas (el
    # manifest real de backup.sh SIEMPRE vive en la raíz del staging, nunca
    # dentro de ellas), y contar con NUL en vez de líneas (una ruta de
    # destino con un salto de línea en algún componente no debe inflar el
    # recuento, el mismo defecto de D1-R5/D2-R5 en el otro extremo).
    mapfile -d '' -t manifest_arr < <(
      find "$dir" -name manifest.sha256 \
        ! -path '*/maps/*' ! -path '*/bot_sources/*' \
        ! -path '*/assets/*' ! -path '*/replays/*' \
        -print0
    )
    manifest_count="${#manifest_arr[@]}"
    if [ "$manifest_count" -eq 0 ]; then
      log error "manifest.sha256 no encontrado en $dir"
      exit 1
    fi
    if [ "$manifest_count" -gt 1 ]; then
      log error "se encontraron $manifest_count manifest.sha256 en $dir (ambiguo; restaura un único snapshot por directorio)"
      exit 1
    fi
    manifest="${manifest_arr[0]}"
    stagedir="$(dirname "$manifest")"
    manifest_json="$stagedir/manifest.json"

    # D2-R4 (ronda 5, HALLAZGO DEL SUPERVISOR): el cruce con manifest.json
    # (usado en las dos ramas de abajo) hacía `grep` sobre texto arbitrario
    # sin comprobar que fuera JSON de verdad ni que tuviera las 6 claves
    # esperadas. Un manifest.json TRUNCADO —el mismo escenario "disco
    # lleno" que motiva media PR— convertía el cruce en un no-op silencioso
    # (ningún `grep` encontraba nada, así que "ninguna fuente declara ok"
    # parecía cierto por ausencia de datos, no por comprobación real) y
    # encima el log afirmaba "confirmado contra manifest.json" sobre un
    # fichero que no es JSON válido. `validate_manifest_json` NO es un
    # parser JSON completo (este script no tiene jq/python garantizados en
    # la imagen del contenedor), pero es un chequeo mínimo honesto: llaves
    # `{`/`}` balanceadas y presencia de las 6 claves de fuente con forma
    # `"nombre":{"status":"...`. Basta para detectar truncamiento/corrupción
    # básica, que es exactamente lo que hundía este chequeo antes.
    validate_manifest_json() {
      local mj="$1" content nopen nclose src
      content="$(cat "$mj" 2>/dev/null)" || return 1
      [ -n "$content" ] || return 1
      case "$content" in
        '{'*'}') ;;
        *) return 1 ;;
      esac
      nopen=$(printf '%s' "$content" | tr -cd '{' | wc -c)
      nclose=$(printf '%s' "$content" | tr -cd '}' | wc -c)
      [ "$nopen" -eq "$nclose" ] || return 1
      for src in postgres secrets maps bot_sources replays assets; do
        printf '%s' "$content" | grep -q "\"$src\":{\"status\":\"[a-z]*\"" || return 1
      done
      return 0
    }

    if [ ! -f "$manifest_json" ]; then
      log error "manifest.json ausente en $stagedir: no se puede contrastar la cobertura declarada por backup.sh"
      exit 1
    fi
    if ! validate_manifest_json "$manifest_json"; then
      log error "manifest.json ($manifest_json) no tiene forma válida (JSON truncado/corrupto o faltan claves de fuente): no se puede confiar en su cobertura"
      exit 1
    fi

    # D3-R2 (supervisión independiente de #119, BLOQUEANTE, corregido): la
    # rama de "manifest vacío legítimo" de abajo (D1) no distinguía un
    # snapshot LEGACY (anterior a D3, dump siempre fuera del manifest) de
    # uno NUEVO degradado (schema>=2, al que se le vació manifest.sha256 y
    # se le sustituyó el dump) — ambos manifest.json declaran postgres
    # 'ok' por igual y esa rama nunca consultaba `postgres`. Resultado
    # reproducido por el supervisor: vaciar manifest.sha256 + sustituir el
    # dump por basura pasaba con EXIT=0 y "ninguna fuente ok", una
    # afirmación falsa (manifest.json SÍ declara postgres/secrets 'ok').
    # `schema` (ver backup.sh, generación de manifest.json) es la versión
    # de CONTRATO: >=2 significa "postgres DEBE tener línea en
    # manifest.sha256 si está 'ok'"; ausente (backups anteriores a este
    # fix) significa "postgres NUNCA tiene línea, sea cual sea su status".
    # Bajo schema>=2 un manifest.sha256 vacío NUNCA es legítimo (postgres
    # siempre está 'ok' si backup.sh llegó a escribir el manifest — ver
    # comentario en backup.sh), así que esa rama queda reservada
    # EXCLUSIVAMENTE a schema<2 (legacy real).
    # `|| true`: bajo `set -e`, un manifest.json LEGACY (sin campo
    # "schema" — el caso normal para snapshots anteriores a este fix) hace
    # que `grep -o` no encuentre nada y salga con exit 1; sin el `|| true`
    # esa asignación mataba el script entero SIN log alguno (comprobado:
    # exit 1 con stdout/stderr vacíos), el mismo tipo de fallo silencioso
    # que otras partes de este script evitan explícitamente.
    schema="$( { grep -o '"schema":[0-9]*' "$manifest_json" | head -1 | grep -o '[0-9]*$'; } || true )"
    schema="${schema:-1}"

    # D1 (ronda 3 de #112): un manifest.sha256 de 0 bytes es el resultado
    # LEGÍTIMO de un backup sano cuando las cuatro fuentes no críticas
    # (maps/bot_sources/assets/replays) están vacías — el estado de un
    # snapshot LEGACY (schema<2, anterior a D3) recién desplegado.
    # `sha256sum -c` sobre un fichero vacío sale con exit 1 y el mensaje "no
    # properly formatted checksum lines found": un operador siguiendo la
    # Fase 7 del runbook vería un FALLO DURO sobre un backup perfecto.
    #
    # D1-R3 (ronda 4, HALLAZGO DEL SUPERVISOR): la primera versión de este
    # fix trataba CUALQUIER manifest de 0 bytes como "vacío legítimo" sin
    # comprobar nada más — cambiaba un falso positivo (rechazar un backup
    # sano) por un falso NEGATIVO (aceptar un backup roto: datos presentes
    # sin verificar, o un manifest.json que declara fuentes `ok` mientras
    # manifest.sha256 no tiene ni una línea). Un falso negativo aquí es
    # peor: es la única comprobación de integridad que tiene el operador, y
    # la habría hecho afirmar por escrito "checksums correctos" sin haber
    # comprobado ni uno. Ahora, con manifest vacío, se exige POSITIVAMENTE
    # que no haya nada que debiera haberse verificado:
    #   0. (D3-R2) El propio CONTRATO admite un manifest vacío — sólo
    #      schema<2. Bajo schema>=2 nunca es legítimo: FALLA sin mirar nada
    #      más, porque postgres 'ok' es obligatorio y siempre exigiría una
    #      línea.
    #   1. Ningún fichero de datos (fuera de pgdump-*/manifest.*) en el
    #      árbol restaurado junto al manifest — si lo hay, hay contenido sin
    #      checksum, y eso es sospechoso, no legítimo.
    #   2. manifest.json no declara NINGUNA fuente no crítica `status:"ok"`
    #      — si lo hiciera, manifest.sha256 vacío sería inconsistente con
    #      lo que el propio backup dice haber capturado.
    # Sólo si TODAS las comprobaciones pasan se acepta como cobertura vacía
    # legítima; en cualquier otro caso, FALLA (no se asume nada a favor).
    if [ ! -s "$manifest" ]; then
      if [ "$schema" -ge 2 ]; then
        log error "manifest.sha256 vacío pero manifest.json declara schema=$schema (postgres/secrets 'ok' obligan a que el dump tenga entrada en manifest.sha256): inconsistente con el contrato de este backup, no es una cobertura vacía legítima"
        exit 1
      fi
      # D6-R5 (ronda 6): `! -name` excluía por nombre base en TODO el
      # árbol; un fichero de usuario como `maps/pgdump-x` escapaba a la
      # comprobación (ver el mismo fix en backup.sh). `-path` con el
      # directorio completo sólo excluye la raíz del staging, que es donde
      # viven de verdad el dump y los manifests. La exclusión de
      # `pgdump-*` aquí sigue siendo correcta PORQUE ya estamos en la rama
      # schema<2: en un legacy real, el dump vive en el árbol pero nunca
      # tuvo línea propia en el manifest, así que no debe contarse como
      # "residual sin checksum".
      stray="$(find "$stagedir" -type f ! -path "$stagedir/manifest.*" ! -path "$stagedir/pgdump-*")"
      if [ -n "$stray" ]; then
        log error "manifest.sha256 vacío pero hay ficheros de datos SIN verificar en $stagedir (p.ej. $(printf '%s\n' "$stray" | head -1)): posible backup roto, no cobertura vacía legítima"
        exit 1
      fi
      # Acoplado deliberadamente al formato exacto que genera backup.sh
      # (sin espacios, ver json_source). Sólo se comprueban las CUATRO
      # fuentes NO críticas (maps/bot_sources/assets/replays) — secrets
      # nunca se lista, y postgres NO se comprueba aquí a propósito: en un
      # legacy real (schema<2, la única forma de llegar a esta rama)
      # postgres SIEMPRE declara 'ok' sin que eso implique una línea en el
      # manifest, así que exigir "postgres no-ok" aquí rechazaría TODO
      # legacy sano, reintroduciendo el falso positivo original de D1.
      for src in maps bot_sources assets replays; do
        if grep -q "\"$src\":{\"status\":\"ok\"" "$manifest_json"; then
          log error "manifest.sha256 vacío pero manifest.json ($manifest_json) declara '$src' como 'ok': inconsistencia real, no se puede confiar en este backup"
          exit 1
        fi
      done
      # D3-R3b: decir la verdad. No se ha comprobado ningún checksum aquí
      # (no había ninguno que comprobar) — la frase "checksums correctos"
      # sería una afirmación sobre algo que el script nunca ejecutó.
      log info "manifest.sha256 vacío: confirmado contra manifest.json y el árbol restaurado (sin datos residuales, ninguna fuente no crítica 'ok'; snapshot legacy anterior a D3, dump de PostgreSQL sin checksum en este manifest); no había nada que verificar"
    else
      # D1-R4 (ronda 5, HALLAZGO DEL SUPERVISOR): el chequeo de D1-R3 sólo
      # vivía en la rama de manifest VACÍO. Esta rama —manifest CON
      # contenido, la que se usa el 99% de las veces porque es la de un
      # backup con datos— sólo hacía `sha256sum -c`, que verifica que cada
      # línea LISTADA coincida, pero NO detecta (a) un manifest truncado a
      # menos líneas de las que el backup realmente produjo (mismo defecto
      # que backup.sh ya comprobaba en su propia generación, backup.sh
      # líneas ~458-484, nunca trasladado aquí), ni (b) un fichero de datos
      # presente en el árbol restaurado SIN entrada en el manifest
      # (contenido inyectado después del backup, o un manifest que nunca
      # llegó a cubrir todo). Mismo rigor que la rama de arriba, en los dos
      # sentidos: ni de menos (truncado) ni de más (residual sin listar).
      # D3 (#112, decisión del operador aplicada en backup.sh): el pg_dump
      # sólo se excluye del manifest en snapshots LEGACY (schema<2);
      # `postgres` entra en esta cuenta igual que las fuentes no críticas
      # SÓLO cuando schema>=2 (ver el mismo cambio en backup.sh). D3-R2:
      # esto es justo lo que faltaba para el defecto 2 — un legacy CON
      # datos (dump fuera del manifest desde antes de D3) ya NO suma
      # postgres aquí, así que `expected_lines` vuelve a coincidir con las
      # líneas reales que ese backup antiguo generó.
      expected_lines=0
      count_srcs="maps bot_sources assets replays"
      [ "$schema" -ge 2 ] && count_srcs="postgres $count_srcs"
      for src in $count_srcs; do
        if grep -q "\"$src\":{\"status\":\"ok\",\"files\":" "$manifest_json"; then
          n="$(grep -o "\"$src\":{\"status\":\"ok\",\"files\":[0-9]*" "$manifest_json" | grep -o '[0-9]*$')"
          expected_lines=$((expected_lines + n))
        fi
      done
      actual_lines="$(wc -l < "$manifest")"
      if [ "$actual_lines" -ne "$expected_lines" ]; then
        log error "manifest.sha256 inconsistente: $actual_lines líneas, manifest.json declara $expected_lines ficheros 'ok' (schema=$schema; manifest truncado o corrupto)"
        exit 1
      fi
      # D1-R5/D2-R5 (ronda 6, HALLAZGO DEL SUPERVISOR): `find … | wc -l`
      # cuenta SALTOS DE LÍNEA de la salida de find (una entrada por
      # fichero, con su nombre completo) mientras `actual_lines` viene de
      # contar líneas de manifest.sha256, donde sha256sum ya ESCAPA los
      # saltos de línea internos del nombre a una sola línea por fichero
      # (formato "portable"). Con un fichero legítimo llamado
      # "salto\nlinea.json", `wc -l` sobre `find` lo contaba como 2,
      # mientras el manifest (correctamente) lo cubre en 1 línea: un
      # backup SANO con ese nombre quedaba denunciado como manipulado. Se
      # cuenta con NUL como separador (`-print0`), inmune a saltos de
      # línea en el propio nombre — la misma técnica que ya se usa bien
      # para `replays` en backup.sh desde la ronda 4, ahora también aquí.
      # D6-R5: exclusión por `-path`, no por `-name` (ver arriba). D3
      # (#112)/D3-R2: `pgdump-*` sólo se excluye aquí cuando schema<2
      # (legacy: el dump está en el árbol pero nunca tuvo línea propia, así
      # que no cuenta como "residual"). Con schema>=2 el dump SÍ tiene
      # línea, así que ya no se excluye — si se siguiera excluyendo,
      # `total_data_files` quedaría sistemáticamente una unidad por debajo
      # de `actual_lines` y esta rama denunciaría "inyección" en todo
      # backup sano con dump.
      pgdump_excl_args=()
      [ "$schema" -lt 2 ] && pgdump_excl_args=(! -path "$stagedir/pgdump-*")
      total_data_files="$(find "$stagedir" -type f ! -path "$stagedir/manifest.*" "${pgdump_excl_args[@]}" -print0 | tr -cd '\0' | wc -c)"
      if [ "$total_data_files" -ne "$actual_lines" ]; then
        # D3-R2 (observación menor del supervisor): el mensaje decía
        # siempre "hay contenido SIN entrada en el manifest (posible
        # inyección)" incluso cuando ocurría lo CONTRARIO — un fichero
        # declarado en el manifest que ya no está en el árbol (p.ej. el
        # dump borrado tras generarse el manifest). Mensaje según el
        # sentido real de la discrepancia.
        if [ "$total_data_files" -gt "$actual_lines" ]; then
          log error "$stagedir tiene $total_data_files ficheros de datos pero manifest.sha256 sólo cubre $actual_lines: hay contenido SIN entrada en el manifest (posible inyección tras el backup)"
        else
          log error "$stagedir tiene $total_data_files ficheros de datos pero manifest.sha256 cubre $actual_lines: faltan ficheros que el manifest declara (posible borrado/pérdida tras el backup)"
        fi
        exit 1
      fi
      # D6-R5 (opcional, barato): sha256sum -c con la ruta ABSOLUTA de
      # $manifest tras el `cd` sería relativa al cwd ORIGINAL si $manifest
      # no era ya absoluta (p.ej. invocado con una ruta relativa) —
      # preexistente en main, sin disparador conocido (el runbook siempre
      # usa rutas absolutas), pero gratis de cerrar: tras el `cd`, usar
      # sólo el nombre del fichero en el directorio ya correcto.
      (cd "$stagedir" && sha256sum -c "$(basename "$manifest")")
      # D3 (#112)/D3-R2 (observación menor del supervisor): el mensaje fijo
      # "postgres, mapas y replays" no mencionaba bot_sources/assets (que
      # también se cubren cuando tienen contenido) y afirmaba "postgres"
      # incluso en un legacy que nunca lo verificó. Se compone dinámicamente
      # a partir de las fuentes que de verdad aportaron líneas al manifest.
      covered=""
      for src in postgres maps bot_sources assets replays; do
        # postgres sólo cuenta como "cubierto" si el contrato de este
        # manifest realmente le dio línea propia (schema>=2); el resto de
        # fuentes cuenta si backup.sh las declaró 'ok' (con 'files', que
        # 'ok' siempre lleva — a diferencia de 'empty'/'error').
        if [ "$src" = postgres ] && [ "$schema" -lt 2 ]; then
          continue
        fi
        if grep -q "\"$src\":{\"status\":\"ok\",\"files\":" "$manifest_json"; then
          case "$src" in
            postgres) label=postgres ;;
            maps) label=mapas ;;
            bot_sources) label=bot-sources ;;
            assets) label=assets ;;
            replays) label=replays ;;
          esac
          covered="${covered:+$covered, }$label"
        fi
      done
      if [ "$schema" -lt 2 ]; then
        log info "integridad verificada: checksums de ${covered:-ninguna fuente con contenido} correctos (snapshot legacy anterior a D3: el dump de PostgreSQL NO tiene checksum en este manifest)"
      else
        log info "integridad verificada: checksums de ${covered:-ninguna fuente con contenido} correctos"
      fi
    fi
    ;;
  *)
    echo "uso: restore.sh --list | --restore <dest> [--snapshot <id> | --latest] | --restore-secrets <dest> [--snapshot <id> | --latest] | --verify <dir> | --dry-run" >&2
    exit 2
    ;;
esac
