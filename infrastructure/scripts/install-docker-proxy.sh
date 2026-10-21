#!/usr/bin/env bash
# R-DEPLOY · R2 / RC2 — instala/valida/revierte el proxy de la API de Docker como
# unidad systemd en el HOST. Debe ejecutarse con privilegios (sudo), salvo `check-env`.
#
# ÚNICO proceso autorizado a tocar /var/run/docker.sock (R1.7 · ERR-SEC-02).
# Ningún contenedor del stack monta el socket.
#
# Uso:
#   bash      infrastructure/scripts/install-docker-proxy.sh check-env [fichero]  # sin root
#   sudo bash infrastructure/scripts/install-docker-proxy.sh install
#   sudo bash infrastructure/scripts/install-docker-proxy.sh validate
#   sudo bash infrastructure/scripts/install-docker-proxy.sh rollback
#
# `check-env` valida el fichero de configuración SIN ejecutarlo (se parsea como
# CLAVE=VALOR, nunca se hace `source`): bind del contrato RC2 (nunca 0.0.0.0, ::,
# loopback, docker0 ni host-gateway), clientes admitidos, allowlist de imágenes, red
# `arena` y usuario del sandbox. `install` lo ejecuta ANTES de tocar la unidad: con un
# fichero inválido no se instala nada y el proxy en marcha sigue como estaba.
set -euo pipefail
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin:/usr/bin:/bin"

APP_DIR="${APP_DIR:-/opt/s9-ai-arena}"
ETC_DIR="/etc/s9-ai-arena"
ENV_FILE="${ETC_DIR}/docker-proxy.env"
UNIT="s9-docker-proxy.service"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/${UNIT}"
ENV_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/docker-proxy.env.example"
PROXY_USER="s9proxy"
FIREWALL_BIN="/usr/local/sbin/s9-firewall"

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

check_env() {
  local f="${1:-$ENV_FILE}" errs=0 v c
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
    is_ipv4 "$bind" && [ "$inside" = 1 ] || err "DOCKER_PROXY_BIND ($bind) no pertenece a DOCKER_PROXY_ALLOWED_CLIENTS ($v): el bind debe ser el gateway de esa subred"
  fi

  # --- allowlist de imágenes ---
  v="${CFG[DOCKER_PROXY_IMAGE_ALLOWLIST]:-}"
  if [ -z "$v" ]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST vacío (contrato: ruta a runtimes/DIGESTS.lock)"
  elif [[ "$v" != /* ]]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST debe ser una ruta absoluta: '$v'"
  elif [ ! -r "$v" ]; then
    err "DOCKER_PROXY_IMAGE_ALLOWLIST no existe o no se puede leer: $v"
  else
    local n
    n="$(awk '!/^[[:space:]]*(#|$)/ && NF>=3 && $3 ~ /^[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/ {c++} END {print c+0}' "$v")"
    [ "$n" -ge 1 ] || err "DOCKER_PROXY_IMAGE_ALLOWLIST ($v) no contiene ninguna imagen de runtime por digest en la 3ª columna"
  fi

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

install_proxy() {
  need_root
  echo "==> config en ${ENV_FILE} (no se sobrescribe si existe)"
  mkdir -p "$ETC_DIR"
  [ -f "$ENV_FILE" ] || install -o root -g root -m 0640 "$ENV_SRC" "$ENV_FILE"
  echo "==> validación de la config ANTES de tocar la unidad"
  if ! check_env "$ENV_FILE"; then
    echo "==> ABORTO: corrige ${ENV_FILE} (referencia: ${ENV_SRC}). No se ha cambiado la unidad."
    exit 1
  fi

  echo "==> usuario de servicio '${PROXY_USER}' (sin login, en grupo docker)"
  id -u "$PROXY_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$PROXY_USER"
  usermod -aG docker "$PROXY_USER"

  echo "==> unidad systemd"
  install -m 0644 "$UNIT_SRC" "/etc/systemd/system/${UNIT}"
  systemctl daemon-reload
  systemctl enable "$UNIT"
  systemctl restart "$UNIT"
  echo "==> hecho. Comprueba: sudo bash $0 validate"
}

validate_proxy() {
  need_root
  local rc=0
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
  # No se hace `curl` desde el host: el firewall (capa b) DESCARTA también loopback hacia
  # 2375 por diseño. El alcance real se mide desde los contenedores (sonda de red).

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
  echo "==> unidad retirada. Config y usuario se conservan:"
  echo "   rm -rf ${ETC_DIR} && userdel ${PROXY_USER}   # opcional, borrado total"
}

case "${1:-}" in
  check-env) check_env "${2:-$ENV_FILE}" ;;
  install) install_proxy ;;
  validate) validate_proxy ;;
  rollback) rollback_proxy ;;
  *) echo "Uso: $0 {check-env [fichero]|install|validate|rollback}"; exit 2 ;;
esac
