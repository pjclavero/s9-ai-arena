# Arquitectura técnica

## Resumen

Este documento es el detalle técnico de la arquitectura que resume
[docs/overview/architecture.md](../overview/architecture.md): estructura del monorepo, modelo de
procesos, acoplamiento por código, contratos, configuración y puntos de extensión. Todo está
verificado en `27f70bb`.

## Índice

- [Estructura del monorepo](#estructura-del-monorepo)
- [Modelo de procesos](#modelo-de-procesos)
- [Acoplamiento por código](#acoplamiento-por-código)
- [Contratos](#contratos)
- [Configuración](#configuración)
- [Imágenes](#imágenes)
- [Seguridad estructural](#seguridad-estructural)
- [Extensión](#extensión)
- [Estado actual](#estado-actual)
- [Verificación](#verificación)

## Estructura del monorepo

| Ruta | Contenido |
|---|---|
| `apps/api` | API REST, migraciones (`src/db/migrations.ts`), CLI de BD (`src/db/cli.ts`), contrato `openapi.yaml`, gateway de espectador (`src/spectate/gateway.ts`, que **ejecuta el worker**) |
| `apps/arena-engine` | motor (`src/sim/battle.ts`), servidor de protocolo motor ↔ bot, replays, checkpoints, servicio HTTP `/run` (`src/service.ts`) |
| `apps/tournament-worker` | bucle de trabajos, ejecutor de batallas en proceso, calendarios, resultados, ratings, standings |
| `apps/bot-manager` | pipeline de build (`pipeline.ts`), análisis estático y AST, detección de secretos, firma, runner de contenedores, proxy Docker (`docker-proxy-main.ts`), worker de build (`build-worker-main.ts`) |
| `apps/map-service` | librería de mapas: validación, import de Tiled, generador procedural, conversión al formato del motor. También tiene un entrypoint HTTP en memoria sin uso |
| `apps/replay-service` | almacén de replays en disco, servidor HTTP, cálculo de estadísticas (`stats.ts`) |
| `apps/web` | SPA React + Phaser |
| `apps/streamer` | captura headless a RTMPS (perfil `streaming`) |
| `apps/arena-server`, `apps/arena-viewer` | **v1 legacy**, sólo en `docker-compose.demo.yml` |
| `packages/*` | `game-rules` (constantes de ADR-000), `module-catalog` (catálogo, validador, resolución de vehículo), `map-schema`, `protocol`, `build-info` (ADR-016, `/version`), `readiness` y `first-run` (R17), `data-dir`, `shared-types` |
| `sdks/javascript`, `sdks/python` | SDK de bots. `sdks/dotnet` y `sdks/java` son plantillas vacías |
| `runtimes/node`, `runtimes/python` | imágenes de sandbox de bots, fijadas por digest (`runtimes/DIGESTS.lock`) |
| `infrastructure/` | compose, Dockerfiles, configuración del gateway, backup, scripts de gates (`scripts/*.mjs`), unidad systemd del proxy Docker, tests de infraestructura |
| `tests/`, `acceptance/` | E2E (mayoritariamente simulados o con BD embebida), gamedays, aceptación visual |

## Modelo de procesos

- **Servicios HTTP** (Express 5): `api` :8080, `arena-engine` :8081, `map-service` :8082, `replay-service` :8083, `bot-manager` :8084. `web` sirve estáticos con nginx en :3000.
- **Workers sin HTTP:** `tournament-worker` y `bot-build-worker`. Su vida se señala con un fichero de latido, `/tmp/heartbeat`, que el healthcheck exige con menos de 120 s de antigüedad. El tournament-worker abre además un **servidor WebSocket** en `SPECTATE_PORT` (8081 dentro de su contenedor) para el espectador.
- **Concurrencia del tournament-worker:** `computeConcurrency()` usa `min(cpus − 1, RAM/2 GB)` bucles, cada uno con una batalla a la vez (`apps/tournament-worker/src/worker.ts:71-80`).
- **La simulación** de las batallas del sistema ocurre **dentro del proceso del tournament-worker** (`makeEngineExecutor`), no en `arena-engine`.
- **Servicio del host:** `s9-docker-proxy` (systemd), que escucha por defecto en loopback, puerto 2375, y habla con `docker.sock` aplicando una allowlist.

## Acoplamiento por código

Los servicios **no** son paquetes independientes: se importan unos a otros por ruta relativa, y
la imagen genérica `node-service` copia todo `apps/` y `packages/`. Ejemplos verificados:

| Consumidor | Importa de |
|---|---|
| `tournament-worker` | `api/src/db/connection`, `api/src/spectate/gateway`, `api/src/services/catalog`, `arena-engine/src/sim/battle`, `arena-engine/src/stubs`, `map-service/src/to-engine-map`, `replay-service/src/data-dir` |
| `bot-build-worker` | `api/src/db/connection`, `api/src/services/e6-bot-manager` |
| `api` | `map-service/src/*` (validar, generar, importar), `bot-manager/src/*`, `arena-engine/src/*` |

Consecuencias:
- Un cambio en `apps/api` puede cambiar el comportamiento del worker.
- Desplegar servicios con commits distintos produce costuras. La mezcla actual anula una defensa del Carril J ([TD-006](../roadmap/technical-debt.md#td-006)).
- Al mismo tiempo, el worker no recibe los secretos que necesita el código que importa ([TD-028](../roadmap/technical-debt.md#td-028)).

## Contratos

| Contrato | Fichero | Quién lo consume |
|---|---|---|
| API HTTP + RBAC | `apps/api/openapi.yaml` (`x-min-role` por operación). `defineOperation` impide implementar rutas fuera del contrato; las extensiones explícitas van con `defineExtension` | `apps/api/src/registry.ts`, web, tests de conformidad. Ver [api.md](api.md) |
| Protocolo motor ↔ bot | `packages/protocol` (`arena/1`, JSON) | motor, SDK. Ver [websocket.md](websocket.md) y [bots.md](bots.md) |
| Catálogo de módulos | `packages/module-catalog/schema`, `data` | API, motor, web. Ver [equipment.md](equipment.md) |
| Mapas | `packages/map-schema` | map-service (librería), API, motor. Ver [maps.md](maps.md) |
| Identidad de build | `packages/build-info` (`/version`, ADR-016) | gates de despliegue |
| Despliegue | `infrastructure/deploy-contract.json` | `deploy-contract-gate.mjs`, `runtime-drift-scan.mjs` |

## Configuración

- **Secretos:** siempre por fichero (Docker secrets, `*_FILE`), nunca en claro en el entorno. Se resuelven con la precedencia archivo > variable y fallan cerrado (`apps/api/src/auth/tokens.ts:46-60`). El modo `ARENA_DEV_INSECURE_SECRETS=1` existe sólo para desarrollo y tests.
- **Flags de capacidad, apagadas por defecto:**
  - `S9_ENABLE_REAL_BATTLE_RUNS`
  - `S9_PUBLIC_SPECTATE_ENABLED`
  - `S9_PUBLIC_REPLAYS_ENABLED`
  - `S9_METRICS_ENABLED`
- **Versiones de imagen:** `TAG` común, con overrides por servicio (`*_TAG`). `backup` usa `BACKUP_TAG`, sin heredar `TAG`, a propósito.
- Variables por servicio: [services.md](services.md). Operación: [docs/operations/configuration.md](../operations/configuration.md).

## Imágenes

| Dockerfile | Servicios |
|---|---|
| `infrastructure/docker/node-service` | api, tournament-worker, map-service, replay-service (`SERVICE_ENTRY` elige el entrypoint; arranca con `npx tsx`) |
| `infrastructure/docker/bot-manager` | bot-manager y bot-build-worker (misma imagen; añade `python3` para el AST) |
| `infrastructure/docker/arena-engine` | arena-engine |
| `infrastructure/docker/web` | web (Vite build → nginx) |
| `infrastructure/docker/gateway` | gateway (nginx; la config se monta por bind) |
| `infrastructure/docker/backup` | backup (Alpine + restic + `pg_dump`) |
| `infrastructure/docker/streamer`, `bot-runtime` | perfiles opcionales |

## Seguridad estructural

- Ningún servicio monta `docker.sock` ni corre `privileged`. `infrastructure/scripts/scan-compose.mjs` lo comprueba en CI.
- Todos los servicios declaran `no-new-privileges` y límites de CPU y memoria.
- Redes internas sin salida (ver [data-flow.md](data-flow.md)). Los contenedores de bots sólo están en la red `arena`.
- Modelo de autenticación, RBAC y superficies abiertas: [security.md](security.md).

## Extensión

- **Nueva ruta de la API:** declárala primero en `openapi.yaml`, con su `x-min-role`, e impleméntala con `defineOperation`.
- **Nuevo tipo de trabajo:** añádelo a `JobKind` (`apps/tournament-worker/src/queue.ts:26`) y su handler en `main.ts`. Ver [queue.md](queue.md).
- **Nueva migración:** añádela a `apps/api/src/db/migrations.ts`. Ver [database.md](database.md).
- **Nuevo servicio de aplicación:** su imagen debe anidar `${X_TAG:-${TAG:-latest}}` y tiene que declararse en `deploy-contract.json`.

## Estado actual

**PARCIAL.** La estructura es coherente en código, pero el runtime no corresponde a un único commit
([TD-006](../roadmap/technical-debt.md#td-006)). Hay dos servicios sin uso efectivo: `map-service`
y `arena-engine` (/run apagado).

## Documentación relacionada

- [docs/overview/architecture.md](../overview/architecture.md) · [services.md](services.md) · [data-flow.md](data-flow.md) · [database.md](database.md)
- [battles.md](battles.md) · [engine.md](engine.md) · [api.md](api.md) · [bots.md](bots.md) · [frontend.md](frontend.md)
- [docs/development/repository.md](../development/repository.md) · [docs/operations/docker.md](../operations/docker.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Puertos de los servicios | CODE_VERIFIED | `infrastructure/docker-compose.yml` (`PORT`); `apps/*/src/main.ts`/`service.ts` (`process.env.PORT ??`) |
| Latido de los workers | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:29-38`; `apps/bot-manager/src/build-worker-main.ts:21,33` |
| Fórmula de concurrencia | CODE_VERIFIED | `apps/tournament-worker/src/worker.ts:71-80` |
| Imports entre apps | CODE_VERIFIED | `grep -rhoE 'from "(\.\./)+…/src' apps/*/src` |
| La imagen `node-service` copia `apps/` | CODE_VERIFIED | `infrastructure/docker/node-service/Dockerfile` (`COPY apps ./apps`) |
| Arranque con `npx tsx` | CODE_VERIFIED | `infrastructure/docker/node-service/Dockerfile:123` |
| Secretos por fichero, fail-closed | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:46-84` |
| `defineOperation` / `defineExtension` | CODE_VERIFIED | `apps/api/src/registry.ts:1-30` |
