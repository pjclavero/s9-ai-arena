#!/usr/bin/env bash
# Genera los archivos de secretos del stack (paso 1 de docs/despliegue.md).
# Idempotente: nunca sobrescribe un secreto existente.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
mkdir -p "$DIR/tls"

gen() {
  local f="$DIR/$1"
  if [ -s "$f" ]; then
    echo "ya existe: $1 (no se toca)"
  else
    umask 077
    head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 40 > "$f"
    echo "generado:  $1"
  fi
}

gen postgres_password.txt
gen jwt_secret.txt
gen grafana_admin_password.txt
gen restic_password.txt

# stream_key es del proveedor (YouTube): placeholder vacío que el operador rellena.
if [ ! -f "$DIR/stream_key.txt" ]; then
  umask 077; : > "$DIR/stream_key.txt"
  echo "creado vacío: stream_key.txt (rellenar con la clave de YouTube si se usa streaming)"
fi

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
