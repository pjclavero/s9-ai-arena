#!/usr/bin/env bash
# RC2 · DEV-SECOPS — arnés del firewall de host en un netns AISLADO.
#
# Monta, dentro de un network namespace propio (nunca el del host), un «host» con:
#   s9-botctl0 (10.89.250.1/24, el bridge dedicado del contrato), br-rc2so0 (otra red de
#   Docker), docker0, una «LAN» y una interfaz «tailscale0» con una cadena ts-input que
#   ACEPTA todo lo que entra por ella (como Tailscale), y escuchas en 0.0.0.0:2375 y :22.
# Cada cliente vive en su propio netns y entra al host por su interfaz. El arnés mide
# CONNECT/TIMEOUT/REFUSED/UNREACH con conexiones TCP reales, en fases:
#   control (sin reglas: TODO conecta ⇒ la sonda es capaz de ver alcance) → apply → idem-
#   potencia → deriva de Tailscale → deriva de contenido → config inválida → remove.
# Además intercepta iptables/ip6tables/nft con un shim para demostrar por EFECTO que el
# script nunca invoca nft ni toca cadenas ajenas.
#
# Uso: bash infrastructure/firewall/tests/netns-harness.sh
#   S9FW_SCRIPT=<ruta> para probar otra versión del script (calibración por mutación).
# Salida: líneas PASS/FAIL y «RESULT pass=N fail=M expected=E»; rc=0 sólo si fail=0 y
# pass=E. rc=77 si no hay forma de crear un netns (ni userns sin privilegios ni sudo -n).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${S9FW_SCRIPT:-$HERE/../s9-firewall.sh}"
SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"

if [ "${S9FW_HARNESS_INNER:-}" != 1 ]; then
  self="$HERE/$(basename "${BASH_SOURCE[0]}")"
  if [ "$(id -u)" = 0 ]; then
    exec unshare -n env S9FW_HARNESS_INNER=1 S9FW_SCRIPT="$SCRIPT" bash "$self"
  elif unshare -rn true 2>/dev/null; then
    exec unshare -rn env S9FW_HARNESS_INNER=1 S9FW_SCRIPT="$SCRIPT" bash "$self"
  elif sudo -n true 2>/dev/null; then
    exec sudo -n env "PATH=$PATH" S9FW_HARNESS_INNER=1 S9FW_SCRIPT="$SCRIPT" unshare -n bash "$self"
  fi
  echo "netns-harness: no se puede crear un netns (sin userns sin privilegios ni sudo -n)" >&2
  exit 77
fi

# ------------------------------------------------------------------ dentro ----
export PATH="$PATH:/usr/sbin:/sbin"
IPT_REAL="$(command -v iptables)"
IP6T_REAL="$(command -v ip6tables || true)"

# Salvaguarda: sólo se trabaja en un netns recién creado (sólo `lo`). Si no, se aborta
# antes de tocar nada: este arnés NUNCA debe ejecutar iptables en un netns real.
links="$(ip -o link show | awk -F': ' '{print $2}' | sed 's/@.*//' | sort | tr '\n' ' ')"
if [ "$links" != "lo " ]; then
  echo "netns-harness: ABORTO, el netns no está vacío (interfaces: $links)" >&2
  exit 70
fi

T="$(mktemp -d /tmp/rc2so-fwh.XXXXXX)"
PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

PASS=0
FAIL=0
EXPECTED=0
ok() { PASS=$((PASS + 1)); echo "PASS $*"; }
ko() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }
expect_eq() { # nombre esperado obtenido
  EXPECTED=$((EXPECTED + 1))
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else ko "$1: esperado $2, obtenido $3"; fi
}

# ---- shim: registra cada invocación; nft está prohibido ----
mkdir -p "$T/shim"
cat >"$T/shim/iptables" <<EOF
#!/bin/sh
echo "4 \$*" >>"$T/ipt.log"
exec "$IPT_REAL" "\$@"
EOF
if [ -n "$IP6T_REAL" ]; then
  cat >"$T/shim/ip6tables" <<EOF
#!/bin/sh
echo "6 \$*" >>"$T/ipt.log"
exec "$IP6T_REAL" "\$@"
EOF
fi
cat >"$T/shim/nft" <<EOF
#!/bin/sh
echo "nft \$*" >>"$T/nft.log"
exit 1
EOF
chmod +x "$T/shim/"*
: >"$T/ipt.log"
fw() { S9FW_CONF=/dev/null PATH="$T/shim:$PATH" bash "$SCRIPT" "$@"; }

# ---- utilidades python: escucha y sonda ----
cat >"$T/listen.py" <<'EOF'
import socket, sys, threading
def serve(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port)); s.listen(64)
    while True:
        c, _ = s.accept(); c.close()
for p in sys.argv[1:]:
    threading.Thread(target=serve, args=(int(p),), daemon=True).start()
threading.Event().wait()
EOF
cat >"$T/probe.py" <<'EOF'
import errno, socket, sys
host, port = sys.argv[1], int(sys.argv[2]); src = sys.argv[3] if len(sys.argv) > 3 else ""
s = socket.socket(); s.settimeout(0.8)
try:
    if src: s.bind((src, 0))
    s.connect((host, port)); print("CONNECT")
except socket.timeout: print("TIMEOUT")
except ConnectionRefusedError: print("REFUSED")
except OSError as e:
    print("UNREACH" if e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH) else "ERR%d" % e.errno)
EOF

# ---- topología ----
ip link set lo up
declare -A NS
mkns() {
  unshare -n sleep 3600 &
  local pid=$!
  PIDS+=("$pid")
  local _
  for _ in $(seq 1 50); do
    [ "$(readlink /proc/$pid/ns/net)" != "$(readlink /proc/self/ns/net)" ] && break
    sleep 0.05
  done
  NS[$1]=$pid
}
inns() {
  local n="$1"
  shift
  nsenter -t "${NS[$n]}" -n "$@"
}

mkbridge() { # nombre cidr
  ip link add "$1" type bridge
  ip addr add "$2" dev "$1"
  ip link set "$1" up
}
mkbridge s9-botctl0 10.89.250.1/24
mkbridge br-rc2so0 172.30.99.1/24
mkbridge docker0 172.31.99.1/24

attach() { # cliente bridge|- ifhost cidr_cliente gw [cidr_host]
  local c="$1" br="$2" ifh="$3" cip="$4" gw="$5" hip="${6:-}"
  mkns "$c"
  ip link add "$ifh" type veth peer name "p-$c"
  ip link set "p-$c" netns "${NS[$c]}"
  if [ "$br" != - ]; then ip link set "$ifh" master "$br"; else ip addr add "$hip" dev "$ifh"; fi
  ip link set "$ifh" up
  inns "$c" ip link set lo up
  inns "$c" ip link set "p-$c" name eth0
  inns "$c" ip addr add "$cip" dev eth0
  inns "$c" ip link set eth0 up
  inns "$c" ip route add default via "$gw"
}
attach ctl s9-botctl0 ctl-h 10.89.250.10/24 10.89.250.1
attach pub br-rc2so0 pub-h 172.30.99.10/24 172.30.99.1
attach dk0 docker0 dk0-h 172.31.99.10/24 172.31.99.1
attach lan - lan0 192.0.2.10/24 192.0.2.1 192.0.2.1/24
attach ts - tailscale0 198.51.100.2/24 198.51.100.1 198.51.100.1/24
# Origen FALSIFICADO: «pub» se pone una IP de la subred dedicada. Con ruta de vuelta por su
# propio bridge, sin firewall CONECTA (control); con firewall sólo lo para el `-i`.
inns pub ip addr add 10.89.250.50/32 dev eth0
ip route add 10.89.250.50/32 via 172.30.99.10 dev br-rc2so0

python3 "$T/listen.py" 2375 22 &
PIDS+=("$!")
for _ in $(seq 1 50); do python3 "$T/probe.py" 127.0.0.1 2375 | grep -q CONNECT && break; sleep 0.1; done

# Tailscale simulado: ts-input ACEPTA todo lo de tailscale0 y está en INPUT 1 (como en el host real).
"$IPT_REAL" -N ts-input
"$IPT_REAL" -A ts-input -i tailscale0 -j ACCEPT
"$IPT_REAL" -I INPUT 1 -j ts-input
# Cadenas «de Docker» simuladas: el script no debe tocarlas.
"$IPT_REAL" -N DOCKER-USER
"$IPT_REAL" -A DOCKER-USER -j RETURN
"$IPT_REAL" -A FORWARD -j DOCKER-USER
"$IPT_REAL" -t nat -N DOCKER
"$IPT_REAL" -t nat -A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER

probe() { inns "$1" python3 "$T/probe.py" "$2" "$3" ${4:+"$4"}; }
hostprobe() { python3 "$T/probe.py" "$1" "$2"; }

# Matriz: nombre cliente destino puerto [origen] — esperado con firewall aplicado.
MATRIX=(
  "ctl->proxy:2375|ctl|10.89.250.1|2375||CONNECT"
  "ctl->proxy:22|ctl|10.89.250.1|22||TIMEOUT"
  "pub->proxy:2375|pub|10.89.250.1|2375||TIMEOUT"
  "pub->gw:2375|pub|172.30.99.1|2375||TIMEOUT"
  "pub->gw:22|pub|172.30.99.1|22||TIMEOUT"
  "pub(spoof 10.89.250.50)->proxy:2375|pub|10.89.250.1|2375|10.89.250.50|TIMEOUT"
  "docker0->proxy:2375|dk0|10.89.250.1|2375||TIMEOUT"
  "docker0->gw:2375|dk0|172.31.99.1|2375||TIMEOUT"
  "docker0->gw:22|dk0|172.31.99.1|22||TIMEOUT"
  "lan->proxy:2375|lan|10.89.250.1|2375||TIMEOUT"
  "lan->host:22|lan|192.0.2.1|22||CONNECT"
  "tailscale->proxy:2375|ts|10.89.250.1|2375||TIMEOUT"
  "tailscale->host:22|ts|198.51.100.1|22||CONNECT"
)

run_matrix() { # fase modo(applied|open)
  local phase="$1" mode="$2" row name c dst port src want got
  for row in "${MATRIX[@]}"; do
    IFS='|' read -r name c dst port src want <<<"$row"
    [ "$mode" = open ] && want=CONNECT
    got="$(probe "$c" "$dst" "$port" "$src")"
    expect_eq "[$phase] $name" "$want" "$got"
  done
  want=TIMEOUT
  [ "$mode" = open ] && want=CONNECT
  expect_eq "[$phase] host(lo)->proxy:2375" "$want" "$(hostprobe 10.89.250.1 2375)"
}

foreign_state() { # todo lo que NO es nuestro, en filter y nat (v4) y filter (v6)
  {
    "$IPT_REAL" -S | grep -v -E 'S9-HOST-GUARD' || true
    "$IPT_REAL" -t nat -S
    [ -n "$IP6T_REAL" ] && { "$IP6T_REAL" -S | grep -v -E 'S9-HOST-GUARD' || true; }
  } | sed 's/^/  /'
}

rc_of() { local rc=0; "$@" >"$T/last.out" 2>&1 || rc=$?; echo "$rc"; }

# ---------------------------------------------------------------- fases ----
FOREIGN0="$(foreign_state)"

# 1) control negativo: sin reglas TODO conecta (si no, una «denegación» no probaría nada).
run_matrix control open
expect_eq "[control] check sin reglas ⇒ deriva" 1 "$(rc_of fw check)"

# 2) apply
expect_eq "[apply] rc" 0 "$(rc_of fw apply)"
expect_eq "[apply] check" 0 "$(rc_of fw check)"
first="$("$IPT_REAL" -S INPUT | grep '^-A INPUT' | head -n 1)"
expect_eq "[apply] salto propio = regla 1 de INPUT (delante de ts-input)" \
  "-A INPUT -m comment --comment s9-host-guard -j S9-HOST-GUARD" "$first"
run_matrix applied applied
if [ -n "$IP6T_REAL" ] && "$IP6T_REAL" -S INPUT >/dev/null 2>&1; then
  expect_eq "[apply] IPv6: DROP de 2375 presente" 0 \
    "$(rc_of "$IP6T_REAL" -C S9-HOST-GUARD -p tcp -m tcp --dport 2375 -j DROP)"
fi

# 3) idempotencia: segundo apply no cambia nada (estado completo de filter+nat).
S1="$("$IPT_REAL" -S; "$IPT_REAL" -t nat -S)"
expect_eq "[idem] segundo apply rc" 0 "$(rc_of fw apply)"
expect_eq "[idem] dice «sin cambios»" yes "$(grep -q 'IPv4: sin cambios' "$T/last.out" && echo yes || echo no)"
S2="$("$IPT_REAL" -S; "$IPT_REAL" -t nat -S)"
expect_eq "[idem] estado idéntico tras 2º apply" same "$([ "$S1" = "$S2" ] && echo same || echo differs)"

# 4) deriva de Tailscale: tailscaled reinicia y vuelve a poner ts-input en INPUT 1.
"$IPT_REAL" -D INPUT -j ts-input
"$IPT_REAL" -I INPUT 1 -j ts-input
expect_eq "[ts-drift] check detecta la deriva" 1 "$(rc_of fw check)"
expect_eq "[ts-drift] el riesgo es real: tailscale->proxy:2375" CONNECT "$(probe ts 10.89.250.1 2375)"
expect_eq "[ts-drift] apply corrige" 0 "$(rc_of fw apply)"
expect_eq "[ts-drift] check tras corregir" 0 "$(rc_of fw check)"
expect_eq "[ts-drift] tailscale->proxy:2375 tras corregir" TIMEOUT "$(probe ts 10.89.250.1 2375)"
expect_eq "[ts-drift] ts-input sigue existiendo (no se toca lo ajeno)" 0 "$(rc_of "$IPT_REAL" -C INPUT -j ts-input)"

# 5) deriva de contenido: alguien inserta un RETURN al principio de nuestra cadena.
"$IPT_REAL" -I S9-HOST-GUARD 1 -j RETURN
expect_eq "[body-drift] check detecta" 1 "$(rc_of fw check)"
expect_eq "[body-drift] pub->proxy:2375 abierto por la deriva" CONNECT "$(probe pub 10.89.250.1 2375)"
expect_eq "[body-drift] apply corrige" 0 "$(rc_of fw apply)"
expect_eq "[body-drift] check" 0 "$(rc_of fw check)"
expect_eq "[body-drift] pub->proxy:2375 cerrado otra vez" TIMEOUT "$(probe pub 10.89.250.1 2375)"

# 6) configuración insegura ⇒ rc=2 y sin cambios.
S3="$("$IPT_REAL" -S)"
expect_eq "[config] subred 0.0.0.0/0 ⇒ rc 2" 2 "$(S9FW_SUBNET=0.0.0.0/0 rc_of fw apply)"
expect_eq "[config] bridge docker0 ⇒ rc 2" 2 "$(S9FW_BRIDGE=docker0 rc_of fw apply)"
expect_eq "[config] proxy fuera de la subred ⇒ rc 2" 2 "$(S9FW_PROXY_IP=172.17.0.1 rc_of fw apply)"
expect_eq "[config] sin cambios tras rechazos" same "$([ "$S3" = "$("$IPT_REAL" -S)" ] && echo same || echo differs)"

# 7) remove: vuelve exactamente al estado ajeno de partida y todo reabre.
expect_eq "[remove] rc" 0 "$(rc_of fw remove)"
expect_eq "[remove] check ⇒ deriva (no hay reglas)" 1 "$(rc_of fw check)"
expect_eq "[remove] estado ajeno idéntico al inicial" same "$([ "$FOREIGN0" = "$(foreign_state)" ] && echo same || echo differs)"
expect_eq "[remove] no quedan cadenas S9" 0 "$("$IPT_REAL" -S | grep -c S9-HOST-GUARD || true)"
expect_eq "[remove] pub->proxy:2375 reabre" CONNECT "$(probe pub 10.89.250.1 2375)"

# 8) efecto observado sobre las llamadas: nunca nft; mutaciones sólo sobre lo propio.
expect_eq "[shim] nft nunca invocado" 0 "$( [ -f "$T/nft.log" ] && wc -l <"$T/nft.log" || echo 0)"
bad="$(awk '
  { fam=$1; $1=""; sub(/^ /,"") }
  { op=""; for (i=1;i<=NF;i++) if ($i ~ /^-(A|I|D|R|F|X|N|E|P|Z)$/) { op=$i; ch=$(i+1); break } }
  op=="" { next }
  /-t / { print; next }
  ch ~ /^S9-HOST-GUARD(-NEW)?$/ { next }
  ch=="INPUT" && $0 ~ /-m comment --comment s9-host-guard(-tmp)? -j S9-HOST-GUARD(-NEW)?$/ { next }
  { print }' "$T/ipt.log")"
expect_eq "[shim] ninguna mutación fuera de lo propio" "" "$bad"
expect_eq "[shim] se registraron llamadas (el shim estaba activo)" yes "$([ -s "$T/ipt.log" ] && echo yes || echo no)"

echo "RESULT pass=$PASS fail=$FAIL expected=$EXPECTED"
[ "$FAIL" = 0 ] && [ "$PASS" = "$EXPECTED" ]
