#!/bin/bash
# #256 · Envoltorio de DIAGNÓSTICO de FFMPEG_BIN (sólo en el arnés, nunca en la imagen).
# EL MISMO ffmpeg con EL MISMO argv. Registra el argv (desde EQ5b no contiene la clave:
# en rtmps ffmpeg escribe FLV por el fd 3 al relé). Si la salida es `pipe:3`, copia
# byte a byte ese FLV —el que recibe el relé— a /tmp/diag/pre-relay-<n>.flv: la etapa
# «FLV antes del relé» se observa sin cambiar nada de lo que ffmpeg hace.
mkdir -p /tmp/diag
n=$(date +%s%N)
printf '%s\n' "$@" >"/tmp/diag/ffmpeg-argv-$n.txt"
REAL="${DIAG_REAL_FFMPEG:-/usr/bin/ffmpeg}"
case " $* " in
  *" pipe:3 "*)
    exec 4>&3
    "$REAL" "$@" 3> >(tee "/tmp/diag/pre-relay-$n.flv" >&4)
    rc=$?
    exit $rc
    ;;
  *) exec "$REAL" "$@" ;;
esac
