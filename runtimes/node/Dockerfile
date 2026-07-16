# E6 · T6.3 — Runtime Node.js FIJADO para bots (cap. 18.3).
#
# - Versión fijada por DIGEST (no por tag mutable): ver runtimes/DIGESTS.lock.
# - Solo la lista de paquetes permitidos (runtimes/node/ALLOWED-PACKAGES.md), preinstalada.
# - npm/pnpm/yarn/corepack DESHABILITADOS en ejecución: el bot no instala nada.
#
# NOTA DE ENTORNO: ia02 no tiene grupo docker; esta imagen NO se ha construido aquí.

# node:20.14.0-bookworm-slim — el sha256 se fija en runtimes/DIGESTS.lock
FROM node@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS base

ENV NODE_ENV=production \
    NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_AUDIT=false

WORKDIR /opt/runtime
# --- Etapa de instalación: SOLO la allowlist, con package-lock verificado --------------
COPY runtimes/node/allowed-package.json ./package.json
COPY runtimes/node/allowed-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts

# --- Endurecimiento: deshabilitar gestores de paquetes en ejecución --------------------
RUN rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/pnpm \
          /usr/local/bin/corepack && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack

# --- Usuario no root ------------------------------------------------------------------
RUN useradd -u 10001 -m -s /usr/sbin/nologin botuser
USER 10001:10001

WORKDIR /bot
ENTRYPOINT ["node"]
CMD ["/bot/main.js"]
