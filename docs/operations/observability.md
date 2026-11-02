# Observabilidad

## Resumen

Cómo ver qué hace la plataforma una vez instalada: métricas, alertas, logs y paneles. Es un perfil
**opcional** del Compose (`observability`): no forma parte del perfil `production` ni de
`servicios_esperados` de `infrastructure/deploy-contract.json`. Este documento dice qué incluye, cómo se
activa y qué alertas trae configuradas. Qué está desplegado en tu instalación lo decides tú; en el
repositorio solo se puede comprobar la configuración.

## Índice

- [Qué incluye el perfil](#qué-incluye-el-perfil)
- [Activarlo](#activarlo)
- [Alertas configuradas](#alertas-configuradas)
- [Canal de avisos](#canal-de-avisos)
- [Métricas de la API](#métricas-de-la-api)
- [Límites conocidos](#límites-conocidos)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué incluye el perfil

| Servicio | Para qué |
|---|---|
| `prometheus` | recoge métricas y evalúa las reglas de `infrastructure/observability/prometheus/alerts.yml` |
| `alertmanager` | envía los avisos al canal del operador |
| `grafana` | paneles; el gateway lo publica en `/grafana/` solo si el servicio está levantado (si no, responde 502) |
| `loki` y `promtail` | logs de los contenedores |
| `cadvisor` y `node-exporter` | métricas de contenedores y de la máquina |
| `postgres-exporter` | métricas de PostgreSQL |

El job `streamer` de Prometheus (`streamer:8090`) recoge las métricas del emisor cuando el perfil `streaming` está activo
([streaming.md](streaming.md)).

## Activarlo

El perfil se añade a los que ya uses; no sustituye a `production`:

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
$DC --profile observability up -d prometheus alertmanager grafana loki promtail cadvisor node-exporter postgres-exporter
```

Para que la API exponga sus métricas hay que poner `S9_METRICS_ENABLED=1` en `infrastructure/.env` y recrear la API
([configuration.md](configuration.md)). Está apagado por defecto.

## Alertas configuradas

Reglas de `infrastructure/observability/prometheus/alerts.yml`:

| Alerta | Cuándo salta |
|---|---|
| `EngineTickStalled`, `EngineDown` | el motor deja de avanzar o desaparece |
| `QueueBacklog` | más de 100 trabajos en una cola |
| `DiskAlmostFull` | menos del 10 % libre en un sistema de ficheros |
| `PostgresDown` | PostgreSQL no responde |
| `StreamDown` | el contenedor del streamer lleva más de 2 minutos sin verse en cAdvisor (mide presencia, no la salud de la emisión) |
| `HighErrorRate` | tasa alta de errores HTTP |
| `BackupFailed`, `BackupPartialSuccess` | la última copia terminó con error o con éxito parcial |
| `BackupTooOld` | han pasado más de 26 horas desde la última copia correcta |
| `BackupMetricsMissing` | la métrica del backup no existe (no se está recogiendo) |

## Canal de avisos

Alertmanager entrega los avisos a un **webhook** (Slack, Matrix, ntfy…) que defines en `ALERT_WEBHOOK_URL` de
`infrastructure/.env`. Sin esa variable los avisos van a una dirección de relleno y **no llegan a nadie**.
Para correo hay que añadir un receptor SMTP a `infrastructure/observability/alertmanager/alertmanager.yml.tpl`.

## Métricas de la API

Con `S9_METRICS_ENABLED` encendido, la API sirve `GET /metrics` (formato Prometheus, solo agregados: sin secretos ni datos
personales) en su puerto interno, que Prometheus raspa dentro de la red de la plataforma. **No se autentica**: el gateway no lo
publica y no debe publicarse; restringir el acceso es responsabilidad del despliegue (`apps/api/src/metrics.ts`, cabecera).

## Límites conocidos

- Las alertas del backup y de la cola existen en la configuración; que se disparan de verdad en tu instalación hay que
  probarlo (la deuda sigue abierta: [TD-007](../roadmap/technical-debt.md#td-007)).
- No hay alerta sobre la salud real de la emisión (`streamer_up`): [TD-066](../roadmap/technical-debt.md#td-066).
- Sin `ALERT_WEBHOOK_URL`, nadie recibe los avisos.

## Documentación relacionada

[backup.md](backup.md) · [diagnostics.md](diagnostics.md) · [streaming.md](streaming.md) · [docker.md](docker.md) ·
[../technical/services.md](../technical/services.md)

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Servicios del perfil `observability` | CODE_VERIFIED (`e3bf2fa`) | `infrastructure/docker-compose.yml:936-1122` (prometheus, alertmanager, grafana, loki, promtail, cadvisor, node-exporter) y `:1122` (postgres-exporter) |
| Las once alertas | CODE_VERIFIED | `infrastructure/observability/prometheus/alerts.yml:9-101` |
| Canal por webhook y valor de relleno | CODE_VERIFIED | `infrastructure/observability/alertmanager/alertmanager.yml.tpl`; `docker-compose.yml:962-985` |
| Grafana en `/grafana/` | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:134-138` |
| Métricas de la API apagadas por defecto, sin autenticación | CODE_VERIFIED | `apps/api/src/metrics.ts:21-31`; `apps/api/src/app.ts:107-120` |
| Que las alertas se disparan en una instalación real | NOT TESTED | pendiente ([TD-007](../roadmap/technical-debt.md#td-007)) |
