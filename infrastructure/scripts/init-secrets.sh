#!/usr/bin/env bash
# Genera los archivos de secretos del stack (paso 1 de docs/despliegue.md).
# Idempotente: nunca sobrescribe un secreto existente.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
mkdir -p "$DIR/tls"

# Los contenedores corren como usuario sin privilegios (USER node, uid 1000) y
# Compose monta cada secreto con el owner del archivo del host: fuera de swarm
# ignora uid/gid/mode, así que un 0600 root:root da EACCES al leer
# /run/secrets/*. El dueño pasa a ser el uid del runtime; el modo sigue 0400.
RUNTIME_UID="${RUNTIME_UID:-1000}"
RUNTIME_GID="${RUNTIME_GID:-1000}"

harden() {
  local f="$DIR/$1"
  chown "$RUNTIME_UID:$RUNTIME_GID" "$f" 2>/dev/null || true
  chmod 0400 "$f"
}

gen() {
  local f="$DIR/$1"
  if [ -s "$f" ]; then
    echo "ya existe: $1 (no se toca)"
  else
    umask 077
    head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 40 > "$f"
    echo "generado:  $1"
  fi
  harden "$1"
}

gen postgres_password.txt
gen jwt_secret.txt
gen grafana_admin_password.txt
gen restic_password.txt
# B2 · secreto interno api<->arena-engine (POST /run). Mismo fichero montado
# en ambos servicios (docker-compose.yml): generarlo aquí basta para que
# coincidan. Sin este secreto, /battles/:id/run sigue en 503
# runner_unavailable (aunque S9_ENABLE_REAL_BATTLE_RUNS=1) y POST /run de
# arena-engine responde 401 a cualquier petición: fail closed por defecto.
gen arena_engine_internal_secret.txt
# B8 · secreto interno api<->replay-service para la INGESTA de replays y el
# barrido de retención (cabecera x-replay-ingest-auth). Mismo fichero montado en
# ambos servicios (docker-compose.yml). Sin él, replay-service responde 401 a
# toda escritura y la API reporta `replay.ingested: false`: fail closed.
gen replay_ingest_secret.txt

# R-DEPLOY · R2: clave de firma de artefactos (ed25519, PEM PKCS8) para el
# bot-build-worker (ARTIFACT_SIGNING_KEY_FILE, ERR-SEC-15). Idempotente.
if [ ! -s "$DIR/artifact_signing_key.pem" ]; then
  if command -v openssl >/dev/null; then
    umask 077
    openssl genpkey -algorithm ed25519 -out "$DIR/artifact_signing_key.pem" 2>/dev/null
    echo "generado:  artifact_signing_key.pem (ed25519)"
  else
    echo "AVISO: sin openssl; el bot-build-worker exige artifact_signing_key.pem (ed25519 PEM PKCS8)"
  fi
fi
[ -f "$DIR/artifact_signing_key.pem" ] && harden artifact_signing_key.pem

# stream_key es del proveedor (YouTube): placeholder vacío que el operador rellena.
if [ ! -f "$DIR/stream_key.txt" ]; then
  umask 077; : > "$DIR/stream_key.txt"
  echo "creado vacío: stream_key.txt (rellenar con la clave de YouTube si se usa streaming)"
fi
harden stream_key.txt

# fix/backup-sftp-scheduled-runtime: clave SSH dedicada al backend sftp: de
# restic. Se puede generar sin intervención del operador (es sólo un par de
# claves; la parte pública hay que añadirla a authorized_keys en el host de
# respaldo). El known_hosts NO: aceptar a ciegas la huella del host de
# respaldo sería StrictHostKeyChecking=no con otro nombre, así que se deja
# vacío para que el operador lo rellene tras VERIFICAR la huella fuera de
# banda (ver infrastructure/.env.example).
if [ ! -s "$DIR/restic_ssh_key" ]; then
  if command -v ssh-keygen >/dev/null; then
    umask 077
    ssh-keygen -t ed25519 -N "" -C "s9-ai-arena-backup" -f "$DIR/restic_ssh_key" >/dev/null
    echo "generado:  restic_ssh_key (ed25519) — añadir $DIR/restic_ssh_key.pub a authorized_keys del host de respaldo"
  else
    echo "AVISO: sin ssh-keygen; el backend sftp exige restic_ssh_key (clave privada OpenSSH)"
  fi
fi
[ -f "$DIR/restic_ssh_key" ] && harden restic_ssh_key
if [ ! -f "$DIR/restic_ssh_known_hosts" ]; then
  umask 077; : > "$DIR/restic_ssh_known_hosts"
  echo "creado vacío: restic_ssh_known_hosts (rellenar con 'ssh-keyscan -t ed25519 <backup-host>' TRAS verificar la huella; NUNCA StrictHostKeyChecking=no)"
fi
harden restic_ssh_known_hosts

# TLS solo en modo standalone: autofirmado si no hay certificados (docs/despliegue.md).
if [ ! -f "$DIR/tls/fullchain.pem" ]; then
  if command -v openssl >/dev/null; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -subj "/CN=${S9_DOMAIN:-arena.local}" \
      -keyout "$DIR/tls/privkey.pem" -out "$DIR/tls/fullchain.pem" 2>/dev/null
    echo "generado:  tls/ autofirmado (sustituir por certificados reales en producción standalone)"
  else
    echo "AVISO: sin openssl; en modo standalone hay que aportar tls/fullchain.pem y tls/privkey.pem"
  fi
fi

echo "Secretos en $DIR (fuera del control de versiones)."
