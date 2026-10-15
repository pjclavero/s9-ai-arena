# Apagado y encendido

## Resumen

Cómo apagar y volver a encender la máquina que aloja el stack sin perder trabajo y sin dejar a
PostgreSQL y Redis con un cierre forzado. Corrige el runbook anterior, cuya afirmación «PostgreSQL
cierra su cluster limpiamente» quedó **refutada** por el apagado del 13-sep-2026: el compose no
define `stop_grace_period` y Docker mató a `postgres` y `queue` a los 10 s.

## Índice

- [Qué se pierde y qué no](#qué-se-pierde-y-qué-no)
- [1. Preflight](#1-preflight)
- [2. Parar el stack ordenadamente](#2-parar-el-stack-ordenadamente)
- [3. Apagar la máquina](#3-apagar-la-máquina)
- [4. Encender](#4-encender)
- [5. Después de un apagado largo](#5-después-de-un-apagado-largo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué se pierde y qué no

Los datos viven en volúmenes (`infrastructure_postgres_data`, `infrastructure_arena_*`) y
sobreviven al apagado. Lo que se puede perder es **trabajo en vuelo**: un job reclamado, una batalla
en curso, una transacción abierta. La autoridad sobre el trabajo es PostgreSQL (tabla `jobs`);
Redis (`queue`) es efímero.

## 1. Preflight

```bash
bash infrastructure/scripts/preflight-apagado.sh
```

Sólo lectura (escribe un temporal `/tmp/preflight-snaps.json`). Comprueba jobs
`running/claimed/pending`, transacciones `idle in transaction` y preparadas, batallas `running`,
builds en curso, tamaño de la cola, contenedores del proyecto y ajenos, y el último backup con BD.

| rc | Significado | Qué hacer |
|---|---|---|
| `0` | seguro apagar | continuar |
| `1` | hay trabajo en vuelo (o contenedores ajenos) | esperar y repetir |
| `2` | indeterminado: alguna comprobación no se pudo hacer | investigar; **no** apagar |

El script existe a partir de `27f70bb`. Si el clon desplegado es anterior, ejecútalo desde un clon
actualizado fuera del árbol productivo (sólo lee el daemon y la BD).

## 2. Parar el stack ordenadamente

Como el compose no define `stop_grace_period`, **no confíes en que el apagado del sistema pare bien
los contenedores**: para el stack antes, con un plazo amplio, en este orden:

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
$DC stop -t 30 gateway web api arena-engine tournament-worker bot-manager bot-build-worker map-service replay-service backup
$DC stop -t 120 queue postgres
$DC ps -a --format '{{.Service}} {{.Status}}'      # todos "Exited (0)"
```

`stop` **no** elimina contenedores ni volúmenes (a diferencia de `down`). Comprueba en los logs que
PostgreSQL registró un cierre normal:

```bash
$DC logs --tail 20 postgres | grep -E 'database system is shut down|shutting down'
```

Si en el siguiente arranque PostgreSQL registra `database system was not properly shut down;
automatic recovery in progress`, el cierre no fue limpio.

## 3. Apagar la máquina

Desde dentro de la máquina: `sudo shutdown -h now`. Desde el hipervisor: apagado ordenado (ACPI),
**nunca** un «stop»/apagado forzado, que equivale a cortar la corriente.

Advertencias:

- Si la VM no tiene el agente de invitado activo, el apagado ordenado del hipervisor depende de
  ACPI y puede agotar su tiempo de espera; por eso el paso 2 se hace antes.
- **No hay snapshots de VM** de la instalación de referencia: hacer uno antes de una intervención
  arriesgada es responsabilidad del operador en el hipervisor ([TD-007](../roadmap/technical-debt.md#td-007)).

## 4. Encender

Con Docker habilitado al arranque, los contenedores vuelven solos: todos tienen
`restart: unless-stopped`. **Excepción:** los contenedores parados a mano con `stop` (paso 2) **no**
vuelven solos con `unless-stopped`; hay que arrancarlos:

```bash
$DC up -d --no-build
$DC ps --format '{{.Service}} {{.Status}}'          # 12 servicios; ~25 s postgres, ~50 s api
curl -s http://127.0.0.1:${HTTP_PORT:-80}/api/v1/healthz
```

`up -d --no-build` con el mismo `.env` y compose no recrea contenedores cuya configuración no ha
cambiado: sólo los arranca.

## 5. Después de un apagado largo

- La copia diaria corre a las 04:15 UTC (`BACKUP_CRON`); si la máquina estaba apagada, ese día no
  hay copia. Con más de 26 h sin copia el contenedor `backup` arranca `unhealthy` («copia rancia»)
  hasta la siguiente copia correcta. Lanza una manual: [backup.md](backup.md#copia-manual).
- En un arranque en frío el `tournament-worker` puede no registrar ninguna transición de Redis; no
  es una incidencia.

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `automatic recovery in progress` en postgres al arrancar | cierre forzado (10 s por defecto) | paso 2 antes de apagar; deuda: `stop_grace_period` en el compose |
| Tras encender faltan servicios | se pararon con `stop` y `unless-stopped` no los relanza | `$DC up -d --no-build` |
| `preflight-apagado.sh: No such file` | clon desplegado anterior a `27f70bb` | ejecutarlo desde un clon actualizado |
| El apagado del hipervisor «agota el tiempo» | sin agente de invitado; ACPI lento | paso 2 + apagado desde dentro |

## Estado actual

- **FUNCIONA ACTUALMENTE:** preflight calibrado (rc 0/1/2), vuelta automática con `unless-stopped`.
- **PARCIAL:** el cierre limpio depende del paso manual 2; el compose no fija plazos de parada.
- **PENDIENTE:** `stop_grace_period` para `postgres` y `queue`, agente de invitado y snapshot base de
  la VM ([TD-007](../roadmap/technical-debt.md#td-007)).

## Documentación relacionada

[docker.md](docker.md) · [backup.md](backup.md) · [diagnostics.md](diagnostics.md) ·
[../technical/queue.md](../technical/queue.md) · Runbook anterior (histórico):
[../history/operaciones/APAGADO_Y_ENCENDIDO.md](../history/operaciones/APAGADO_Y_ENCENDIDO.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Ningún servicio con `stop_grace_period`; `restart: unless-stopped` en los 12 | CODE_VERIFIED | compose parseado |
| Cierre forzado de postgres y queue el 13-sep y recuperación WAL al arrancar | RUNTIME_VERIFIED (auditoría 2026-10-15, journal y logs, sólo lectura) | registro privado de la auditoría (§ apagado/encendido) |
| Preflight: qué comprueba y códigos 0/1/2; escribe `/tmp/preflight-snaps.json` | CODE_VERIFIED | `infrastructure/scripts/preflight-apagado.sh:1-120` |
| `stop` no elimina contenedores; `unless-stopped` no relanza los parados a mano | CODE_VERIFIED (semántica de Docker) | documentación de Docker Engine |
| Backup a las 04:15 UTC y umbral de 26 h | CODE_VERIFIED | compose `BACKUP_CRON`; `infrastructure/backup/healthcheck.sh:40` |
| Sin snapshots de VM | RUNTIME_VERIFIED | verificación de la consolidación, 2026-10-15 (listado de snapshots del hipervisor) |
