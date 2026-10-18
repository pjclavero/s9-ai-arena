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
| `ARENA_ENGINE_URL` | `api` | `http://arena-engine:8081` | no | **legado**: la API ya no cablea el runner HTTP de `/run` (cierre funcional; `server.ts`) |
| `S9_ENABLE_REAL_BATTLE_RUNS` | `api` | vacío (apagado) | no | **legado**: sólo cambia `realBattleRuns.enabled` en `/system/status`; `POST /battles/{id}/run` ya sólo delega en la cola |
| `S9_MAX_CONCURRENT_REAL_BATTLE_RUNS` | `api` | vacío | no | límite de `/run` concurrentes |
| `REPLAY_SERVICE_URL` | `api` | `http://replay-service:8083` | no | ingesta del replay del camino `/run` |
| `REPLAY_INGEST_REQUIRED` | `api` | vacío | no | `1` = la batalla falla si la ingesta falla |
| `DOCKER_PROXY_URL` | `tournament-worker` | vacío (sin defecto a propósito) | **sí** para ejecutar batallas | vacío = el worker NO reclama `run_battle` y lo anuncia al arrancar (`battleExecution: disabled`); con valor, ejecuta cada batalla con el artefacto firmado de cada bot |
| `DOCKER_PROXY_URL` | `bot-build-worker` | `http://docker-proxy.internal:2375` | **sí** para validar bots | sin proxy, todo build se rechaza «sandbox no verificado» |
| `DOCKER_PROXY_URL` | `arena-engine` | vacío | no | camino legado; vacío = el motor no lanza contenedores |
| `DOCKER_PROXY_URL` | `bot-manager` | `http://docker-proxy.internal:2375` | no | el proxy vive en el host ([docker-proxy.md](docker-proxy.md)) |
| `SANDBOX_STARTUP_TIMEOUT_MS` | `tournament-worker`, `bot-build-worker` | `30000` | no | reloj de **plataforma** del arranque de cada bot ([TD-034](../roadmap/technical-debt.md#td-034)): petición de lanzamiento del contenedor → señal `ready` del bootstrap (create/start de la Engine, runtime, descarga y sha256 del artefacto, SDK). Agotarlo es infraestructura (build: reintento → «no verificable»; batalla: `container_unavailable`, se reintenta), nunca rechazo del bot. Entero `1..600000`; inválido → el sandbox no arranca (build-worker no arranca; tournament-worker no ejecuta batallas y lo anuncia). Subirlo sólo si la Engine es lenta de forma sostenida: no afecta al límite del bot |
| `BOT_EXECUTION_TIMEOUT_MS` | `tournament-worker`, `bot-build-worker` | `5000` | no | reloj del **bot** ([TD-034](../roadmap/technical-debt.md#td-034)): empieza en la señal `ready` (nunca antes) y cubre import del código del usuario, constructor, conexión y HELLO. Agotarlo es culpa del bot (`protocol_test` rechazado / `bot_timeout`). Es también el `handshakeTimeoutMs` del ProtocolServer. Las decisiones tienen su propio límite (`maxDecisionMs`, deadline del protocolo). Entero `1..600000`; inválido → como arriba |
| `ARENA_NETWORK` | `arena-engine` | `arena` | no | red de los contenedores de bots (nombre fijo) |
| `ARENA_ENGINE_HOST` | `arena-engine` | `arena-engine` | no | nombre con el que los bots alcanzan al motor |
| `SPECTATE_WS_URL` | `api` | `/ws/spectate` | no | base del WebSocket de espectador para el NAVEGADOR: ruta del mismo origen (el cliente la ancla a `wss://` bajo https) o `wss://…`; `ws://` en claro se rechaza con `NODE_ENV=production` |
| `CORS_ORIGIN` | `api` | `http://localhost:5173` | no | mismo defecto que el código; la web es same-origin por el gateway |
| `S9_PUBLIC_SPECTATE_ENABLED` | `api`, `tournament-worker` | vacío (apagado) | no | espectador público; el gateway del worker aplica la MISMA capability |
| `S9_PUBLIC_REPLAYS_ENABLED` | `api` | vacío (apagado) | no | replays públicos (anónimos) sólo de batallas `finished` cuyos bots son todos `public`; el gateway ya no sirve `/replays/*` ([TD-004](../roadmap/technical-debt.md#td-004)) |
| `S9_METRICS_ENABLED` | `api` | vacío (apagado) | no | `/metrics` |
| `API_ENTRY`, `ENGINE_ENTRY`, `WORKER_ENTRY`, `BOT_MANAGER_ENTRY`, `BOT_BUILD_WORKER_ENTRY`, `MAP_SERVICE_ENTRY`, `REPLAY_SERVICE_ENTRY` | servicios Node (`SERVICE_ENTRY`) | el `main`/`server` de cada app | no | no tocar salvo depuración |
| `RESTIC_REPOSITORY` | `backup` | vacío | **sí** para tener copias | `sftp:usuario@host:/ruta` (ruta dentro del chroot) o ruta montada |
| `RESTIC_HOSTNAME` | `backup` | un nombre lógico fijo | **sí** (vacío aborta el arranque) | agrupa la retención; no cambiarlo en producción |
| `BACKUP_CRON` | `backup` | `15 4 * * *` | no | hora del contenedor (UTC) |
| `REPLAY_RETENTION_DAYS` | `backup` | `180` | no | replays de más edad no se copian (`official/` sin límite) |
| `BUILD_COMMIT` / `BUILD_DATE` | `build.args` de todas las imágenes propias | `unknown` | **sí al construir** | identidad ADR-016; sólo afecta a `build` |
| `BROADCAST_URL`, `RTMPS_URL`, `STREAM_MODE`, `STREAM_ENCODER`, `STREAM_AUTOSTART` | `streamer` (perfil `streaming`) | ver compose | no | fuera del perfil `production` |
| `ALERT_WEBHOOK_URL`, `ALERT_EMAIL`, `PG_EXPORTER_URI` | perfil `observability` | — | no | observabilidad no desplegada en producción |

> **Una sola autoridad de ejecución.** Toda batalla la ejecuta `tournament-worker` (reserva
> atómica + lease + cierre exactamente una vez). La API ya no construye el runner HTTP de `/run`,
> así que `S9_ENABLE_REAL_BATTLE_RUNS` no abre un segundo camino
> ([battles.md](../technical/battles.md#autoridad-única-de-ejecución)).

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

Desde el cierre funcional (REVIEW, [TD-030](../roadmap/technical-debt.md#td-030)) el contrato lo
fija `infrastructure/tests/service-env-contract.test.ts`: para `api`, `tournament-worker` y
`bot-build-worker` recorre el grafo de imports real y exige que cada lectura de entorno esté en el
bloque `environment` o en una lista interna con motivo. Las que siguen sin pasarse, a propósito:

| Variable | Lee | Por defecto en código | Por qué no se pasa |
|---|---|---|---|
| `NODE_ENV` | api (`/system/status`, chequeo `wss://`) | sin definir | no se fija en las imágenes: el rechazo de `ws://` en claro sólo se activa con `production`. Como el compose pasa `SPECTATE_WS_URL=/ws/spectate`, el valor efectivo ya es seguro (deuda registrada en el informe de cierre) |
| `GIT_COMMIT` / `COMMIT_SHA` | api (`/system/status`) | `unknown` | identidad de build del Dockerfile ([TD-020](../roadmap/technical-debt.md#td-020)) |
| `SPECTATE_TICKET_SECRET_FILE` | api, tournament-worker | derivado de `jwt_secret` (HKDF) | secreto dedicado del ticket propuesto como deuda (el worker recibe hoy `jwt_secret`) |
| `ARENA_ENGINE_RUN_TIMEOUT_MS`, `REPLAY_INGEST_TIMEOUT_MS`, `REPLAY_INGEST_REQUIRED` | api | derivado / `10000` | ajustes del camino legado `/run` |
| `RUNTIME_DIGESTS_LOCK` | tournament-worker, bot-build-worker | `runtimes/DIGESTS.lock` copiado en la imagen | sólo para una ruta distinta |
| `S9_READINESS_CONTAINER`, `S9_READINESS_BACKUP_CONTAINER`, `S9_READINESS_REPO` | `scripts/readiness.ts` (host) | vacío | se pasan en la línea de comandos del host ([readiness.md](readiness.md)) |

## Secretos

Ficheros en `infrastructure/secrets/` (generados por `init-secrets.sh`), montados en
`/run/secrets/`:

| Secreto | Servicios | Variable que lo lee |
|---|---|---|
| `postgres_password` | postgres, api, tournament-worker, bot-build-worker, map-service, replay-service, backup (y postgres-exporter en `observability`) | `POSTGRES_PASSWORD_FILE` / `PGPASSWORD_FILE` |
| `jwt_secret` | api, tournament-worker (verifica el ticket de espectador, TD-028) | `JWT_SECRET_FILE` |
| `arena_engine_internal_secret` | api, arena-engine | `ARENA_ENGINE_SHARED_SECRET_FILE` / `ARENA_ENGINE_INTERNAL_SECRET_FILE` |
| `replay_ingest_secret` | api, replay-service | `REPLAY_INGEST_SECRET_FILE` |
| `artifact_signing_key` | bot-build-worker (firma) | `ARTIFACT_SIGNING_KEY_FILE` |
| `artifact_verify_key` (pública, PEM SPKI; la deriva `init-secrets.sh` de la anterior) | api (`/keys/artifact-signing`), tournament-worker (verifica antes de lanzar) | `ARTIFACT_VERIFY_KEY_FILE` |
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
| Toda lectura de entorno de api, tournament-worker y bot-build-worker está en su `environment` o es interna con motivo; toda interpolación está en `.env.example` (TD-030) | CODE_VERIFIED | `infrastructure/tests/service-env-contract.test.ts` (rc=0; mutación «quitar `SPECTATE_WS_URL` del compose» ⇒ rc=1) |
| `SPECTATE_WS_URL` relativa aceptada; `ws://` y `//host` rechazadas en producción | CODE_VERIFIED | `apps/api/src/routes/battles.ts` (`spectateWsBase`); `apps/api/src/public-api.test.ts` (R2.6) |
| `TRUST_PROXY_HOPS`: compose `1`, código `0` si falta, `0..8`, inválido no arranca | CODE_VERIFIED | `apps/api/src/middleware/proxy-trust.ts:15-27`; `server.ts:20` |
| `/run` ya no ejecuta; la API no cablea el launcher HTTP | CODE_VERIFIED | `apps/api/src/server.ts`; `apps/api/src/server-wiring.test.ts` (AST) |
| `REPLAY_INGEST_ENABLED/RETRIES` sólo en el smoke | CODE_VERIFIED | `scripts/e2e-real-battle-smoke.ts:151,157`; `battle-run-http-launcher.ts:367-370` |
| `/system/status` lee `GIT_COMMIT`/`COMMIT_SHA` | CODE_VERIFIED | `apps/api/src/routes/system.ts:50-51` |
| Secreto de ticket derivado por HKDF | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:84-97` |
