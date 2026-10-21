#!/usr/bin/env bash
# R-DEPLOY · R2 / RC2 — instala/valida/revierte el proxy de la API de Docker como
# unidad systemd en el HOST. Debe ejecutarse con privilegios (sudo), salvo `check-env`.
#
# ÚNICO proceso autorizado a tocar /var/run/docker.sock (R1.7 · ERR-SEC-02).
# Ningún contenedor del stack monta el socket.
#
# Uso:
#   bash      infrastructure/scripts/install-docker-proxy.sh check-env [fichero]  # sin root
#   bash      infrastructure/scripts/install-docker-proxy.sh probe <bind> [puerto] # sin root
#   npm run build:docker-proxy                                   # SIN root: genera el bundle
#   sudo bash infrastructure/scripts/install-docker-proxy.sh install
#   sudo bash infrastructure/scripts/install-docker-proxy.sh preflight [--static]
#   sudo bash infrastructure/scripts/install-docker-proxy.sh validate
#   sudo bash infrastructure/scripts/install-docker-proxy.sh rollback
#
# `check-env` valida el fichero de configuración SIN ejecutarlo (se parsea como
# CLAVE=VALOR, nunca se hace `source`): bind del contrato RC2 (nunca 0.0.0.0, ::,
# loopback, docker0 ni host-gateway), clientes admitidos, allowlist de imágenes, red
# `arena` y usuario del sandbox. `install` lo ejecuta ANTES de tocar la unidad: con un
# fichero inválido no se instala nada y el proxy en marcha sigue como estaba.
#
# TD-062 · frontera de privilegio. El proxy corre con el grupo `docker` (= root en el
# host): «el llamador puede pedir una operación; no puede modificar la autoridad que la
# aplica». Por eso el proxy NO se ejecuta desde el árbol de despliegue (/opt/s9-ai-arena,
# escribible por el usuario de despliegue):
#   - `install` copia un bundle autocontenido (sin node_modules) a ${LIB_DIR} y la
#     allowlist a ${LOCK_DST}, root:root 0755/0644, y la unidad los usa con /usr/bin/node;
#   - `preflight` FALLA si cualquier ruta que el proxy ejecuta o lee como política (o un
#     directorio padre hasta /) no es de root o es escribible por grupo/otros, si la unidad
#     invoca otra cosa (npx/tsx, WorkingDirectory u otra ruta en /opt) o si el entorno
#     apunta la allowlist fuera de la copia de root. `validate` lo incluye.
# Modo árbol de pruebas (SÓLO tests): S9PX_ROOT=<dir> antepone <dir> a todas las rutas del
# host, la cadena de padres termina en <dir> y no se tocan usuarios ni systemd.
set -euo pipefail
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin:/usr/bin:/bin"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${APP_DIR:-/opt/s9-ai-arena}"
R="${S9PX_ROOT:-}"
R="${R%/}"
ETC_DIR="/etc/s9-ai-arena"
ENV_FILE="${ETC_DIR}/docker-proxy.env"
UNIT="s9-docker-proxy.service"
UNIT_DST="/etc/systemd/system/${UNIT}"
UNIT_SRC="${REPO_DIR}/infrastructure/systemd/${UNIT}"
ENV_SRC="${REPO_DIR}/infrastructure/systemd/docker-proxy.env.example"
PROXY_USER="s9proxy"
FIREWALL_BIN="/usr/local/sbin/s9-firewall"
# Artefacto instalado y política (TD-062): rutas de root, fuera del árbol.
NODE_BIN="/usr/bin/node"
LIB_DIR="/usr/local/lib/s9-docker-proxy"
BUNDLE_DST="${LIB_DIR}/docker-proxy.mjs"
BUNDLE_SUM="${LIB_DIR}/docker-proxy.mjs.sha256"
POLICY_DIR="/etc/s9-docker-proxy"
LOCK_DST="${POLICY_DIR}/DIGESTS.lock"
# B1: copia de ROOT de este mismo script, instalada por `install`; validate/preflight y
# TD-057 usan SÓLO esta (como /usr/local/sbin/s9-firewall).
PREFLIGHT_DST="/usr/local/sbin/s9-docker-proxy-preflight"
BACKUP_ROOT="/var/lib/s9-docker-proxy/backup"
EXPECTED_EXECSTART="${NODE_BIN} --no-addons ${BUNDLE_DST}"
BUNDLE_SRC="${S9PX_BUNDLE_SRC:-${REPO_DIR}/dist/s9-docker-proxy/docker-proxy.mjs}"
LOCK_SRC="${S9PX_LOCK_SRC:-${REPO_DIR}/runtimes/DIGESTS.lock}"
# PATH por defecto de los servicios de systemd: el ExecStartPre resuelve ahí sh, ip, grep y
# sleep, así que un directorio escribible de la lista permitiría plantar un binario.
SERVICE_PATH_DIRS=(/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin)
# Árbol que el proceso del proxy NO debe ver (InaccessiblePaths); en CI, el checkout.
TREE_DIR="${S9PX_TREE:-$APP_DIR}"

need_root() { [ "$(id -u)" = "0" ] || { echo "Ejecuta con sudo/root."; exit 1; }; }

# ------------------------------------------------------------- check-env ----

declare -A CFG=()

parse_env() { # fichero → CFG (sin ejecutar nada)
  local f="$1" line key val
  [ -r "$f" ] || { echo "check-env: no se puede leer $f" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then val="${val:1:${#val}-2}"; fi
    CFG[$key]="$val"
  done <"$f"
}

ip2int() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  echo $(((a << 24) | (b << 16) | (c << 8) | d))
}

is_ipv4() {
  local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$' o
  [[ "$1" =~ $re ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
}

in_cidr() { # ip cidr
  local net="${2%/*}" pfx="${2#*/}" mask
  mask=$(((0xFFFFFFFF << (32 - pfx)) & 0xFFFFFFFF))
  [ $(($(ip2int "$1") & mask)) -eq $(($(ip2int "$net") & mask)) ]
}

# DIGESTS.lock válido para el proxy: toda línea útil con 3 columnas y la 3ª una imagen por
# digest completo; al menos una. Misma regla que parseImageAllowlist (docker-proxy.ts).
lock_check() {
  awk '
    { sub(/#.*/, ""); gsub(/^[ \t]+|[ \t]+$/, "") }
    $0 == "" { next }
    NF != 3 || $3 !~ /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/ { bad++; next }
    { ok++ }
    END { exit (bad == 0 && ok >= 1) ? 0 : 1 }
  ' "$1"
}

check_env() {
  local f="${1:-${R}${ENV_FILE}}" errs=0 v c k
  CFG=()
  parse_env "$f" || return 1
  err() { echo "check-env: ERROR: $*" >&2; errs=$((errs + 1)); }

  # --- bind ---
  v="${CFG[DOCKER_PROXY_BIND]:-}"
  if [ -z "$v" ]; then
    err "DOCKER_PROXY_BIND vacío (no hay valor por defecto seguro)"
  elif ! is_ipv4 "$v"; then
    err "DOCKER_PROXY_BIND debe ser una IPv4 concreta (no '$v')"
  elif [ "$v" = 0.0.0.0 ] || in_cidr "$v" 127.0.0.0/8; then
    err "DOCKER_PROXY_BIND=$v prohibido (comodín o loopback)"
  elif in_cidr "$v" 172.17.0.0/16; then
    err "DOCKER_PROXY_BIND=$v está en el pool de docker0/host-gateway (prohibido)"
  elif ip -4 -o addr show dev docker0 2>/dev/null | grep -qF " $v/"; then
    err "DOCKER_PROXY_BIND=$v es una IP de docker0 (prohibido)"
  fi
  local bind="$v"

  # --- puerto ---
  v="${CFG[DOCKER_PROXY_PORT]:-}"
  [[ "$v" =~ ^[0-9]{1,5}$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 65535 ] || err "DOCKER_PROXY_PORT inválido: '$v'"

  # --- bridge ---
  v="${CFG[DOCKER_PROXY_BRIDGE]:-s9-botctl0}"
  case "$v" in docker0 | lo | "") err "DOCKER_PROXY_BRIDGE=$v prohibido" ;; esac
  [[ "$v" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || err "DOCKER_PROXY_BRIDGE inválido: '$v'"
  v="${CFG[DOCKER_PROXY_BRIDGE_WAIT]:-60}"
  [[ "$v" =~ ^[0-9]{1,2}$ ]] && [ "$v" -le 80 ] || err "DOCKER_PROXY_BRIDGE_WAIT debe ser 0..80 (TimeoutStartSec=180)"

  # --- clientes admitidos ---
  v="${CFG[DOCKER_PROXY_ALLOWED_CLIENTS]:-}"
  if [ -z "$v" ]; then
    err "DOCKER_PROXY_ALLOWED_CLIENTS vacío (contrato: 10.89.250.0/24)"
  else
    local inside=0
    IFS=',' read -r -a _cl <<<"$v"
    for c in "${_cl[@]}"; do
      c="${c// /}"
      if ! { [[ "$c" == */* ]] && is_ipv4 "${c%/*}" && [[ "${c#*/}" =~ ^[0-9]{1,2}$ ]] && [ "${c#*/}" -le 32 ]; }; then
        err "CIDR inválido en DOCKER_PROXY_ALLOWED_CLIENTS: '$c'"
      elif [ "${c#*/}" -lt 16 ]; then
        err "CIDR demasiado ancho en DOCKER_PROXY_ALLOWED_CLIENTS: '$c' (mínimo /16)"
      elif is_ipv4 "$bind" && in_cidr "$bind" "$c"; then
        inside=1
      fi
    done
    # (Un bind que no es IPv4 ya se ha rechazado arriba: no se cuenta dos veces.)
    if is_ipv4 "$bind" && [ "$inside" != 1 ]; then
      err "DOCKER_PROXY_BIND ($bind) no pertenece a DOCKER_PROXY_ALLOWED_CLIENTS ($v): el bind debe ser el gateway de esa subred"
    fi
  fi

  # --- clientes excluidos (opcional; prevalecen sobre los admitidos) ---
  v="${CFG[DOCKER_PROXY_DENIED_CLIENTS]:-}"
  if [ -n "$v" ]; then
    IFS=',' read -r -a _dl <<<"$v"
    for c in "${_dl[@]}"; do
      c="${c// /}"
      if [[ "$c" == */* ]]; then
        if ! { is_ipv4 "${c%/*}" && [[ "${c#*/}" =~ ^[0-9]{1,2}$ ]] && [ "${c#*/}" -le 32 ]; } &&
          ! [[ "$c" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]]; then
          err "CIDR inválido en DOCKER_PROXY_DENIED_CLIENTS: '$c'"
        elif [ "${c#*/}" = 0 ]; then
          err "DOCKER_PROXY_DENIED_CLIENTS no admite /0: '$c'"
        fi
      elif ! is_ipv4 "$c" && ! [[ "$c" =~ ^[0-9A-Fa-f:]*:[0-9A-Fa-f:]*$ ]]; then
        err "entrada inválida en DOCKER_PROXY_DENIED_CLIENTS: '$c'"
      fi
    done
  fi

  # --- allowlist de imágenes ---
  # TD-062: OBLIGATORIA y explícita. Nunca se deduce del árbol de despliegue (/opt), que no
  # es autoridad del proxy. En producción es la copia de root ${LOCK_DST} (la exige
  # `preflight`); aquí se validan su forma y su contenido. Se lee bajo S9PX_ROOT.
  v="${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}"
  if [ -z "$v" ]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST vacía: es obligatoria (producción: ${LOCK_DST})"
  elif [[ "$v" != /* ]]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST debe ser una ruta absoluta: '$v'"
  elif [ ! -r "${R}${v}" ]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST no existe o no se puede leer: ${R}${v}"
  elif ! lock_check "${R}${v}"; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST (${R}${v}) no contiene ninguna imagen de runtime por digest en la 3ª columna (o tiene líneas inválidas)"
  fi

  # --- variables que inyectarían código en node o en el enlazador (TD-062) ---
  for k in "${!CFG[@]}"; do
    case "$k" in
      NODE_* | LD_*) err "variable prohibida en el entorno del proxy: $k (inyección de código en node/ld.so)" ;;
      DOCKER_PROXY_INSECURE_BIND_FOR_TESTS) err "DOCKER_PROXY_INSECURE_BIND_FOR_TESTS es SÓLO para tests: prohibida en el entorno instalado" ;;
    esac
  done

  # --- instancia (label s9.proxy.instance) ---
  v="${CFG[DOCKER_PROXY_INSTANCE]:-s9-docker-proxy}"
  [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || err "DOCKER_PROXY_INSTANCE inválido: '$v'"

  # --- red y usuario del sandbox ---
  [ "${CFG[ARENA_NETWORK]:-}" = arena ] || err "ARENA_NETWORK debe ser exactamente 'arena' (compliance.mjs)"
  v="${CFG[SANDBOX_USER]:-}"
  if [[ "$v" =~ ^([0-9]+):([0-9]+)$ ]]; then
    [ "${BASH_REMATCH[1]}" != 0 ] && [ "${BASH_REMATCH[2]}" != 0 ] || err "SANDBOX_USER no puede ser root ($v)"
  else
    err "SANDBOX_USER debe ser uid:gid numérico ('$v')"
  fi

  if [ "$errs" -gt 0 ]; then
    echo "check-env: $f NO conforme ($errs error/es)" >&2
    return 1
  fi
  echo "check-env: $f conforme (bind ${CFG[DOCKER_PROXY_BIND]}:${CFG[DOCKER_PROXY_PORT]} en ${CFG[DOCKER_PROXY_BRIDGE]:-s9-botctl0})"
}

# ------------------------------------------------------- install/validate ----

# Sonda /_ping (sin root). rc=0 si la respuesta es una de las esperadas, rc=1 si no.
probe_ping() {
  local bind="$1" port="$2" body code
  command -v curl >/dev/null || { echo "curl no disponible: se omite la sonda"; return 0; }
  body="$(curl -sS --max-time "${PROBE_TIMEOUT:-3}" -o - -w '\n%{http_code}' "http://${bind}:${port}/_ping" 2>/dev/null || true)"
  code="${body##*$'\n'}"
  case "$code:$body" in
    403:*"endpoint fuera de la allowlist"*) echo "PING=ENDPOINT_DENIED proxy vivo: 403 por allowlist de endpoints (origen admitido)" ;;
    403:*"cliente no autorizado"*) echo "PING=CLIENT_DENIED proxy vivo: 403 del control de cliente (origen rechazado)" ;;
    000:* | :*) echo "PING=NO_RESPONSE sin respuesta (esperado con el firewall de host aplicado: descarta loopback)" ;;
    *) echo "PING=UNEXPECTED respuesta inesperada (http ${code})"; return 1 ;;
  esac
}

# ------------------------------------------------------------ preflight ----
# TD-062 · S8. Comprueba la FRONTERA DE PRIVILEGIO del proxy. Cada fallo es una línea
# «preflight: ROJO: …» y el rc final es 1 si hay alguno. Con --static no consulta systemd ni
# el proceso en marcha (lo usa `install` antes de reiniciar).
PF_ERRS=0
pf_err() { echo "preflight: ROJO: $*" >&2; PF_ERRS=$((PF_ERRS + 1)); }
pf_ok() { echo "preflight: ok: $*"; }

# Un nodo del sistema de ficheros: de root (uid 0), sin escritura de grupo ni de otros
# (los bits de un enlace simbólico no significan nada; su destino se comprueba aparte) y
# sin ACL (un `+` en `ls -ld`: permisos que el modo no muestra).
declare -A PF_SEEN=()
pf_node() {
  local p="$1" label="$2" uid gid mode typ perm lsf
  # Cada nodo se juzga una vez (los padres comunes no repiten el mismo fallo).
  [ -n "${PF_SEEN[$p]:-}" ] && return
  PF_SEEN[$p]=1
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then
    pf_err "$label: no existe: $p"
    return
  fi
  read -r uid gid mode typ < <(stat -c '%u %g %a %F' -- "$p")
  perm=$((8#$mode))
  [ "$uid" = 0 ] || pf_err "$label: $p es propiedad de uid=$uid (debe ser root)"
  if [ "$typ" != "symbolic link" ] && [ $((perm & 8#022)) -ne 0 ]; then
    pf_err "$label: $p es escribible por grupo u otros (modo $mode, gid=$gid)"
  fi
  lsf="$(ls -ld -- "$p" | awk '{print $1}')"
  [ "${lsf:10:1}" != "+" ] || pf_err "$label: $p tiene ACL (permisos fuera del modo)"
}

# La ruta y TODOS sus padres hasta / (o hasta S9PX_ROOT en el árbol de pruebas): un padre
# escribible permite renombrar/sustituir lo de dentro. Si la ruta pasa por un enlace (la hoja
# o CUALQUIER componente intermedio, p. ej. /usr/local/lib → otro sitio), también la cadena
# de la ruta REAL: el enlace es de root, pero el directorio al que apunta puede no serlo
# (REVIEW PR #167).
pf_chain() {
  local path="$1" label="$2" p top="${R:-/}" real
  p="$path"
  while :; do
    pf_node "$p" "$label"
    [ "$p" = "$top" ] || [ "$p" = "/" ] && break
    p="$(dirname -- "$p")"
  done
  real="$(readlink -f -- "$path" 2>/dev/null || true)"
  if [ -n "$real" ] && [ "$real" != "$path" ]; then
    pf_chain "$real" "$label (destino de $path)"
  fi
}

# Valores de una clave de la sección [Service] de un fichero de unidad (continuaciones `\` unidas).
unit_values() {
  awk -v want="$2" '
    /\\$/ { buf = buf substr($0, 1, length($0) - 1) " "; next }
    {
      line = buf $0; buf = ""
      sub(/^[ \t]+/, "", line)
      if (line == "" || line ~ /^[#;]/) next
      if (line ~ /^\[.*\]$/) { sec = line; next }
      if (sec != "[Service]") next
      i = index(line, "="); if (i == 0) next
      k = substr(line, 1, i - 1); v = substr(line, i + 1)
      gsub(/[ \t]+$/, "", k); sub(/^[ \t]+/, "", v); gsub(/[ \t]+$/, "", v)
      if (k == want) print v
    }' "$1"
}

pf_unit_file() {
  local u="$1" v n
  echo "==> unidad ${u}"
  v="$(unit_values "$u" ExecStart | tr -s ' ')"
  n="$(unit_values "$u" ExecStart | grep -c . || true)"
  if [ "$n" != 1 ] || [ "$v" != "$EXPECTED_EXECSTART" ]; then
    pf_err "ExecStart debe ser exactamente «${EXPECTED_EXECSTART}» (hay ${n}: «${v}»)"
  else
    pf_ok "ExecStart = artefacto instalado"
  fi
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    [[ "$v" == "/bin/sh -ec '"* ]] || pf_err "ExecStartPre no es el guardián /bin/sh -ec del repo: «${v:0:60}…»"
  done < <(unit_values "$u" ExecStartPre)
  v="$(unit_values "$u" WorkingDirectory | tail -1)"
  case "$v" in "" | /) ;; *) pf_err "WorkingDirectory=${v}: el proxy no se ejecuta desde un árbol (sólo vacío o /)" ;; esac
  v="$(unit_values "$u" EnvironmentFile)"
  [ "$v" = "$ENV_FILE" ] || pf_err "EnvironmentFile debe ser exactamente ${ENV_FILE} (hay «${v}»)"
  [ "$(unit_values "$u" User | tail -1)" = "$PROXY_USER" ] || pf_err "User debe ser ${PROXY_USER}"
  [ "$(unit_values "$u" NoNewPrivileges | tail -1)" = true ] || pf_err "NoNewPrivileges=true ausente"
  unit_values "$u" InaccessiblePaths | tr ' ' '\n' | grep -qxE -- "-?${APP_DIR}" ||
    pf_err "InaccessiblePaths no incluye el árbol de despliegue ${APP_DIR}"
  # Ninguna ejecución, directorio, entorno ni montaje puede apuntar al árbol, a npx o a tsx.
  local key
  for key in ExecStart ExecStartPre ExecStartPost ExecStop ExecStopPost ExecReload ExecCondition \
    WorkingDirectory RootDirectory EnvironmentFile Environment BindPaths BindReadOnlyPaths ReadWritePaths; do
    while IFS= read -r v; do
      [ -z "$v" ] && continue
      if [[ "$v" == *"${APP_DIR}"* || "$v" == *"/opt/"* ]]; then pf_err "${key} apunta al árbol de despliegue: «${v:0:80}»"; fi
      if [[ " $v " =~ [[:space:]/](npx|tsx)[[:space:]] || "$v" == *node_modules* ]]; then
        pf_err "${key} invoca npx/tsx/node_modules: «${v:0:80}»"
      fi
      if [ "$key" = Environment ] && [[ "$v" =~ (^|[[:space:]\"])(NODE_|LD_) ]]; then pf_err "Environment= fija NODE_*/LD_*: «${v:0:80}»"; fi
      if [ "$key" = Environment ] && [[ "$v" =~ (^|[[:space:]\"])(DOCKER_PROXY_INSECURE_BIND_FOR_TESTS|S9PX_[A-Z_]*)= ]]; then
        pf_err "Environment= fija una variable de tests (${BASH_REMATCH[2]}): prohibida en la unidad instalada"
      fi
    done < <(unit_values "$u" "$key")
  done
}

# Unidades del firewall (también corren como root: misma regla). Sólo si están instaladas.
pf_firewall() {
  local f v found=0
  for f in s9-firewall.service s9-firewall-reassert.service s9-firewall-reassert.timer; do
    [ -e "${R}/etc/systemd/system/$f" ] || continue
    found=1
    pf_chain "${R}/etc/systemd/system/$f" "unidad $f"
    while IFS= read -r v; do
      [ -z "$v" ] && continue
      [[ "$v" == "${FIREWALL_BIN} "* || "$v" == "$FIREWALL_BIN" ]] || pf_err "$f ejecuta algo que no es ${FIREWALL_BIN}: «${v:0:80}»"
    done < <(unit_values "${R}/etc/systemd/system/$f" ExecStart; unit_values "${R}/etc/systemd/system/$f" ExecReload)
  done
  if [ "$found" = 1 ]; then
    pf_chain "${R}${FIREWALL_BIN}" "firewall (ejecutado como root)"
    [ -e "${R}${ETC_DIR}/firewall.env" ] && pf_chain "${R}${ETC_DIR}/firewall.env" "config del firewall"
  else
    echo "preflight: AVISO: unidades del firewall no instaladas (capa b ausente; docs/operations/firewall.md)"
  fi
}

# Lo EFECTIVO (no el fichero): lo que systemd tiene cargado y el proceso en marcha.
pf_effective() {
  echo "==> efectivo (systemd y proceso)"
  local show k v pid exe cmd
  show="$(systemctl show "$UNIT" -p FragmentPath -p DropInPaths -p NeedDaemonReload -p User -p WorkingDirectory \
    -p EnvironmentFiles -p ExecStart -p MainPID -p ActiveState --no-pager 2>&1)" || { pf_err "systemctl show falló: $show"; return; }
  declare -A S=()
  while IFS= read -r v; do k="${v%%=*}"; S[$k]="${v#*=}"; done <<<"$show"
  [ "${S[FragmentPath]:-}" = "$UNIT_DST" ] || pf_err "unidad cargada desde «${S[FragmentPath]:-}» (debe ser ${UNIT_DST})"
  [ -z "${S[DropInPaths]:-}" ] || pf_err "drop-ins cargados: ${S[DropInPaths]}"
  [ "${S[NeedDaemonReload]:-}" = no ] || pf_err "NeedDaemonReload=${S[NeedDaemonReload]:-?}: lo cargado no es lo que hay en disco"
  [ "${S[User]:-}" = "$PROXY_USER" ] || pf_err "User efectivo=${S[User]:-}"
  case "${S[WorkingDirectory]:-}" in "" | /) ;; *) pf_err "WorkingDirectory efectivo=${S[WorkingDirectory]}" ;; esac
  [[ "${S[EnvironmentFiles]:-}" == "${ENV_FILE} "* ]] || pf_err "EnvironmentFiles efectivo=«${S[EnvironmentFiles]:-}»"
  v="$(sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' <<<"${S[ExecStart]:-}" | tr -s ' ' | sed 's/ $//')"
  [ "$v" = "$EXPECTED_EXECSTART" ] || pf_err "ExecStart efectivo=«${v}»"
  pid="${S[MainPID]:-0}"
  if [ "${S[ActiveState]:-}" != active ] || [ "$pid" = 0 ]; then
    pf_err "el proxy no está activo (ActiveState=${S[ActiveState]:-?}, MainPID=${pid})"
    return
  fi
  exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
  [ "$exe" = "$(readlink -f "$NODE_BIN")" ] || pf_err "el proceso $pid ejecuta «${exe}» (debe ser $(readlink -f "$NODE_BIN"))"
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | sed 's/ $//')"
  [ "$cmd" = "$EXPECTED_EXECSTART" ] || pf_err "línea de órdenes del proceso $pid: «${cmd}»"
  # El árbol de despliegue NO es visible para el proceso (InaccessiblePaths/ProtectHome).
  if command -v nsenter >/dev/null; then
    if nsenter -t "$pid" -m -- sh -c "[ -n \"\$(ls -A '$TREE_DIR' 2>/dev/null)\" ]" 2>/dev/null; then
      pf_err "el proceso $pid VE el contenido de ${TREE_DIR} (debe ser inaccesible)"
    else
      pf_ok "el proceso no ve ${TREE_DIR}"
    fi
  fi
  pf_ok "proceso ${pid}: ${cmd}"
}

preflight() {
  local static=0
  [ "${1:-}" = --static ] && static=1
  PF_ERRS=0
  PF_SEEN=()
  [ -n "$R" ] && echo "preflight: ÁRBOL DE PRUEBAS ${R} (no es el host)"

  echo "==> código y su intérprete (ejecutados con el grupo docker)"
  pf_chain "${R}${NODE_BIN}" "node"
  pf_chain "${R}${BUNDLE_DST}" "bundle"
  if [ -L "${R}${BUNDLE_DST}" ] || [ ! -f "${R}${BUNDLE_DST}" ]; then pf_err "bundle: ${BUNDLE_DST} no es un fichero regular"; fi
  pf_chain "${R}${BUNDLE_SUM}" "sha256 del bundle"
  if [ -f "${R}${BUNDLE_DST}" ] && [ -f "${R}${BUNDLE_SUM}" ]; then
    local want got
    want="$(awk '{print $1; exit}' "${R}${BUNDLE_SUM}")"
    got="$(sha256sum "${R}${BUNDLE_DST}" | awk '{print $1}')"
    [ "$want" = "$got" ] && pf_ok "bundle sha256 ${got}" || pf_err "bundle: sha256 ${got} ≠ registrado en la instalación ${want}"
  fi
  pf_chain "${R}/bin/sh" "shell del ExecStartPre"
  # La copia de root de este preflight (la que usan validate y TD-057).
  pf_chain "${R}${PREFLIGHT_DST}" "preflight instalado"
  local d
  for d in "${SERVICE_PATH_DIRS[@]}"; do
    [ -e "${R}${d}" ] && pf_chain "${R}${d}" "PATH del servicio (ip/grep/sleep)"
  done

  echo "==> política (allowlist, entorno, unidad)"
  pf_chain "${R}${LOCK_DST}" "allowlist"
  [ -f "${R}${LOCK_DST}" ] && { lock_check "${R}${LOCK_DST}" && pf_ok "allowlist válida" || pf_err "allowlist: ${LOCK_DST} no es un DIGESTS.lock válido"; }
  if [ -f "${R}${LOCK_DST}" ] && [ -f "${APP_DIR}/runtimes/DIGESTS.lock" ] && ! cmp -s "${R}${LOCK_DST}" "${APP_DIR}/runtimes/DIGESTS.lock"; then
    echo "preflight: AVISO: ${LOCK_DST} difiere de ${APP_DIR}/runtimes/DIGESTS.lock (la autoridad es la copia de root; reinstala para actualizarla)"
  fi
  pf_chain "${R}${ENV_FILE}" "entorno"
  if [ -r "${R}${ENV_FILE}" ]; then
    check_env "${R}${ENV_FILE}" >/dev/null 2>&1 || pf_err "entorno: check-env NO conforme (sudo bash $0 check-env ${ENV_FILE})"
    parse_env "${R}${ENV_FILE}"
    [ "${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}" = "$LOCK_DST" ] ||
      pf_err "entorno: DOCKER_PROXY_IMAGE_ALLOWLIST=«${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}» (debe ser la copia de root ${LOCK_DST})"
  fi
  pf_chain "${R}${UNIT_DST}" "unidad"
  # Drop-ins y fragmentos que systemd FUSIONA con la unidad, también sin systemctl (--static):
  # los de la propia unidad (en /etc, /run, /usr/lib, /usr/local/lib) y los GLOBALES de
  # servicio de /etc y /run (los de /usr/lib/systemd/system/service.d son del paquete de
  # systemd; en modo completo, DropInPaths de systemctl show lista TODOS). REVIEW PR #167.
  local dd
  for dd in "${UNIT_DST}.d" "/run/systemd/system/${UNIT}.d" "/usr/lib/systemd/system/${UNIT}.d" \
    "/usr/local/lib/systemd/system/${UNIT}.d" /etc/systemd/system/service.d /run/systemd/system/service.d; do
    [ -e "${R}${dd}" ] || continue
    pf_chain "${R}${dd}" "drop-ins"
    [ -z "$(ls -A "${R}${dd}" 2>/dev/null)" ] || pf_err "drop-ins presentes en ${dd} (no auditados): $(ls -A "${R}${dd}" | tr '\n' ' ')"
  done
  [ -e "${R}/run/systemd/system/${UNIT}" ] && pf_err "fragmento en /run/systemd/system/${UNIT} (sustituye a la unidad instalada)"
  [ -f "${R}${UNIT_DST}" ] && pf_unit_file "${R}${UNIT_DST}"
  [ -e "${R}/etc/ld.so.preload" ] && pf_chain "${R}/etc/ld.so.preload" "ld.so.preload"

  echo "==> firewall (también root)"
  pf_firewall

  if [ "$static" = 0 ] && [ -z "$R" ]; then
    pf_effective
  fi

  if [ "$PF_ERRS" -gt 0 ]; then
    echo "==> PREFLIGHT ROJO (${PF_ERRS} fallo/s): la frontera de privilegio del proxy NO se cumple (TD-062)" >&2
    return 1
  fi
  echo "==> PREFLIGHT VERDE: lo que el proxy ejecuta y lee como política es de root y no lo escribe nadie más"
}

# --------------------------------------------------------------- install ----

# Copia src → dst con root:root y modo, de forma ATÓMICA (temporal en el mismo directorio +
# rename).
install_file() {
  local src="$1" dst="$2" mode="$3" tmp
  tmp="$(dirname "$dst")/.$(basename "$dst").new.$$"
  install -o root -g root -m 0600 -- "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f -- "$tmp" "$dst"
}

# B1 (REVIEW PR #167) · ancla de confianza. Un script que corre como root y del que depende
# la frontera NO puede venir de un sitio que escriba otro usuario: el árbol de despliegue
# (/opt/s9-ai-arena) es del usuario de despliegue. Esta comprobación aplica la regla de
# preflight (root, sin escritura de grupo/otros, padres hasta /) a la copia que se está
# ejecutando y a lo que va a instalar. AVISO honesto: protege contra el ERROR del operador
# (ejecutar desde /opt), no contra un atacante que ya reescribió esta copia; la confianza la
# da el procedimiento (copia de root obtenida en el SHA revisado; upgrades.md#td-062).
self_check() { # self_check <qué> [rutas a instalar…]
  local what="$1" self
  shift
  self="$(readlink -f -- "${BASH_SOURCE[0]}")"
  PF_ERRS=0
  PF_SEEN=()
  pf_chain "$self" "copia en ejecución"
  local p
  for p in "$@"; do [ -e "$p" ] && pf_chain "$p" "origen de ${what}"; done
  if [ "$PF_ERRS" -gt 0 ]; then
    echo "==> ABORTO (${what}): esta copia o lo que instala NO es sólo de root (${PF_ERRS} fallo/s)." >&2
    echo "    Ejecuta la copia instalada (${PREFLIGHT_DST}) o una copia de root obtenida en el SHA revisado" >&2
    echo "    (docs/operations/upgrades.md#td-062), nunca la del árbol de despliegue." >&2
    exit 2
  fi
}

# Copia de seguridad de lo que `install` va a cambiar (unidad, drop-ins, entorno), root 0700.
backup_state() {
  local dir="${R}${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -o root -g root -m 0700 "${R}${BACKUP_ROOT}" "$dir"
  [ -e "${R}${UNIT_DST}" ] && cp -a -- "${R}${UNIT_DST}" "$dir/unit"
  [ -e "${R}${UNIT_DST}.d" ] && cp -a -- "${R}${UNIT_DST}.d" "$dir/unit.d"
  [ -e "${R}${ENV_FILE}" ] && cp -a -- "${R}${ENV_FILE}" "$dir/env"
  : >"$dir/.complete"
  echo "$dir"
}

# Vuelve al estado de una copia de seguridad (lo que no estaba, se retira).
restore_state() { # restore_state <dir>
  local dir="$1"
  [ -f "$dir/.complete" ] || { echo "==> ${dir} no es una copia de seguridad completa de install" >&2; return 1; }
  if [ -e "$dir/unit" ]; then cp -a -- "$dir/unit" "${R}${UNIT_DST}"; else rm -f -- "${R}${UNIT_DST}"; fi
  rm -rf -- "${R}${UNIT_DST}.d"
  [ -e "$dir/unit.d" ] && cp -a -- "$dir/unit.d" "${R}${UNIT_DST}.d"
  if [ -e "$dir/env" ]; then cp -a -- "$dir/env" "${R}${ENV_FILE}"; fi
  echo "==> restaurado desde ${dir}"
}

# B2 · migración del entorno SIN ventana: sólo cambia DOCKER_PROXY_IMAGE_ALLOWLIST, y sólo
# DESPUÉS de instalar la copia de root de la allowlist (que ya existe cuando el proxy la lea).
migrate_env() {
  local f="${R}${ENV_FILE}" tmp
  tmp="$(dirname "$f")/.$(basename "$f").new.$$"
  install -o root -g root -m 0640 /dev/null "$tmp"
  awk -v v="$LOCK_DST" '
    /^[[:space:]]*DOCKER_PROXY_IMAGE_ALLOWLIST[[:space:]]*=/ { if (!done) print "DOCKER_PROXY_IMAGE_ALLOWLIST=" v; done = 1; next }
    { print }
    END { if (!done) print "DOCKER_PROXY_IMAGE_ALLOWLIST=" v }' "$f" >"$tmp"
  mv -f -- "$tmp" "$f"
  echo "==> ${ENV_FILE}: DOCKER_PROXY_IMAGE_ALLOWLIST=${LOCK_DST} (migrado; copia de seguridad hecha)"
}

install_proxy() {
  need_root
  umask 022
  [ -n "$R" ] && echo "==> MODO ÁRBOL DE PRUEBAS en ${R}: sin usuarios ni systemd"
  self_check install "$UNIT_SRC" "$ENV_SRC" "$LOCK_SRC" "$BUNDLE_SRC"

  echo "==> artefacto: ${BUNDLE_SRC}"
  if [ ! -f "$BUNDLE_SRC" ] || [ -L "$BUNDLE_SRC" ]; then
    echo "==> ABORTO: falta el bundle (constrúyelo en esta copia: build-docker-proxy-bundle.mjs --commit <sha>)" >&2
    exit 1
  fi
  # S9PX_EXPECT_SHA256 es OBLIGATORIO. Sólo tiene valor porque lo compara una copia de root
  # (self_check): es el sha256 publicado por la CI de main para el SHA revisado, una medida
  # INDEPENDIENTE de este build. Ejecutado desde una copia escribible por otro no valdría nada.
  if ! [[ "${S9PX_EXPECT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "==> ABORTO: falta S9PX_EXPECT_SHA256 (sha256 del bundle publicado por la CI para el SHA revisado)" >&2
    exit 1
  fi
  lock_check "$LOCK_SRC" || { echo "==> ABORTO: ${LOCK_SRC} no es un DIGESTS.lock válido" >&2; exit 1; }

  install -d -o root -g root -m 0755 "${R}${LIB_DIR}" "${R}${POLICY_DIR}" "${R}${ETC_DIR}" \
    "${R}$(dirname "$UNIT_DST")" "${R}$(dirname "$PREFLIGHT_DST")"
  local stage="${R}${LIB_DIR}/.stage.$$" sum
  install -o root -g root -m 0600 -- "$BUNDLE_SRC" "$stage"
  sum="$(sha256sum "$stage" | awk '{print $1}')"
  if [ "$S9PX_EXPECT_SHA256" != "$sum" ]; then
    rm -f "$stage"
    echo "==> ABORTO: sha256 del bundle ${sum} ≠ S9PX_EXPECT_SHA256 (${S9PX_EXPECT_SHA256}). PARA: no instales." >&2
    exit 1
  fi
  echo "==> sha256 del bundle = el esperado (${sum})"

  local bak
  bak="$(backup_state)"
  echo "==> copia de seguridad de unidad y entorno: ${bak}"

  chmod 0644 "$stage"
  mv -f -- "$stage" "${R}${BUNDLE_DST}"
  printf '%s  %s\n' "$sum" "$(basename "$BUNDLE_DST")" >"${R}${LIB_DIR}/.sum.$$"
  install_file "${R}${LIB_DIR}/.sum.$$" "${R}${BUNDLE_SUM}" 0644
  rm -f "${R}${LIB_DIR}/.sum.$$"
  echo "==> bundle instalado: ${BUNDLE_DST} (root:root 0644, sha256 ${sum})"

  echo "==> allowlist: ${LOCK_SRC} → ${LOCK_DST}"
  local lstage="${R}${POLICY_DIR}/.stage.$$"
  install -o root -g root -m 0600 -- "$LOCK_SRC" "$lstage"
  lock_check "$lstage" || { rm -f "$lstage"; echo "==> ABORTO: la copia de la allowlist no es válida" >&2; exit 1; }
  chmod 0644 "$lstage"
  mv -f -- "$lstage" "${R}${LOCK_DST}"
  echo "==> allowlist instalada (root:root 0644, sha256 $(sha256sum "${R}${LOCK_DST}" | awk '{print $1}'))"

  # El preflight se instala como root: validate/preflight/TD-057 usan SÓLO esta copia.
  install_file "${BASH_SOURCE[0]}" "${R}${PREFLIGHT_DST}" 0755
  echo "==> preflight instalado: ${PREFLIGHT_DST} (root:root 0755)"

  echo "==> config en ${ENV_FILE} (no se sobrescribe si existe)"
  [ -f "${R}${ENV_FILE}" ] || install -o root -g root -m 0640 "$ENV_SRC" "${R}${ENV_FILE}"
  parse_env "${R}${ENV_FILE}"
  if [ "${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}" != "$LOCK_DST" ]; then
    if [ "${S9PX_MIGRATE_ENV:-}" = 1 ]; then
      migrate_env
    else
      echo "==> ABORTO: ${ENV_FILE} tiene DOCKER_PROXY_IMAGE_ALLOWLIST=«${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}»;" >&2
      echo "    debe ser ${LOCK_DST}. Repite con S9PX_MIGRATE_ENV=1 (sólo cambia esa línea). Unidad sin tocar." >&2
      exit 1
    fi
  fi
  echo "==> validación de la config ANTES de tocar la unidad"
  if ! check_env "${R}${ENV_FILE}"; then
    restore_state "$bak" >&2
    echo "==> ABORTO: corrige ${ENV_FILE} (referencia: ${ENV_SRC}). Entorno restaurado; unidad sin tocar." >&2
    exit 1
  fi

  echo "==> unidad systemd"
  install_file "$UNIT_SRC" "${R}${UNIT_DST}" 0644

  echo "==> preflight estático (antes de arrancar)"
  if ! preflight --static; then
    restore_state "$bak" >&2
    echo "==> ABORTO: preflight ROJO. Unidad y entorno RESTAURADOS desde ${bak}; el proxy NO se ha reiniciado." >&2
    exit 1
  fi
  if [ -n "$R" ]; then
    echo "==> hecho (árbol de pruebas)."
    return 0
  fi

  echo "==> usuario de servicio '${PROXY_USER}' (sin login, en grupo docker)"
  id -u "$PROXY_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$PROXY_USER"
  usermod -aG docker "$PROXY_USER"
  systemctl daemon-reload
  systemctl enable "$UNIT"
  systemctl restart "$UNIT"
  sleep "${S9PX_SETTLE:-2}"
  echo "==> preflight completo con la copia INSTALADA (${PREFLIGHT_DST})"
  "$PREFLIGHT_DST" preflight || { echo "==> el proxy arrancó pero el PREFLIGHT está ROJO (vuelta atrás: ${PREFLIGHT_DST} restore ${bak})" >&2; exit 1; }
  echo "==> hecho. Copia de seguridad: ${bak}. Comprueba: sudo ${PREFLIGHT_DST} validate"
}

validate_proxy() {
  need_root
  local rc=0
  echo "==> frontera de privilegio (TD-062)"
  preflight || rc=1
  echo "==> configuración"
  check_env "$ENV_FILE" || rc=1
  local bind="${CFG[DOCKER_PROXY_BIND]:-}" port="${CFG[DOCKER_PROXY_PORT]:-2375}" br="${CFG[DOCKER_PROXY_BRIDGE]:-s9-botctl0}"

  echo "==> estado de la unidad"
  systemctl is-active "$UNIT" || { echo "NO activo"; rc=1; }

  echo "==> bridge ${br} con ${bind}"
  if ip -4 -o addr show dev "$br" 2>/dev/null | grep -qF " ${bind}/"; then echo "OK"; else echo "FALLO: ${br} no tiene ${bind}"; rc=1; fi

  echo "==> escucha en :${port} (debe ser EXACTAMENTE ${bind}:${port})"
  local listen
  listen="$(ss -ltnH "sport = :${port}" 2>/dev/null | awk '{print $4}' | sort -u)"
  if [ -z "$listen" ]; then
    echo "FALLO: nadie escucha en :${port}"
    rc=1
  elif [ "$listen" != "${bind}:${port}" ]; then
    echo "FALLO: escuchas en :${port} = $(echo "$listen" | tr '\n' ' ') (se esperaba sólo ${bind}:${port})"
    rc=1
  else
    echo "OK ${listen}"
  fi
  echo "==> sonda /_ping desde el host (informativa; el alcance real se mide desde los contenedores)"
  # Un proceso del host sale con origen = ${bind}, que está DENTRO de la subred admitida.
  # Con el firewall instalado, loopback hacia 2375 se descarta por diseño ⇒ TIMEOUT.
  # Sin firewall, `/_ping` da 403 por la allowlist de ENDPOINTS (proxy vivo); un 403 con
  # «cliente no autorizado» indica que el control de cliente rechazó el origen.
  probe_ping "$bind" "$port" || rc=1

  echo "==> firewall de host (capa b)"
  if [ -x "$FIREWALL_BIN" ]; then
    "$FIREWALL_BIN" check || rc=1
  else
    echo "AVISO: ${FIREWALL_BIN} no instalado: la capa (b) no está aplicada (docs/operations/firewall.md)"
  fi

  echo "==> últimos logs (decisiones JSON)"
  journalctl -u "$UNIT" -n 20 --no-pager || true
  [ "$rc" = 0 ] && echo "==> VALIDACIÓN OK" || echo "==> VALIDACIÓN FALLIDA"
  return "$rc"
}

rollback_proxy() {
  need_root
  echo "==> parando y deshabilitando ${UNIT}"
  systemctl disable --now "$UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/${UNIT}"
  systemctl daemon-reload
  echo "==> unidad retirada. Config, artefacto, allowlist, preflight y usuario se conservan:"
  echo "   rm -rf ${ETC_DIR} ${LIB_DIR} ${POLICY_DIR} ${PREFLIGHT_DST} && userdel ${PROXY_USER}   # opcional, borrado total"
}

# Vuelta atrás de un `install`: unidad, drop-ins y entorno de la copia de seguridad; recarga
# y reinicia. Si la copia es de la unidad de RC1/RC2 (npx tsx desde el árbol), TD-062 vuelve
# a estar abierta: es una medida de EMERGENCIA, no un estado admitido.
restore_proxy() {
  need_root
  local dir="${1:?uso: restore <directorio de copia de seguridad de install>}"
  restore_state "$dir" || exit 1
  [ -n "$R" ] && return 0
  systemctl daemon-reload
  systemctl restart "$UNIT" || true
  if ! "$PREFLIGHT_DST" preflight >/dev/null 2>&1; then
    echo "==> AVISO: tras restaurar, el preflight está ROJO: si es la unidad de RC1/RC2, TD-062 está ABIERTA otra vez" >&2
  fi
}

case "${1:-}" in
  check-env) check_env "${2:-${R}${ENV_FILE}}" ;;
  probe) probe_ping "${2:?bind}" "${3:-2375}" ;;
  install) install_proxy ;;
  preflight)
    need_root
    self_check preflight
    preflight "${2:-}"
    ;;
  validate)
    need_root
    self_check validate
    validate_proxy
    ;;
  rollback) rollback_proxy ;;
  restore) restore_proxy "${2:-}" ;;
  *) echo "Uso: $0 {check-env [fichero]|probe <bind> [puerto]|install|preflight [--static]|validate|rollback|restore <copia>}"; exit 2 ;;
esac
