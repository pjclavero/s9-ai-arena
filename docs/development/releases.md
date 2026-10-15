# Releases e imágenes

## Resumen

Qué se publica, con qué etiquetas y cómo se identifica una imagen. No hay versiones semánticas:
**una release es un commit de `main`** cuyas imágenes la CI publica en GHCR con
`BUILD_COMMIT=<sha>` y la etiqueta `sha-<sha>`. Los runtimes de bots se publican aparte y se fijan
por digest.

## Índice

- [Imágenes de la plataforma](#imágenes-de-la-plataforma)
- [Etiquetas](#etiquetas)
- [Identidad de build (ADR-016)](#identidad-de-build-adr-016)
- [Imágenes de terceros](#imágenes-de-terceros)
- [Runtimes de bots](#runtimes-de-bots)
- [Changesets y versiones de paquetes](#changesets-y-versiones-de-paquetes)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Imágenes de la plataforma

Repositorio: `ghcr.io/pjclavero/s9-ai-arena/<servicio>` (públicas, descarga anónima). Servicios:
`gateway`, `web`, `api`, `arena-engine`, `tournament-worker`, `bot-manager` (también
`bot-build-worker`), `map-service`, `replay-service`, `backup`, `streamer`, `bot-runtime-python`
(plantilla). Las construye el job `build-images` de `ci.yml` en cada PR (sin publicar) y en cada push
a `main` (publicando).

## Etiquetas

| Etiqueta | Mutabilidad | Uso |
|---|---|---|
| `sha-<commit completo>` | **inmutable** | la única que debe usarse para desplegar |
| `v<version>` | **móvil** | el `package.json` raíz no declara `version`, así que siempre es `v0.0.0` = último build de `main` |
| `latest` | **no existe** | no la publica nadie; los valores por defecto `latest` del compose y del `.env.example` fallan |

## Identidad de build (ADR-016)

Cada imagen propia se construye con `BUILD_COMMIT`, `BUILD_DATE` y `SERVICE_NAME` (build args). Con
ellos:

- etiqueta OCI `org.opencontainers.image.revision=<commit>`;
- `GET /version` del servicio (montado por `packages/build-info`) devuelve servicio, commit y fecha;
- sin `BUILD_COMMIT` todo sale `unknown` y los gates rechazan la imagen.

Comprobación: `node infrastructure/scripts/verify-image-provenance.mjs --image <ref> --commit <sha>
--service <svc>` exige que etiqueta, `revision` y `/version` coincidan.

## Imágenes de terceros

`postgres:16.14-alpine` y `redis:7.4.9-alpine` se referencian **por digest** en el compose; las del
perfil `observability` por etiqueta de versión. Bases de los Dockerfiles principales:
`node:22.15-alpine` (servicios Node), `nginx:1.27-alpine` (gateway), `alpine:3.20` (backup).

## Runtimes de bots

- Dockerfiles en `runtimes/{node,python}`; paquetes permitidos en `runtimes/*/ALLOWED-PACKAGES.md`.
- `runtimes-publish.yml` (manual) construye `ghcr.io/pjclavero/s9-ai-arena/bot-runtime-<runtime>`
  etiquetada con el sha y muestra su digest.
- `runtimes/DIGESTS.lock` fija **por digest** la base y la imagen de cada runtime; se actualiza a mano
  con el digest publicado y lo verifica `scripts/verify-runtime-digests.ts`. Un bot sólo se construye
  sobre el runtime declarado, resuelto a esos digests.

## Changesets y versiones de paquetes

`.changeset/` y los scripts `npm run changeset` / `version-packages` existen, pero no se usan para
publicar nada: los paquetes son privados y el despliegue no depende de sus versiones.

## Estado actual

- **FUNCIONA ACTUALMENTE:** publicación por commit con identidad; descarga anónima verificada para
  `sha-27f70bb…` en los 11 repositorios de imagen.
- **PARCIAL:** la instalación de referencia no corre imágenes de la CI sino builds locales mezclados,
  9 de 12 sin identidad ([TD-006](../roadmap/technical-debt.md#td-006)).
- **PENDIENTE:** valores por defecto válidos en lugar de `latest`
  ([TD-024](../roadmap/technical-debt.md#td-024)).

## Documentación relacionada

[ci.md](ci.md) · [workflow.md](workflow.md) · [../operations/installation.md](../operations/installation.md#4-elegir-la-versión-de-las-imágenes) ·
[../operations/upgrades.md](../operations/upgrades.md) · [ADR-016](../adr/ADR-016-identidad-de-build.md) ·
[ADR-017](../adr/ADR-017-contrato-de-release.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Etiquetas `sha-<sha>` y `v<version ?? 0.0.0>`, push sólo en `main` | CODE_VERIFIED | `.github/workflows/ci.yml:362,374-377` |
| `latest` 404, `v0.0.0` 200, `sha-27f70bb…` 200 | RUNTIME_VERIFIED | GHCR anónimo, 2026-10-15 |
| `BUILD_COMMIT`/`BUILD_DATE`/`SERVICE_NAME` como build args | CODE_VERIFIED | compose `build.args`; `ci.yml:370-373` |
| `/version` montado por `packages/build-info` | CODE_VERIFIED | `apps/api/src/server.ts:50`; `packages/build-info/index.ts` |
| `/version` del gateway con el commit | RUNTIME_VERIFIED | entorno aislado: `{"service":"gateway","commit":"27f70bb…"}` |
| postgres y redis por digest; bases de Dockerfile | CODE_VERIFIED | compose; `infrastructure/docker/*/Dockerfile` |
| Flujo de runtimes y `DIGESTS.lock` | CODE_VERIFIED | `.github/workflows/runtimes-publish.yml`; cabecera de `runtimes/DIGESTS.lock` |
