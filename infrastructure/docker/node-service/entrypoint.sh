#!/bin/sh
# B7 · Entrypoint de la imagen genérica de servicios Node.
#
# POR QUÉ EXISTE (defecto real de producción, VM108, 2026-07-17 → 2026-07-27):
# Docker crea el directorio de un volumen nombrado como root:root cuando la
# imagen que lo monta no tiene ese directorio. El replay-service corre como
# `node` (uid 1000), así que TODA ingesta moría con
# `EACCES: permission denied, open '/data/replays/...'`. El contenedor seguía
# "healthy" (/healthz no toca el disco) y el volumen llevaba diez días vacío:
# el servicio NUNCA había guardado un replay. Se desbloqueó a mano con un
# `chown 1000:1000`, un parche que se pierde en cuanto el volumen se recrea.
#
# QUÉ HACE: arranca como root SOLO para ajustar la propiedad de los directorios
# de datos que el servicio declara en ARENA_DATA_DIRS, y baja INMEDIATAMENTE a
# `node` con su-exec antes de ejecutar nada del servicio. El proceso del
# servicio NUNCA es root.
#
# LÍMITES DELIBERADOS (esto es un paso privilegiado, así que está acotado):
#   - solo rutas bajo /data/ y sin ".." — cualquier otra cosa ABORTA el arranque
#     (fail-closed: no se ignora en silencio, que es el bug que estamos
#     matando);
#   - `chown` NO recursivo: el directorio, no su contenido (un `chown -R` sobre
#     un volumen de replays de meses sería carísimo y no hace falta: los
#     archivos ya escritos se leen igual);
#   - sin ARENA_DATA_DIRS no se toca NADA (api, web, map-service… se comportan
#     exactamente igual que antes de B7, solo que bajando de root a node aquí en
#     vez de en la instrucción USER del Dockerfile);
#   - si el contenedor ya arranca sin privilegios (`user:` en el Compose, uid
#     no-0), no se intenta ningún chown: se ejecuta el servicio tal cual y, si
#     el directorio no sirve, el preflight del propio servicio
#     (apps/replay-service/src/data-dir.ts) lo dirá a gritos.
set -eu

if [ "$(id -u)" = "0" ]; then
  # Sin comillas a propósito: ARENA_DATA_DIRS es una lista separada por espacios.
  for d in ${ARENA_DATA_DIRS:-}; do
    case "$d" in
      *..*)
        echo "{\"level\":\"error\",\"msg\":\"ARENA_DATA_DIRS: ruta con '..' rechazada: $d\"}" >&2
        exit 1
        ;;
    esac
    case "$d" in
      /data/?*) ;;
      *)
        echo "{\"level\":\"error\",\"msg\":\"ARENA_DATA_DIRS solo admite rutas bajo /data/: rechazada $d\"}" >&2
        exit 1
        ;;
    esac
    mkdir -p "$d"
    chown node:node "$d"
  done
  exec su-exec node:node "$@"
fi

exec "$@"
