#!/usr/bin/env bash
# RC2 DEV-CI · E2E REAL contenedor → bot-control → s9-docker-proxy → Docker → bots → batalla.
#
# Por qué existe (RC1 = DEPLOYMENT_BLOCKED, REVIEW P0-3, TD-052): el golden path de
# tests/browser/run.sh corre los servicios como PROCESOS del host y habla con el proxy por
# 127.0.0.1, así que nunca ejercitó el camino que falló en producción (contenedor en red
# interna → proxy del host: ENETUNREACH) ni el que sobraba (gateway/backup → proxy: 403).
# Aquí el stack es el Compose REAL (perfil production, mismas redes), con imágenes
# construidas en el propio job desde el commit, y el proxy es un PROCESO DEL HOST del runner
# escuchando en 10.89.250.1, con el firewall de DEV-SECOPS aplicado de verdad (sudo). Nada de
# bypass: las sondas y los flujos salen desde dentro de los contenedores del stack.
# TD-062: el proxy NO se arranca con tsx desde el checkout: se instala con
# infrastructure/scripts/install-docker-proxy.sh install (bundle de root en
# /usr/local/lib/s9-docker-proxy, allowlist en /etc/s9-docker-proxy) y corre como la unidad
# systemd REAL s9-docker-proxy.service (User=s9proxy, ProtectHome: el checkout es invisible).
#
# Subcomandos (cada uno es un paso del job con su propio reloj; el estado vive en $STATE):
#   prepare   secretos efímeros, entorno, compose resuelto (+ defectos) y compose-check
#   build     imágenes de la aplicación desde el commit (BUILD_COMMIT = commit del job)
#   up        redes + contenedores sin arrancar → proxy en 10.89.250.1 → stack con --wait
#   probes    C5: sondas desde CADA contenedor (y equivalentes declarados de backup y de un
#             bot) sin firewall (capa proxy) y con firewall (capa host); escucha del proxy
#   flow      C3/C4: build → published ×2 y batalla A+B por la API pública del gateway
#   policy    C6: política de imagen y de propiedad desde un consumidor legítimo (DESPUÉS
#             del flujo: con un proxy roto, estas peticiones paran postgres y el gateway)
#   privilege TD-062: preflight real, proceso efectivo, negativos EACCES con usuarios reales
#             y calibración del preflight con mutaciones de root (ROJO → revertida → VERDE)
#   evidence  C9: logs, compose config, redes saneadas, eventos de Docker, sin secretos
#   cleanup   para el proxy, retira el firewall y el stack (SÓLO en el runner efímero)
#
# Salida: $STATE/out/*.json; el veredicto lo da scripts/ci/assert-container-proxy-e2e.mjs.
#
# SEGURIDAD: aplica reglas de firewall con sudo, levanta un stack y lo borra con `down -v`.
# Sólo corre en un runner efímero de GitHub Actions (GITHUB_ACTIONS=true); en cualquier otra
# máquina se niega (rc 3). NUNCA contra producción.
set -uo pipefail

CMD=${1:?uso: run.sh <prepare|build|up|probes|flow|policy|privilege|evidence|cleanup>}
if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
  echo "run.sh: sólo en un runner efímero de GitHub Actions (aplica firewall y borra el stack)" >&2
  exit 3
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/tests/container-proxy-e2e"
STATE="${S9_CPX_STATE:?S9_CPX_STATE (directorio de estado) obligatorio}"
OUT="$STATE/out"
LOGS="$STATE/logs"
PROJECT="${S9_CPX_PROJECT:-s9cpx}"
COMMIT="${S9_CPX_COMMIT:-$(git -C "$REPO" rev-parse HEAD)}"
IMAGE_PREFIX="s9cpx-local"
TAG="ci-${COMMIT:0:12}"
# Contrato RC2 (COMMON-RC2.md): constantes, no parámetros.
NET_NAME="s9-bot-control"
BRIDGE="s9-botctl0"
GW_IP="10.89.250.1"
SUBNET="10.89.250.0/24"
PROXY_PORT=2375
PROXY_URL="http://docker-proxy.internal:2375"
PROXY_INSTANCE="s9-docker-proxy"
HTTP_PORT=18080
# Firewall de DEV-SECOPS (infrastructure/firewall/). Se invoca, no se reimplementa.
FIREWALL="${S9_CPX_FIREWALL:-$REPO/infrastructure/firewall/s9-firewall.sh}"
# TD-062: el proxy se instala con el instalador REAL y corre como la unidad systemd REAL.
INSTALLER="$REPO/infrastructure/scripts/install-docker-proxy.sh"
PROXY_UNIT="s9-docker-proxy.service"
BUNDLE_DST="/usr/local/lib/s9-docker-proxy/docker-proxy.mjs"
LOCK_DST="/etc/s9-docker-proxy/DIGESTS.lock"
PROXY_ENV="/etc/s9-ai-arena/docker-proxy.env"
EXPECTED_EXECSTART="/usr/bin/node --no-addons $BUNDLE_DST"
# S9PX_TREE: el checkout es «el árbol» que el proceso del proxy no debe ver.
PX=(sudo -n env "S9PX_TREE=$REPO" bash "$INSTALLER")

BUILD_SERVICES=(gateway web api arena-engine tournament-worker bot-manager map-service replay-service)
INFRA_SERVICES=(postgres queue)
APP_SERVICES=(api web gateway arena-engine tournament-worker bot-manager bot-build-worker map-service replay-service)
STACK=("${INFRA_SERVICES[@]}" "${APP_SERVICES[@]}")
DC=(docker compose -p "$PROJECT" -f "$REPO/infrastructure/docker-compose.yml" --env-file "$STATE/compose.env" --profile production)
PROBE_IMG="$IMAGE_PREFIX/api:$TAG"

umask 077
mkdir -p "$OUT" "$LOGS/containers" "$STATE/secrets" "$STATE/bodies"
chmod 755 "$STATE" "$STATE/bodies"
log() { echo "[cpx $(date +%H:%M:%S) $CMD] $*" | tee -a "$OUT/summary.txt"; }
cid() { "${DC[@]}" ps -aq "$1" 2>/dev/null | head -1; }

# ── prepare ─────────────────────────────────────────────────────────────────
do_prepare() {
  # Secretos efímeros con el instalador del repo (propietario 1000 = usuario de las imágenes).
  sudo -n env RUNTIME_UID=1000 RUNTIME_GID=1000 bash "$REPO/infrastructure/scripts/init-secrets.sh" >"$LOGS/init-secrets.log" 2>&1 ||
    { log "init-secrets.sh falló"; return 1; }
  # Copia legible SÓLO para buscar fugas en la evidencia (collect-functional-evidence.sh);
  # $STATE/secrets nunca se sube.
  for f in "$REPO"/infrastructure/secrets/*.txt "$REPO"/infrastructure/secrets/*.pem; do
    [ -f "$f" ] && sudo -n cat "$f" >"$STATE/secrets/$(basename "$f")"
  done
  cat >"$STATE/compose.env" <<EOF
IMAGE_PREFIX=$IMAGE_PREFIX
TAG=$TAG
BUILD_COMMIT=$COMMIT
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
GATEWAY_CONF=nginx-behind-proxy.conf
HTTP_PORT=127.0.0.1:$HTTP_PORT
HTTPS_PORT=127.0.0.1:18443
DOCKER_PROXY_URL=$PROXY_URL
EOF
  grep -v '^DOCKER_PROXY_URL=' "$STATE/compose.env" >"$STATE/compose-defaults.env"
  "${DC[@]}" config --format json >"$OUT/compose-config.json" 2>"$LOGS/compose-config.log" ||
    { log "docker compose config falló"; return 1; }
  docker compose -p "$PROJECT" -f "$REPO/infrastructure/docker-compose.yml" --env-file "$STATE/compose-defaults.env" \
    --profile production config --format json >"$OUT/compose-config-defaults.json" 2>>"$LOGS/compose-config.log"
  node "$HERE/compose-check.mjs" "$OUT/compose-config.json" "$OUT/compose-config-defaults.json" \
    >"$OUT/compose-check.json" 2>"$LOGS/compose-check.log"
  log "COMPOSE_CHECK_RC=$? (el veredicto lo juzga; aquí sólo se registra)"
  (cd "$REPO" && node_modules/.bin/tsx "$HERE/make-bodies.ts" "$OUT/compose-config.json" "$STATE/bodies") \
    >>"$LOGS/make-bodies.log" 2>&1 || { log "make-bodies falló"; return 1; }
  chmod 644 "$STATE"/bodies/*.json
  cp "$STATE/bodies/images.json" "$OUT/images.json"
  log "preparado: proyecto $PROJECT, imágenes $IMAGE_PREFIX/*:$TAG, commit $COMMIT"
}

# ── build ───────────────────────────────────────────────────────────────────
do_build() {
  "${DC[@]}" build "${BUILD_SERVICES[@]}" >"$LOGS/build.log" 2>&1
  local rc=$?
  log "BUILD_RC=$rc (${BUILD_SERVICES[*]})"
  return $rc
}

# ── instalación del proxy como en producción (TD-062) ───────────────────────
install_proxy_as_production() {
  {
    # a) bundle SIN root (usuario del runner), con el commit del job.
    node "$REPO/infrastructure/scripts/build-docker-proxy-bundle.mjs" --commit "$COMMIT" >"$OUT/proxy-bundle.json" || return 1
    # b) /usr/bin/node de root (la unidad lo fija): el node del job, copiado con root:root 0755.
    #    El de setup-node vive en el toolcache del usuario del runner: el preflight lo
    #    rechazaría, y con razón.
    sudo -n install -o root -g root -m 0755 "$(command -v node)" /usr/bin/node || return 1
    /usr/bin/node --version
    # c) entorno del operador: el ejemplo del repo (constantes del contrato RC2; allowlist =
    #    copia de root). Root 0640, como en producción.
    sudo -n install -d -o root -g root -m 0755 /etc/s9-ai-arena || return 1
    sudo -n install -o root -g root -m 0640 "$REPO/infrastructure/systemd/docker-proxy.env.example" "$PROXY_ENV" || return 1
    # d) instalador REAL: copia bundle/allowlist/unidad, usuario s9proxy, systemd, preflight.
    "${PX[@]}" install
  } >"$LOGS/proxy-install.log" 2>&1
}

# ── privilege (TD-062) ───────────────────────────────────────────────────────
# La frontera de privilegio medida con root REAL, systemd REAL y usuarios REALES:
#   P1 preflight completo (ficheros, unidad cargada, proceso en marcha) ⇒ rc 0
#   P2 lo efectivo: /proc/<MainPID>/exe = /usr/bin/node, cmdline = ExecStart esperado,
#      usuario s9proxy, y el proceso NO ve el checkout (namespace de montaje del servicio)
#   P3 negativos: un usuario no root (s9cpx-arena, el papel de s9arena) y el propio s9proxy
#      NO pueden escribir/crear/renombrar bundle, allowlist, unidad ni entorno ⇒ EACCES
#   P4 calibración: cada mutación (root) pone el preflight ROJO por su motivo; revertida ⇒ VERDE
#   P5 el proxy siguió vivo (mismo MainPID): ninguna mutación lo reinició
do_privilege() {
  local pid0 rc
  pid0=$(systemctl show -p MainPID --value "$PROXY_UNIT")
  : >"$STATE/privilege-neg.jsonl"
  : >"$STATE/privilege-mut.jsonl"

  # P1
  "${PX[@]}" preflight >"$LOGS/privilege-preflight-1.log" 2>&1
  local pf1=$?

  # P2
  local exe cmd user tree_visible
  exe=$(sudo -n readlink -f "/proc/$pid0/exe")
  cmd=$(sudo -n cat "/proc/$pid0/cmdline" | tr '\0' ' ' | sed 's/ $//')
  user=$(ps -o user= -p "$pid0" | tr -d ' ')
  if sudo -n nsenter -t "$pid0" -m -- test -e "$REPO/package.json"; then tree_visible=true; else tree_visible=false; fi

  # P3 · negativos con usuarios reales
  id -u s9cpx-arena >/dev/null 2>&1 || sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin s9cpx-arena
  local who t a err
  for who in s9cpx-arena s9proxy; do
    for t in \
      "append-bundle|printf x >>$BUNDLE_DST" \
      "create-in-libdir|touch /usr/local/lib/s9-docker-proxy/evil.mjs" \
      "rename-bundle|mv $BUNDLE_DST $BUNDLE_DST.old" \
      "append-lock|printf x >>$LOCK_DST" \
      "create-in-policydir|touch /etc/s9-docker-proxy/DIGESTS.lock.new" \
      "append-unit|printf x >>/etc/systemd/system/$PROXY_UNIT" \
      "create-dropin|mkdir /etc/systemd/system/$PROXY_UNIT.d" \
      "append-env|printf x >>$PROXY_ENV"; do
      a=${t#*|}
      err=$(sudo -n -u "$who" env LC_ALL=C sh -c "$a" 2>&1)
      rc=$?
      jq -nc --arg who "$who" --arg id "${t%%|*}" --argjson rc $rc --arg err "$err" \
        '{who:$who, id:$id, rc:$rc, eacces: ($err | test("Permission denied")), err:$err}' >>"$STATE/privilege-neg.jsonl"
    done
  done

  # P4 · mutaciones con root real (copia de seguridad antes; restauración con dueño/modo)
  sudo -n install -d -m 0700 /run/s9cpx-bak
  sudo -n cp -a /etc/systemd/system/$PROXY_UNIT "$PROXY_ENV" /run/s9cpx-bak/
  restore_unit() { sudo -n cp -a "/run/s9cpx-bak/$PROXY_UNIT" "/etc/systemd/system/$PROXY_UNIT"; sudo -n rm -rf "/etc/systemd/system/$PROXY_UNIT.d"; sudo -n systemctl daemon-reload; }
  restore_env() { sudo -n cp -a "/run/s9cpx-bak/$(basename "$PROXY_ENV")" "$PROXY_ENV"; }
  mutate() { # id motivo(regex) aplicar revertir
    local id=$1 reason=$2 apply=$3 revert=$4 red green found
    eval "$apply" >>"$LOGS/privilege-mutations.log" 2>&1
    "${PX[@]}" preflight >"$LOGS/privilege-mut-$id.log" 2>&1
    red=$?
    if grep -E "ROJO:" "$LOGS/privilege-mut-$id.log" | grep -qE "$reason"; then found=true; else found=false; fi
    eval "$revert" >>"$LOGS/privilege-mutations.log" 2>&1
    "${PX[@]}" preflight >"$LOGS/privilege-mut-$id-revert.log" 2>&1
    green=$?
    jq -nc --arg id "$id" --arg reason "$reason" --argjson red $red --argjson found $found --argjson green $green \
      '{id:$id, reason:$reason, redRc:$red, reasonFound:$found, revertedRc:$green}' >>"$STATE/privilege-mut.jsonl"
  }
  mutate bundle-group-writable "docker-proxy\.mjs es escribible por grupo" \
    "sudo -n chmod g+w $BUNDLE_DST" "sudo -n chmod g-w $BUNDLE_DST"
  mutate libdir-owned-by-nonroot "s9-docker-proxy es propiedad de uid=" \
    "sudo -n chown s9cpx-arena /usr/local/lib/s9-docker-proxy" "sudo -n chown root /usr/local/lib/s9-docker-proxy"
  mutate lockdir-owned-by-nonroot "etc/s9-docker-proxy es propiedad de uid=" \
    "sudo -n chown s9cpx-arena /etc/s9-docker-proxy" "sudo -n chown root /etc/s9-docker-proxy"
  mutate env-allowlist-in-tree "debe ser la copia de root" \
    "sudo -n sed -i 's|^DOCKER_PROXY_IMAGE_ALLOWLIST=.*|DOCKER_PROXY_IMAGE_ALLOWLIST=$REPO/runtimes/DIGESTS.lock|' $PROXY_ENV" "restore_env"
  mutate unit-npx-tsx "ExecStart (debe ser exactamente|efectivo)" \
    "sudo -n sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/npx tsx apps/bot-manager/src/docker-proxy-main.ts|' /etc/systemd/system/$PROXY_UNIT; sudo -n systemctl daemon-reload" "restore_unit"
  mutate unit-workdir-opt "WorkingDirectory" \
    "sudo -n sed -i 's|^UMask=0077|UMask=0077\nWorkingDirectory=/opt/s9-ai-arena|' /etc/systemd/system/$PROXY_UNIT; sudo -n systemctl daemon-reload" "restore_unit"
  mutate unit-dropin "drop-ins" \
    "sudo -n mkdir -p /etc/systemd/system/$PROXY_UNIT.d; printf '[Service]\nEnvironment=X=1\n' | sudo -n tee /etc/systemd/system/$PROXY_UNIT.d/x.conf; sudo -n systemctl daemon-reload" "restore_unit"
  sudo -n rm -rf /run/s9cpx-bak

  # P5
  "${PX[@]}" preflight >"$LOGS/privilege-preflight-2.log" 2>&1
  local pf2=$? pid1 active
  pid1=$(systemctl show -p MainPID --value "$PROXY_UNIT")
  active=$(systemctl is-active "$PROXY_UNIT")

  jq -n --argjson pf1 $pf1 --argjson pf2 $pf2 --arg exe "$exe" --arg cmd "$cmd" --arg user "$user" \
    --argjson tv $tree_visible --arg pid0 "$pid0" --arg pid1 "$pid1" --arg active "$active" \
    --arg expected "$EXPECTED_EXECSTART" --arg nodeReal "$(readlink -f /usr/bin/node)" \
    --slurpfile neg "$STATE/privilege-neg.jsonl" --slurpfile mut "$STATE/privilege-mut.jsonl" \
    --slurpfile bundle "$OUT/proxy-bundle.json" \
    '{preflightInitialRc: $pf1, preflightFinalRc: $pf2,
      effective: {exe: $exe, nodeReal: $nodeReal, cmdline: $cmd, expectedCmdline: $expected, user: $user, treeVisible: $tv},
      bundle: ($bundle[0] // null),
      negatives: $neg, mutations: $mut,
      process: {mainPidBefore: $pid0, mainPidAfter: $pid1, active: $active}}' >"$OUT/privilege.json"
  log "privilegio: preflight $pf1→$pf2, exe=$exe user=$user treeVisible=$tree_visible, negativos=$(jq -s 'map(select(.rc != 0 and .eacces)) | length' "$STATE/privilege-neg.jsonl")/$(wc -l <"$STATE/privilege-neg.jsonl"), mutaciones=$(jq -s 'map(select(.redRc == 1 and .reasonFound and .revertedRc == 0)) | length' "$STATE/privilege-mut.jsonl")/$(wc -l <"$STATE/privilege-mut.jsonl")"
}

# ── up ──────────────────────────────────────────────────────────────────────
do_up() {
  "${DC[@]}" pull "${INFRA_SERVICES[@]}" >"$LOGS/pull.log" 2>&1 || { log "pull de postgres/queue falló"; return 1; }
  # 1) Redes y contenedores SIN arrancar: crea s9-bot-control y su bridge con 10.89.250.1.
  "${DC[@]}" up --no-start --no-build "${STACK[@]}" >"$LOGS/up-no-start.log" 2>&1 ||
    { log "up --no-start falló"; return 1; }
  ip -4 -o addr show "$BRIDGE" >"$OUT/bridge.txt" 2>&1 || log "aviso: no existe el bridge $BRIDGE"
  # 2) El proxy, PROCESO DEL HOST, escuchando SÓLO en el gateway de bot-control, instalado
  #    COMO EN PRODUCCIÓN (TD-062): bundle construido SIN root, `install-docker-proxy.sh
  #    install` (root) lo copia a /usr/local/lib/s9-docker-proxy y la allowlist a
  #    /etc/s9-docker-proxy, y la unidad systemd REAL (User=s9proxy, ProtectHome: el checkout
  #    de /home/runner es invisible para el proceso) lo ejecuta con /usr/bin/node. Nada de tsx.
  install_proxy_as_production || { log "instalación del proxy falló (logs/proxy-install.log)"; return 1; }
  local ok=0
  for _ in $(seq 1 60); do
    ss -Hltn "sport = :$PROXY_PORT" | grep -q . && { ok=1; break; }
    systemctl is-failed --quiet "$PROXY_UNIT" && break
    sleep 1
  done
  systemctl show -p MainPID --value "$PROXY_UNIT" >"$STATE/proxy.pid"
  [ $ok -eq 1 ] || { log "el s9-docker-proxy no escucha (journalctl -u $PROXY_UNIT)"; return 1; }
  # 3) Eventos de Docker desde ANTES del primer contenedor que pueda crear el proxy.
  docker events --filter type=container --format '{{json .}}' >"$LOGS/docker-events.jsonl" 2>&1 &
  echo $! >"$STATE/events.pid"
  # 4) Infra → contenido base (cli.ts bootstrap, nunca seed) → aplicación, por healthchecks.
  "${DC[@]}" up -d --no-build --wait --wait-timeout 240 "${INFRA_SERVICES[@]}" >"$LOGS/up-infra.log" 2>&1 ||
    { log "postgres/queue no llegan a healthy"; return 1; }
  "${DC[@]}" run --rm --no-deps -T api npx tsx apps/api/src/db/cli.ts bootstrap >"$LOGS/bootstrap.log" 2>&1 ||
    { log "bootstrap de la BD falló"; return 1; }
  "${DC[@]}" up -d --no-build --wait --wait-timeout 300 "${APP_SERVICES[@]}" >"$LOGS/up-app.log" 2>&1
  local rc=$?
  "${DC[@]}" ps -a --format json >"$OUT/compose-ps.json" 2>/dev/null
  [ $rc -eq 0 ] || { log "el stack no llega a healthy (logs/up-app.log)"; return 1; }
  # 5) Los dos ejecutores anuncian ejecución REAL (no apagada, no stub).
  local tw bw
  for _ in $(seq 1 60); do
    tw=$(docker logs "$(cid tournament-worker)" 2>&1 | grep -c '"battleExecution":"container"')
    bw=$(docker logs "$(cid bot-build-worker)" 2>&1 | grep -c '"sandbox":"container"')
    [ "$tw" -gt 0 ] && [ "$bw" -gt 0 ] && break
    sleep 2
  done
  jq -n --argjson tw "${tw:-0}" --argjson bw "${bw:-0}" \
    '{tournamentWorkerContainerExecution: ($tw > 0), buildWorkerContainerSandbox: ($bw > 0)}' >"$OUT/readiness.json"
  services_json
  log "stack arriba; proxy pid $(cat "$STATE/proxy.pid"); ejecutores: tw=$tw bw=$bw"
}

# Identidad y posición de red REAL (docker inspect) de cada servicio. Del entorno sólo se
# extrae DOCKER_PROXY_URL (nunca se vuelca el entorno entero).
services_json() {
  local s id
  for s in "${STACK[@]}"; do
    id=$(cid "$s")
    [ -n "$id" ] || { jq -nc --arg s "$s" '{service:$s, missing:true}'; continue; }
    docker inspect "$id" | jq -c --arg s "$s" '.[0] | {
      service: $s, id: .Id[0:12], name: (.Name | ltrimstr("/")), image: .Config.Image,
      revision: (.Config.Labels["org.opencontainers.image.revision"] // null),
      running: .State.Running, health: (.State.Health.Status // null),
      networks: (.NetworkSettings.Networks | to_entries | map({name: .key, ip: .value.IPAddress})),
      extraHosts: (.HostConfig.ExtraHosts // []),
      dockerProxyUrl: ((.Config.Env // []) | map(select(startswith("DOCKER_PROXY_URL="))) | .[0] // null | if . then ltrimstr("DOCKER_PROXY_URL=") else null end),
      mountsDockerSock: ((.Mounts // []) | map(.Source) | any(test("docker\\.sock"))),
      privileged: .HostConfig.Privileged }'
  done | jq -s . >"$OUT/services.json"
}

# ── probes ──────────────────────────────────────────────────────────────────
# probe_from <id-contenedor> <MÉTODO> <ruta> [cuerpo|-]  → una línea JSON
probe_from() {
  local target=$1 method=$2 path=$3 body=${4:--}
  local b="-"
  [ "$body" != "-" ] && b="/bodies/$body.json"
  docker run --rm --network "container:$target" -v "$HERE:/probe:ro" -v "$STATE/bodies:/bodies:ro" \
    --entrypoint node --user 65534:65534 --read-only --cap-drop ALL --security-opt no-new-privileges \
    "$PROBE_IMG" /probe/probe.mjs "$GW_IP" "$PROXY_PORT" "$method" "$path" "$b" 6000 2>>"$LOGS/probes.err" ||
    echo '{"tcp":"PROBE_ERROR","http":null}'
}

# Redes REALES del contenedor con su flag internal (docker network inspect).
target_networks() {
  local id=$1 n
  for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id"); do
    jq -nc --arg n "$n" --argjson i "$(docker network inspect -f '{{.Internal}}' "$n")" '{name:$n, internal:$i}'
  done | jq -sc .
}

# Equivalentes DECLARADOS (C5): backup no se levanta (pide restic/SFTP reales), así que se
# crea un contenedor en EXACTAMENTE sus redes del compose resuelto; y un «bot» en `arena`
# con la postura de un bot (los bots no deben alcanzar el proxy).
make_equivalents() {
  local nets first n
  mapfile -t nets < <(jq -r --arg p "$PROJECT" '.services.backup.networks // {} | keys[] as $k | ($k)' "$OUT/compose-config.json" |
    while read -r k; do jq -r --arg k "$k" '.networks[$k].name // $k' "$OUT/compose-config.json"; done)
  if [ ${#nets[@]} -gt 0 ]; then
    first=${nets[0]}
    docker create --name "$PROJECT-backup-equivalent" --network "$first" --entrypoint sleep --user 65534:65534 \
      --read-only --cap-drop ALL "$PROBE_IMG" 3600 >/dev/null
    for n in "${nets[@]:1}"; do docker network connect "$n" "$PROJECT-backup-equivalent"; done
    docker start "$PROJECT-backup-equivalent" >/dev/null
  fi
  # --dns 0.0.0.0 como el create de ProxyContainerRunner (HostConfig.Dns): misma resolución.
  docker run -d --name "$PROJECT-bot-equivalent" --network arena --dns 0.0.0.0 --entrypoint sleep --user 10001:10001 \
    --read-only --cap-drop ALL --security-opt no-new-privileges "$PROBE_IMG" 3600 >/dev/null
  jq -nc --argjson b "$(printf '%s\n' "${nets[@]}" | jq -R . | jq -sc .)" \
    '{"backup-equivalent": {declared: "contenedor en las MISMAS redes que el servicio backup del compose resuelto (backup no se arranca: necesita restic/SFTP reales)", networks: $b},
      "bot-equivalent": {declared: "contenedor sólo en la red arena con la postura de un bot", networks: ["arena"]}}' \
    >"$OUT/equivalents.json"
}

# probe_phase <A|B>: create VÁLIDO desde cada objetivo. ACCESS ⇒ el contenedor creado se
# retira al momento (lo identifica su Id, nunca un nombre).
probe_phase() {
  local phase=$1 s id line created
  : >"$STATE/probes-$phase.jsonl"
  for s in "${STACK[@]}" backup-equivalent bot-equivalent; do
    case "$s" in
      *-equivalent) id=$(docker ps -q --filter "name=^$PROJECT-$s\$") ;;
      *) id=$(cid "$s") ;;
    esac
    [ -n "$id" ] || { jq -nc --arg s "$s" '{target:$s, missing:true}' >>"$STATE/probes-$phase.jsonl"; continue; }
    line=$(probe_from "$id" POST /containers/create valid)
    created=$(echo "$line" | jq -r 'select(.http.status == 201) | .http.body | fromjson? | .Id // empty')
    [ -n "$created" ] && docker rm -f "$created" >/dev/null 2>&1
    echo "$line" | jq -c --arg s "$s" --argjson nets "$(target_networks "$id")" --arg created "${created:-}" \
      '. + {target:$s, networks:$nets, createdAndRemoved: ($created != "")}' >>"$STATE/probes-$phase.jsonl"
  done
  jq -s . "$STATE/probes-$phase.jsonl" >"$OUT/probes-$phase.json"
  log "sondas fase $phase: $(jq -r 'map("\(.target)=\(.tcp // "?")/\(.http.status // "-")") | join(" ")' "$OUT/probes-$phase.json")"
}

# s9-firewall.sh de DEV-SECOPS (S9FW_*; sus defectos son las constantes del contrato). Se
# fijan igualmente aquí para que el job pruebe EXACTAMENTE el contrato, y S9FW_CONF apunta
# a un fichero inexistente: ninguna configuración del runner puede cambiar las reglas.
# Segunda medida INDEPENDIENTE (coordinador): la sonda de DEV-NET (scripts/ops/network-probe.mjs)
# sobre el mismo proyecto, con la pertenencia esperada. rc 0 PASS · 1 FAIL · 2 no medido (≠ PASS).
netprobe() { # netprobe <fase> [flags…]
  local phase=$1 rc
  shift
  if [ ! -f "$REPO/scripts/ops/network-probe.mjs" ]; then
    jq -n '{rc: null, missing: true}' >"$OUT/network-probe-$phase.json"
    return
  fi
  node "$REPO/scripts/ops/network-probe.mjs" --project "$PROJECT" \
    --expect-members arena-engine,bot-build-worker,tournament-worker --probe-image "$PROBE_IMG" "$@" --json >"$STATE/netprobe-$phase.json" 2>"$LOGS/netprobe-$phase.err"
  rc=$?
  jq -n --argjson rc $rc --slurpfile r "$STATE/netprobe-$phase.json" '{rc: $rc, result: ($r[0] // null)}' \
    >"$OUT/network-probe-$phase.json" 2>/dev/null || jq -n --argjson rc $rc '{rc: $rc, result: null}' >"$OUT/network-probe-$phase.json"
  log "sonda DEV-NET fase $phase: rc=$rc"
}

firewall() { # firewall <apply|check|remove>
  [ -f "$FIREWALL" ] || { echo "no existe $FIREWALL"; return 127; }
  sudo -n env S9FW_CONF=/nonexistent S9FW_BRIDGE="$BRIDGE" S9FW_SUBNET="$SUBNET" S9FW_PROXY_IP="$GW_IP" \
    S9FW_PROXY_PORT="$PROXY_PORT" bash "$FIREWALL" "$1"
}

pg_state() {
  docker inspect "$(cid postgres)" | jq -c '.[0].State | {Running, Status, StartedAt, Pid, RestartCount: (.RestartCount // null)}'
}

do_probes() {
  make_equivalents
  # Diagnóstico de C3/C4 desde la posición de un bot (evidencia, no veredicto).
  docker run --rm --network "container:$PROJECT-bot-equivalent" -v "$HERE:/probe:ro" --entrypoint node \
    --user 65534:65534 --read-only --cap-drop ALL "$PROBE_IMG" /probe/bot-view.mjs tournament-worker:8081 \
    >"$OUT/bot-view.json" 2>"$LOGS/bot-view.err"
  docker exec "$PROJECT-bot-equivalent" cat /etc/resolv.conf >"$LOGS/bot-view-resolv.txt" 2>&1
  log "vista de un bot: $(cat "$OUT/bot-view.json" 2>/dev/null)"
  # Fase A: SIN firewall. Mide la capa (a) red y la capa (c) control de cliente del proxy.
  probe_phase A
  netprobe A
  # Fase B: CON el firewall de DEV-SECOPS. Mide la capa (b).
  local fa fc
  firewall apply >"$LOGS/firewall-apply.log" 2>&1
  fa=$?
  firewall check >"$LOGS/firewall-check.log" 2>&1
  fc=$?
  { sudo -n iptables -S INPUT; sudo -n iptables -S S9-HOST-GUARD; } >"$LOGS/iptables-input.txt" 2>&1
  jq -n --argjson a $fa --argjson c $fc --arg s "$FIREWALL" '{script:$s, applyRc:$a, checkRc:$c}' >"$OUT/firewall.json"
  log "firewall: apply rc=$fa check rc=$fc"
  probe_phase B
  netprobe B --expect-default-route-blocked

  # Escucha del proxy en el host: SÓLO 10.89.250.1:2375. Y desde el propio host, por
  # loopback, docker0 y la IP principal del runner: nada escucha.
  ss -Hltn "sport = :$PROXY_PORT" | awk '{print $4}' | jq -R . | jq -s '{listeners: .}' >"$STATE/listeners.json"
  local main_ip h
  main_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  : >"$STATE/host-probes.jsonl"
  for h in 127.0.0.1 172.17.0.1 ${main_ip:-}; do
    node "$HERE/probe.mjs" "$h" "$PROXY_PORT" GET /containers/json - 3000 | jq -c --arg h "$h" '. + {from:"host", to:$h}' >>"$STATE/host-probes.jsonl"
  done
  jq -s --slurpfile l "$STATE/listeners.json" '{listeners: $l[0].listeners, hostProbes: .}' "$STATE/host-probes.jsonl" >"$OUT/host-checks.json"
}

# C6 · política desde un consumidor LEGÍTIMO (bot-build-worker): la capa de red y la de
# cliente dejan pasar; sólo pueden denegar la allowlist de imágenes y la propiedad.
# Va DESPUÉS del flujo a propósito: con un proxy sin control de propiedad (calibración)
# estas peticiones paran de verdad postgres y el gateway, y eso no debe enmascarar C3/C4.
do_policy() {
  local bw pg gw
  bw=$(cid bot-build-worker)
  pg=$(docker inspect -f '{{.Id}}' "$(cid postgres)")
  gw=$(docker inspect -f '{{.Id}}' "$(cid gateway)")
  local before after
  before=$(pg_state)
  : >"$STATE/policy.jsonl"
  pol() { # pol <id> <esperado> <MÉTODO> <ruta> [cuerpo]
    local line
    line=$(probe_from "$bw" "$3" "$4" "${5:--}")
    echo "$line" | jq -c --arg id "$1" --argjson exp "$2" '. + {id:$id, expect:$exp}' >>"$STATE/policy.jsonl"
    echo "$line"
  }
  pol create-foreign-postgres 403 POST /containers/create foreign-postgres >/dev/null
  pol create-foreign-base-python 403 POST /containers/create foreign-base-python >/dev/null
  pol create-foreign-digest 403 POST /containers/create foreign-digest >/dev/null
  pol create-label-forgery 403 POST /containers/create label-forgery >/dev/null
  pol stop-postgres-by-id 403 POST "/containers/$pg/stop" >/dev/null
  pol stop-postgres-by-name 403 POST "/containers/$(docker inspect -f '{{.Name}}' "$pg" | tr -d /)/stop" >/dev/null
  pol start-postgres 403 POST "/containers/$pg/start" >/dev/null
  pol inspect-postgres 403 GET "/containers/$pg/json" >/dev/null
  pol stats-postgres 403 GET "/containers/$pg/stats?stream=false" >/dev/null
  pol stop-gateway 403 POST "/containers/$gw/stop" >/dev/null
  # Control positivo de la propiedad: lo creado por el proxy SÍ se puede inspeccionar.
  local made own
  made=$(pol positive-create 201 POST /containers/create valid | jq -r '.http.body | fromjson? | .Id // empty')
  if [ -n "$made" ]; then
    pol positive-inspect-own 200 GET "/containers/$made/json" >/dev/null
    own=$(docker inspect "$made" | jq -c '.[0].Config.Labels | with_entries(select(.key | startswith("s9.")))')
    docker rm -f "$made" >/dev/null 2>&1
  fi
  sleep 2
  after=$(pg_state)
  jq -s --argjson b "$before" --argjson a "$after" --argjson own "${own:-null}" \
    '{requests: ., postgres: {before: $b, after: $a}, ownLabels: $own}' "$STATE/policy.jsonl" >"$OUT/policy.json"
  log "política: $(jq -r '.requests | map("\(.id)=\(.http.status // .tcp)") | join(" ")' "$OUT/policy.json")"
}

# ── flow ────────────────────────────────────────────────────────────────────
do_flow() {
  date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE/flow-start"
  # C9 · los contenedores de bot llevan AutoRemove: sus logs se siguen EN VIVO desde que
  # arrancan (después de salir ya no existen).
  mkdir -p "$LOGS/containers/bots"
  (
    docker events --filter type=container --filter event=start --format '{{.Actor.ID}} {{.Actor.Attributes.name}}' |
      while read -r id name; do
        case "$name" in bot-*) docker logs -f "$id" >"$LOGS/containers/bots/$name.log" 2>&1 & ;; esac
      done
  ) &
  local follower=$!
  node "$HERE/flow.mjs" "http://127.0.0.1:$HTTP_PORT" "$OUT/flow.json" >"$LOGS/flow.log" 2>&1
  local rc=$?
  kill "$follower" 2>/dev/null
  pkill -f "docker events --filter type=container --filter event=start" 2>/dev/null
  date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE/flow-end"
  log "FLOW_RC=$rc ($(tail -1 "$LOGS/flow.log"))"
  return 0 # el veredicto lo da assert-container-proxy-e2e.mjs con flow.json
}

# ── evidence ────────────────────────────────────────────────────────────────
do_evidence() {
  local s id f
  # Decisiones del proxy (JSON por línea) desde journald: corre como unidad systemd (TD-062).
  sudo -n journalctl -u "$PROXY_UNIT" --no-pager -o cat >"$LOGS/docker-proxy.log" 2>&1
  [ -f "$STATE/events.pid" ] && kill "$(cat "$STATE/events.pid")" 2>/dev/null
  [ -f "$LOGS/docker-events.jsonl" ] && cp "$LOGS/docker-events.jsonl" "$OUT/docker-events.jsonl"
  for f in flow-start flow-end; do [ -f "$STATE/$f" ] && cp "$STATE/$f" "$OUT/$f.txt"; done
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' >"$LOGS/containers/docker-ps.txt" 2>&1
  for s in "${STACK[@]}"; do
    id=$(cid "$s")
    [ -n "$id" ] && docker logs "$id" >"$LOGS/containers/$s.log" 2>&1
  done
  for id in $(docker ps -aq --filter 'name=^bot-'); do docker logs "$id" >"$LOGS/containers/bot-$id.log" 2>&1; done
  # Redes saneadas: nombre, interna, subred/gateway y contenedores con su IP (runner efímero).
  docker network ls -q | while read -r n; do
    docker network inspect "$n" | jq -c '.[0] | {Name, Driver, Internal, IPAM: .IPAM.Config,
      BridgeName: (.Options["com.docker.network.bridge.name"] // null),
      Containers: ((.Containers // {}) | to_entries | map({name: .value.Name, ip: .value.IPv4Address}))}'
  done | jq -s . >"$OUT/networks.json" 2>/dev/null
  [ -f "$OUT/services.json" ] || services_json
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "evidencia cerrada $now" >>"$OUT/summary.txt"
}

# ── cleanup ─────────────────────────────────────────────────────────────────
do_cleanup() {
  # TD-062: el proxy es la unidad systemd instalada; se retira con el instalador.
  "${PX[@]}" rollback >"$LOGS/proxy-rollback.log" 2>&1
  [ -f "$STATE/events.pid" ] && kill "$(cat "$STATE/events.pid")" 2>/dev/null
  firewall remove >"$LOGS/firewall-remove.log" 2>&1
  docker rm -f "$PROJECT-backup-equivalent" "$PROJECT-bot-equivalent" >/dev/null 2>&1
  docker ps -aq --filter 'label=s9.managed=true' | xargs -r docker rm -f >/dev/null 2>&1
  docker ps -aq --filter 'name=^bot-' | xargs -r docker rm -f >/dev/null 2>&1
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
  sudo -n rm -rf "$REPO/infrastructure/secrets/"*.txt "$REPO/infrastructure/secrets/"*.pem "$REPO/infrastructure/secrets/tls" \
    "$REPO/infrastructure/secrets/restic_ssh_key"* "$REPO/infrastructure/secrets/restic_ssh_known_hosts" 2>/dev/null
  rm -rf "$STATE" 2>/dev/null || sudo -n rm -rf "$STATE"
  echo "limpieza: stack $PROJECT retirado, proxy parado, firewall retirado, estado borrado"
}

case "$CMD" in
  prepare) do_prepare ;;
  build) do_build ;;
  up) do_up ;;
  probes) do_probes ;;
  policy) do_policy ;;
  privilege) do_privilege ;;
  flow) do_flow ;;
  evidence) do_evidence ;;
  cleanup) do_cleanup ;;
  *)
    echo "subcomando desconocido: $CMD" >&2
    exit 2
    ;;
esac
