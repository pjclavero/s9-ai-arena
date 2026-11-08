#!/usr/bin/env bash
# STREAMER · §29 · backup y restore LOCAL de los 3 secretos de streaming (nunca producción).
#
# Dentro de la imagen de backup del repo (la misma restic y el mismo restore.sh que en
# producción): crea los 3 secretos con nombres y permisos de producción (uid 1000, 0400)
# y contenido ALEATORIO de prueba, los respalda con el tag `s9-arena-secrets` en un
# repositorio restic local, los restaura con `restore.sh --restore-secrets` y compara
# presencia, dueño, modo y sha256. Sólo imprime metadatos y la igualdad de hashes: el
# contenido no sale nunca.
#
#   BACKUP_IMAGE=<imagen> tests/streaming-e2e/secrets-restore.sh
set -uo pipefail
IMG="${BACKUP_IMAGE:?define BACKUP_IMAGE (imagen de infrastructure/docker/backup)}"
docker run --rm -i --entrypoint bash "$IMG" -s <<'EOF'
set -euo pipefail
umask 077
mkdir -p /secrets /repo /dest
head -c 32 /dev/urandom | base64 | tr -d '=+/\n' >/secrets/streamer_control_secret.txt
# Par RSA de prueba (3072, como el de producción), sin openssl: con la clave pública
# basta texto aleatorio con su forma; lo que se comprueba es el fichero, no el PEM.
{ echo "-----BEGIN PRIVATE KEY-----"; head -c 1800 /dev/urandom | base64 -w 64; echo "-----END PRIVATE KEY-----"; } >/secrets/stream_secrets_private.pem
{ echo "-----BEGIN PUBLIC KEY-----"; head -c 400 /dev/urandom | base64 -w 64; echo "-----END PUBLIC KEY-----"; } >/secrets/stream_secrets_public.pem
chown 1000:1000 /secrets/*
chmod 0400 /secrets/*
head -c 24 /dev/urandom | base64 >/run/restic_password
export RESTIC_REPOSITORY=/repo RESTIC_PASSWORD_FILE=/run/restic_password
restic init -q >/dev/null
restic backup -q --tag s9-arena-secrets --host s9-test /secrets >/dev/null
/usr/local/bin/restore.sh --restore-secrets /dest --latest >/tmp/restore.log 2>&1 || { echo "restore.sh falló"; tail -5 /tmp/restore.log; exit 1; }
fail=0
for f in streamer_control_secret.txt stream_secrets_private.pem stream_secrets_public.pem; do
  a=/secrets/$f; b=/dest/secrets/$f
  if [ ! -f "$b" ]; then echo "$f: AUSENTE tras restore"; fail=1; continue; fi
  sa=$(stat -c '%u:%g %a' "$a"); sb=$(stat -c '%u:%g %a' "$b")
  ha=$(sha256sum "$a" | cut -d' ' -f1); hb=$(sha256sum "$b" | cut -d' ' -f1)
  same=$([ "$ha" = "$hb" ] && echo igual || echo DISTINTO)
  echo "$f: origen=$sa restaurado=$sb sha256=$same"
  [ "$sa" = "$sb" ] && [ "$sb" = "1000:1000 400" ] && [ "$ha" = "$hb" ] || fail=1
done
echo "directorio restaurado: $(stat -c '%u:%g %a' /dest/secrets)"
grep -q '"msg":"secretos restaurados' /tmp/restore.log && echo "log de restore: sin contenido de secretos ($(grep -cF -f /secrets/streamer_control_secret.txt /tmp/restore.log || true) apariciones del secreto de control)"
[ "$fail" = 0 ] && echo "RESULTADO: PASS" || { echo "RESULTADO: FAIL"; exit 1; }
EOF
