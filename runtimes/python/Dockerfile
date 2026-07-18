# E6 · T6.3 / R6.1 — Runtime Python FIJADO para bots (cap. 18.3).
#
# - Base fijada por DIGEST real (no por tag mutable): ver runtimes/DIGESTS.lock.
# - Solo la allowlist (runtimes/python/ALLOWED-PACKAGES.md), preinstalada con hashes.
# - El SDK propio se CONSTRUYE desde el repo (sdks/python), nunca se resuelve desde PyPI.
# - pip DESHABILITADO en ejecución: un bot no puede instalar nada dentro del contenedor.
#
# Contexto de build = RAÍZ del repo:  docker build -f runtimes/python/Dockerfile .

# python:3.11-slim-bookworm (hoy 3.11.15) — digest real, el mismo fijado en
# runtimes/DIGESTS.lock. Literal y no ARG: un ARG sería sobrescribible con --build-arg y la
# base dejaría de estar fijada, que es justo lo que verify-runtime-digests impide.
#
# R6.1: se subió desde python:3.11.9-slim-bookworm (de 2024), que traía 6 CVE CRÍTICAS con
# fix publicado (libexpat1 CVE-2024-45491/45492, libgnutls30, libssl3). El escaneo Trivy
# nunca las había visto porque el digests-gate saltaba ese job. Se mantiene el contrato de
# lenguaje (Python 3.11): un bot no depende del número de parche.
FROM python@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS sdk-builder

# --- Etapa 1: construir el wheel del SDK PROPIO desde el repo -------------------------
# Sin red (--no-index) y sin build isolation: el toolchain (setuptools/wheel) lo aporta la
# base fijada por digest, así que el wheel es reproducible byte a byte. Su sha256 se
# verifica contra sdk-wheel.lock: si el SDK (o la base que lo construye) cambia, el build
# falla hasta actualizar el lock. Eso ya pasó al subir la base, y es el comportamiento
# buscado: lo que entra en el runtime queda fijado en el repo.
ENV SOURCE_DATE_EPOCH=1700000000
COPY sdks/python /src/sdk
COPY runtimes/python/sdk-wheel.lock /src/sdk-wheel.lock
WORKDIR /src/sdk
RUN pip wheel --no-deps --no-build-isolation --no-index -w /wheels . && \
    expected=$(grep -oE "sha256:[0-9a-f]{64}" /src/sdk-wheel.lock | cut -d: -f2) && \
    actual=$(sha256sum /wheels/arena_sdk-0.1.0-py3-none-any.whl | cut -d" " -f1) && \
    if [ "$expected" != "$actual" ]; then \
      echo "ERROR R6.1: el wheel del SDK no coincide con sdk-wheel.lock"; \
      echo "  esperado: $expected"; echo "  obtenido: $actual"; exit 1; \
    fi && \
    echo "SDK wheel verificado: $actual"

# --- Etapa 2: runtime -----------------------------------------------------------------
FROM python@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Parches de seguridad del SO. La base se publica cada pocas semanas, pero los paquetes
# corregidos salen antes: sin esto, el runtime arrastra CVE que Debian ya tiene arregladas.
# El digest de la imagen resultante se fija igual (ver DIGESTS.lock), así que lo que se
# despliega sigue siendo exactamente lo pineado, no "lo que hubiera ese día".
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Terceros: SOLO la allowlist, con hashes reales verificados por pip.
COPY runtimes/python/allowed-requirements.lock /tmp/allowed-requirements.lock
RUN pip install --require-hashes --no-deps -r /tmp/allowed-requirements.lock

# SDK propio: desde el wheel local construido arriba. --no-index impide cualquier fallback
# a PyPI; --no-deps es seguro porque websocket-client ya está en el lock de terceros.
COPY --from=sdk-builder /wheels /tmp/wheels
RUN pip install --no-deps --no-index --find-links=/tmp/wheels arena-sdk==0.1.0 && \
    rm -rf /tmp/wheels /tmp/allowed-requirements.lock && \
    python -c "import arena_sdk, websocket, numpy; print('runtime OK', arena_sdk.__name__)"

# --- Endurecimiento: deshabilitar pip en ejecución ------------------------------------
RUN pip uninstall -y pip || true && \
    rm -rf /usr/local/lib/python3.11/site-packages/pip* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11 && \
    printf 'raise SystemExit("pip está deshabilitado en el runtime de bots (E6/T6.3)")\n' \
        > /usr/local/lib/python3.11/pip.py

# --- Usuario no root ------------------------------------------------------------------
RUN useradd -u 10001 -m -s /usr/sbin/nologin botuser
USER 10001:10001

WORKDIR /bot
ENTRYPOINT ["python"]
CMD ["/bot/main.py"]
