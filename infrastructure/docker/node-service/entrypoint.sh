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
# QUÉ ACEPTA EXACTAMENTE en ARENA_DATA_DIRS (esto corre como uid 0 y lo gobierna
# una variable de entorno, así que la lista es literal, no tranquilizadora).
# Una ruta se acepta solo si cumple TODO:
#   - cuelga de /data/ y tiene al menos un componente propio (nunca /data a
#     secas, nunca /dataOtraCosa);
#   - todos sus componentes son reales: ni vacíos ('//'), ni '.', ni '..';
#   - ningún componente del camino es un ENLACE SIMBÓLICO. Un enlace dentro de
#     /data apunta fuera de /data y `chown` lo seguiría: el guard de prefijo por
#     sí solo NO impide salir de /data;
#   - no contiene metacaracteres de patrón ('*', '?', '[');
#   - reconstruida componente a componente es IDÉNTICA a la recibida (nada de
#     barras finales ni formas equivalentes que el chown interpretaría de otro
#     modo que la validación).
# Cualquier otra cosa ABORTA el arranque; nunca se ignora en silencio.
#
# GARANTÍAS DEL PASO PRIVILEGIADO:
#   - VALIDACIÓN EN DOS FASES: primero se valida la lista ENTERA y solo después
#     se toca el disco. Una entrada inválida al final de la lista no deja
#     efectos a medias de las anteriores.
#   - `set -f`: la lista NO se expande como patrón. Un '*' accidental sería, si
#     no, un chown masivo silencioso en vez de un error.
#   - `chown` NO recursivo y con `-h` (no sigue enlaces): el directorio, no su
#     contenido ni el destino de ningún enlace. Un `chown -R` sobre un volumen
#     de replays de meses sería carísimo y no hace falta: los archivos ya
#     escritos se leen igual.
#   - sin ARENA_DATA_DIRS no se toca NADA: api, web y map-service se comportan
#     exactamente igual que antes de B7, solo que bajando de root a node aquí en
#     vez de en la instrucción USER del Dockerfile.
#   - si el contenedor ya arranca sin privilegios (`user:` en el Compose, uid
#     no-0), no se intenta ningún chown: se ejecuta el servicio tal cual y, si
#     el directorio no sirve, el preflight del propio servicio
#     (apps/replay-service/src/data-dir.ts) lo dirá a gritos.
#
# INVARIANTE QUE HAY QUE PRESERVAR AL AMPLIAR ARENA_DATA_DIRS
# ----------------------------------------------------------
# Entre que se comprueba que un componente no es un enlace (fase 1) y que se le
# hace mkdir/chown (fase 2) hay una ventana. Hoy NO es explotable, y el motivo
# es concreto: los dos únicos valores reales son `/data/replays`, una ruta de UN
# SOLO componente bajo /data, y su padre `/data` vive en la capa de la imagen,
# no en ningún volumen — nadie de fuera puede sustituirlo, y en ese instante
# este script es PID 1 y el servicio todavía no existe. El volumen compartido se
# monta POR DEBAJO del componente validado: otro contenedor con rw puede crear
# cosas dentro, nunca reemplazar /data ni /data/replays en este namespace.
#
# Eso deja de ser cierto en cuanto se declare una ruta de DOS O MÁS componentes
# dentro de un volumen compartido (el caso obvio: /data/replays/video del
# streamer). Entonces el componente intermedio sí es escribible por otro
# contenedor y la carrera pasa a ser alcanzable. Ojo: `chown -h` NO protege de
# eso, porque `-h` sólo cubre el último componente; un intermedio sustituido por
# un enlace se seguiría dereferenciando en el `mkdir -p`.
#
# Si algún día hace falta una ruta profunda dentro de un volumen compartido, no
# basta con añadirla: hay que cerrar antes la ventana (crear y validar con el
# directorio ya abierto, o exigir que el servicio se cree su subdirectorio él
# mismo una vez sin privilegios).
set -euf

RAIZ_DATOS=/data

err() {
  echo "{\"level\":\"error\",\"service\":\"node-service-entrypoint\",\"msg\":\"$1\"}" >&2
}

# Valida UNA ruta de ARENA_DATA_DIRS. NO modifica nada: la fase de validación es
# previa y completa. Devuelve 0 si es aceptable, 1 si no (explicando por qué).
valida_ruta() {
  ruta=$1

  case $ruta in
    "$RAIZ_DATOS"/?*) ;;
    *)
      err "ARENA_DATA_DIRS: '$ruta' no cuelga de $RAIZ_DATOS/ con un componente propio - rechazada"
      return 1
      ;;
  esac

  case $ruta in
    *'*'* | *'?'* | *'['*)
      err "ARENA_DATA_DIRS: '$ruta' contiene metacaracteres de patron - rechazada"
      return 1
      ;;
  esac

  # Troceado por '/'. Las funciones tienen sus propios parámetros posicionales,
  # así que esto no pisa los argumentos del servicio.
  OIFS=$IFS
  IFS=/
  set -- ${ruta#/}
  IFS=$OIFS

  prefijo=
  for componente in "$@"; do
    if [ -z "$componente" ]; then
      err "ARENA_DATA_DIRS: '$ruta' tiene un componente vacio ('//') - rechazada"
      return 1
    fi
    case $componente in
      . | ..)
        err "ARENA_DATA_DIRS: '$ruta' usa '$componente' como componente - rechazada"
        return 1
        ;;
    esac
    prefijo=$prefijo/$componente
    # El guard de prefijo NO basta: se comprueba CADA componente del camino,
    # no solo el último.
    if [ -L "$prefijo" ]; then
      err "ARENA_DATA_DIRS: '$prefijo' es un enlace simbolico y el chown actuaria sobre su destino, fuera de $RAIZ_DATOS - rechazada"
      return 1
    fi
  done

  # La ruta reconstruida debe ser IDÉNTICA a la recibida: si el troceado y la
  # ruta literal no coinciden, se validaría una cosa y se chownearía otra.
  if [ "$prefijo" != "$ruta" ]; then
    err "ARENA_DATA_DIRS: '$ruta' no esta en forma canonica (se valido '$prefijo') - rechazada"
    return 1
  fi

  return 0
}

if [ "$(id -u)" = "0" ]; then
  # FASE 1 · validar la lista ENTERA antes de tocar el disco.
  # Sin comillas a propósito: ARENA_DATA_DIRS es una lista separada por
  # espacios. `set -f` (arriba) impide que se expanda como patrón.
  for d in ${ARENA_DATA_DIRS:-}; do
    if ! valida_ruta "$d"; then
      err "arranque abortado: no se ha modificado ningun directorio"
      exit 1
    fi
  done

  # FASE 2 · actuar, ya con la lista completa validada.
  for d in ${ARENA_DATA_DIRS:-}; do
    mkdir -p "$d"
    chown -h node:node "$d"
  done

  exec su-exec node:node "$@"
fi

exec "$@"
