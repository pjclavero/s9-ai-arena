#!/usr/bin/env bash
# RC2 · DEV-SECOPS — firewall del HOST como código (TD-053).
#
# Capa (b) de la defensa en profundidad del s9-docker-proxy (docs/operations/firewall.md):
#   1. El puerto del proxy (2375) sólo se acepta si el paquete ENTRA por el bridge dedicado
#      `s9-botctl0`, con origen en 10.89.250.0/24 y destino la IP del proxy (10.89.250.1).
#      Cualquier otro origen (docker0, otras redes de Docker, LAN, Tailscale, loopback) ⇒ DROP.
#      La comprobación de interfaz de entrada (`-i`) es la que importa: una IP de origen se
#      puede falsificar desde cualquier contenedor; la interfaz por la que entra, no.
#   2. Desde los bridges de Docker (redes internas incluidas, y por tanto los BOTS) no se
#      alcanza el sshd del host por la IP del bridge ⇒ DROP. El sshd sigue accesible por la
#      LAN y por Tailscale (no se toca ningún otro origen).
#
# Diseño (contrato RC2, COMMON-RC2.md):
#   - Sólo iptables (Docker 29 con backend iptables; nftables del sistema DESHABILITADO).
#   - Una cadena PROPIA (`S9-HOST-GUARD`) enganchada como PRIMERA regla de INPUT, delante
#     de `ts-input` de Tailscale (que ACEPTA todo lo que entra por tailscale0).
#   - En caliente e idempotente: nunca `nft flush`, nunca recargar ficheros, nunca tocar las
#     cadenas de Docker ni de Tailscale, nunca borrar reglas por NÚMERO (otro actor puede
#     insertar a la vez y se borraría una regla ajena). Sólo se borran reglas propias por
#     especificación.
#   - Sin ventana abierta: al reconstruir, una cadena nueva protege INPUT antes de retirar
#     la vieja.
#
# Uso (root):
#   s9-firewall.sh apply    # instala o corrige (idempotente). rc=0
#   s9-firewall.sh check    # rc=0 conforme, rc=1 deriva (lo explica por stdout)
#   s9-firewall.sh remove   # retira SÓLO lo propio. rc=0
#   s9-firewall.sh print    # reglas deseadas, sin tocar nada (no requiere root)
#   s9-firewall.sh install  # copia a /usr/local/sbin y habilita las unidades systemd
#   s9-firewall.sh uninstall
#
# Configuración (opcional): /etc/s9-ai-arena/firewall.env (ver firewall.env.example) o
# variables S9FW_* en el entorno. Los valores por defecto son las constantes del contrato.
#
# Códigos de salida: 0 ok · 1 deriva (check) · 2 configuración inválida · 3 entorno
# (sin root, sin iptables).
set -euo pipefail
# Los directorios del sistema van al FINAL: el arnés de pruebas intercepta iptables/nft
# con un shim delante en el PATH (y así se demuestra que nunca se invoca `nft`).
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin:/usr/bin:/bin"

CONF_FILE="${S9FW_CONF:-/etc/s9-ai-arena/firewall.env}"
if [ -r "$CONF_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONF_FILE"
fi

S9FW_BRIDGE="${S9FW_BRIDGE:-s9-botctl0}"
S9FW_SUBNET="${S9FW_SUBNET:-10.89.250.0/24}"
S9FW_PROXY_IP="${S9FW_PROXY_IP:-10.89.250.1}"
S9FW_PROXY_PORT="${S9FW_PROXY_PORT:-2375}"
S9FW_SSH_PORTS="${S9FW_SSH_PORTS:-22}"
S9FW_SSH_BLOCK_IFACES="${S9FW_SSH_BLOCK_IFACES:-br-+ docker0 s9-botctl0}"
S9FW_IPV6="${S9FW_IPV6:-auto}"

CHAIN="S9-HOST-GUARD"
CHAIN_NEW="S9-HOST-GUARD-NEW"
JUMP_TAG="s9-host-guard"
TMP_TAG="s9-host-guard-tmp"

SBIN_DST="/usr/local/sbin/s9-firewall"
UNIT_DIR="/etc/systemd/system"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC_DIR="$(cd "${SELF_DIR}/.." 2>/dev/null && pwd)/systemd"
UNITS=(s9-firewall.service s9-firewall-reassert.service s9-firewall-reassert.timer)

die() { echo "s9-firewall: $2" >&2; exit "$1"; }
log() { echo "s9-firewall: $*"; }

# ---------------------------------------------------------------- validación ----

ip2int() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  echo $(((a << 24) | (b << 16) | (c << 8) | d))
}

is_ipv4() {
  local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$'
  [[ "$1" =~ $re ]] || return 1
  local o
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
}

is_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Nombre de interfaz de Linux (IFNAMSIZ=16 ⇒ 15 caracteres). `+` sólo como comodín final.
is_ifname() { [[ "$1" =~ ^[A-Za-z0-9_.-]{1,14}\+?$ ]] || [[ "$1" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; }

validate_config() {
  is_ifname "$S9FW_BRIDGE" && [[ "$S9FW_BRIDGE" != *+ ]] || die 2 "S9FW_BRIDGE inválido: '$S9FW_BRIDGE'"
  [ "$S9FW_BRIDGE" != "docker0" ] || die 2 "S9FW_BRIDGE no puede ser docker0 (contrato: bridge dedicado)"
  [ "$S9FW_BRIDGE" != "lo" ] || die 2 "S9FW_BRIDGE no puede ser lo"

  local net="${S9FW_SUBNET%/*}" pfx="${S9FW_SUBNET#*/}"
  [ "$net" != "$S9FW_SUBNET" ] || die 2 "S9FW_SUBNET debe ser CIDR: '$S9FW_SUBNET'"
  is_ipv4 "$net" && [[ "$pfx" =~ ^[0-9]{1,2}$ ]] || die 2 "S9FW_SUBNET inválido: '$S9FW_SUBNET'"
  # /16 como mínimo: una subred más ancha (p. ej. 0.0.0.0/0) anularía la regla.
  [ "$pfx" -ge 16 ] && [ "$pfx" -le 30 ] || die 2 "S9FW_SUBNET con prefijo fuera de /16../30: '$S9FW_SUBNET'"
  local mask=$(((0xFFFFFFFF << (32 - pfx)) & 0xFFFFFFFF))
  local ni
  ni=$(ip2int "$net")
  [ $((ni & mask)) -eq "$ni" ] || die 2 "S9FW_SUBNET no es una dirección de red: '$S9FW_SUBNET'"

  is_ipv4 "$S9FW_PROXY_IP" || die 2 "S9FW_PROXY_IP inválido: '$S9FW_PROXY_IP'"
  [ $(($(ip2int "$S9FW_PROXY_IP") & mask)) -eq "$ni" ] || die 2 "S9FW_PROXY_IP ($S9FW_PROXY_IP) fuera de S9FW_SUBNET ($S9FW_SUBNET)"
  is_port "$S9FW_PROXY_PORT" || die 2 "S9FW_PROXY_PORT inválido: '$S9FW_PROXY_PORT'"

  local p i
  [ -n "$S9FW_SSH_PORTS" ] || die 2 "S9FW_SSH_PORTS vacío"
  for p in $S9FW_SSH_PORTS; do is_port "$p" || die 2 "puerto de sshd inválido: '$p'"; done
  [ -n "$S9FW_SSH_BLOCK_IFACES" ] || die 2 "S9FW_SSH_BLOCK_IFACES vacío"
  for i in $S9FW_SSH_BLOCK_IFACES; do
    is_ifname "$i" || die 2 "interfaz inválida en S9FW_SSH_BLOCK_IFACES: '$i'"
    case "$i" in lo | +) die 2 "S9FW_SSH_BLOCK_IFACES no puede incluir '$i'" ;; esac
  done
  case "$S9FW_IPV6" in auto | on | off) ;; *) die 2 "S9FW_IPV6 debe ser auto|on|off" ;; esac
}

# ------------------------------------------------------------ reglas deseadas ----
# Una única fuente: las líneas EXACTAS que imprime `iptables -S <cadena>` (forma canónica).
# Las reglas se instalan a partir de estas mismas líneas, y `check` compara contra ellas.

desired_rules() {
  local fam="$1" p i
  if [ "$fam" = 4 ]; then
    echo "-A $CHAIN -s $S9FW_SUBNET -d $S9FW_PROXY_IP/32 -i $S9FW_BRIDGE -p tcp -m tcp --dport $S9FW_PROXY_PORT -j RETURN"
  fi
  echo "-A $CHAIN -p tcp -m tcp --dport $S9FW_PROXY_PORT -j DROP"
  for p in $S9FW_SSH_PORTS; do
    for i in $S9FW_SSH_BLOCK_IFACES; do
      echo "-A $CHAIN -i $i -p tcp -m tcp --dport $p -j DROP"
    done
  done
}

jump_spec() { echo "-m comment --comment $1 -j $2"; }

# ---------------------------------------------------------------- iptables ----

ipt() {
  local fam="$1"
  shift
  if [ "$fam" = 4 ]; then iptables -w 5 "$@"; else ip6tables -w 5 "$@"; fi
}

families() {
  echo 4
  case "$S9FW_IPV6" in
    on) echo 6 ;;
    auto) command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -S INPUT >/dev/null 2>&1 && echo 6 ;;
  esac
  return 0
}

chain_exists() { ipt "$1" -S "$2" >/dev/null 2>&1; }

chain_body() { ipt "$1" -S "$2" | grep -v -- "^-N $2\$" || true; }

fill_chain() {
  local fam="$1" target="$2" line
  local -a args
  while IFS= read -r line; do
    read -r -a args <<<"${line#"-A $CHAIN "}"
    ipt "$fam" -A "$target" "${args[@]}"
  done < <(desired_rules "$fam")
}

# Borra TODAS las apariciones de un salto propio, por especificación (nunca por número).
delete_jumps() {
  local fam="$1" tag="$2" target="$3"
  local -a spec
  read -r -a spec <<<"$(jump_spec "$tag" "$target")"
  while ipt "$fam" -C INPUT "${spec[@]}" 2>/dev/null; do
    ipt "$fam" -D INPUT "${spec[@]}"
  done
}

insert_jump_top() {
  local -a spec
  read -r -a spec <<<"$(jump_spec "$2" "$3")"
  ipt "$1" -I INPUT 1 "${spec[@]}"
}

# Líneas -A de INPUT, en orden (la 1ª es la regla número 1).
input_rules() { ipt "$1" -S INPUT | grep -- '^-A INPUT ' || true; }

jump_ok() {
  local fam="$1" want rules count first
  want="-A INPUT $(jump_spec "$JUMP_TAG" "$CHAIN")"
  rules="$(input_rules "$fam")"
  first="$(printf '%s\n' "$rules" | head -n 1)"
  count="$(printf '%s\n' "$rules" | grep -cxF -- "$want" || true)"
  [ "$first" = "$want" ] && [ "$count" = 1 ]
}

body_ok() {
  local fam="$1"
  chain_exists "$fam" "$CHAIN" || return 1
  [ "$(chain_body "$fam" "$CHAIN")" = "$(desired_rules "$fam")" ]
}

drop_chain() {
  local fam="$1" c="$2"
  if chain_exists "$fam" "$c"; then
    ipt "$fam" -F "$c"
    ipt "$fam" -X "$c"
  fi
}

apply_family() {
  local fam="$1" changed=0
  if ! body_ok "$fam"; then
    changed=1
    # 1) Cadena nueva completa, enganchada ARRIBA antes de tocar la vieja: no hay ventana.
    drop_chain "$fam" "$CHAIN_NEW"
    ipt "$fam" -N "$CHAIN_NEW"
    fill_chain "$fam" "$CHAIN_NEW"
    insert_jump_top "$fam" "$TMP_TAG" "$CHAIN_NEW"
    # 2) Rehacer la cadena canónica.
    delete_jumps "$fam" "$JUMP_TAG" "$CHAIN"
    drop_chain "$fam" "$CHAIN"
    ipt "$fam" -N "$CHAIN"
    fill_chain "$fam" "$CHAIN"
    insert_jump_top "$fam" "$JUMP_TAG" "$CHAIN"
    # 3) Retirar la temporal.
    delete_jumps "$fam" "$TMP_TAG" "$CHAIN_NEW"
    drop_chain "$fam" "$CHAIN_NEW"
  fi
  if ! jump_ok "$fam"; then
    changed=1
    # Reposicionar sin ventana: salto temporal arriba, quitar los canónicos, poner el
    # canónico arriba, quitar el temporal. (p. ej. tailscaled reinició y puso ts-input 1º.)
    insert_jump_top "$fam" "$TMP_TAG" "$CHAIN"
    delete_jumps "$fam" "$JUMP_TAG" "$CHAIN"
    insert_jump_top "$fam" "$JUMP_TAG" "$CHAIN"
    delete_jumps "$fam" "$TMP_TAG" "$CHAIN"
  fi
  # Restos de una ejecución interrumpida.
  delete_jumps "$fam" "$TMP_TAG" "$CHAIN"
  delete_jumps "$fam" "$TMP_TAG" "$CHAIN_NEW"
  drop_chain "$fam" "$CHAIN_NEW"
  if body_ok "$fam" && jump_ok "$fam"; then
    if [ "$changed" = 1 ]; then log "IPv$fam: reglas aplicadas/corregidas"; else log "IPv$fam: sin cambios"; fi
  else
    die 1 "IPv$fam: tras apply el estado sigue sin ser conforme (ver 'check')"
  fi
}

check_family() {
  local fam="$1" bad=0
  if ! chain_exists "$fam" "$CHAIN"; then
    log "DERIVA IPv$fam: no existe la cadena $CHAIN"
    bad=1
  elif ! body_ok "$fam"; then
    log "DERIVA IPv$fam: el contenido de $CHAIN no es el esperado"
    diff <(desired_rules "$fam") <(chain_body "$fam" "$CHAIN") | sed 's/^/  /' || true
    bad=1
  fi
  if ! jump_ok "$fam"; then
    log "DERIVA IPv$fam: el salto a $CHAIN no es la regla 1 de INPUT o no es único"
    input_rules "$fam" | head -n 3 | sed 's/^/  INPUT: /'
    bad=1
  fi
  if chain_exists "$fam" "$CHAIN_NEW"; then
    log "DERIVA IPv$fam: resto de una ejecución interrumpida ($CHAIN_NEW)"
    bad=1
  fi
  [ "$bad" = 0 ] && log "IPv$fam: conforme"
  return "$bad"
}

remove_family() {
  local fam="$1"
  delete_jumps "$fam" "$JUMP_TAG" "$CHAIN"
  delete_jumps "$fam" "$TMP_TAG" "$CHAIN"
  delete_jumps "$fam" "$TMP_TAG" "$CHAIN_NEW"
  drop_chain "$fam" "$CHAIN"
  drop_chain "$fam" "$CHAIN_NEW"
  log "IPv$fam: reglas propias retiradas"
}

need_root() { [ "$(id -u)" = 0 ] || die 3 "ejecuta como root"; }
need_iptables() {
  command -v iptables >/dev/null 2>&1 || die 3 "no hay iptables en el PATH"
  iptables -w 5 -S INPUT >/dev/null 2>&1 || die 3 "iptables no puede leer la tabla filter"
}

bridge_note() {
  ip -4 -o addr show dev "$S9FW_BRIDGE" 2>/dev/null | grep -qF " $S9FW_PROXY_IP/" ||
    log "aviso: $S9FW_BRIDGE no existe todavía o no tiene $S9FW_PROXY_IP (las reglas valen igual: filtran por nombre de interfaz)"
}

cmd_apply() {
  need_root
  need_iptables
  local fam
  for fam in $(families); do apply_family "$fam"; done
  bridge_note
}

cmd_check() {
  need_root
  need_iptables
  local fam rc=0
  for fam in $(families); do check_family "$fam" || rc=1; done
  return "$rc"
}

cmd_remove() {
  need_root
  need_iptables
  local fam
  for fam in 4 6; do
    if [ "$fam" = 6 ] && ! { command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -S INPUT >/dev/null 2>&1; }; then continue; fi
    remove_family "$fam"
  done
}

cmd_print() {
  local fam
  for fam in 4 6; do
    echo "# IPv$fam (cadena $CHAIN; salto: -I INPUT 1 $(jump_spec "$JUMP_TAG" "$CHAIN"))"
    desired_rules "$fam"
  done
}

cmd_install() {
  need_root
  local u
  for u in "${UNITS[@]}"; do [ -f "$UNIT_SRC_DIR/$u" ] || die 3 "falta $UNIT_SRC_DIR/$u"; done
  # Copia propiedad de root: la unidad (root) NO ejecuta un script del clon, que es
  # escribible por el usuario de despliegue.
  install -o root -g root -m 0755 "${SELF_DIR}/s9-firewall.sh" "$SBIN_DST"
  if [ ! -f /etc/s9-ai-arena/firewall.env ] && [ -f "${SELF_DIR}/firewall.env.example" ]; then
    install -d -m 0755 /etc/s9-ai-arena
    install -o root -g root -m 0644 "${SELF_DIR}/firewall.env.example" /etc/s9-ai-arena/firewall.env
  fi
  for u in "${UNITS[@]}"; do install -o root -g root -m 0644 "$UNIT_SRC_DIR/$u" "$UNIT_DIR/$u"; done
  systemctl daemon-reload
  systemctl enable --now s9-firewall.service s9-firewall-reassert.timer
  "$SBIN_DST" check
}

cmd_uninstall() {
  need_root
  systemctl disable --now s9-firewall-reassert.timer s9-firewall.service 2>/dev/null || true
  local u
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  systemctl daemon-reload
  cmd_remove
  rm -f "$SBIN_DST"
  log "desinstalado (se conserva /etc/s9-ai-arena/firewall.env)"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    apply | check | remove | print | install | uninstall) ;;
    *) die 2 "uso: $0 {apply|check|remove|print|install|uninstall}" ;;
  esac
  validate_config
  "cmd_$cmd"
}

main "$@"
