#!/bin/sh
# #256 · Envoltorio de DIAGNÓSTICO de CHROMIUM_BIN (sólo en el arnés, nunca en la imagen).
# Lanza EL MISMO Chromium con EL MISMO argv que construye buildChromiumArgs y le añade
# únicamente el puerto de depuración remota en 127.0.0.1 (para la sonda CDP). Registra
# el argv recibido (no contiene secretos: la URL /broadcast no lleva clave) y guarda su
# stderr completo en /tmp/diag (el supervisor sólo conserva 2 KiB al morir Chromium).
mkdir -p /tmp/diag
n=$(date +%s%N)
printf '%s\n' "$@" >"/tmp/diag/chromium-argv-$n.txt"
# DIAG_CDP_PORT vacío ⇒ SIN puerto de depuración (para descartar que la sonda sea la causa).
if [ -z "${DIAG_CDP_PORT:-}" ]; then exec "${DIAG_REAL_CHROMIUM:-/usr/bin/chromium-browser}" "$@" 2>>"/tmp/diag/chromium-stderr-$n.log"; fi
exec "${DIAG_REAL_CHROMIUM:-/usr/bin/chromium-browser}" \
  "--remote-debugging-port=${DIAG_CDP_PORT}" --remote-debugging-address=127.0.0.1 "$@" 2>>"/tmp/diag/chromium-stderr-$n.log"
