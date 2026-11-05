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
  # EQ5c (revisión EQ6b, P2-3) · el chown ya no falla en silencio: si no se puede
  # (sin privilegios) y el dueño no es el uid del runtime, el contenedor no podrá
  # leer el secreto. Los servicios que lo EXIGEN fallan en cerrado (p. ej. el
  # control del streamer: 401 y /healthz 503), así que se avisa aquí, en voz alta.
  if ! chown "$RUNTIME_UID:$RUNTIME_GID" "$f" 2>/dev/null; then
    local owner
    owner="$(stat -c %u "$f" 2>/dev/null || echo '?')"
    if [ "$owner" != "$RUNTIME_UID" ]; then
      echo "AVISO: no se pudo dar $1 al uid $RUNTIME_UID (dueño actual: $owner); el contenedor no podrá leerlo." \
        "Repite init-secrets.sh con privilegios o ajusta RUNTIME_UID/RUNTIME_GID." >&2
    fi
  fi
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

# REVIEW (cierre funcional) · clave PÚBLICA de verificación (PEM SPKI) para el
# tournament-worker (ARTIFACT_VERIFY_KEY_FILE): se DERIVA siempre de la privada,
# así que no puede divergir; se regenera si falta o si no casa con la privada.
if [ -s "$DIR/artifact_signing_key.pem" ] && command -v openssl >/dev/null; then
  umask 077
  openssl pkey -in "$DIR/artifact_signing_key.pem" -pubout -out "$DIR/artifact_verify_key.pem.tmp" 2>/dev/null &&
    if ! cmp -s "$DIR/artifact_verify_key.pem.tmp" "$DIR/artifact_verify_key.pem" 2>/dev/null; then
      mv "$DIR/artifact_verify_key.pem.tmp" "$DIR/artifact_verify_key.pem"
      echo "generado:  artifact_verify_key.pem (pública de artifact_signing_key.pem)"
    else
      rm -f "$DIR/artifact_verify_key.pem.tmp"
    fi
fi
[ -f "$DIR/artifact_verify_key.pem" ] && harden artifact_verify_key.pem

# stream_key es del proveedor (YouTube): placeholder vacío que el operador rellena.
if [ ! -f "$DIR/stream_key.txt" ]; then
  umask 077; : > "$DIR/stream_key.txt"
  echo "creado vacío: stream_key.txt (rellenar con la clave de YouTube si se usa streaming)"
fi
harden stream_key.txt

# EQ5b §19 · Administración de streaming desde la web: secreto compartido
# api<->streamer para la API interna de control (cabecera x-streamer-auth).
gen streamer_control_secret.txt
# EQ5b §19 · par RSA-3072 para SELLAR las claves de emisión que se configuran
# desde la web: la API sólo tiene la PÚBLICA (cifra y guarda el sobre en la BD;
# no puede descifrar), el streamer la PRIVADA (abre en memoria al emitir).
# Rotarla invalida las credenciales guardadas: hay que volver a introducirlas.
if [ ! -s "$DIR/stream_secrets_private.pem" ]; then
  if command -v openssl >/dev/null; then
    umask 077
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$DIR/stream_secrets_private.pem" 2>/dev/null
    echo "generado:  stream_secrets_private.pem (RSA-3072)"
  else
    echo "AVISO: sin openssl; sin stream_secrets_private.pem no se pueden guardar claves de emisión desde la web"
  fi
fi
[ -f "$DIR/stream_secrets_private.pem" ] && harden stream_secrets_private.pem
if [ -s "$DIR/stream_secrets_private.pem" ] && command -v openssl >/dev/null; then
  umask 077
  openssl pkey -in "$DIR/stream_secrets_private.pem" -pubout -out "$DIR/stream_secrets_public.pem.tmp" 2>/dev/null &&
    if ! cmp -s "$DIR/stream_secrets_public.pem.tmp" "$DIR/stream_secrets_public.pem" 2>/dev/null; then
      mv "$DIR/stream_secrets_public.pem.tmp" "$DIR/stream_secrets_public.pem"
      echo "generado:  stream_secrets_public.pem (pública de stream_secrets_private.pem)"
    else
      rm -f "$DIR/stream_secrets_public.pem.tmp"
    fi
fi
[ -f "$DIR/stream_secrets_public.pem" ] && harden stream_secrets_public.pem

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
