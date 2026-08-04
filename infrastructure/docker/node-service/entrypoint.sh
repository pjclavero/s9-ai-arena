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
# B13 · ESTE SCRIPT LO COMPARTEN VARIAS IMÁGENES. La imagen del streamer
# (infrastructure/docker/streamer/Dockerfile) lo copia tal cual y lo encadena
# delante de su propio entrypoint, porque el streamer escribe en
# /data/replays/video y padecía EXACTAMENTE el mismo fallo silencioso. Lo único
# que cambia entre imágenes es el usuario sin privilegios al que se baja, que
# viene de ARENA_SERVICE_USER (`node` por defecto). Ese valor se BAKEA en la
# imagen (ENV del Dockerfile), NUNCA se pone en el Compose: es una propiedad de
# la imagen, y un test del Compose comprueba que ningún servicio lo declara.
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
#
# B13 · QUÉ SE HIZO CON ESTA INVARIANTE (el caso del streamer, que es
# literalmente el ejemplo que cita el párrafo de arriba):
# El streamer escribe en /data/replays/video, DOS componentes dentro de un
# volumen compartido. En vez de declararlo —lo que habría ensanchado la ventana
# y convertido el párrafo de arriba en una afirmación falsa— se toma la segunda
# salida que el propio párrafo propone: el streamer declara
# `ARENA_DATA_DIRS=/data/replays` (UN componente, igual que el resto) y es el
# SERVICIO, ya sin privilegios, quien crea `video/` dentro en su preflight
# (packages/data-dir). Funciona porque el usuario `streamer` es uid:gid 1000:1000
# igual que `node`: el chown de la raíz del volumen es el mismo en las dos
# imágenes, y el build de cada imagen lo comprueba con `stat`.
# Y para que esto no dependa de que alguien lea este comentario, la invariante
# ya NO es prosa: `valida_ruta` RECHAZA cualquier ruta de más de un componente
# bajo /data (abajo), y un test del Compose lo fija desde el otro lado.
# Medición del Supervisor sobre el estado anterior: 600 intentos de la carrera
# con un atacante en bucle apretado, 0 ganados. Eso es ausencia de prueba de
# explotación, no prueba de que no exista: por eso la ventana se cierra en vez de
# documentarse.
set -euf

RAIZ_DATOS=/data
# Usuario sin privilegios del servicio. Se valida abajo: nunca root, y nunca
# algo que no sea un nombre de usuario plausible.
USUARIO_SERVICIO=${ARENA_SERVICE_USER:-node}

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

  # B13 · LA INVARIANTE DE LA CABECERA, EJECUTABLE. Solo `/data/<algo>`:
  # exactamente dos componentes ("data" + uno). Una ruta más profunda dentro de
  # un volumen compartido pone un componente intermedio ESCRIBIBLE por otro
  # contenedor entre la validación y el mkdir/chown, y `chown -h` no cubre los
  # intermedios. Quien la necesite tiene que cerrar la ventana primero, no solo
  # declararla; el camino barato ya está probado: que el servicio se cree el
  # subdirectorio él mismo, sin privilegios, en su preflight (es lo que hace el
  # streamer con /data/replays/video). Se comprueba ANTES de tocar el disco,
  # como el resto de la fase 1.
  componentes=$#

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

  if [ "$componentes" -ne 2 ]; then
    err "ARENA_DATA_DIRS: '$ruta' es una ruta profunda ($componentes componentes); solo se admite $RAIZ_DATOS/<dir>. Los subdirectorios los crea el servicio sin privilegios (ver INVARIANTE en la cabecera) - rechazada"
    return 1
  fi

  return 0
}

if [ "$(id -u)" = "0" ]; then
  # FASE 0 · el usuario al que se baja. Corremos como uid 0: un valor absurdo
  # aquí significaría o bien no bajar de root, o bien un chown a un usuario
  # inesperado. Se rechaza cerrado en vez de continuar.
  case $USUARIO_SERVICIO in
    root | 0)
      err "ARENA_SERVICE_USER='$USUARIO_SERVICIO': el servicio NO puede correr como root - arranque abortado"
      exit 1
      ;;
  esac
  # Allowlist POR EXCLUSIÓN: los patrones de sh no expresan repetición, así que
  # "empieza por letra y el resto son [a-z0-9_-]" se comprueba rechazando todo
  # lo que contenga UN carácter fuera del juego. Un `[a-z_][a-z0-9_-]*` parecería
  # correcto y aceptaría 'no;rm -rf /': el '*' casa con cualquier cosa.
  case $USUARIO_SERVICIO in
    "" | *[!a-z0-9_-]* | [!a-z_]*)
      err "ARENA_SERVICE_USER='$USUARIO_SERVICIO' no es un nombre de usuario valido - arranque abortado"
      exit 1
      ;;
  esac

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
    # B13 · Si el directorio no se puede ni crear (p. ej. el volumen padre
    # llegó root:root y este servicio solo escribe en un subdirectorio), el
    # arranque muere AQUÍ con un motivo legible, no con un error suelto de sh.
    mkdir -p "$d" || {
      err "no se pudo crear '$d' (¿el directorio padre pertenece a otro usuario?) - arranque abortado"
      exit 1
    }
    chown -h "$USUARIO_SERVICIO:$USUARIO_SERVICIO" "$d"
  done

  exec su-exec "$USUARIO_SERVICIO:$USUARIO_SERVICIO" "$@"
fi

exec "$@"
