# Configuración

## Resumen

Referencia de las variables de configuración de una instalación: dónde se definen, qué servicio
las lee, su valor por defecto y si son obligatorias. Contrastada con
`infrastructure/docker-compose.yml`, `infrastructure/.env.example` y el código de `27f70bb`.
Ningún valor secreto aparece aquí.

## Índice

- [Cómo funciona](#cómo-funciona)
- [Variables de interpolación del compose (`infrastructure/.env`)](#variables-de-interpolación-del-compose-infrastructureenv)
- [Variables fijadas por el compose dentro de los contenedores](#variables-fijadas-por-el-compose-dentro-de-los-contenedores)
- [Variables que el código lee pero el compose NO pasa](#variables-que-el-código-lee-pero-el-compose-no-pasa)
- [Secretos](#secretos)
- [Variables sólo de desarrollo y tests](#variables-sólo-de-desarrollo-y-tests)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Cómo funciona

- `infrastructure/.env` (copia de `infrastructure/.env.example`) sirve **sólo para interpolar**
  `${VAR}` en el compose. El compose **no** usa `env_file:`: una variable puesta en `.env` llega
  a un contenedor únicamente si el bloque `environment:` de ese servicio la referencia.
- Los secretos nunca van en `.env`: se montan como ficheros en `/run/secrets/<nombre>` y el código
  lee la variable `*_FILE` correspondiente.
- El `.env.example` de la **raíz** del repositorio (`ARENA_PORT`, `TICK_RATE`, `VIEWER_PORT`)
  pertenece al prototipo v1 (`apps/arena-server`, `docker-compose.demo.yml`) y no afecta al stack.

## Variables de interpolación del compose (`infrastructure/.env`)

| Variable | Usada por | Por defecto (compose) | Obligatoria | Notas |
|---|---|---|---|---|
| `TAG` | todas las imágenes propias | `latest` | **sí** | fija `sha-<commit>`; `latest` no se publica |
| `<SERVICIO>_TAG` (`API_TAG`, `WEB_TAG`, `GATEWAY_TAG`, `ARENA_ENGINE_TAG`, `MAP_SERVICE_TAG`, `REPLAY_SERVICE_TAG`, `BOT_MANAGER_TAG`, `BOT_RUNTIME_TAG`, `STREAMER_TAG`, `TOURNAMENT_WORKER_TAG`) | ese servicio | `${TAG}` | no | override por servicio; sólo reproducible si vive en `.env` ([upgrades.md](upgrades.md#override-de-versión-por-servicio)) |
| `BACKUP_TAG` | `backup` | `latest` | **sí** | no sigue a `TAG` a propósito |
| `IMAGE_PREFIX` | todas las imágenes propias | `ghcr.io/pjclavero/s9-ai-arena` | no | registro alternativo o imágenes locales |
| `COMPOSE_PROFILES` | Compose | — | no | `production`; alternativa a `--profile` |
| `S9_DOMAIN` | `gateway` (entorno) | `arena.local` | sí (readiness lo exige) | el gateway no lo usa en `server_name` (`_`) |
| `HTTP_PORT` / `HTTPS_PORT` | `gateway` (puertos publicados) | `80` / `443` | no | único servicio con puertos al host |
| `GATEWAY_CONF` | `gateway` (fichero montado) | `nginx.conf` | no | `nginx-behind-proxy.conf` detrás de proxy ([networking.md](networking.md)) |
| `TRUST_PROXY_HOPS` | `api` | `1` | no | entero `0..8`; inválido → la API no arranca; `2` detrás de un proxy inverso |
| `DATABASE_URL` | `api`, `tournament-worker`, `bot-build-worker`, `map-service`, `replay-service` | vacío | no | vacío = Postgres del stack vía `PGHOST`; con perfil `external-db` apunta a un PostgreSQL externo |
| `ARENA_ENGINE_URL` | `api` | `http://arena-engine:8081` | no | runner HTTP de `/run` |
| `S9_ENABLE_REAL_BATTLE_RUNS` | `api` | vacío (apagado) | no | `1` activa `/run` real; **no activar**: ver nota de doble ejecución abajo |
| `S9_MAX_CONCURRENT_REAL_BATTLE_RUNS` | `api` | vacío | no | límite de `/run` concurrentes |
| `REPLAY_SERVICE_URL` | `api` | `http://replay-service:8083` | no | ingesta del replay del camino `/run` |
| `REPLAY_INGEST_REQUIRED` | `api` | vacío | no | `1` = la batalla falla si la ingesta falla |
| `DOCKER_PROXY_URL` | `arena-engine` | vacío | no | vacío = el motor no lanza contenedores de bots (estado de producción) |
| `DOCKER_PROXY_URL` | `bot-manager` | `http://docker-proxy.internal:2375` | no | el proxy vive en el host ([docker-proxy.md](docker-proxy.md)) |
| `ARENA_NETWORK` | `arena-engine` | `arena` | no | red de los contenedores de bots (nombre fijo) |
| `ARENA_ENGINE_HOST` | `arena-engine` | `arena-engine` | no | nombre con el que los bots alcanzan al motor |
| `API_ENTRY`, `ENGINE_ENTRY`, `WORKER_ENTRY`, `BOT_MANAGER_ENTRY`, `BOT_BUILD_WORKER_ENTRY`, `MAP_SERVICE_ENTRY`, `REPLAY_SERVICE_ENTRY` | servicios Node (`SERVICE_ENTRY`) | el `main`/`server` de cada app | no | no tocar salvo depuración |
| `RESTIC_REPOSITORY` | `backup` | vacío | **sí** para tener copias | `sftp:usuario@host:/ruta` (ruta dentro del chroot) o ruta montada |
| `RESTIC_HOSTNAME` | `backup` | un nombre lógico fijo | **sí** (vacío aborta el arranque) | agrupa la retención; no cambiarlo en producción |
| `BACKUP_CRON` | `backup` | `15 4 * * *` | no | hora del contenedor (UTC) |
| `REPLAY_RETENTION_DAYS` | `backup` | `180` | no | replays de más edad no se copian (`official/` sin límite) |
| `BUILD_COMMIT` / `BUILD_DATE` | `build.args` de todas las imágenes propias | `unknown` | **sí al construir** | identidad ADR-016; sólo afecta a `build` |
| `BROADCAST_URL`, `RTMPS_URL`, `STREAM_MODE`, `STREAM_ENCODER`, `STREAM_AUTOSTART` | `streamer` (perfil `streaming`) | ver compose | no | fuera del perfil `production` |
| `ALERT_WEBHOOK_URL`, `ALERT_EMAIL`, `PG_EXPORTER_URI` | perfil `observability` | — | no | observabilidad no desplegada en producción |

> **Doble ejecución.** Hoy toda batalla la ejecuta `tournament-worker`. Encender
> `S9_ENABLE_REAL_BATTLE_RUNS=1` con `DOCKER_PROXY_URL` del motor configurado añadiría un segundo
> camino de ejecución sobre las mismas batallas ([TD-002](../roadmap/technical-debt.md#td-002)).
> La puerta de activación está descrita en [../technical/battles.md](../technical/battles.md).

## Variables fijadas por el compose dentro de los contenedores

No se configuran en `.env`; se documentan para diagnóstico.

| Variable | Servicios | Valor |
|---|---|---|
| `PGHOST` / `PGUSER` / `PGDATABASE` / `PGPASSWORD_FILE` | api, tournament-worker, bot-build-worker, map-service, replay-service, backup | `postgres` / `arena` / `arena` / `/run/secrets/postgres_password` |
| `REDIS_URL` | los mismos (salvo backup) | `redis://queue:6379` |
| `PORT` | api 8080 · arena-engine 8081 · map-service 8082 · replay-service 8083 · bot-manager 8084 | — |
| `SPECTATE_PORT` | tournament-worker | `8081` (WebSocket de espectador, enrutado por el gateway en `/ws/`) |
| `REPLAYS_DIR` / `ARENA_DATA_DIRS` | tournament-worker, replay-service | `/data/replays` |
| `LOG_FORMAT` | servicios propios | `json` |
| `POSTGRES_USER` / `POSTGRES_DB` | postgres | `arena` / `arena` |
| `METRICS_DIR` / `WORK_DIR` | backup | `/textfile` / `/tmp/backup-work` |

## Variables que el código lee pero el compose NO pasa

Ponerlas en `infrastructure/.env` **no tiene efecto**: haría falta un fichero compose adicional
(override) que las añada al `environment:` del servicio, con el procedimiento de
[upgrades.md](upgrades.md).

| Variable | Lee | Por defecto en código | Efecto hoy |
|---|---|---|---|
| `CORS_ORIGIN` | api (`app.ts:120`) | `http://localhost:5173` | el origen permitido en producción es ese valor por defecto; la web es same-origin a través del gateway. El compose no la entrega ([TD-030](../roadmap/technical-debt.md#td-030)) |
| `S9_PUBLIC_SPECTATE_ENABLED` | api | apagado | espectador público apagado |
| `S9_PUBLIC_REPLAYS_ENABLED` | api | apagado | replays públicos de la API apagados (pero `/replays/*` del replay-service es anónimo por el gateway, [TD-004](../roadmap/technical-debt.md#td-004)) |
| `S9_METRICS_ENABLED` | api | apagado | sin `/metrics` |
| `SPECTATE_WS_URL` | api (`routes/battles.ts:37`) | `ws://localhost:8081/spectate` | el ticket de espectador apunta a localhost; sin `NODE_ENV=production` no se exige `wss://` ([TD-028](../roadmap/technical-debt.md#td-028)) |
| `SPECTATE_TICKET_SECRET_FILE` | api | derivado de `jwt_secret` (HKDF) | — |
| `NODE_ENV` | api (`/system/status`, chequeo `wss://`) | sin definir | `/system/status` informa `unknown` |
| `GIT_COMMIT` / `COMMIT_SHA` | api (`/system/status`) | `unknown` | el panel no muestra la versión ADR-016 ([TD-020](../roadmap/technical-debt.md#td-020)) |
| `ARENA_ENGINE_RUN_TIMEOUT_MS`, `REPLAY_INGEST_TIMEOUT_MS` | api | derivado / `10000` | — |
| `S9_READINESS_CONTAINER`, `S9_READINESS_BACKUP_CONTAINER`, `S9_READINESS_REPO` | `scripts/readiness.ts` (host) | vacío | se pasan en la línea de comandos del host ([readiness.md](readiness.md)) |

## Secretos

Ficheros en `infrastructure/secrets/` (generados por `init-secrets.sh`), montados en
`/run/secrets/`:

| Secreto | Servicios | Variable que lo lee |
|---|---|---|
| `postgres_password` | postgres, api, tournament-worker, bot-build-worker, map-service, replay-service, backup (y postgres-exporter en `observability`) | `POSTGRES_PASSWORD_FILE` / `PGPASSWORD_FILE` |
| `jwt_secret` | api | `JWT_SECRET_FILE` |
| `arena_engine_internal_secret` | api, arena-engine | `ARENA_ENGINE_SHARED_SECRET_FILE` / `ARENA_ENGINE_INTERNAL_SECRET_FILE` |
| `replay_ingest_secret` | api, replay-service | `REPLAY_INGEST_SECRET_FILE` |
| `artifact_signing_key` | bot-build-worker | `ARTIFACT_SIGNING_KEY_FILE` |
| `restic_password`, `restic_ssh_key`, `restic_ssh_known_hosts` | backup | `RESTIC_PASSWORD_FILE`, `RESTIC_SSH_KEY_FILE`, `RESTIC_SSH_KNOWN_HOSTS_FILE` |
| `stream_key` | streamer | `STREAM_KEY_FILE` |
| `grafana_admin_password` | grafana (perfil `observability`) | — |
| `tls/` (directorio) | gateway (`/etc/nginx/tls`) | sólo con `nginx.conf` |

Además el servicio `backup` monta todo `infrastructure/secrets` en `/secrets:ro` para copiarlo en
un snapshot aparte (`s9-arena-secrets`).

Sin secreto, los servicios **fallan cerrados** (no arrancan): la API exige `JWT_SECRET_FILE` o
`JWT_SECRET` salvo `ARENA_DEV_INSECURE_SECRETS=1`, que es sólo de desarrollo.

## Variables sólo de desarrollo y tests

`ARENA_DEV_INSECURE_SECRETS=1` (secretos efímeros por proceso), `RUN_SLOW=1`, `REDIS_TEST_URL`,
`S9_RUN_REAL_DOCKER_E2E`, `SMOKE_*`, `REPLAY_INGEST_ENABLED`, `REPLAY_INGEST_RETRIES` (estas dos
las lee sólo `scripts/e2e-real-battle-smoke.ts`, no la API). Ver
[../development/testing.md](../development/testing.md). **Nunca** en producción.

## Errores / limitaciones

- Variables con nombre parecido que **no existen**: `S9_LOG_LEVEL`, `S9_PUBLIC_BASE_URL`,
  `STAGING_SSH_KEY` (la CI sólo lee `STAGING_HOST`), `S9_WEBRTC_ENABLED`.
- `TRUST_PROXY_HOPS`: con un proxy delante y el valor por defecto `1`, la API ve la IP del proxy
  como IP del cliente; la cuota anónima y el bloqueo de login se comparten entre todos los
  clientes ([TD-012](../roadmap/technical-debt.md#td-012)).

## Documentación relacionada

[installation.md](installation.md) · [docker.md](docker.md) · [networking.md](networking.md) ·
[backup.md](backup.md) · [../technical/services.md](../technical/services.md) ·
[../technical/security.md](../technical/security.md) · [../technical/gateway.md](../technical/gateway.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Valores por defecto de la tabla de interpolación | CODE_VERIFIED | `infrastructure/docker-compose.yml` (bloques `environment:`/`image:`/`ports:`), renderizado con `docker compose config` |
| El compose no usa `env_file:` | CODE_VERIFIED | `grep env_file infrastructure/docker-compose.yml` → 0 |
| `CORS_ORIGIN`, `S9_PUBLIC_*`, `S9_METRICS_ENABLED`, `SPECTATE_WS_URL`, `NODE_ENV` no están en el compose | CODE_VERIFIED | `grep` sobre el compose → 0; lecturas en `apps/api/src/app.ts:120`, `public-spectate.ts:12`, `public-replays.ts:20`, `metrics.ts:31`, `routes/battles.ts:37-38` |
| `TRUST_PROXY_HOPS`: compose `1`, código `0` si falta, `0..8`, inválido no arranca | CODE_VERIFIED | `apps/api/src/middleware/proxy-trust.ts:15-27`; `server.ts:20` |
| `S9_ENABLE_REAL_BATTLE_RUNS === "1"` activa `/run` | CODE_VERIFIED | `apps/api/src/battle-run.ts:84-87` |
| `REPLAY_INGEST_ENABLED/RETRIES` sólo en el smoke | CODE_VERIFIED | `scripts/e2e-real-battle-smoke.ts:151,157`; `battle-run-http-launcher.ts:367-370` |
| `/system/status` lee `GIT_COMMIT`/`COMMIT_SHA` | CODE_VERIFIED | `apps/api/src/routes/system.ts:50-51` |
| Secreto de ticket derivado por HKDF | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:84-97` |
