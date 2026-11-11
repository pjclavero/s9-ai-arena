#!/bin/bash
# procsnap.sh <contenedor> <fichero-salida>: procesos de Chromium y CPU por hilo.
C=$1
{
  date
  docker exec "$C" ps -o pid,stat,time,args | cut -c1-220
  for p in $(docker exec "$C" sh -c 'pgrep -f "type=renderer"; pgrep -f "type=gpu-process"'); do
    echo "--- hilos pid $p: $(docker exec "$C" sh -c "tr '\0' ' ' </proc/$p/cmdline" | grep -oE 'type=[a-z-]+' | head -1)"
    docker exec "$C" sh -c "for t in /proc/$p/task/*; do echo \"\$(cat \$t/comm) \$(awk '{print \$3, \$14+\$15}' \$t/stat)\"; done" | sort -k3 -n -r | head -6
    docker exec "$C" grep -E "ctxt" "/proc/$p/task/$p/status"
  done
} >"$2" 2>&1
