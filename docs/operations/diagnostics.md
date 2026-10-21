# Diagnóstico

## Resumen

Cómo averiguar, sólo con lecturas, qué está corriendo, en qué versión, si responde y por qué
falla. Para síntomas concretos y su remedio, ver [troubleshooting.md](troubleshooting.md).

## Índice

- [Primer vistazo](#primer-vistazo)
- [Salud por servicio](#salud-por-servicio)
- [Qué versión corre](#qué-versión-corre)
- [Logs](#logs)
- [Base de datos y cola](#base-de-datos-y-cola)
- [Estado desde la web](#estado-desde-la-web)
- [Proxy de Docker: qué se está ejecutando de verdad](#proxy-de-docker-qué-se-está-ejecutando-de-verdad)
- [Deriva entre lo declarado y lo que corre](#deriva-entre-lo-declarado-y-lo-que-corre)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

Todos los comandos de esta página son de **solo lectura**.

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
```

## Primer vistazo

```bash
docker compose ls                                     # proyecto infrastructure, running(12), CONFIG FILES
$DC ps --format '{{.Service}}\t{{.Status}}'           # 12 servicios; backup puede estar unhealthy
docker ps --filter label=com.docker.compose.project=infrastructure --format '{{.Names}}\t{{.Status}}'
df -h /var/lib/docker; docker system df
```

Si `CONFIG FILES` muestra más de una ruta, hay contenedores lanzados desde otro árbol: ver
[upgrades.md](upgrades.md#un-solo-compose-canónico).

## Salud por servicio

| Comprobación | Comando | Esperado |
|---|---|---|
| Gateway | `curl -s http://127.0.0.1:${HTTP_PORT:-80}/healthz` | `ok` |
| API | `curl -s http://127.0.0.1:${HTTP_PORT:-80}/api/v1/healthz` | `{"status":"ok","service":"api"}` |
| Web | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT:-80}/` | `200` |
| Servicios internos | `$DC exec <servicio> wget -qO- http://127.0.0.1:<puerto>/healthz` | respuesta del servicio |
| Workers | `$DC exec tournament-worker sh -c 'echo $(( $(date +%s) - $(cat /tmp/heartbeat) ))'` | < 120 (segundos desde el último latido) |
| PostgreSQL | `$DC exec postgres pg_isready -U arena -d arena` | `accepting connections` |
| Redis | `$DC exec queue redis-cli ping` | `PONG` |
| Backup | `$DC exec backup /usr/local/bin/healthcheck.sh` | `BACKUP OK …` ([backup.md](backup.md#estados-del-healthcheck)) |

Rutas que **no** sirven como diagnóstico: `/api/healthz` (devuelve la web), `/replays/healthz`
(404), `/api/v1/` (404 JSON), `smoke.sh` ([TD-020](../roadmap/technical-debt.md#td-020)).

## Qué versión corre

La referencia declarada y la imagen real se comparan con `docker inspect`, nunca con
`docker ps` (trunca y muestra la etiqueta, no el contenido):

```bash
for c in $(docker ps --filter label=com.docker.compose.project=infrastructure --format '{{.Names}}'); do
  docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$c"
done
node infrastructure/scripts/check-running-image-id.mjs          # la image ID en ejecución existe y es la de la etiqueta
```

Identidad de build (ADR-016): las imágenes construidas con `BUILD_COMMIT` exponen
`GET /version` dentro de la red del stack (`$DC exec api wget -qO- http://127.0.0.1:8080/version`)
y la etiqueta OCI `org.opencontainers.image.revision`. En la instalación de referencia 9 de 12
contenedores no tienen identidad verificable ([TD-006](../roadmap/technical-debt.md#td-006)). El
`/version` del gateway sólo describe al gateway.

Verificación completa de una imagen antes de desplegarla:
`node infrastructure/scripts/verify-image-provenance.mjs --image <ref> --commit <sha> --service <svc>`
(ver [upgrades.md](upgrades.md)).

## Logs

Los servicios propios escriben JSON (`LOG_FORMAT=json`) por stdout, con `correlation_id` propagado
desde el gateway.

```bash
$DC logs --since 30m --tail 300 api
$DC logs --since 30m gateway | grep '"status":5'
$DC logs --since 26h backup | grep -E 'SUCCESS|FAILURE'
```

No hay agregación desplegada (Loki/Grafana están en el perfil `observability`, no activo).

## Base de datos y cola

```bash
$DC exec postgres psql -U arena -d arena -tAc "SELECT status, count(*) FROM battles GROUP BY 1;"
$DC exec postgres psql -U arena -d arena -tAc "SELECT status, count(*) FROM jobs GROUP BY 1;"
$DC exec postgres psql -U arena -d arena -tAc "SELECT state, count(*) FROM pg_stat_activity WHERE datname='arena' GROUP BY 1;"
$DC exec queue redis-cli dbsize
```

La autoridad sobre el trabajo pendiente es la tabla `jobs` de PostgreSQL; Redis sólo avisa
([../technical/queue.md](../technical/queue.md)).

## Estado desde la web

La página **Sistema** del panel (rol admin) usa `GET /api/v1/system/status`: conteos de batallas,
builds y versiones, y el estado de las puertas (`realBattleRuns`, espectador y replays públicos).
Su campo `commit` lee `GIT_COMMIT`/`COMMIT_SHA` (que el compose no define → `unknown`) y no la
identidad ADR-016 ([TD-020](../roadmap/technical-debt.md#td-020)).

## Proxy de Docker: qué se está ejecutando de verdad

Sólo lectura. Responde a «¿el proxy ejecuta el artefacto de root o algo del árbol?» (TD-062):

```bash
sudo /usr/local/sbin/s9-docker-proxy-preflight preflight   # copia de root instalada; una línea «ROJO:» por problema
systemctl show s9-docker-proxy -p ExecStart -p WorkingDirectory -p DropInPaths -p NeedDaemonReload
pid=$(systemctl show -p MainPID --value s9-docker-proxy); sudo readlink -f /proc/$pid/exe; sudo tr '\0' ' ' </proc/$pid/cmdline
sudo journalctl -u s9-docker-proxy -o cat | grep -m1 'escuchando'   # "artifact":{"kind":"bundle",…} y la ruta de la allowlist
```

Síntomas típicos:

- `ExecStart … npx tsx`: la unidad es la de RC1. Hay que migrar
  ([upgrades.md](upgrades.md#td-062)).
- `DOCKER_PROXY_IMAGE_ALLOWLIST=… (debe ser la copia de root …)`: falta el paso 3 de la migración.
- `exit 78` con «DOCKER_PROXY_IMAGE_ALLOWLIST es obligatoria»: el bundle arrancó sin la variable.
- `rc 2` con «esta copia o lo que instala NO es sólo de root»: se está ejecutando el script del árbol
  (`/opt/...`). Usa `/usr/local/sbin/s9-docker-proxy-preflight` o el clon de root.

## Deriva entre lo declarado y lo que corre

[runtime-drift-scanner.md](runtime-drift-scanner.md): `runtime-drift-scan.mjs --collect` recoge
hechos del host en solo lectura y los compara con el objetivo declarado.

## Errores / limitaciones

- Sin observabilidad desplegada no hay métricas históricas ni alertas
  ([TD-007](../roadmap/technical-debt.md#td-007)).
- La administración operativa sólo es posible por SSH ([TD-023](../roadmap/technical-debt.md#td-023)).

## Documentación relacionada

[troubleshooting.md](troubleshooting.md) · [docker.md](docker.md) · [readiness.md](readiness.md) ·
[runtime-drift-scanner.md](runtime-drift-scanner.md) · [../technical/services.md](../technical/services.md) ·
[../technical/gateway.md](../technical/gateway.md) · [../technical/workers.md](../technical/workers.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Healthchecks y puertos | CODE_VERIFIED | compose `healthcheck:`; `apps/*/src` `PORT` |
| `/api/v1/healthz` JSON, `/api/healthz` HTML, `/replays/healthz` 404 | RUNTIME_VERIFIED | entorno aislado; auditoría 2026-10-15 en producción |
| `/version` montado por `packages/build-info` en el envolvente de la API | CODE_VERIFIED | `apps/api/src/server.ts:50` |
| `/system/status.commit` lee `GIT_COMMIT`/`COMMIT_SHA` | CODE_VERIFIED | `apps/api/src/routes/system.ts:50-51` |
| `check-running-image-id.mjs` y `verify-image-provenance.mjs` existen con esas opciones | CODE_VERIFIED | `infrastructure/scripts/*.mjs` (cabeceras de uso) |
| 9/12 sin identidad en la instalación de referencia | RUNTIME_VERIFIED (auditoría, sólo lectura) | `docker inspect` en producción, 2026-10-15 |
