#!/usr/bin/env bash
# D-OP-32 · Plan de medición del escenario de pico simultáneo (SOLO LECTURA).
#
# Muestrea durante una ventana la CPU, la memoria y el pico de memoria de cada
# contenedor del stack (y de los contenedores de bot) más la memoria y la presión
# del sistema. NO lanza batallas ni toca el streamer: la carga (una batalla 1v1/4v4
# con contenedores reales, la emisión 1080p30 con la CPU del host) la genera quien
# ejecuta el plan, con el stack de PRUEBAS y con los límites del compose.
#
# Uso:  bash scripts/ops/measure-resource-scenario.sh <etiqueta> [muestras=40] [intervalo_s=15]
# Salida: ./resource-scenario-<etiqueta>.tsv  (una fila por contenedor y muestra)
#         + una línea de resumen por contenedor al final (pico de cada columna).
#
# Reglas del laboratorio: una sola ejecución pesada a la vez, con `nice -n 19 ionice -c3`
# y `flock`, y con el guardián de producción en OK antes de CADA fase. Este script sólo
# lee (docker stats, docker inspect y /sys/fs/cgroup); no escribe fuera de su .tsv.
#
# FASES a medir (registrar la etiqueta A/B/C/D en cada ejecución; ver
# docs/operations/resource-budget.md § Plan de medición):
#   A  reposo: stack sin emisión ni batallas
#   B  streamer solo, emisión 1080p30 (CPU con AVX2: valor pendiente de medir)
#   C  una batalla 1v1 con contenedores reales
#   D  una batalla 4v4 (8 bots) con contenedores reales, sola y con la emisión
set -u
LABEL=${1:?etiqueta de la fase (A, B, C, D…)}
N=${2:-40}
EVERY=${3:-15}
OUT="resource-scenario-${LABEL}.tsv"

command -v docker >/dev/null || { echo "docker no disponible" >&2; exit 2; }
printf 'ts\tcontenedor\tcpu_pct\tmem_mib\tmem_limit_mib\tpids\tmem_peak_mib\tcpu_throttled_periods\n' >"$OUT"

# Cgroup v2 (systemd driver): /sys/fs/cgroup/system.slice/docker-<id>.scope
cg_dir() { echo "/sys/fs/cgroup/system.slice/docker-$1.scope"; }

for _ in $(seq 1 "$N"); do
  ts=$(date -u +%FT%TZ)
  docker stats --no-stream --format '{{.ID}} {{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.PIDs}}' |
    while read -r id name cpu used _ lim pids; do
      full=$(docker inspect --format '{{.Id}}' "$id" 2>/dev/null) || continue
      d=$(cg_dir "$full")
      peak=$(cat "$d/memory.peak" 2>/dev/null || echo 0)
      thr=$(awk '/^nr_throttled/{print $2}' "$d/cpu.stat" 2>/dev/null || echo 0)
      to_mib() { # 12.5MiB | 1.2GiB | 800KiB → MiB
        awk -v v="$1" 'BEGIN{n=v+0; if(v~/GiB/)n*=1024; else if(v~/KiB/)n/=1024; printf "%.1f", n}'
      }
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$name" "${cpu%\%}" "$(to_mib "$used")" "$(to_mib "$lim")" "$pids" \
        "$(awk -v p="$peak" 'BEGIN{printf "%.1f", p/1048576}')" "$thr"
    done >>"$OUT"
  free -m | awk -v ts="$ts" '/^Mem:/{printf "%s\t__host__\t0\t%s\t%s\t0\t0\t0\n", ts, $3, $2}' >>"$OUT"
  sleep "$EVERY"
done

echo "== pico por contenedor (fase $LABEL, $N muestras cada ${EVERY}s) =="
awk -F'\t' 'NR>1 { if($3>c[$2])c[$2]=$3; if($4>m[$2])m[$2]=$4; if($7>p[$2])p[$2]=$7 }
  END{ printf "%-40s %8s %10s %10s\n","contenedor","cpu%max","mem_max","peak_cg"; for(k in c) printf "%-40s %8.1f %10.1f %10.1f\n",k,c[k],m[k],p[k] }' "$OUT" | sort
