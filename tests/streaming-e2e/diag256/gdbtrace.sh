#!/bin/bash
# #256 · gdbtrace.sh <contenedor> <salida>: pila nativa de todos los hilos de los renderers
# y del proceso GPU de Chromium. Sólo diagnóstico: exige `--cap-add SYS_PTRACE` e instala
# gdb con apk en el contenedor de PRUEBA (nunca en producción ni en la imagen).
C=$1
docker exec -u 0 "$C" sh -c 'command -v gdb >/dev/null || apk add -q --no-cache gdb musl-dbg >/dev/null 2>&1'
{
  for p in $(docker exec "$C" sh -c 'pgrep -f "type=renderer"; pgrep -f "type=gpu-process"'); do
    echo "=== pid $p $(docker exec "$C" sh -c "tr '\0' ' ' </proc/$p/cmdline 2>/dev/null" | grep -oE 'type=[a-z-]+' | head -1)"
    docker exec -u 0 "$C" timeout 60 gdb -p "$p" -batch -nx -ex "set pagination off" -ex "thread apply all bt 25" 2>&1 |
      grep -E '^(#|Thread )' | head -200
  done
} >"$2" 2>&1
