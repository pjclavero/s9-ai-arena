# Operación de S9 AI Arena

## Resumen

Manual del **operador** de una instalación de S9 AI Arena: instalar desde una máquina
nueva, configurar, arrancar, comprobar, copiar y restaurar, actualizar, apagar y
diagnosticar. Todo lo que aquí se afirma está contrastado con el código de `main`
(`27f70bb`) o medido en un entorno aislado; lo que no funciona hoy se dice y se enlaza
a la deuda técnica.

## Índice

- [Qué es](#qué-es)
- [Mapa de tareas](#mapa-de-tareas)
- [Reglas de oro](#reglas-de-oro)
- [Convenciones de este manual](#convenciones-de-este-manual)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

S9 AI Arena se despliega como un proyecto Docker Compose (`infrastructure/docker-compose.yml`)
con **perfiles**. El perfil de producción real es `production` (12 servicios). La administración
de la plataforma se reparte entre la web (roles, mapas, auditoría) y la línea de comandos del
host (todo lo demás: base de datos, copias, restauración, readiness, versiones, logs), como
documenta [TD-023](../roadmap/technical-debt.md#td-023).

## Mapa de tareas

| Quiero… | Documento | Dónde se hace |
|---|---|---|
| Instalar desde cero | [installation.md](installation.md) | host (SSH) |
| Hacer la puesta en marcha (contenido base, primer administrador, repositorio de copias) | [first-run.md](first-run.md) | host + web |
| Saber qué variable hace qué | [configuration.md](configuration.md) | `infrastructure/.env` |
| Entender servicios, perfiles, volúmenes y redes | [docker.md](docker.md) | host |
| Operar el proxy de Docker del host (ejecución de bots) | [docker-proxy.md](docker-proxy.md) | host (systemd) |
| Cerrar el puerto del proxy y el sshd del host a los contenedores (firewall como código) | [firewall.md](firewall.md) | host (systemd, root) |
| Descargar las imágenes de runtime de los bots antes de activar la ejecución | [installation.md](installation.md#imágenes-de-runtime-de-los-bots) | host |
| Publicar detrás de un proxy inverso / TLS | [networking.md](networking.md) | host + proxy |
| Comprobar las copias | [backup.md](backup.md) | host |
| Restaurar | [restore.md](restore.md) | host nuevo o aislado |
| Saber si la instalación está lista | [readiness.md](readiness.md) | host |
| Diagnosticar | [diagnostics.md](diagnostics.md) · [troubleshooting.md](troubleshooting.md) | host |
| Actualizar o cambiar la versión de un servicio | [upgrades.md](upgrades.md) | host de build + host productivo |
| Detectar deriva entre lo declarado y lo que corre | [runtime-drift-scanner.md](runtime-drift-scanner.md) | host |
| Apagar y encender la máquina | [shutdown.md](shutdown.md) | host + hipervisor |

## Reglas de oro

1. **Nunca `latest`.** La CI no publica esa etiqueta; las imágenes se fijan por `sha-<commit>`
   ([installation.md](installation.md#4-elegir-la-versión-de-las-imágenes)).
2. **Nunca recrear `postgres` sin ventana de mantenimiento.** Su imagen está fijada por digest; no
   hay razón para tocarla en una actualización normal ([upgrades.md](upgrades.md)).
3. **Construir y desplegar son fases distintas** (ADR-017): en el host productivo se despliega con
   `--no-build` ([upgrades.md](upgrades.md)).
4. **Nunca `seed` en producción**: crea usuarios con contraseñas conocidas del repositorio. El
   comando apto es `bootstrap` ([first-run.md](first-run.md)).
5. **Nunca `down` sobre el stack productivo** salvo que se quiera eliminar contenedores, y nunca
   `down -v` (borra volúmenes con los datos).
6. **Comprobar con lo que de verdad responde**: `/healthz` del gateway y `/api/v1/healthz` de la API.
   `/api/healthz` y `infrastructure/scripts/smoke.sh` dan resultados engañosos
   ([TD-020](../roadmap/technical-debt.md#td-020)).

## Convenciones de este manual

- Los comandos se ejecutan desde la raíz del clon en el host (`/opt/s9-ai-arena` en los
  ejemplos; puede ser otra) con el **usuario de despliegue** que posee el clon, salvo que se
  indique otra cosa.
- Abreviatura usada en los ejemplos:

  ```bash
  DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
  ```

  El nombre de proyecto resultante es `infrastructure` (el directorio del fichero compose): de él
  salen los nombres de volúmenes (`infrastructure_postgres_data`, …) y redes.
- Direcciones y nombres de ejemplo: `192.0.2.x`, `203.0.113.x`, `arena.example.internal`,
  `<host-arena>`, `<backup-host>`. Ninguno corresponde a una instalación real.
- Los comandos con efectos destructivos van en un bloque **DANGER / PRECONDITION / EFFECT / ROLLBACK**.

## Estado actual

- **FUNCIONA ACTUALMENTE:** despliegue del perfil `production` desde imágenes publicadas por la CI,
  `bootstrap` del contenido base, copias diarias con restic, restauración por snapshot, gates de
  versión y de deriva por línea de comandos.
- **PARCIAL:** readiness (sólo por CLI y nunca puede dar `READY`, ver [readiness.md](readiness.md));
  identidad de versión en runtime ([TD-006](../roadmap/technical-debt.md#td-006)); copias sin
  alertas ni snapshots de VM y apagado no limpio ([TD-007](../roadmap/technical-debt.md#td-007)).
- **PENDIENTE:** alta del primer administrador sin SQL ([TD-023](../roadmap/technical-debt.md#td-023)),
  instalación de un solo paso y readiness desplegado ([TD-024](../roadmap/technical-debt.md#td-024)),
  ensayo reciente de restauración ([TD-025](../roadmap/technical-debt.md#td-025)).

## Documentación relacionada

- Arquitectura y servicios: [../technical/architecture.md](../technical/architecture.md),
  [../technical/services.md](../technical/services.md), [../technical/gateway.md](../technical/gateway.md),
  [../technical/database.md](../technical/database.md), [../technical/queue.md](../technical/queue.md),
  [../technical/workers.md](../technical/workers.md), [../technical/security.md](../technical/security.md).
- Estado y deuda: [../roadmap/current-status.md](../roadmap/current-status.md),
  [../roadmap/technical-debt.md](../roadmap/technical-debt.md).
- Administración desde la web: [../user/administration.md](../user/administration.md).
- Desarrollo: [../development/index.md](../development/index.md).
- Decisiones: [../adr/index.md](../adr/index.md) (ADR-010 copias, ADR-016 identidad de build,
  ADR-017 contrato de release, ADR-018 semántica del escaneo).
- Runbooks anteriores (históricos, no vigentes): [../history/index.md](../history/index.md#operaciones).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| El perfil `production` tiene 12 servicios; `nucleo` 7; sin perfil, 0 | RUNTIME_VERIFIED | `docker compose -f infrastructure/docker-compose.yml --profile production config --services` (máquina de desarrollo, sin daemon productivo) |
| El nombre de proyecto es `infrastructure` | RUNTIME_VERIFIED | `docker compose … config` → `name: infrastructure`; el compose no declara `name:` |
| La CI no publica `latest` | RUNTIME_VERIFIED | GHCR anónimo: `api:latest` → 404; `api:sha-27f70bb…` → 200 (2026-10-15) |
| `seed` crea usuarios de desarrollo; `bootstrap` no crea usuarios | CODE_VERIFIED | `apps/api/src/db/cli.ts:11-13,52-59` |
| `/api/healthz` no es la salud de la API | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:88` sólo proxea `/api/v1/`; `apps/api/src/server.ts:46` |
