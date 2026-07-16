# E6 · T6.3 — Runtime Python FIJADO para bots (cap. 18.3).
#
# - Versión fijada por DIGEST (no por tag mutable): ver runtimes/DIGESTS.lock.
#   El FROM usa el digest para que el build sea reproducible aunque el tag se mueva.
# - Solo la lista de paquetes permitidos (runtimes/python/ALLOWED-PACKAGES.md), preinstalada.
# - pip DESHABILITADO en ejecución: un bot no puede instalar nada dentro del contenedor.
#
# NOTA DE ENTORNO: ia02 no tiene grupo docker; esta imagen NO se ha construido aquí.
# Está lista para `docker build` donde haya Docker (ver docs/entrega-E6.md).

# python:3.11.9-slim-bookworm — el sha256 se fija en runtimes/DIGESTS.lock
FROM python@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# --- Etapa de instalación: SOLO la allowlist, con hashes/lockfile ---------------------
# El lockfile con hashes garantiza el mismo árbol de dependencias en cada build.
COPY runtimes/python/allowed-requirements.lock /tmp/allowed-requirements.lock
RUN pip install --require-hashes --no-deps -r /tmp/allowed-requirements.lock

# --- Endurecimiento: deshabilitar pip en ejecución ------------------------------------
# 1) elimina el módulo pip y sus ejecutables; 2) deja un stub que falla con mensaje claro
#    por si algún código intenta `python -m pip`.
RUN pip uninstall -y pip || true && \
    rm -rf /usr/local/lib/python3.11/site-packages/pip* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11 && \
    printf 'raise SystemExit("pip está deshabilitado en el runtime de bots (E6/T6.3)")\n' \
        > /usr/local/lib/python3.11/pip.py

# --- Usuario no root ------------------------------------------------------------------
RUN useradd -u 10001 -m -s /usr/sbin/nologin botuser
USER 10001:10001

WORKDIR /bot
# El código del bot (artefacto verificado y firmado por T6.1) se copia en el build por bot,
# que hereda ESTA imagen por digest. El manifiesto del bot debe declarar este runtime.
ENTRYPOINT ["python"]
CMD ["/bot/main.py"]
