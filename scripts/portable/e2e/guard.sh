# Guarda de anfitrión del E2E portable. Se hace `source` desde run.sh y repeat.sh (no se ejecuta suelta).
#
# Protege POR DEFECTO, sin nombres de máquinas en el repo, con dos capas:
#  1) CONSENTIMIENTO explícito: sin S9_PORTABLE_E2E_LAB=1 el E2E se niega a correr. Una máquina nueva,
#     o un operador que lanza el script a ciegas, no arranca Postgres ni APIs por accidente.
#  2) SEÑALES genéricas de producción, que se comprueban AUNQUE haya consentimiento: contenedores en
#     marcha del propio producto (nombre `s9`/`arena` + servicio api/gateway/postgres/db/streamer/redis…)
#     que no sean los del propio ensayo (prefijo `s9portable-`). Anula la señal sólo un segundo
#     consentimiento deliberado: S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS=1 (p. ej. un laboratorio
#     que a propósito tenga otro stack del producto).
# Además, S9_PORTABLE_FORBIDDEN_HOSTS="h1 h2" sigue vetando nombres concretos (opcional).
# Para pruebas: S9_PORTABLE_GUARD_CONTAINERS (una línea por nombre) sustituye a `docker ps`.
s9_portable_guard() {
  local h
  for h in ${S9_PORTABLE_FORBIDDEN_HOSTS:-}; do
    if [ "$(hostname)" = "$h" ]; then echo "STOP: anfitrión vetado por S9_PORTABLE_FORBIDDEN_HOSTS" >&2; return 1; fi
  done
  if [ "${S9_PORTABLE_E2E_LAB:-}" != "1" ]; then
    echo "STOP: el E2E portable levanta Postgres y APIs reales y SÓLO se ejecuta en un laboratorio. Exporta S9_PORTABLE_E2E_LAB=1 si esta máquina lo es." >&2
    return 1
  fi
  if [ "${S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS:-}" != "1" ]; then
    local names hits
    if [ -n "${S9_PORTABLE_GUARD_CONTAINERS+x}" ]; then
      names=$S9_PORTABLE_GUARD_CONTAINERS
    else
      names=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
    fi
    hits=$(printf '%s\n' "$names" | grep -v '^s9portable-' | grep -Ei '(s9|arena)' | grep -Ei '(api|gateway|postgres|db|streamer|redis|worker|nginx)' || true)
    if [ -n "$hits" ]; then
      echo "STOP: hay contenedores del producto en marcha en este anfitrión (¿producción?): $(printf '%s' "$hits" | tr '\n' ' ')" >&2
      return 1
    fi
  fi
  return 0
}
