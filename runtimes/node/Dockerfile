# E6 · T6.3 / R6.1 — Runtime Node.js FIJADO para bots (cap. 18.3).
#
# - Base fijada por DIGEST real (no por tag mutable): ver runtimes/DIGESTS.lock.
# - Terceros: solo la allowlist, con integrity REAL verificado por `npm ci`.
# - El SDK propio (@arena/sdk) se COMPILA desde el repo (sdks/javascript) y se instala
#   desde el árbol local. NUNCA se resuelve desde npmjs: el scope @arena no es nuestro en
#   el registro público, así que pedirlo por nombre sería DEPENDENCY CONFUSION.
# - npm/pnpm/yarn/corepack DESHABILITADOS en ejecución: el bot no instala nada.
#
# Contexto de build = RAÍZ del repo:  docker build -f runtimes/node/Dockerfile .

# Runtime Node de bots. Base: node:20-bookworm-slim, fijada por digest en runtimes/DIGESTS.lock.

# --- Etapa 1: compilar el SDK PROPIO desde el repo ------------------------------------
# sdks/javascript es TypeScript con noEmit:true (nunca se había compilado: los bots de
# ejemplo lo importaban por ruta relativa del monorepo). Aquí se emite JS + .d.ts para que
# el runtime pueda instalarlo como paquete real.
FROM node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS sdk-builder
ARG TS_VERSION=5.8.3
WORKDIR /src
COPY sdks/javascript/ ./
COPY runtimes/node/sdk-package.mjs /sdk-package.mjs
RUN npm install --no-save --ignore-scripts typescript@${TS_VERSION} \
 && npx tsc -p tsconfig.json --noEmit false --outDir /out/dist --declaration \
 && node /sdk-package.mjs /src/package.json /out/package.json \
 && test -f /out/dist/index.js || (echo "ERROR R6.1: el SDK no emitio dist/index.js"; exit 1)

# --- Etapa 2: runtime -----------------------------------------------------------------
FROM node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false

# Parches de seguridad del SO. R6.1: la base de node, incluso en su ultima version, trae
# 2 CVE CRITICAS de libgnutls30 (CVE-2026-33845, CVE-2026-42010) que Debian ya tiene
# corregidas en sus repos pero que la imagen aun no recoge. Sin esto, el runtime las
# arrastra. El digest de la imagen resultante se fija igual (ver DIGESTS.lock), asi que lo
# que se despliega sigue siendo exactamente lo pineado.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/runtime
# Terceros: SOLO la allowlist, con el integrity real del lock verificado por npm ci.
COPY runtimes/node/allowed-package.json ./package.json
COPY runtimes/node/allowed-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts

# SDK propio: desde el árbol construido arriba, sin tocar el registro.
COPY --from=sdk-builder /out /opt/runtime/node_modules/@arena/sdk

# Los paquetes se dejan en /node_modules, NO en /opt/runtime, y sin NODE_PATH: NODE_PATH
# solo lo respeta CommonJS, y el SDK es ESM ("type": "module"), asi que con NODE_PATH un
# `import "@arena/sdk"` desde /bot/main.js fallaba con ERR_MODULE_NOT_FOUND. La resolucion
# ESM sube por los node_modules de los directorios padre: desde /bot encuentra /node_modules.
RUN mv /opt/runtime/node_modules /node_modules \
 && rm -rf /opt/runtime \
 && test -f /node_modules/@arena/sdk/dist/index.js \
 && test -d /node_modules/ws \
 && echo "runtime OK: ws + @arena/sdk instalados"

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
