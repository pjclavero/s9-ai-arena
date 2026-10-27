# Arquitectura real

## Resumen

Esta es la arquitectura **tal como está en el código de `35a4fb9` (desplegado como RC4, `f32ab2c`) y en el perfil compose `production`**,
que es el que corre. No describe la arquitectura deseada: lo que no existe o no se usa se marca
como tal. El detalle técnico está en [docs/technical/architecture.md](../technical/architecture.md)
y en [docs/technical/services.md](../technical/services.md).

## Índice

- [Diagrama](#diagrama)
- [Los 12 servicios](#los-12-servicios)
- [Fuera del perfil production](#fuera-del-perfil-production)
- [Persistencia](#persistencia)
- [Comunicaciones](#comunicaciones)
- [Redes compose](#redes-compose)
- [Autoridades](#autoridades)
- [Lo que la arquitectura aparenta y no es](#lo-que-la-arquitectura-aparenta-y-no-es)
- [Verificación](#verificación)

## Diagrama

```
                         Navegador (SPA React + Phaser)
                                    │ HTTP(S) / WebSocket
                    [proxy inverso externo opcional, termina TLS]
                                    │
┌───────────────────────────────── gateway (nginx) ─────────────────────────────────┐
│  /            → web:3000          /api/v1/* → api:8080 (sin prefijo)                │
│  /ws/*        → tournament-worker:8081 (WebSocket espectador)                       │
│  /replays/*   → 404 (TD-004: replays por /api/v1)  /grafana/* → grafana:3000        │
└───────┬───────────────┬──────────────────────┬────────────────────────────────────┘
        │               │                      │
      web            api ── lee replays (volumen arena_replays, sólo lectura)
   (estático)           │
     INSERT jobs        │
                        ▼
             postgres ◄──── claim jobs ──── tournament-worker  (motor EN PROCESO; autoridad única de ejecución)
              ▲   ▲                              │  ingestReplay (disco) ─► arena_replays ◄── replay-service (interno)
              │   │                              │  lanza el ARTEFACTO FIRMADO de cada versión
              │   │                              ▼
              │   │                     s9-docker-proxy (HOST, red bot-control) ── docker.sock
              │   │                              ▼
              │   │                     contenedores de bots (red arena)
              │   └──── claim bot_build ──── bot-build-worker (pipeline + sandbox real por el mismo proxy)
              │                                queue (redis, aviso opcional)
              ├──── pg_dump ──── backup ──── SFTP ──► <backup-host> (restic)
              │
          map-service (en memoria, nadie lo llama)   bot-manager (control; /healthz)   arena-engine (servicio sin uso)
```
## Los 12 servicios

| Servicio | Responsabilidad real | Persistencia | Estado |
|---|---|---|---|
| `gateway` | nginx: único punto de entrada; enruta por prefijo; HSTS | — | FUNCIONA (con [TD-004](../roadmap/technical-debt.md#td-004) y [TD-014](../roadmap/technical-debt.md#td-014)) |
| `web` | SPA React 19 + Phaser 4 servida por nginx | — | PARCIAL |
| `api` | API REST (Express 5): usuarios, bots, loadouts, mapas, batallas, torneos, administración. RBAC desde OpenAPI. Encola trabajos. **Persiste los mapas** | PostgreSQL (casi todas las tablas) | FUNCIONA |
| `arena-engine` | Servicio HTTP con `POST /run` (camino legado) | — | **sin uso**: la API ya no lo llama; las batallas las ejecuta el `tournament-worker` |
| `tournament-worker` | **Autoridad única de ejecución**: reclama todos los trabajos `run_battle` de la cola `jobs`, calendarios, resultados y clasificación. Simula las batallas **en proceso** y lanza el artefacto firmado de la versión exacta de cada bot en contenedores, por el proxy de Docker. Aloja el WebSocket de espectador | PostgreSQL + replays en disco | FUNCIONA con el código real de los bots ([TD-002](../roadmap/technical-debt.md#td-002), cerrada) |
| `bot-manager` | Proceso de control: `/healthz` y readiness de la autoridad de lanzamiento | volúmenes de fuentes y caché | sin función de negocio activa |
| `bot-build-worker` | Ejecuta el pipeline de build de los trabajos `bot_build` (10 etapas: análisis, sandbox real con partida de humo, firma) | PostgreSQL | FUNCIONA ([TD-001](../roadmap/technical-debt.md#td-001)) |
| `map-service` | Almacén de mapas **en memoria**, sólo lectura | volúmenes montados sin uso | **sin uso** ([TD-017](../roadmap/technical-debt.md#td-017)) |
| `replay-service` | Guarda replays (índice y segmentos), re-verificación y retención. **Interno**: el navegador lee los replays por la API | **sólo disco** (no tiene tabla) | FUNCIONA; el gateway no lo expone ([TD-004](../roadmap/technical-debt.md#td-004)) |
| `queue` | Redis 7.4.9 (AOF, `noeviction`) | volumen | sólo canal de aviso, sin productor ([TD-026](../roadmap/technical-debt.md#td-026)) |
| `postgres` | PostgreSQL 16.14 (fijado por digest) | volumen | FUNCIONA |
| `backup` | cron: `pg_dump` + restic a SFTP; healthcheck sobre la última copia | repositorio restic remoto | FUNCIONA desde el 2026-10-15 ([TD-007](../roadmap/technical-debt.md#td-007)) |

## Fuera del perfil production

| Pieza | Dónde | Estado |
|---|---|---|
| `s9-docker-proxy` | **servicio systemd del host**, no un contenedor. Proxy de la API de Docker con allowlist (crear, arrancar, parar, inspeccionar) | en uso: lanza los contenedores del build y de las batallas (red `bot-control`) |
| `streamer` | perfil `streaming` | no desplegado |
| `bot-runtime-template` | perfil `bots`: plantilla del contenedor efímero de un bot | no desplegado |
| Observabilidad | perfil `observability` (Prometheus, Alertmanager, Grafana, Loki, Promtail, cAdvisor, exporters) | no desplegado |
| v1 | `docker-compose.demo.yml` | legacy, no desplegado |

## Persistencia

| Dato | Dónde vive | Quién escribe |
|---|---|---|
| Usuarios, sesiones, roles, equipos, bots, versiones, loadouts, catálogo, rulesets, mapas, batallas, torneos, ratings, auditoría, trabajos | PostgreSQL (35 tablas, 13 migraciones) | `api`, `tournament-worker`, `bot-build-worker` |
| Replays | volumen `arena_replays`; la BD sólo guarda `battles.replay_ref` | `tournament-worker` (disco directo) y `replay-service` (ingesta HTTP) |
| Fuentes de bots y caché de build | volúmenes `arena_bot_sources` y `arena_build_cache` | pipeline de build |
| Copias | repositorio restic remoto por SFTP | `backup` |

Detalle: [docs/technical/database.md](../technical/database.md).

## Comunicaciones

- **Navegador ↔ gateway:** HTTP(S) y WebSocket (`/ws/spectate/<battleId>`, con el ticket como subprotocolo).
- **api → postgres:** SQL (Knex). La API **no** llama a `arena-engine` (`POST /run` ya no ejecuta: delega en la cola) y lee los replays del volumen en sólo lectura.
- **Trabajos:** la API inserta en la tabla `jobs` y los workers la reclaman con `FOR UPDATE SKIP LOCKED`. Redis sólo es un aviso opcional.
- **tournament-worker y bot-build-worker → proxy Docker del host (red `bot-control`) → contenedores de bots** (red `arena`). El worker lanza el artefacto firmado de la versión exacta y le habla por el protocolo `arena/1`.
- **backup → `<backup-host>`:** SFTP (restic).

Detalle: [docs/technical/data-flow.md](../technical/data-flow.md).

## Redes compose

| Red | Tipo | Quién está |
|---|---|---|
| `public` | con salida | gateway (publica puertos), backup (sólo salida a SFTP), streamer y alertmanager (sólo salida) |
| `platform` | `internal: true` | casi todos los servicios de aplicación y redis |
| `data` | `internal: true` | postgres, api, tournament-worker, bot-build-worker, map-service, replay-service, backup |
| `build` | `internal: true` | bot-manager, bot-build-worker |
| `arena` | `internal: true` | tournament-worker, bot-build-worker, arena-engine y los contenedores de bots (los bots, sin ruta a BD ni API) |
| `bot-control` | `internal: true` | sólo los consumidores del proxy Docker: tournament-worker, bot-build-worker y arena-engine |

## Autoridades

| Dato | Autoridad única | Observación |
|---|---|---|
| Estado de los trabajos | tabla `jobs` (PostgreSQL) | Redis no es autoridad |
| Estado de una batalla | `battles.status`, escrito por el worker | reserva atómica con lease (`claimBattle`); `/run` de la API sólo encola ([TD-002](../roadmap/technical-debt.md#td-002)) |
| Contenido de los mapas | `map_versions.content`, escrito por la **API** | map-service no es autoridad aunque su nombre lo sugiera |
| Fichero de replay | disco (`arena_replays`) | sin tabla; la BD sólo guarda la referencia |
| Contrato HTTP y RBAC | `apps/api/openapi.yaml` (`x-min-role`) | las rutas fuera del contrato se declaran con `defineExtension` |
| Identidad de build | `BUILD_COMMIT` en cada imagen + `/version` (ADR-016) | **no existe en 9/12 servicios desplegados** ([TD-006](../roadmap/technical-debt.md#td-006)) |

## Lo que la arquitectura aparenta y no es

- `arena-engine` aparenta ser «el motor», pero las batallas se simulan **dentro del tournament-worker**, que importa el motor como librería.
- `map-service` aparenta ser la autoridad de mapas, pero la API importa su librería y persiste por su cuenta.
- `queue` (Redis) aparenta ser la cola, pero la cola es PostgreSQL.
- El WebSocket de espectador vive en el `tournament-worker`, no en la API; el gateway enruta `/ws/` hacia él.

## Documentación relacionada

- [docs/technical/architecture.md](../technical/architecture.md) · [services.md](../technical/services.md) · [data-flow.md](../technical/data-flow.md)
- [docs/technical/battles.md](../technical/battles.md): ciclo de batalla paso a paso.
- [docs/operations/docker.md](../operations/docker.md) · [docs/operations/networking.md](../operations/networking.md)
- [technologies.md](technologies.md) · [glossary.md](glossary.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| 12 servicios en el perfil `production` | CODE_VERIFIED | `infrastructure/docker-compose.yml` (`profiles:` de cada servicio) |
| Rutas del gateway | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf` (`location`) |
| La API no llama a `arena-engine`; el worker es la autoridad única de ejecución | CODE_VERIFIED | `apps/api/src/server.ts:15-21`; [battles.md](../technical/battles.md#autoridad-única-de-ejecución) |
| Motor en proceso dentro del worker | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:62-65`; `engine-executor.ts:20-27` |
| El WebSocket de espectador vive en el worker | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:59-60` |
| La API persiste los mapas | CODE_VERIFIED | `apps/api/src/routes/maps.ts` (`insertMapVersion`) |
| map-service en memoria | CODE_VERIFIED | `apps/map-service/src/main.ts:20-42` |
| La cola es PostgreSQL | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts`; `apps/bot-manager/src/build-worker.ts` |
| Redis sin productor | CODE_VERIFIED | `apps/tournament-worker/src/redis-signal.ts:207`; `notify(` sólo en tests |
| Redes `internal` | CODE_VERIFIED | `infrastructure/docker-compose.yml`, bloque `networks:` |
| Proxy Docker en el host | CODE_VERIFIED | `infrastructure/systemd/s9-docker-proxy.service`; `apps/bot-manager/src/docker-proxy-main.ts` |
| Estado en runtime | RUNTIME_VERIFIED (RC4 `f32ab2c`, 2026-10-27) | [current-status.md](../roadmap/current-status.md); histórico: [AUDIT-DELTA](../audits/2026-10-15/AUDIT-DELTA-2026-10.md) |
