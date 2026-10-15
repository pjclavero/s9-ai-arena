# Resolución de problemas

## Resumen

Síntoma → causa → remedio para los problemas conocidos de una instalación. Primero se diagnostica
con lecturas ([diagnostics.md](diagnostics.md)); los remedios que cambian algo enlazan al
procedimiento que corresponde.

## Índice

- [Arranque e instalación](#arranque-e-instalación)
- [Salud y versiones](#salud-y-versiones)
- [Base de datos y cola](#base-de-datos-y-cola)
- [Copias y restauración](#copias-y-restauración)
- [Funcionalidad que no está disponible](#funcionalidad-que-no-está-disponible)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Arranque e instalación

| Síntoma | Causa probable | Remedio |
|---|---|---|
| `docker compose up -d` no arranca nada | sin perfil | `--profile production` o `COMPOSE_PROFILES=production` |
| `manifest unknown` / `not found` en `pull` | `TAG` o `BACKUP_TAG` = `latest`, o sha no publicado | [installation.md §4](installation.md#4-elegir-la-versión-de-las-imágenes) |
| API en bucle: «Sin conexión a PostgreSQL: define DATABASE_URL, o PGHOST + PGPASSWORD_FILE» | secreto `postgres_password` ausente o ilegible por uid 1000 | `init-secrets.sh` con `RUNTIME_UID/GID`; permisos `0400` dueño 1000 |
| API no arranca: «JWT_SECRET…» | falta `jwt_secret` | `init-secrets.sh` |
| API no arranca: `TRUST_PROXY_HOPS inválido` | valor fuera de `0..8` | [configuration.md](configuration.md) |
| `bot-build-worker` no arranca por la clave de firma | falta `artifact_signing_key.pem` (sin `openssl` al generar secretos) | instalar `openssl` y reejecutar `init-secrets.sh` |
| Gateway no arranca con `nginx.conf` | faltan `tls/fullchain.pem`/`privkey.pem` | generarlos o usar `nginx-behind-proxy.conf` |
| Registro: error de FK con `roles` | no se ejecutó `bootstrap` | [first-run.md §1](first-run.md#1-contenido-base-bootstrap) |
| No hay ningún administrador | no existe alta de admin | [first-run.md §3](first-run.md#3-primer-administrador) |

## Salud y versiones

| Síntoma | Causa probable | Remedio |
|---|---|---|
| `/api/healthz` responde 200 pero la API está caída | esa ruta la sirve la web | usar `/api/v1/healthz` ([TD-020](../roadmap/technical-debt.md#td-020)) |
| `smoke.sh` falla en `/replays/healthz` | la ruta no existe | no usar `smoke.sh` como criterio |
| `/grafana/` → 502 | observabilidad no desplegada | esperado |
| `/version` dice `unknown` o 404 | imagen sin `BUILD_COMMIT` o gateway sin la ruta | [upgrades.md](upgrades.md#alinear-todas-las-imágenes-con-un-mismo-build_commit) |
| El panel Sistema muestra `commit: unknown` | lee `GIT_COMMIT`/`COMMIT_SHA` | esperado hoy ([TD-020](../roadmap/technical-debt.md#td-020)) |
| `docker compose ls` muestra dos `CONFIG FILES` | contenedores lanzados desde otro árbol | [upgrades.md](upgrades.md#un-solo-compose-canónico) |
| Un servicio vuelve a una versión antigua tras un `up` | override pasado por CLI, no en `.env` | [upgrades.md](upgrades.md#override-de-versión-por-servicio) |
| Todos los usuarios bloqueados en el login a la vez / cuota anónima compartida | `TRUST_PROXY_HOPS` menor que los saltos reales | `2` detrás de un proxy ([networking.md](networking.md#trust_proxy_hops)) |

## Base de datos y cola

| Síntoma | Causa probable | Remedio |
|---|---|---|
| `role "postgres" does not exist` | comando antiguo | usar `-U arena` |
| `automatic recovery in progress` al arrancar | apagado forzado | [shutdown.md](shutdown.md) |
| Errores tras actualizar: columna/tabla inexistente | faltan migraciones | `cli.ts migrate` ([upgrades.md](upgrades.md#migraciones)) |
| `tournament-worker` «Redis no disponible: degrada a polling» | Redis reiniciado o caído | autocorrige al volver Redis; la cola no es autoridad |
| `tournament-worker`/`bot-build-worker` `unhealthy` | latido parado (>120 s) | logs del worker; reinicio del servicio con `$DC restart <svc>` |

## Copias y restauración

| Síntoma | Causa probable | Remedio |
|---|---|---|
| `backup` `unhealthy` «copia rancia» | más de 26 h sin copia (p. ej. tras apagado) | copia manual ([backup.md](backup.md#copia-manual)) |
| `backup` reinicia: «CONFIG INCOMPLETA» | `RESTIC_HOSTNAME` vacío | definirlo |
| «ARRANQUE ABORTADO: backend sftp mal configurado» | clave o `known_hosts` vacíos | rellenar los secretos `restic_ssh_*` |
| `Fatal: unable to open config file` | repositorio no inicializado / errata en la ruta | `--init-repo` tras revisar la ruta |
| Restauración «correcta» pero volúmenes vacíos | nombres `s9-ai-arena_*` de runbooks antiguos | [restore.md §6](restore.md#fase-6--volúmenes) |
| `restore.sh` restaura otro snapshot del decidido | se usó `latest` | `--snapshot <id>` |

## Funcionalidad que no está disponible

No son fallos de la instalación sino del producto; no se arreglan desde operación.

| Síntoma | Estado | Deuda |
|---|---|---|
| Ningún bot pasa de la validación a `published` | build fail-closed sin sandbox real | [TD-001](../roadmap/technical-debt.md#td-001) |
| Las batallas no ejecutan el código del usuario | las ejecuta el worker con un bot stub | [TD-002](../roadmap/technical-debt.md#td-002) |
| «Crear batalla» en la web → 400 `rulesetId desconocido` | la web envía ids de modo | [TD-003](../roadmap/technical-debt.md#td-003) |
| El reproductor/visor no carga en el navegador | arranque de Phaser | [TD-009](../roadmap/technical-debt.md#td-009) |
| Importar el JSON exportado por el editor de mapas → 500 | formatos distintos | [TD-010](../roadmap/technical-debt.md#td-010) |
| Espectador en directo rechaza el ticket (4401) | worker sin secreto de verificación | [TD-028](../roadmap/technical-debt.md#td-028) |

## Documentación relacionada

[diagnostics.md](diagnostics.md) · [installation.md](installation.md) · [backup.md](backup.md) ·
[restore.md](restore.md) · [upgrades.md](upgrades.md) · [../roadmap/known-issues.md](../roadmap/known-issues.md) ·
[../roadmap/technical-debt.md](../roadmap/technical-debt.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Mensajes de error de conexión, JWT y `TRUST_PROXY_HOPS` | CODE_VERIFIED | `apps/api/src/db/connection.ts:33`; `auth/tokens.ts:74-80`; `middleware/proxy-trust.ts:27` |
| Mensajes del backup («CONFIG INCOMPLETA», «ARRANQUE ABORTADO», «copia rancia») | CODE_VERIFIED | `infrastructure/backup/entrypoint.sh`, `backup.sh`, `healthcheck.sh:104` |
| Degradación del worker a polling | CODE_VERIFIED | `apps/tournament-worker/src` (señal Redis / polling; ver [../technical/workers.md](../technical/workers.md)) |
| Defectos de producto | CODE_VERIFIED / RUNTIME_VERIFIED (auditoría) | entradas TD enlazadas |
