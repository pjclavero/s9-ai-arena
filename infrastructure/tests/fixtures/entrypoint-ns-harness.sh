#!/bin/sh
# B7/O1 · Banco de pruebas del entrypoint con un /data REAL.
#
# El guard de rutas del entrypoint (infrastructure/docker/node-service/
# entrypoint.sh) consulta el sistema de ficheros: `[ -L ]` sobre cada componente
# de la ruta. Para probarlo de verdad hace falta un `/data` real que contenga un
# enlace simbólico — y para eso hace falta ser root. Este banco lo consigue SIN
# privilegios: `unshare -rm` (espacios de nombres de usuario y de montaje, uid 0
# dentro) + `chroot` sobre una raíz preparada en un temporal. Es la misma
# técnica con la que el Supervisor demostró que el guard antiguo era evadible.
#
# Uso:  entrypoint-ns-harness.sh <entrypoint.sh> <ARENA_DATA_DIRS> <escenario> [usuario]
# [usuario] (B13) es el valor de ARENA_SERVICE_USER: `node` por defecto (imagen
# genérica), `streamer` en la imagen del streamer, que comparte este entrypoint.
# Escenarios:
#   normal    /data/{replays,logs,secretos} reales
#   symlink   /data/replays es un ENLACE a /fuera (el escape que reportó O1)
#   ancestro  /data/sub es un ENLACE a /fuera (el escape por un componente
#             intermedio, no por el último)
#
# Salida (una línea por evento, para que el test la analice):
#   CHOWN <ruta> -> <destino real>   por cada chown que el entrypoint intenta
#   SU-EXEC <usuario:grupo>          usuario al que baja antes de ejecutar (B13)
#   SERVICIO-EJECUTADO               si el entrypoint llega a ejecutar el CMD
#   rc=<n>                           código de salida del entrypoint
# Sale con 99 (y no imprime rc=) si el entorno no permite espacios de nombres
# sin privilegios: el test lo distingue de un fallo real.
set -eu

EP=$1
DIRS=$2
ESCENARIO=${3:-normal}
USUARIO=${4:-node}

if ! unshare -rm /bin/true 2>/dev/null; then
  echo "SIN-NAMESPACES" >&2
  exit 99
fi

R=$(mktemp -d)
trap 'chmod -R u+rwX "$R" 2>/dev/null || true; rm -rf "$R"' EXIT
mkdir -p "$R/data" "$R/fuera" "$R/tmp" "$R/shim" "$R/bin" "$R/sbin" "$R/usr" "$R/lib" "$R/lib64" "$R/dev"
: > "$R/dev/null"
cp "$EP" "$R/entrypoint.sh"
chmod 0755 "$R/entrypoint.sh"
: > "$R/fuera/testigo"

case "$ESCENARIO" in
  symlink)
    ln -s /fuera "$R/data/replays"
    ;;
  ancestro)
    ln -s /fuera "$R/data/sub"
    ;;
  normal)
    mkdir -p "$R/data/replays" "$R/data/logs" "$R/data/secretos"
    ;;
  *)
    echo "escenario desconocido: $ESCENARIO" >&2
    exit 2
    ;;
esac

# Dobles DENTRO de la raíz falsa. Solo se doblan las dos llamadas que no se
# pueden ejecutar de verdad aquí (no existe el usuario `node` en esta raíz):
# `chown`, que además delata sobre qué inodo REAL habría actuado, y `su-exec`.
# `id`, `mkdir` y el propio `[ -L ]` son los de verdad, y el uid ES 0.
# El usuario llega por ENTORNO, no interpolado en el código del shim: los tests
# le pasan valores hostiles a propósito (B13) y el shim no debe interpretarlos.
cat > "$R/shim/chown" <<'SHIM'
#!/bin/sh
u=${ARENA_SERVICE_USER:-node}
for a in "$@"; do
  case "$a" in
    -*) ;;
    *)
      if [ "$a" != "$u:$u" ]; then
        printf 'CHOWN %s -> %s\n' "$a" "$(readlink -f "$a" || echo NOEXISTE)"
      fi
      ;;
  esac
done
SHIM
# B13 · el shim de su-exec DELATA a qué usuario se baja: así el test puede
# comprobar que la imagen del streamer no acaba corriendo como `node` (ni como
# root) por reutilizar este entrypoint.
cat > "$R/shim/su-exec" <<'SHIM'
#!/bin/sh
printf 'SU-EXEC %s\n' "$1"
shift
exec "$@"
SHIM
chmod 0755 "$R/shim/chown" "$R/shim/su-exec"

export R DIRS USUARIO
unshare -rm /bin/sh -c '
  set -eu
  mount --bind /bin "$R/bin"
  mount --bind /sbin "$R/sbin"
  mount --bind /usr "$R/usr"
  mount --bind /lib "$R/lib"
  if [ -d /lib64 ]; then mount --bind /lib64 "$R/lib64"; fi
  /usr/sbin/chroot "$R" /bin/sh -c "
     PATH=/shim:/bin:/usr/bin:/sbin:/usr/sbin
     export PATH
     ARENA_DATA_DIRS=\"$DIRS\" ARENA_SERVICE_USER=\"$USUARIO\" /entrypoint.sh /bin/sh -c \"echo SERVICIO-EJECUTADO\"
     echo rc=\$?
  " || echo "rc=$?"
'
