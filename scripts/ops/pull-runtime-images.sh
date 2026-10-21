#!/usr/bin/env bash
# RC2 · DEV-SECOPS — pre-pull y verificación de las imágenes de runtime de los bots (P1-2).
#
# El s9-docker-proxy NO permite `pull` (ni debe): las imágenes de runtime tienen que estar
# en el Docker del host ANTES de activar la ejecución real. Este script:
#   1. lee runtimes/DIGESTS.lock y toma SÓLO la 3ª columna (imagen de runtime `repo@sha256:…`,
#      la misma que el proxy admite en su allowlist). La base (2ª columna) nunca se descarga;
#   2. rechaza cualquier referencia que no sea por digest completo (nada de tags ni `latest`);
#   3. `docker pull <repo@sha256:…>` (salvo --check-only);
#   4. verifica con `docker image inspect` que la imagen local tiene EXACTAMENTE ese digest
#      entre sus RepoDigests (un `pull` con rc=0 no basta: se comprueba el efecto).
#
# Uso:
#   scripts/ops/pull-runtime-images.sh                 # descarga y verifica
#   scripts/ops/pull-runtime-images.sh --check-only    # sólo verifica (sólo lectura)
#   scripts/ops/pull-runtime-images.sh --lock <fichero>
# Variables: DOCKER (binario, por defecto `docker`; respeta DOCKER_HOST).
#
# Salida: una línea por runtime (OK / ABSENT / PULL_FAILED / NOT_BY_DIGEST) y al final
# `RUNTIME_IMAGES_READY=YES|NO`. rc: 0 todas presentes y verificadas · 1 alguna falta o no
# cuadra · 2 lock inválido o uso incorrecto.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOCK="$HERE/../../runtimes/DIGESTS.lock"
CHECK_ONLY=0
DOCKER="${DOCKER:-docker}"

while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --lock)
      [ $# -ge 2 ] || { echo "uso: --lock <fichero>" >&2; exit 2; }
      LOCK="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -r "$LOCK" ] || { echo "pull-runtime-images: no se puede leer el lock: $LOCK" >&2; exit 2; }

# Referencia de runtime válida: nombre en minúsculas SIN tag ni puerto, @sha256 de 64 hex.
REF_RE='^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'

declare -a NAMES=() REFS=()
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  trimmed="${line#"${line%%[![:space:]]*}"}"
  [ -z "$trimmed" ] && continue
  [[ "$trimmed" == \#* ]] && continue
  read -r -a cols <<<"$trimmed"
  if [ "${#cols[@]}" -ne 3 ]; then
    echo "pull-runtime-images: línea $lineno del lock con ${#cols[@]} columnas (se esperan 3)" >&2
    exit 2
  fi
  ref="${cols[2]}"
  if ! [[ "$ref" =~ $REF_RE ]]; then
    echo "NOT_BY_DIGEST ${cols[0]} $ref"
    echo "pull-runtime-images: línea $lineno: la imagen de runtime no está fijada por digest completo" >&2
    exit 2
  fi
  for r in "${REFS[@]}"; do
    [ "$r" != "$ref" ] || { echo "pull-runtime-images: referencia duplicada en el lock: $ref" >&2; exit 2; }
  done
  NAMES+=("${cols[0]}")
  REFS+=("$ref")
done <"$LOCK"

[ "${#REFS[@]}" -ge 1 ] || { echo "pull-runtime-images: el lock no declara ninguna imagen de runtime" >&2; exit 2; }

fail=0
for idx in "${!REFS[@]}"; do
  name="${NAMES[$idx]}"
  ref="${REFS[$idx]}"
  if [ "$CHECK_ONLY" = 0 ]; then
    prc=0
    "$DOCKER" pull --quiet "$ref" >/dev/null || prc=$?
    if [ "$prc" != 0 ]; then
      echo "PULL_FAILED $name $ref (rc=$prc)"
      fail=1
      continue
    fi
  fi
  # Efecto, no mensaje: la imagen local debe tener este digest EXACTO en RepoDigests.
  irc=0
  digests="$("$DOCKER" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null)" || irc=$?
  if [ "$irc" = 0 ] && printf '%s\n' "$digests" | grep -qxF -- "$ref"; then
    id="$("$DOCKER" image inspect --format '{{.Id}}' "$ref" 2>/dev/null || echo '?')"
    echo "OK $name $ref id=$id"
  else
    echo "ABSENT $name $ref"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "RUNTIME_IMAGES_READY=YES (${#REFS[@]} imágenes)"
else
  echo "RUNTIME_IMAGES_READY=NO"
  exit 1
fi
