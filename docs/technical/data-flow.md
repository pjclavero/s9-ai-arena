# Flujo de datos y comunicaciones

## Resumen

Inventario de **todas** las comunicaciones entre componentes de S9 AI Arena en `27f70bb`:
HTTP, WebSocket, Redis, la API de Docker a través del proxy del host, PostgreSQL, ficheros
compartidos y SFTP. Para cada una se indica productor, consumidor, contrato, autoridad, errores,
seguridad y estado.

El sistema no usa MQTT ni ningún otro bus de mensajes.

## Índice

- [Mapa](#mapa)
- [HTTP](#http)
- [WebSocket](#websocket)
- [PostgreSQL](#postgresql)
- [Redis](#redis)
- [API de Docker (proxy del host)](#api-de-docker-proxy-del-host)
- [Ficheros compartidos (volúmenes)](#ficheros-compartidos-volúmenes)
- [SFTP (backup)](#sftp-backup)
- [Flujos de extremo a extremo](#flujos-de-extremo-a-extremo)
- [Verificación](#verificación)

## Mapa

```
navegador ─HTTP(S)/WS─► gateway ─► web | api | tournament-worker(WS) | replay-service
api ─SQL─► postgres ◄─SQL─ tournament-worker, bot-build-worker, backup(pg_dump)
api ─HTTP─► arena-engine ─HTTP─► s9-docker-proxy(host) ─► docker.sock ─► bots(red arena) ─WS─► arena-engine
api ─HTTP─► replay-service            tournament-worker ─fichero─► arena_replays ◄─fichero─ replay-service
tournament-worker ─BLPOP─► redis      backup ─SFTP─► <backup-host>
```

Los caminos que hoy no se ejercen son los del proxy Docker, los bots y la ingesta HTTP de replays
(ver [battles.md](battles.md)).

## HTTP

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad | Estado |
|---|---|---|---|---|---|
| navegador → gateway → `api` (`/api/v1/*`) | `apps/api/openapi.yaml` | la API | JSON `{error, message, correlationId}` | JWT Bearer + RBAC `x-min-role`; refresh en cookie `httpOnly` | FUNCIONA |
| navegador → gateway → `replay-service` (`/replays/*`) | rutas de `apps/replay-service/src/server.ts` | el replay-service (disco) | 404 si no existe | lectura **sin** autenticación ([TD-004](../roadmap/technical-debt.md#td-004)) | FUNCIONA; 301 a http ([TD-014](../roadmap/technical-debt.md#td-014)) |
| navegador → gateway → `web` (`/`) | estáticos | — | rutas desconocidas ⇒ SPA | — | FUNCIONA |
| `api` → `arena-engine` `POST /run` | `apps/arena-engine/src/service.ts` | arena-engine (ejecución) | 401 sin secreto; 503 sin runner; la API devuelve `{status:"failed"}` | cabecera `x-arena-engine-auth` (secreto `arena_engine_internal_secret`), sólo red `platform` | **apagado**: flag vacía y `DOCKER_PROXY_URL` vacío |
| `api` → `replay-service` `POST /replays/:battleId` | ingesta (`battle-run-http-launcher.ts`) | el replay-service | sin secreto ⇒ 401 ⇒ `replay.ingested: false` (falla cerrado). `REPLAY_INGEST_REQUIRED` vacío ⇒ un fallo no tumba la batalla | secreto `replay_ingest_secret` | sólo en el camino real (apagado) |
| `bot-build-worker` / `tournament-worker` / `arena-engine` → `s9-docker-proxy` | subconjunto de la API de Docker (create/start/stop/json/stats) | el proxy (allowlist de endpoints, de imágenes y propiedad por labels) | 403 fuera de la allowlist, con imagen ajena, sobre un contenedor ajeno o desde un cliente no admitido; 404 si el contenedor no existe | sin TLS; red dedicada `bot-control` (`docker-proxy.internal` → `10.89.250.1`, IP fija, nunca `host-gateway`), firewall de host y control de cliente por IP de origen ([docker-proxy.md](../operations/docker-proxy.md), [networking.md](../operations/networking.md)). `bot-manager` no lo consume | integrado en `main` (RC2) y cubierto por `functional-e2e / container-proxy-e2e`; sin desplegar |
| `gateway` → `grafana` (`/grafana/`) | — | — | 502 sin el perfil | autenticación de Grafana | perfil no desplegado |

## WebSocket

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad | Estado |
|---|---|---|---|---|---|
| navegador → gateway `/ws/spectate/<battleId>` → `tournament-worker` :8081 | `SpectateGateway` (`apps/api/src/spectate/gateway.ts`): subprotocolos `spectate.v1, ticket.<jwt>` | la batalla en la memoria del worker | cierres 4400 (sin ticket), 4401 (ticket inválido), 4403 (otra batalla, ya usado o público apagado), 4404 (batalla no en directo) | ticket JWT con `aud = s9-arena/spectate`, de un solo uso (`jti`), emitido por la API (`getSpectateTicket`) | **roto**: el worker no tiene el secreto ([TD-028](../roadmap/technical-debt.md#td-028)); el visor no llega a conectar ([TD-009](../roadmap/technical-debt.md#td-009)) |
| bot (contenedor) ↔ `arena-engine` (protocolo `arena/1`) | `packages/protocol` (JSON); decisión cada 3 ticks con un plazo de 80 ms | el motor | timeout ⇒ fallo deportivo del bot | sólo red `arena` | sin uso (no hay contenedores de bot) |

Detalle del protocolo: [websocket.md](websocket.md) y [bots.md](bots.md).

## PostgreSQL

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad |
|---|---|---|---|---|
| `api`, `tournament-worker`, `bot-build-worker` ↔ `postgres` | esquema de `apps/api/src/db/migrations.ts` (Knex) | **PostgreSQL es la autoridad** de todo el estado de negocio y de la cola (`jobs`) | constraints (CHECK, UNIQUE). Una violación de unicidad por carrera se convierte en 500 ([TD-013](../roadmap/technical-debt.md#td-013)) | red `data` (interna); rol único `arena`; contraseña por fichero |
| `backup` → `postgres` (`pg_dump -U arena`) | volcado lógico | — | un fallo marca la ejecución como fallida en las métricas | sólo lectura de datos |

Mapa de quién escribe y lee cada tabla: [database.md](database.md#quién-escribe-y-quién-lee).
Cola: [queue.md](queue.md).

## Redis

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad | Estado |
|---|---|---|---|---|---|
| **(nadie)** → `tournament-worker`: `LPUSH`/`BLPOP s9:wake:jobs` | `apps/tournament-worker/src/redis-signal.ts` | **ninguna** (sólo aviso) | si cae, el worker pasa a polling y lo registra | red `platform`; sin autenticación | sin productor ([TD-026](../roadmap/technical-debt.md#td-026)) |

## API de Docker (proxy del host)

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad | Estado |
|---|---|---|---|---|---|
| `arena-engine` (ProxyContainerRunner) / `bot-manager` → `s9-docker-proxy` → `docker.sock` | crear, arrancar, parar, inspeccionar, estadísticas (`apps/bot-manager/src/docker-proxy.ts`) | el proxy aplica la política: red `arena`, usuario de sandbox | rechaza `privileged`, bind-mounts, red del host y cambio de usuario | sólo el proxy del host toca el socket; ningún contenedor lo monta | sin uso activo: `DOCKER_PROXY_URL` vacío en arena-engine |

Operación: [docs/operations/docker-proxy.md](../operations/docker-proxy.md).

## Ficheros compartidos (volúmenes)

| Volumen | Escribe | Lee | Contrato |
|---|---|---|---|
| `arena_replays` | tournament-worker (`ingestReplay`, en disco); replay-service (ingesta HTTP, retención) | replay-service; api (sólo lectura: `getReplay`/`verifyReplay` leen `battles.replay_ref`); backup (sólo lectura) | formato de replay del motor (índice + segmentos). Ver [replays.md](replays.md) |
| `arena_bot_sources`, `arena_build_cache` | pipeline de build | bot-manager, backup (sólo lectura las fuentes) | — |
| `arena_maps`, `arena_assets` | (ninguno en el flujo actual) | map-service (montado sin uso), backup | — |
| `backup_metrics` | backup | healthcheck del backup; Prometheus si se despliega | textfile collector |

## SFTP (backup)

| Productor → consumidor | Contrato | Autoridad | Errores | Seguridad | Estado |
|---|---|---|---|---|---|
| `backup` → `<backup-host>` (restic sobre SFTP) | repositorio restic (`RESTIC_REPOSITORY`), `--host $RESTIC_HOSTNAME`; retención de 14 diarios, 8 semanales y 12 mensuales | el repositorio restic | `restic check` después de cada ejecución; el healthcheck se pone `unhealthy` si la última copia correcta tiene más de 26 h | clave SSH propia y `known_hosts` (**nunca** `StrictHostKeyChecking=no`); red `public` sólo de salida | FUNCIONA (2026-10-15); sin alerta ([TD-007](../roadmap/technical-debt.md#td-007)) |

## Flujos de extremo a extremo

| Flujo | Recorrido real | Estado |
|---|---|---|
| Enviar un bot a validación | web → api (`bot_versions`, `builds`, `jobs.bot_build`) → bot-build-worker → `rejected` | falla cerrado ([TD-001](../roadmap/technical-debt.md#td-001)) |
| Crear una batalla | web → api (400 de ruleset) | roto ([TD-003](../roadmap/technical-debt.md#td-003)) |
| Ejecutar una batalla | api (`jobs.run_battle`) → tournament-worker (motor en proceso, stub) → disco + `battles` → `process_result` | funciona con el stub ([TD-002](../roadmap/technical-debt.md#td-002)) |
| Ver un replay | web → gateway `/replays/<id>/index` y `segment` → render Phaser | la cadena HTTP funciona; el render no ([TD-009](../roadmap/technical-debt.md#td-009)) |
| Ver en directo | web → api (ticket) → gateway `/ws/` → worker | roto ([TD-009](../roadmap/technical-debt.md#td-009), [TD-028](../roadmap/technical-debt.md#td-028)) |
| Copia nocturna | backup → postgres + volúmenes → SFTP | funciona |

El ciclo de batalla paso a paso está en [battles.md](battles.md).

## Documentación relacionada

- [architecture.md](architecture.md) · [services.md](services.md) · [gateway.md](gateway.md) · [queue.md](queue.md) · [security.md](security.md)
- [api.md](api.md) · [websocket.md](websocket.md) · [replays.md](replays.md) · [battles.md](battles.md)
- [docs/operations/networking.md](../operations/networking.md) · [docs/operations/backup.md](../operations/backup.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Rutas del gateway | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf` |
| Códigos de cierre del WS | CODE_VERIFIED | `apps/api/src/spectate/gateway.ts:195-240` |
| Secreto interno de `/run` | CODE_VERIFIED | `apps/arena-engine/src/service.ts:264-270` |
| Ingesta con secreto, fail-closed | CODE_VERIFIED | `apps/replay-service/src/server.ts:111`; comentario del compose del servicio api (B8) |
| La API lee `replay_ref` en sólo lectura | CODE_VERIFIED | `infrastructure/docker-compose.yml` (volumen `arena_replays:/data/replays:ro` de api) |
| Redis sin productor | CODE_VERIFIED | `apps/tournament-worker/src/redis-signal.ts:207-215` |
| Allowlist del proxy | CODE_VERIFIED | `apps/bot-manager/src/docker-proxy.ts:100-104` |
| Retención de restic | CODE_VERIFIED | `infrastructure/backup/backup.sh:771` |
| Sin MQTT | CODE_VERIFIED | `grep -rni mqtt apps packages infrastructure` (vacío) |
| Backup funcionando | RUNTIME_VERIFIED | estado de salud y logs, 2026-10-15 |
