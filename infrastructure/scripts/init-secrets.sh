#!/usr/bin/env bash
# Genera los archivos de secretos del stack (paso 1 de docs/despliegue.md).
# Idempotente: nunca sobrescribe un secreto existente.
#
# TD-064 · Este script lo ejecuta root en producción. La versión anterior
# seguía enlaces simbólicos ([ -s ], `> f`, chown/chmod sin -h, `openssl -out
# f.tmp`) dentro de un directorio que controlaba un usuario sin privilegios: un
# enlace plantado acababa en escritura o cambio de dueño de un fichero
# arbitrario del host. Reglas de esta versión:
#   1. El directorio se FIJA con `cd -P` y todo se hace con rutas relativas a
#      él: renombrar o sustituir padres después no cambia dónde se escribe.
#   2. Root sólo escribe en un directorio que sea suyo y no escribible por
#      grupo/otros. Si no lo es, se NIEGA (rc 3) salvo S9_SECRETS_ADOPT=1, que
#      primero se lo apropia (chown root:root, chmod 0755) y después valida
#      cada nombre: lo plantado antes de la apropiación sigue bloqueando.
#   3. Cada nombre que el script toca se mira con lstat: o no existe, o es un
#      fichero regular con nlink 1, o es un enlace ADMITIDO (destino literal
#      sin '/', a un fichero regular del mismo directorio, creado por root o
#      por el usuario que ejecuta). Cualquier otra cosa => abortar sin tocar.
#   4. Nada se escribe sobre un nombre existente: se escribe en un temporal
#      nuevo (mktemp, O_EXCL) y se instala con rename(2) (`mv -T`), que
#      sustituye la entrada de directorio y nunca sigue un enlace.
#   5. chown con -h y sólo sobre ficheros ya comprobados como regulares.
# S9_SECRETS_DIR (absoluta) permite ejecutar una COPIA de confianza del script
# contra el directorio real sin depender de la ubicación del script.
set -euo pipefail
umask 077

die() { echo "init-secrets: ERROR (TD-064): $*" >&2; exit 3; }

if [ -n "${S9_SECRETS_DIR:-}" ]; then
  DIR=$S9_SECRETS_DIR
else
  # Por stdin (bash -s) BASH_SOURCE está vacío: antes eso daba DIR=/secrets.
  [ -n "${BASH_SOURCE[0]:-}" ] || die "ejecutado sin ruta de script (¿por stdin?): define S9_SECRETS_DIR"
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
fi
case "$DIR" in /*) ;; *) die "el directorio de secretos debe ser una ruta absoluta: $DIR" ;; esac

# Los contenedores corren como usuario sin privilegios (USER node, uid 1000) y
# Compose monta cada secreto con el owner del archivo del host: fuera de swarm
# ignora uid/gid/mode, así que un 0600 root:root da EACCES al leer
# /run/secrets/*. El dueño pasa a ser el uid del runtime; el modo sigue 0400.
RUNTIME_UID="${RUNTIME_UID:-1000}"
RUNTIME_GID="${RUNTIME_GID:-1000}"
ME=$(id -u)
ADOPT="${S9_SECRETS_ADOPT:-0}"

lkind() { # tipo SIN seguir enlaces: absent | file | link | dir | other
  local t
  t=$(stat -c '%F' -- "$1" 2>/dev/null) || { echo absent; return; }
  case "$t" in
    "regular file"|"regular empty file") echo file ;;
    "symbolic link") echo link ;;
    directory) echo dir ;;
    *) echo other ;;
  esac
}

# Directorio de confianza: tipo directorio real, dueño root (o quien ejecuta si
# no es root) y sin escritura para grupo/otros.
trust_dir() {
  local d=$1 label=$2 st owner mode
  [ "$(lkind "$d")" = dir ] || die "$label no es un directorio real (¿enlace?)"
  st=$(stat -c '%u|%a' -- "$d")
  owner=${st%%|*}; mode=${st#*|}
  if [ "$owner" != 0 ] && [ "$owner" != "$ME" ]; then
    if [ "$ME" = 0 ] && [ "$ADOPT" = 1 ]; then
      chown -h 0:0 -- "$d"; chmod 0755 -- "$d"
      echo "apropiado: $label (era de uid $owner; ahora root:root 0755)"
    else
      die "$label es de uid $owner: root no escribe en un directorio que controla otro usuario. Corrige con 'chown root:root' y 'chmod 0755' (o S9_SECRETS_ADOPT=1)."
    fi
  elif (( 8#$mode & 8#022 )); then
    if [ "$ADOPT" = 1 ] || [ "$owner" = "$ME" ]; then
      chmod go-w -- "$d"
    else
      die "$label es escribible por grupo/otros (modo $mode)"
    fi
  fi
}

# Resuelve un nombre del directorio actual al fichero REGULAR sobre el que se
# opera. Deja el resultado en RES ("" si no existe). Aborta en cualquier otro caso.
RES=""
resolve() {
  local n=$1 k t lo
  RES=""
  k=$(lkind "$n")
  case "$k" in
    absent) return 0 ;;
    file)
      [ "$(stat -c '%h' -- "$n")" = 1 ] || die "$n tiene enlaces duros (nlink > 1)"
      RES=$n; return 0 ;;
    link)
      t=$(readlink -- "$n")
      lo=$(stat -c '%u' -- "$n")
      case "$t" in ""|.|..|*/*) die "$n es un enlace con destino no admitido ('$t')" ;; esac
      [ "$lo" = 0 ] || [ "$lo" = "$ME" ] || die "$n es un enlace de uid $lo (no admitido)"
      [ "$(lkind "$t")" = file ] || die "$n -> $t: el destino no es un fichero regular existente"
      [ "$(stat -c '%h' -- "$t")" = 1 ] || die "$t tiene enlaces duros (nlink > 1)"
      RES=$t; return 0 ;;
    *) die "$n existe y no es un fichero regular (tipo $k)" ;;
  esac
}

# Temporales: siempre RELATIVOS al directorio fijado (nunca se sale de él con cd).
TMPS=()
cleanup() { local f; for f in "${TMPS[@]}"; do rm -rf -- "$f" 2>/dev/null || true; done; }
trap cleanup EXIT
newtmp() { mktemp -- "${1:-}.init-secrets.XXXXXX"; }  # $1 = "" o "tls/"
track() { TMPS+=("$1"); }

harden_file() { # sólo sobre ficheros regulares ya comprobados
  [ "$(lkind "$1")" = file ] || die "harden: $1 no es un fichero regular"
  chown -h "$RUNTIME_UID:$RUNTIME_GID" -- "$1" 2>/dev/null || true
  chmod 0400 -- "$1"
}
harden() { resolve "$1"; [ -n "$RES" ] || die "harden: falta $1"; harden_file "$RES"; }

# Instala el temporal $1 en el nombre $2 (o en el destino de su enlace admitido).
install_as() {
  local tmp=$1 n=$2
  resolve "$n"
  mv -fT -- "$tmp" "${RES:-$n}"
}

# ------------------------------------------------------------- directorio
case "$(lkind "$DIR")" in
  absent) mkdir -m 0755 -- "$DIR" ;;
  dir) ;;
  *) die "$DIR no es un directorio real (¿enlace?)" ;;
esac
cd -P -- "$DIR" || die "no se puede entrar en $DIR"
trust_dir . "$DIR"
[ "$(lkind tls)" = absent ] && mkdir -m 0755 tls
trust_dir tls "$DIR/tls"

gen() {
  resolve "$1"
  if [ -n "$RES" ] && [ "$(stat -c '%s' -- "$RES")" -gt 0 ]; then
    echo "ya existe: $1 (no se toca)"
  else
    local t; t=$(newtmp); track "$t"
    head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 40 > "$t"
    harden_file "$t"
    install_as "$t" "$1"
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
resolve artifact_signing_key.pem
if [ -z "$RES" ] || [ "$(stat -c '%s' -- "$RES")" -eq 0 ]; then
  if command -v openssl >/dev/null; then
    t=$(newtmp); track "$t"
    openssl genpkey -algorithm ed25519 -out "$t" 2>/dev/null
    harden_file "$t"
    install_as "$t" artifact_signing_key.pem
    echo "generado:  artifact_signing_key.pem (ed25519)"
  else
    echo "AVISO: sin openssl; el bot-build-worker exige artifact_signing_key.pem (ed25519 PEM PKCS8)"
  fi
fi
resolve artifact_signing_key.pem
[ -n "$RES" ] && harden artifact_signing_key.pem

# REVIEW (cierre funcional) · clave PÚBLICA de verificación (PEM SPKI) para el
# tournament-worker (ARTIFACT_VERIFY_KEY_FILE): se DERIVA siempre de la privada,
# así que no puede divergir; se regenera si falta o si no casa con la privada.
resolve artifact_signing_key.pem; SIGN=$RES
if [ -n "$SIGN" ] && [ "$(stat -c '%s' -- "$SIGN")" -gt 0 ] && command -v openssl >/dev/null; then
  t=$(newtmp); track "$t"
  if openssl pkey -in "$SIGN" -pubout -out "$t" 2>/dev/null; then
    resolve artifact_verify_key.pem
    if [ -z "$RES" ] || ! cmp -s -- "$t" "$RES"; then
      harden_file "$t"
      install_as "$t" artifact_verify_key.pem
      echo "generado:  artifact_verify_key.pem (pública de artifact_signing_key.pem)"
    fi
  fi
fi
resolve artifact_verify_key.pem
[ -n "$RES" ] && harden artifact_verify_key.pem

# stream_key es del proveedor (YouTube): placeholder vacío que el operador rellena.
resolve stream_key.txt
if [ -z "$RES" ]; then
  t=$(newtmp); track "$t"; harden_file "$t"; install_as "$t" stream_key.txt
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
resolve restic_ssh_key
if [ -z "$RES" ] || [ "$(stat -c '%s' -- "$RES")" -eq 0 ]; then
  if command -v ssh-keygen >/dev/null; then
    td=$(mktemp -d -- ".init-secrets.XXXXXX"); track "$td"
    ssh-keygen -t ed25519 -N "" -C "s9-ai-arena-backup" -f "$td/k" >/dev/null
    harden_file "$td/k"
    chmod 0644 -- "$td/k.pub"
    install_as "$td/k" restic_ssh_key
    install_as "$td/k.pub" restic_ssh_key.pub
    echo "generado:  restic_ssh_key (ed25519) — añadir $DIR/restic_ssh_key.pub a authorized_keys del host de respaldo"
  else
    echo "AVISO: sin ssh-keygen; el backend sftp exige restic_ssh_key (clave privada OpenSSH)"
  fi
fi
resolve restic_ssh_key
[ -n "$RES" ] && harden restic_ssh_key
resolve restic_ssh_known_hosts
if [ -z "$RES" ]; then
  t=$(newtmp); track "$t"; harden_file "$t"; install_as "$t" restic_ssh_known_hosts
  echo "creado vacío: restic_ssh_known_hosts (rellenar con 'ssh-keyscan -t ed25519 <backup-host>' TRAS verificar la huella; NUNCA StrictHostKeyChecking=no)"
fi
harden restic_ssh_known_hosts

# TLS solo en modo standalone: autofirmado si no hay certificados (docs/despliegue.md).
# En tls/ no se admite ningún enlace: cada nombre o no existe o es regular.
for n in tls/fullchain.pem tls/privkey.pem; do
  case "$(lkind "$n")" in absent|file) ;; *) die "$n existe y no es un fichero regular" ;; esac
done
if [ "$(lkind tls/fullchain.pem)" = absent ]; then
  if command -v openssl >/dev/null; then
    tk=$(newtmp tls/); track "$tk"; tc=$(newtmp tls/); track "$tc"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -subj "/CN=${S9_DOMAIN:-arena.local}" \
      -keyout "$tk" -out "$tc" 2>/dev/null
    mv -fT -- "$tk" tls/privkey.pem
    mv -fT -- "$tc" tls/fullchain.pem
    echo "generado:  tls/ autofirmado (sustituir por certificados reales en producción standalone)"
  else
    echo "AVISO: sin openssl; en modo standalone hay que aportar tls/fullchain.pem y tls/privkey.pem"
  fi
fi

echo "Secretos en $DIR (fuera del control de versiones)."
