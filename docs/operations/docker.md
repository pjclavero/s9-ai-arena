# Docker Compose: servicios, perfiles, volúmenes y redes

## Resumen

Descripción operativa del fichero `infrastructure/docker-compose.yml`: qué servicios define, en
qué perfiles, con qué imágenes, volúmenes, redes y healthchecks, y cómo se llama de verdad cada
recurso en el host (proyecto `infrastructure`). La descripción funcional de cada servicio está
en [../technical/services.md](../technical/services.md).

## Índice

- [Proyecto y fichero canónico](#proyecto-y-fichero-canónico)
- [Perfiles](#perfiles)
- [Servicios del perfil `production`](#servicios-del-perfil-production)
- [Otros servicios](#otros-servicios)
- [Volúmenes](#volúmenes)
- [Redes](#redes)
- [Healthchecks y readiness de contenedores](#healthchecks-y-readiness-de-contenedores)
- [Comandos habituales](#comandos-habituales)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Proyecto y fichero canónico

- El compose **no** declara `name:`; Compose toma el nombre del directorio del fichero:
  **`infrastructure`**. Prefijo de volúmenes y redes: `infrastructure_`.
- Todo comando se lanza contra el mismo fichero y el mismo `.env`:

  ```bash
  DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
  ```

- Un proyecto debe tener **un único** origen de configuración. Si `docker compose ls` muestra dos
  rutas en `CONFIG FILES` para `infrastructure`, hay contenedores lanzados desde otro árbol (por
  ejemplo un directorio de build) y un `up` posterior no los reproduce: ver
  [upgrades.md](upgrades.md#un-solo-compose-canónico) y [TD-027](../roadmap/technical-debt.md#td-027).
- Nombres de volúmenes antiguos (`s9-ai-arena_*`) o de red (`s9-ai-arena_arena`) que aparecen en
  documentos históricos **no existen**: un `docker run -v s9-ai-arena_<vol>:…` crea en silencio un
  volumen nuevo y vacío.

## Perfiles

Todos los servicios pertenecen a algún perfil: sin `--profile` (o `COMPOSE_PROFILES`) no arranca
nada.

| Perfil | Servicios | Uso |
|---|---|---|
| `production` | 12: gateway, web, api, arena-engine, tournament-worker, bot-manager, bot-build-worker, map-service, replay-service, queue, postgres, backup | **perfil real de producción** |
| `external-db` | los 12 de `production` **sin** `postgres` (11) | PostgreSQL externo vía `DATABASE_URL` |
| `development` | los de `production` sin `backup` (11) | desarrollo con Docker |
| `nucleo` | 7: gateway, web, api, tournament-worker, replay-service, queue, postgres | perfil reducido histórico; **no** usar sobre un stack desplegado como `production` |
| `observability` | prometheus, alertmanager, grafana, loki, promtail, cadvisor, node-exporter, postgres-exporter | no desplegado en producción |
| `streaming` | streamer | no desplegado |
| `bots` | bot-runtime-template | plantilla; los bots reales los lanza el proxy, fuera de Compose |

El compose define 22 servicios en total.

## Servicios del perfil `production`

| Servicio | Imagen | Puerto interno | Redes | Volúmenes | Depende de |
|---|---|---|---|---|---|
| `gateway` | `${IMAGE_PREFIX}/gateway:${GATEWAY_TAG:-${TAG}}` (nginx 1.27) | 80, 443 (**publicados** como `HTTP_PORT`/`HTTPS_PORT`) | public, platform | `./gateway/${GATEWAY_CONF}` → `/etc/nginx/nginx.conf`, `./secrets/tls` | web, api |
| `web` | `…/web` | 3000 | platform | — | — |
| `api` | `…/api` | 8080 | platform, data | `arena_replays:/data/replays:ro` | queue, postgres |
| `arena-engine` | `…/arena-engine` | 8081 | platform, arena, bot-control | — | queue |
| `tournament-worker` | `…/tournament-worker` | 8081 (espectador WS) | platform, data, arena, bot-control | `arena_replays:/data/replays` | queue, postgres |
| `bot-manager` | `…/bot-manager` | 8084 | platform, build | `arena_bot_sources`, `arena_build_cache` | queue |
| `bot-build-worker` | `…/bot-manager` (misma imagen, otro entrypoint) | — | platform, build, data, arena, bot-control | `arena_bot_sources`, `arena_build_cache` | queue, postgres |
| `map-service` | `…/map-service` | 8082 | platform, data | `arena_maps`, `arena_assets:ro` | postgres |
| `replay-service` | `…/replay-service` | 8083 | platform, data | `arena_replays` | postgres |
| `queue` | `redis:7.4.9-alpine@sha256:6ab0…` | 6379 | platform | `queue_data:/data` | — |
| `postgres` | `postgres:16.14-alpine@sha256:57c7…` | 5432 | data | `postgres_data` | — |
| `backup` | `…/backup:${BACKUP_TAG:-latest}` | — | data, public | los cuatro de datos en `:ro`, `./secrets:/secrets:ro`, `backup_metrics`, `backup_work` | postgres |

Todos con `restart: unless-stopped`. **Ningún servicio define `stop_grace_period`**: Docker da 10 s
por defecto antes de matar el proceso, lo que no basta a PostgreSQL ni a Redis en un apagado
([shutdown.md](shutdown.md)). `queue` arranca con `--appendonly yes --maxmemory 256mb
--maxmemory-policy noeviction`; su contenido no es autoridad de nada (la autoridad es PostgreSQL).

`map-service` está desplegado pero la web y la API no lo usan
([TD-017](../roadmap/technical-debt.md#td-017)).

## Otros servicios

- `docker-proxy` **no** está en Compose: corre en el host como unidad systemd
  ([docker-proxy.md](docker-proxy.md)), porque es el único proceso con acceso al socket de Docker.
- Los contenedores de bots se lanzan, a través de ese proxy, en la red `arena`.
- Los servicios que lo consumen lo alcanzan por la red `bot-control` (`s9-bot-control`), en
  `docker-proxy.internal` → `10.89.250.1` (`extra_hosts` con IP fija, nunca `host-gateway`):
  [networking.md](networking.md#red-de-control-del-docker-proxy-bot-control).

## Volúmenes

| Volumen (nombre real) | Montado en | Contenido | En el backup |
|---|---|---|---|
| `infrastructure_postgres_data` | postgres | base de datos completa | sí (vía `pg_dump`) |
| `infrastructure_arena_replays` | api (ro), tournament-worker, replay-service, backup (ro) | replays | sí (≤ `REPLAY_RETENTION_DAYS`, `official/` sin límite) |
| `infrastructure_arena_maps` | map-service, backup (ro) | mapas del map-service | sí |
| `infrastructure_arena_bot_sources` | bot-manager, bot-build-worker, backup (ro) | código fuente de bots | sí |
| `infrastructure_arena_assets` | map-service (ro), backup (ro) | recursos | sí |
| `infrastructure_arena_build_cache` | bot-manager, bot-build-worker | caché de build | no |
| `infrastructure_queue_data` | queue | AOF de Redis (efímero) | no |
| `infrastructure_backup_metrics` | backup (`/textfile`), node-exporter | métricas de la última copia | no |
| `infrastructure_backup_work` | backup | staging temporal | no |
| `infrastructure_arena_logs`, `_prometheus_data`, `_grafana_data`, `_loki_data`, `_promtail_positions` | observabilidad | — | no |

> Los volúmenes **sólo** se borran con `docker compose down -v` o `docker volume rm`. Ninguno de
> los dos se usa en operación normal.

## Redes

| Red (nombre real) | `internal` | Quién | Para qué |
|---|---|---|---|
| `infrastructure_public` | no | gateway, backup | salida/entrada externa (el backup necesita alcanzar el repositorio) |
| `infrastructure_platform` | sí | casi todos | HTTP interno entre servicios |
| `infrastructure_data` | sí | postgres y sus clientes | acceso a la base de datos |
| `infrastructure_build` | sí | bot-manager, bot-build-worker | pipeline de build |
| `arena` (nombre **explícito**, sin prefijo) | sí | arena-engine, tournament-worker, bot-build-worker y contenedores de bots | partidas y sandbox del build; sin salida a Internet |
| `s9-bot-control` (nombre **explícito**; bridge `s9-botctl0`; `10.89.250.0/24`, gateway `10.89.250.1`) | sí | arena-engine, tournament-worker, bot-build-worker | **sólo** control del s9-docker-proxy del host ([networking.md](networking.md#red-de-control-del-docker-proxy-bot-control)) |

Puede existir además una red `infrastructure_arena` huérfana de una versión anterior; ningún
servicio la usa.

## Healthchecks y readiness de contenedores

| Servicio | Prueba | Intervalo / gracia |
|---|---|---|
| gateway | `wget http://127.0.0.1:80/healthz` | 15 s / 10 s |
| web | `wget :3000/healthz` | 15 s / 20 s |
| api | `wget :8080/healthz` | 15 s / 20 s |
| arena-engine | `wget :8081/healthz` | 10 s / 20 s |
| map-service, replay-service, bot-manager | `wget :<puerto>/healthz` | 15 s / 20 s |
| tournament-worker, bot-build-worker | latido en `/tmp/heartbeat` de menos de 120 s | 30 s / 30 s |
| queue | `redis-cli ping` | 10 s |
| postgres | `pg_isready -U arena -d arena` | 10 s / 15 s |
| backup | `/usr/local/bin/healthcheck.sh` (última copia correcta reciente, `pg_dump` ok y snapshot creado) | 60 s / 30 s |

`healthy` significa que el proceso responde, **no** que la funcionalidad esté operativa: la API
puede estar `healthy` con la ejecución real apagada, y `backup` está `unhealthy` mientras no haya
una copia reciente. Readiness de la instalación completa: [readiness.md](readiness.md).

## Comandos habituales

Lectura (seguros):

```bash
$DC ps --format '{{.Service}} {{.Image}} {{.Status}}'
docker compose ls                                  # proyecto, estado y CONFIG FILES
$DC logs --since 1h --tail 200 api
$DC config --services                             # servicios del perfil
docker volume ls --filter name=infrastructure_
docker inspect --format '{{.Config.Image}} {{.Image}}' infrastructure-api-1
```

Cambios: usa siempre `up -d --no-build` con la lista explícita de servicios y `--no-deps`, tal como
indica [upgrades.md](upgrades.md). Reinicio de un servicio sin estado:

```bash
$DC restart web
```

> **DANGER** — `docker compose … down`
>
> **PRECONDITION:** ventana de mantenimiento; preflight sin trabajo en vuelo ([shutdown.md](shutdown.md)).
>
> **EFFECT:** elimina **todos** los contenedores del perfil, incluido `postgres` (los volúmenes se
> conservan salvo `-v`). Con un perfil distinto del desplegado (p. ej. `nucleo`) deja servicios
> huérfanos funcionando contra una base de datos parada.
>
> **ROLLBACK:** `$DC up -d --no-build` con el mismo `.env`. Con `-v` **no hay rollback**: sólo
> restauración ([restore.md](restore.md)).

## Errores / limitaciones

- `stop_grace_period` ausente → apagados que matan a PostgreSQL y Redis
  ([TD-007](../roadmap/technical-debt.md#td-007)).
- 9 de las 12 imágenes desplegadas hoy no llevan identidad de build verificable
  ([TD-006](../roadmap/technical-debt.md#td-006)).
- El gateway publica `/grafana/` aunque la observabilidad no esté desplegada (responde 502).

## Documentación relacionada

[configuration.md](configuration.md) · [networking.md](networking.md) · [upgrades.md](upgrades.md) ·
[backup.md](backup.md) · [shutdown.md](shutdown.md) · [docker-proxy.md](docker-proxy.md) ·
[../technical/services.md](../technical/services.md) · [../technical/architecture.md](../technical/architecture.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Servicios por perfil (production 12, nucleo 7, total 22) | RUNTIME_VERIFIED | `docker compose -f infrastructure/docker-compose.yml --profile <p> config --services` |
| `external-db` sin postgres; `development` sin backup | CODE_VERIFIED | `profiles:` de cada servicio en el compose |
| Nombres reales `infrastructure_*` y red `arena` | RUNTIME_VERIFIED | `docker compose … config` (bloques `name:`) |
| Red `s9-bot-control` (internal, bridge, subred y gateway fijos) y sus tres miembros | CODE_VERIFIED | `docker compose … config --format json`, comprobado en `infrastructure/tests/bot-control-network.test.ts` |
| Imágenes de postgres y queue por digest | CODE_VERIFIED | `infrastructure/docker-compose.yml` servicios `postgres`, `queue` |
| Ningún servicio define `stop_grace_period` | CODE_VERIFIED | compose parseado: 0 servicios con la clave |
| Healthchecks de la tabla | CODE_VERIFIED | `healthcheck:` de cada servicio |
| `/grafana/` enrutado sin backend | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:126-130` |
| `docker compose up -d` desde el directorio productivo hoy no recrea nada (hashes iguales) | RUNTIME_VERIFIED (auditoría 2026-10-15, sólo lectura) | config-hash de los 12 contenedores = `config --hash` |
