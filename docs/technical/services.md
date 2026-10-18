# Servicios

## Resumen

Ficha de cada uno de los 12 servicios del perfil `production`, más el proxy Docker del host. Cada
ficha recoge: responsabilidad, entrypoint, entrada, salida, dependencias, persistencia,
configuración (por **nombre** de variable, nunca valores), healthcheck, errores conocidos y tests.
Fuente: `infrastructure/docker-compose.yml` y el código de `27f70bb`. La vista resumida está en
[docs/overview/architecture.md](../overview/architecture.md).

## Índice

[gateway](#gateway) · [web](#web) · [api](#api) · [arena-engine](#arena-engine) · [tournament-worker](#tournament-worker) · [bot-manager](#bot-manager) · [bot-build-worker](#bot-build-worker) · [map-service](#map-service) · [replay-service](#replay-service) · [queue](#queue) · [postgres](#postgres) · [backup](#backup) · [s9-docker-proxy (host)](#s9-docker-proxy-host) · [Verificación](#verificación)

Estas variables se repiten en varios servicios y se agrupan como «BD común»:

| Variable | Valor o uso |
|---|---|
| `DATABASE_URL` | vacío ⇒ el DSN se construye a partir de `PG*` |
| `PGHOST` | `postgres` |
| `PGUSER` | `arena` |
| `PGDATABASE` | `arena` |
| `PGPASSWORD_FILE` | fichero con la contraseña |
| `REDIS_URL` | URL de Redis |
| `LOG_FORMAT` | `json` |

---

## gateway

| Campo | Valor |
|---|---|
| Responsabilidad | Único punto de entrada; enruta por prefijo; añade HSTS y `X-Correlation-Id` |
| Entrypoint | nginx; config montada desde `infrastructure/gateway/${GATEWAY_CONF}` (`nginx.conf` o `nginx-behind-proxy.conf`) |
| Entrada | HTTP en `HTTP_PORT` (por defecto 80) y HTTPS en `HTTPS_PORT` (por defecto 443, sólo en el modo con TLS propio) |
| Salida | `web:3000`, `api:8080`, `tournament-worker:8081` (WebSocket), `replay-service:8083`, `grafana:3000` |
| Depende de | web, api (`required: false`) |
| Persistencia | — (TLS montado de sólo lectura en el modo standalone) |
| Configuración | `GATEWAY_CONF`, `S9_DOMAIN`, `HTTP_PORT`, `HTTPS_PORT` |
| Healthcheck | `wget http://127.0.0.1:80/healthz` (lo responde el propio nginx: **no** comprueba los upstreams) |
| Errores conocidos | [TD-004](../roadmap/technical-debt.md#td-004), [TD-014](../roadmap/technical-debt.md#td-014), [TD-020](../roadmap/technical-debt.md#td-020) |
| Tests | no hay test sobre la config real ([TD-018](../roadmap/technical-debt.md#td-018)) |
| Detalle | [gateway.md](gateway.md) |

## web

| Campo | Valor |
|---|---|
| Responsabilidad | SPA del panel: bots, loadouts, equipos, mapas y editor, batallas, torneos y bracket, replays, visor, ranking, admin |
| Entrypoint | nginx sirviendo el build de Vite (`infrastructure/docker/web/Dockerfile`) |
| Entrada | HTTP :3000 (desde el gateway) |
| Salida | el navegador llama a `/api/v1` y `/ws/` a través del gateway (`/replays*` responde 404 desde TD-004) |
| Persistencia | — |
| Configuración | `LOG_FORMAT` |
| Healthcheck | `wget http://127.0.0.1:3000/healthz` |
| Errores conocidos | [TD-003](../roadmap/technical-debt.md#td-003), [TD-009](../roadmap/technical-debt.md#td-009), [TD-010](../roadmap/technical-debt.md#td-010), [TD-022](../roadmap/technical-debt.md#td-022) |
| Tests | 31 ficheros en `apps/web` (jsdom, API mockeada) |
| Detalle | [frontend.md](frontend.md) |

## api

| Campo | Valor |
|---|---|
| Responsabilidad | API REST de toda la plataforma. RBAC desde `openapi.yaml`. Encola trabajos (`jobs`). Persiste los mapas. Emite tickets de espectador. Lanza `/run` hacia arena-engine (apagado) |
| Entrypoint | `apps/api/src/server.ts` (`SERVICE_ENTRY`); app en `apps/api/src/app.ts` |
| Entrada | HTTP :8080 (el gateway quita el prefijo `/api/v1`) |
| Salida | PostgreSQL; HTTP a `ARENA_ENGINE_URL` (`POST /run`) y a `REPLAY_SERVICE_URL` (ingesta); lectura de `/data/replays` (sólo lectura) |
| Depende de | postgres, queue (en el compose; **el código no usa Redis**) |
| Persistencia | casi todas las tablas (ver [database.md](database.md)) |
| Configuración | BD común; `PORT`, `JWT_SECRET_FILE`, `TRUST_PROXY_HOPS`, `CORS_ORIGIN`, `ARENA_ENGINE_URL`, `ARENA_ENGINE_SHARED_SECRET_FILE`, `ARENA_ENGINE_RUN_TIMEOUT_MS`, `S9_ENABLE_REAL_BATTLE_RUNS`, `S9_MAX_CONCURRENT_REAL_BATTLE_RUNS`, `REPLAY_SERVICE_URL`, `REPLAY_INGEST_REQUIRED`, `REPLAY_INGEST_TIMEOUT_MS`, `REPLAY_INGEST_SECRET_FILE`, `S9_PUBLIC_SPECTATE_ENABLED`, `S9_PUBLIC_REPLAYS_ENABLED`, `S9_METRICS_ENABLED`, `SPECTATE_TICKET_SECRET_FILE` (opcional; si falta, se deriva de la clave de sesión), `GIT_COMMIT`/`COMMIT_SHA` (leídas por `/system/status`) |
| Secretos montados | `postgres_password`, `jwt_secret`, `arena_engine_internal_secret`, `replay_ingest_secret` |
| Healthcheck | `wget http://127.0.0.1:8080/healthz` (envolvente Express; no consulta la BD) |
| Errores | JSON `{error, message, correlationId}`. 400 en validación, 403 por rol, 404 por ruta, 409 en conflictos de dominio, 503 `real_battle_runs_disabled`. Las violaciones de unicidad por carrera salen como 500 ([TD-013](../roadmap/technical-debt.md#td-013)) |
| Errores conocidos | [TD-003](../roadmap/technical-debt.md#td-003), [TD-005](../roadmap/technical-debt.md#td-005), [TD-011](../roadmap/technical-debt.md#td-011), [TD-012](../roadmap/technical-debt.md#td-012) |
| Tests | 36 ficheros en `apps/api` (BD embebida); `conformance.test.ts`; `rbac-matrix.test.ts` (generado desde OpenAPI, tautológico) |
| Detalle | [api.md](api.md), [security.md](security.md) |

## arena-engine

| Campo | Valor |
|---|---|
| Responsabilidad | Ejecutar una batalla con **contenedores reales** de bots (`POST /run`). **No** simula las batallas del sistema: eso lo hace el tournament-worker |
| Entrypoint | `apps/arena-engine/src/service.ts` |
| Entrada | HTTP :8081: `GET /healthz`; `POST /run` con la cabecera `x-arena-engine-auth` (secreto interno) |
| Salida | `DOCKER_PROXY_URL` (proxy del host) → contenedores de bots en la red `arena` |
| Persistencia | ninguna. Devuelve el replay en memoria a quien llama |
| Configuración | `PORT`, `DOCKER_PROXY_URL` (**vacía por defecto** ⇒ sin runner ⇒ 503), `ARENA_NETWORK`, `ARENA_ENGINE_HOST`, `ARENA_ENGINE_INTERNAL_SECRET_FILE` |
| Healthcheck | `wget http://127.0.0.1:8081/healthz` |
| Errores | 401 sin secreto válido, 503 sin runner |
| Estado | sin uso efectivo ([TD-002](../roadmap/technical-debt.md#td-002)) |
| Tests | 23 ficheros (motor, `service.test.ts`, regresiones y determinismo) |
| Detalle | [engine.md](engine.md), [battles.md](battles.md) |

## tournament-worker

| Campo | Valor |
|---|---|
| Responsabilidad | Reclamar y ejecutar los trabajos `run_battle`, `generate_schedule`, `process_result`, `update_standings` y `tournament_dry_run`. Simula las batallas en proceso. Escribe el replay en disco y el cierre en la BD. Aloja el WebSocket de espectador |
| Entrypoint | `apps/tournament-worker/src/main.ts` |
| Entrada | tabla `jobs`; Redis `BLPOP s9:wake:jobs` (opcional); WebSocket :8081 (`/spectate/<battleId>`) |
| Salida | `battles`, `participants`, `battle_stats`, `matches`, `tournaments`, `ratings`, `rating_events`, `standings`; ficheros en `/data/replays`; fichero de identidad `/tmp/version.json` |
| Depende de | postgres, queue |
| Persistencia | PostgreSQL + volumen `arena_replays` (lectura y escritura) |
| Configuración | BD común; `SPECTATE_PORT`, `REPLAYS_DIR`, `ARENA_DATA_DIRS`, `HEARTBEAT_PATH`, `VERSION_PATH` |
| Secretos montados | sólo `postgres_password` (falta el secreto de tickets: [TD-028](../roadmap/technical-debt.md#td-028)) |
| Healthcheck | latido `/tmp/heartbeat` con menos de 120 s |
| Errores | fallo de infraestructura ⇒ reintento con backoff y, agotado, `needs_review` + batalla `failed`/`infrastructure`; fallo deportivo ⇒ trabajo `done` con su código. Preflight: no arranca si `/data/replays` no es escribible |
| Errores conocidos | [TD-002](../roadmap/technical-debt.md#td-002), [TD-015](../roadmap/technical-debt.md#td-015), [TD-026](../roadmap/technical-debt.md#td-026), [TD-028](../roadmap/technical-debt.md#td-028) |
| Tests | 10 ficheros (`tournament-e2e`, `queue`, `ratings`, `worker-degradation`, `spectate-live`…) |
| Detalle | [workers.md](workers.md), [queue.md](queue.md) |

## bot-manager

| Campo | Valor |
|---|---|
| Responsabilidad | Proceso de **control**: instancia la autoridad de lanzamiento como prueba de readiness y expone `/healthz` y `/version`. **No** ejecuta builds ni batallas en el código actual |
| Entrypoint | `apps/bot-manager/src/main.ts` |
| Entrada | HTTP :8084 |
| Salida | — (`DOCKER_PROXY_URL` es obligatoria para arrancar, pero no se usa para operar) |
| Persistencia | volúmenes `arena_bot_sources` y `arena_build_cache` |
| Configuración | `PORT`, `DOCKER_PROXY_URL` (por defecto apunta al host vía `host-gateway`) |
| Secretos | ninguno. Redes `platform` + `build`, sin `data` |
| Healthcheck | `wget http://127.0.0.1:8084/healthz` |
| Errores | sin `DOCKER_PROXY_URL` no arranca (exit 1) |
| Tests | 20 ficheros en `apps/bot-manager` (pipeline, análisis, sandbox-escape, docker-proxy, launch-guard); `infrastructure/tests/bot-manager-isolation.test.ts` |
| Detalle | [bots.md](bots.md) |

## bot-build-worker

| Campo | Valor |
|---|---|
| Responsabilidad | Reclamar los trabajos `bot_build` y ejecutar el pipeline E6 (análisis estático y AST, secretos, firma) con `E6PipelineBotManager` |
| Entrypoint | `apps/bot-manager/src/build-worker-main.ts` (misma imagen que bot-manager) |
| Entrada | tabla `jobs` (`kind = bot_build`) |
| Salida | `builds`, `bot_versions.state`, `artifacts`, `security_findings`, `audit_log` |
| Persistencia | PostgreSQL + volúmenes de fuentes y caché |
| Configuración | BD común; `ARTIFACT_SIGNING_KEY_FILE`, `HEARTBEAT_PATH` |
| Secretos montados | `postgres_password`, `artifact_signing_key` (sin clave de firma **no arranca**) |
| Healthcheck | latido `/tmp/heartbeat` con menos de 120 s |
| Errores | sin `agentResolver`, las etapas de ejecución son «no verificables» ⇒ versión `rejected`, build `failed` (**siempre**, [TD-001](../roadmap/technical-debt.md#td-001)) |
| Tests | `pipeline.test.ts`, `static-analysis.test.ts`, `ast-analysis.test.ts`, `r25-cola-builds.test.ts` |
| Detalle | [workers.md](workers.md), [bots.md](bots.md) |

## map-service

| Campo | Valor |
|---|---|
| Responsabilidad | **Nominal:** importar, validar, generar y versionar mapas. **Real:** sirve `GET /maps` y `GET /maps/:id/:version` desde un `MapService` en memoria **vacío**. Ningún componente lo llama |
| Entrypoint | `apps/map-service/src/main.ts` |
| Entrada | HTTP :8082 |
| Persistencia | ninguna efectiva (volúmenes `arena_maps` y `arena_assets` montados sin uso; secreto de BD montado sin uso) |
| Configuración | `PORT` |
| Healthcheck | `wget http://127.0.0.1:8082/healthz` (devuelve `maps: 0`) |
| Estado | [TD-017](../roadmap/technical-debt.md#td-017). La **librería** de `apps/map-service/src` sí se usa, importada por la API y el worker |
| Tests | 6 ficheros (validación, generación, import de Tiled, `main.test.ts`) |
| Detalle | [maps.md](maps.md) |

## replay-service

| Campo | Valor |
|---|---|
| Responsabilidad | Almacén de replays en disco: listar, servir, servir índice y segmentos, re-verificar por re-simulación, ingesta autenticada, barrido de retención |
| Entrypoint | `apps/replay-service/src/main.ts`; rutas en `server.ts` |
| Entrada | HTTP :8083, ver la tabla siguiente |
| Persistencia | **sólo disco** (`arena_replays`). No escribe en la BD |
| Configuración | `PORT`, `REPLAYS_DIR`, `ARENA_DATA_DIRS`, `REPLAY_INGEST_SECRET_FILE` |
| Secretos montados | `postgres_password` (sin uso en el código), `replay_ingest_secret` |
| Healthcheck | `wget http://127.0.0.1:8083/healthz` |
| Errores | 401 en una escritura sin secreto; 404 si el replay no existe |
| Errores conocidos | [TD-004](../roadmap/technical-debt.md#td-004) |
| Tests | 7 ficheros (`ingest-auth`, `list-replays`, `retention-sweep-regression`, `stats`) |
| Detalle | [replays.md](replays.md) |

Rutas del replay-service (internas: el gateway ya no las enruta desde TD-004; el navegador lee por la API):

| Ruta | Autenticación |
|---|---|
| `GET /replays` | ninguna |
| `GET /replays/:battleId` | ninguna |
| `GET /replays/:battleId/index` | ninguna |
| `GET /replays/:battleId/segment` | ninguna |
| `POST /replays/:battleId/verify` | ninguna |
| `POST /replays/:battleId` | secreto (ingesta) |
| `POST /retention/sweep` | secreto |

## queue

| Campo | Valor |
|---|---|
| Responsabilidad | Redis como **canal de aviso** del worker. No es la cola: la cola es `jobs` |
| Imagen | `redis:7.4.9-alpine`, fijada por digest; `--appendonly yes --maxmemory 256mb --maxmemory-policy noeviction` |
| Persistencia | volumen `queue_data` (AOF) |
| Healthcheck | `redis-cli ping` |
| Estado | sin productor ([TD-026](../roadmap/technical-debt.md#td-026)) |
| Detalle | [queue.md](queue.md) |

## postgres

| Campo | Valor |
|---|---|
| Responsabilidad | BD de negocio y cola de trabajos |
| Imagen | `postgres:16.14-alpine`, fijada por digest. Subir de versión requiere una ventana de BD autorizada |
| Persistencia | volumen `postgres_data` |
| Configuración | `POSTGRES_USER=arena`, `POSTGRES_DB=arena`, `POSTGRES_PASSWORD_FILE`. **El único rol es `arena`** (no existe `postgres`) |
| Healthcheck | `pg_isready -U arena -d arena` |
| Errores conocidos | sin `stop_grace_period` ([TD-007](../roadmap/technical-debt.md#td-007)). No está en el perfil `external-db` |
| Detalle | [database.md](database.md) |

## backup

| Campo | Valor |
|---|---|
| Responsabilidad | Cron diario: `pg_dump` + copia de los volúmenes de datos y de los secretos (cifrados por restic), subida por SFTP, `forget --prune` y `restic check` |
| Entrypoint | `infrastructure/backup/entrypoint.sh` → `backup.sh` |
| Entrada | volúmenes de datos de sólo lectura; `./secrets` de sólo lectura |
| Salida | repositorio restic en `<backup-host>` (SFTP); métricas textfile en `backup_metrics` |
| Configuración | `BACKUP_CRON` (por defecto `15 4 * * *`, en UTC), `REPLAY_RETENTION_DAYS`, `RESTIC_HOSTNAME`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `RESTIC_SSH_KEY_FILE`, `RESTIC_SSH_KNOWN_HOSTS_FILE`, `PG*`, `METRICS_DIR`, `WORK_DIR` |
| Healthcheck | `healthcheck.sh`: exige crond vivo **y** una última copia con exit 0, postgres correcto y antigüedad menor de 26 h |
| Errores conocidos | sin alertas ([TD-007](../roadmap/technical-debt.md#td-007)). Versionado aparte con `BACKUP_TAG` |
| Tests | `infrastructure/tests/backup*.test.ts`, `backup-sftp-e2e`, `restore-sftp-bootstrap`, `restore-snapshot-selection`, `manifest-pgdump` |
| Detalle | [docs/operations/backup.md](../operations/backup.md), [docs/operations/restore.md](../operations/restore.md) |

## s9-docker-proxy (host)

| Campo | Valor |
|---|---|
| Responsabilidad | Proxy de la API de Docker con allowlist (crear, arrancar, parar, inspeccionar, estadísticas). Rechaza `privileged`, bind-mounts, red del host y cambios de usuario |
| Entrypoint | unidad systemd `infrastructure/systemd/s9-docker-proxy.service` → `apps/bot-manager/src/docker-proxy-main.ts` |
| Configuración | `DOCKER_PROXY_BIND` (por defecto loopback), `DOCKER_PROXY_PORT` (2375), `DOCKER_SOCKET`, `ARENA_NETWORK`, `SANDBOX_USER` |
| Estado | instalado; ningún flujo activo lo usa hoy |
| Detalle | [docs/operations/docker-proxy.md](../operations/docker-proxy.md) |

## Documentación relacionada

- [architecture.md](architecture.md) · [data-flow.md](data-flow.md) · [database.md](database.md) · [queue.md](queue.md) · [workers.md](workers.md) · [gateway.md](gateway.md) · [security.md](security.md)
- [docs/operations/configuration.md](../operations/configuration.md) · [docs/operations/docker.md](../operations/docker.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Perfiles, redes, volúmenes, secretos, variables y healthchecks | CODE_VERIFIED | `infrastructure/docker-compose.yml`, bloque de cada servicio |
| Variables leídas por el código | CODE_VERIFIED | `grep -rhoE 'process\.env\.[A-Z0-9_]+' apps/<svc>/src` |
| La API no usa Redis | CODE_VERIFIED | ausencia de `REDIS_URL` en `apps/api/src` |
| Rutas del replay-service | CODE_VERIFIED | `apps/replay-service/src/server.ts:105-252` |
| Rutas de map-service | CODE_VERIFIED | `apps/map-service/src/main.ts:26-42` |
| bot-manager no arranca sin proxy | CODE_VERIFIED | `apps/bot-manager/src/main.ts:30-35,62-66` |
| bot-build-worker sin clave no arranca | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:29-30` |
| `/run` con secreto interno | CODE_VERIFIED | `apps/arena-engine/src/service.ts:264-270` |
| Secretos del worker | CODE_VERIFIED + RUNTIME_VERIFIED (sólo nombres) | compose; `docker inspect` de nombres de variables y montajes, 2026-10-15 |
| Recuento de tests | CODE_VERIFIED | `git ls-files apps infrastructure/tests` filtrado por `.test.ts` |
