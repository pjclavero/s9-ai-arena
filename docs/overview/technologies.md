# Tecnologías

## Resumen

Inventario de las tecnologías que **realmente** usa S9 AI Arena, con la versión exacta y dónde se
declara. Las versiones salen de:
- `package-lock.json`: versión instalada; el rango declarado está en `package.json`;
- los `Dockerfile` de `infrastructure/docker/*`;
- `infrastructure/docker-compose.yml`;
- `.github/workflows/*.yml`.

Todo está leído en `27f70bb`. Una versión de esta tabla no garantiza que sea la que corre en
producción, porque las imágenes desplegadas son anteriores a `main`. Ver
[TD-006](../roadmap/technical-debt.md#td-006).

## Índice

- [Lenguajes y runtime](#lenguajes-y-runtime)
- [Backend](#backend)
- [Frontend](#frontend)
- [Motor](#motor)
- [Datos e infraestructura](#datos-e-infraestructura)
- [Ejecución de bots](#ejecución-de-bots)
- [Observabilidad y streaming (perfiles opcionales)](#observabilidad-y-streaming-perfiles-opcionales)
- [Pruebas y CI](#pruebas-y-ci)
- [Verificación](#verificación)

## Lenguajes y runtime

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| TypeScript | 7.0.2 (instalada; `^7.0.2`) | `package.json`, `tsconfig.json` | el monorepo entero (servicios, motor, web) comparte tipos y contratos |
| Node.js | `node:22.15-alpine` en las imágenes; `engines: >=22.15`; CI `22.15` | `infrastructure/docker/*/Dockerfile`; `package.json`; `ci.yml` (`NODE_VERSION`) | runtime único de todos los servicios. **Node 20 no está soportado** (`scripts/check-node.mjs`) |
| tsx | 4.23.1 | `package.json` | los servicios arrancan con `npx tsx <SERVICE_ENTRY>`, sin un paso de compilación (`node-service/Dockerfile:123`) |
| Python | `python:3.12-alpine` (plantilla de runtime de bot); SDK `requires-python >=3.10` | `infrastructure/docker/bot-runtime/Dockerfile`; `sdks/python/pyproject.toml` | lenguaje de bots soportado |
| npm workspaces | — | `package.json` (`workspaces`) | gestión del monorepo. Hay además un `pnpm-workspace.yaml`, pero la instalación de CI y de las imágenes usa `npm ci` |

## Backend

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| Express | 5.2.1 | `apps/api/src/app.ts`, `server.ts`; también map-service, replay-service, arena-engine, bot-manager | framework HTTP de todos los servicios con HTTP. *(Nota: un informe antiguo hablaba de Fastify: es incorrecto.)* |
| Knex | 3.3.0 | `apps/api/src/db/*` | migraciones en código (`migrations.ts`) y consultas |
| pg | 8.22.0 | conexión a PostgreSQL | driver |
| argon2 | 0.44.0 | `apps/api/src/auth/passwords.ts` | hash de contraseñas (Argon2id) |
| jsonwebtoken | 9.0.3 | `apps/api/src/auth/tokens.ts` | tokens de acceso (15 min) y tickets de espectador |
| otplib | 13.4.1 | `apps/api/src/auth/totp.ts` | 2FA TOTP |
| ajv / ajv-formats | 8.20.0 / 3.0.1 | validación de esquemas JSON | contratos de protocolo, catálogo y mapas |
| yaml | 2.9.0 | `apps/api/src/openapi.ts` | carga de `apps/api/openapi.yaml` (contrato y RBAC) |
| multer | 2.3.0 en `main` (el runtime desplegado usa una versión anterior) | subida de ficheros en la API | parche de seguridad pendiente de desplegar |
| ws | 8.21.0 | gateway de espectador; protocolo motor ↔ bot; SDK JS | WebSocket |
| acorn | 8.17.0 | `apps/bot-manager/src/ast-analysis.ts` | análisis AST de bots JavaScript (los de Python usan `python3` dentro de la imagen de bot-manager) |

## Frontend

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| React / react-dom | 19.2.7 | `apps/web/src` | SPA del panel (rutas hash `#/…`) |
| Vite | 8.1.4 (+ `@vitejs/plugin-react` 6.0.3) | `apps/web/vite.config.ts`; `infrastructure/docker/web/Dockerfile` | build del SPA |
| Phaser | 4.2.1 | `apps/web/src/viewer`, `ReplayPage`, `ViewerPage`, `BroadcastPage` | render del visor y del replay. Ver [TD-009](../roadmap/technical-debt.md#td-009) |
| nginx | `nginx:1.27-alpine` | `infrastructure/docker/web/Dockerfile` | sirve el SPA estático en el contenedor `web` |

## Motor

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| Rapier 2D (`@dimforge/rapier2d-compat`) | 0.19.3 | `apps/arena-engine/src/sim` | física determinista. El checksum del WASM está fijado; actualizarlo sólo se permite con evaluación por golden replays |
| fast-check | 3.23.2 | tests del motor | pruebas de propiedades (determinismo) |

## Datos e infraestructura

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| PostgreSQL | 16.14, fijado por digest (`postgres:16.14-alpine@sha256:57c72fd2…`) | `infrastructure/docker-compose.yml` | BD de negocio y **cola de trabajos** (tabla `jobs`) |
| Redis | 7.4.9, fijado por digest (`redis:7.4.9-alpine@sha256:6ab0b6e7…`), AOF, 256 MB, `noeviction` | compose | canal de aviso opcional del worker ([TD-026](../roadmap/technical-debt.md#td-026)) |
| nginx (gateway) | `nginx:1.27-alpine` | `infrastructure/docker/gateway/Dockerfile`; config `infrastructure/gateway/*.conf` | punto de entrada único |
| Docker Compose | — | `infrastructure/docker-compose.yml` (perfiles `development`, `production`, `external-db`, `bots`, `streaming`, `observability`) | despliegue en un solo host |
| restic | paquete `restic` de Alpine 3.20 (sin fijar a propósito) | `infrastructure/docker/backup/Dockerfile:44` | copias cifradas e incrementales |
| OpenSSH client / postgresql16-client | Alpine 3.20 | misma línea | transporte SFTP de restic; `pg_dump` |
| embedded-postgres | 18.4.0-beta.17 | `devDependencies` | PostgreSQL real en tests sin Docker (ADR-E7-002) |

## Ejecución de bots

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| Imágenes de runtime de bots | `node@sha256:2cf067cf…`, `python@sha256:b1899299…`; TypeScript 5.8.3 en el runtime de Node | `runtimes/node/Dockerfile`, `runtimes/python/Dockerfile`, `runtimes/DIGESTS.lock` | sandbox reproducible, con dependencias permitidas (`ALLOWED-PACKAGES.md`) |
| Proxy de la API de Docker | código propio (`apps/bot-manager/src/docker-proxy-main.ts`), servicio systemd del host | `infrastructure/systemd/s9-docker-proxy.service` | ningún contenedor monta `docker.sock`; allowlist estricta |
| SDK JavaScript | 0.1.0 (`@arena/sdk`, depende de `ws`) | `sdks/javascript` | API para escribir bots |
| SDK Python | 0.1.0 (`websocket-client >=1.7,<2`) | `sdks/python` | idem; incluye el simulador `arena-sim` |

## Observabilidad y streaming (perfiles opcionales)

Ninguno de estos servicios está desplegado hoy.

| Tecnología | Versión | Perfil |
|---|---|---|
| Prometheus | `prom/prometheus:v2.53.0` | `observability` |
| Alertmanager | `prom/alertmanager:v0.27.0` | `observability` |
| Grafana | `grafana/grafana:11.1.0` | `observability` |
| Loki / Promtail | `grafana/loki:3.1.0` / `grafana/promtail:3.1.0` | `observability` |
| cAdvisor | `gcr.io/cadvisor/cadvisor:v0.49.1` | `observability` |
| node-exporter / postgres-exporter | `v1.8.1` / `v0.15.0` | `observability` |
| Chromium + FFmpeg + Xvfb | paquetes de Alpine 3.20 | `streaming` (`infrastructure/docker/streamer/Dockerfile:12`) |

## Pruebas y CI

| Tecnología | Versión | Dónde | Por qué en S9 |
|---|---|---|---|
| Vitest | 4.1.10 (+ `@vitest/coverage-v8` 4.1.10) | `vitest.config.ts`, `vitest.pure.config.ts`, `vitest.db.config.ts` | suite principal |
| jsdom / Testing Library | 29.1.1 / React 16.3.2 | tests de `apps/web` | tests de componentes, con la API mockeada |
| supertest | 7.2.2 | tests de la API | HTTP en proceso |
| Playwright | sin declarar en `package.json` | `acceptance/visual/` (`npm run test:visual`) | prueba visual; no forma parte de la suite ni de `npm ci` |
| Prettier | 3.9.5 | `npm run format:check` | formato |
| Changesets | 3.0.3 | `.changeset` | versionado de paquetes |
| GitHub Actions | `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5`, `docker/build-push-action@v6`, `aquasecurity/trivy-action@v0.36.0` | `.github/workflows/{ci,e6-security,nightly,acceptance,runtimes-publish}.yml` | CI, seguridad, nightly y publicación de runtimes |

Más detalle en [docs/development/ci.md](../development/ci.md) y [docs/development/testing.md](../development/testing.md).

## Documentación relacionada

- [architecture.md](architecture.md) · [docs/technical/services.md](../technical/services.md) · [docs/operations/docker.md](../operations/docker.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Versiones instaladas de las librerías | CODE_VERIFIED | `package-lock.json` (`packages["node_modules/<n>"].version`) |
| Imágenes base | CODE_VERIFIED | `grep -n ^FROM infrastructure/docker/*/Dockerfile runtimes/*/Dockerfile` |
| PostgreSQL y Redis por digest | CODE_VERIFIED | `infrastructure/docker-compose.yml:583,629` |
| Versiones de observabilidad | CODE_VERIFIED | `infrastructure/docker-compose.yml:857-1043` |
| Express (no Fastify) | CODE_VERIFIED | `apps/api/src/app.ts:4,95` |
| Arranque con `npx tsx` | CODE_VERIFIED | `infrastructure/docker/node-service/Dockerfile:123`; `arena-engine/Dockerfile:41` |
| Playwright no declarado | CODE_VERIFIED | ausente de `package-lock.json` |
| Versiones en runtime | no verificadas aquí | ver [TD-006](../roadmap/technical-debt.md#td-006) |
