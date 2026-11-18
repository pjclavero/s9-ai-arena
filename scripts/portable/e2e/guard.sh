# Guarda de anfitrión del E2E portable. Se hace `source` desde run.sh y repeat.sh (no se ejecuta suelta).
#
# Protege POR DEFECTO, sin nombres de máquinas en el repo, con dos capas, ambas de FALLO CERRADO:
#  1) CONSENTIMIENTO explícito: sin S9_PORTABLE_E2E_LAB=1 el E2E se niega a correr.
#  2) NINGÚN contenedor ajeno: el E2E se niega si en el anfitrión hay CUALQUIER contenedor en marcha que
#     no lleve la etiqueta `s9portable.e2e=1` (la ponen run.sh a sus propios contenedores; el nombre NO
#     basta: un `s9portable-x` sin etiqueta cuenta como ajeno). Además se niega si existe (en marcha o
#     parado) algún contenedor con la etiqueta `com.docker.compose.project`, sea cual sea el proyecto
#     (producción es el proyecto `infrastructure`: `infrastructure-api-1`, `infrastructure-postgres-1`…).
#     Si `docker` no está, no responde o `docker ps` falla: STOP (no se puede demostrar que no es producción).
#
# Anulaciones (ambas conscientes):
#  - S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS=1  SALTA la capa 2 entera. PELIGROSO: sólo para un laboratorio
#    que a propósito tenga otros contenedores. En producción provoca la caída que esta guarda evita. Imprime aviso.
#  - S9_PORTABLE_FORBIDDEN_HOSTS="h1 h2" (opcional) veta nombres de anfitrión concretos.
# No hay ninguna variable que sustituya a `docker ps`: los tests de la guarda ponen un `docker` falso en el PATH.
s9_portable_guard() {
  local h
  for h in ${S9_PORTABLE_FORBIDDEN_HOSTS:-}; do
    if [ "$(hostname)" = "$h" ]; then echo "STOP: anfitrión vetado por S9_PORTABLE_FORBIDDEN_HOSTS" >&2; return 1; fi
  done
  if [ "${S9_PORTABLE_E2E_LAB:-}" != "1" ]; then
    echo "STOP: el E2E portable levanta Postgres y APIs reales y SÓLO se ejecuta en un laboratorio. Exporta S9_PORTABLE_E2E_LAB=1 si esta máquina lo es." >&2
    return 1
  fi
  if [ "${S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS:-}" = "1" ]; then
    echo "AVISO PELIGROSO: S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS=1 desactiva la comprobación de contenedores ajenos; si este anfitrión es producción, el E2E la puede tumbar." >&2
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "STOP: no hay docker en el PATH; no se puede comprobar que el anfitrión no es producción." >&2
    return 1
  fi
  local ps rc=0 line name state own proj foreign="" composes=""
  ps=$(docker ps -a --format '{{.Names}}|{{.State}}|{{.Label "s9portable.e2e"}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null) || rc=$?
  if [ "$rc" != 0 ]; then
    echo "STOP: «docker ps» falló (rc=$rc); no se puede comprobar que el anfitrión no es producción." >&2
    return 1
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS='|' read -r name state own proj <<<"$line"
    if [ -n "$proj" ]; then composes="$composes $name($proj)"; fi
    case "$state" in
      exited | created | dead) ;;
      *) if [ "$own" != "1" ]; then foreign="$foreign $name"; fi ;;
    esac
  done <<<"$ps"
  if [ -n "$foreign" ]; then
    echo "STOP: hay contenedores ajenos al ensayo en marcha en este anfitrión (¿producción u otro carril?):$foreign" >&2
    return 1
  fi
  if [ -n "$composes" ]; then
    echo "STOP: hay contenedores de un proyecto compose (¿producción?):$composes" >&2
    return 1
  fi
  return 0
}
