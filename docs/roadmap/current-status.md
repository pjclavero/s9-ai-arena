# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado del proyecto**. Sustituye a los antiguos `docs/estado-proyecto.md`
y `docs/ESTADO_ACTUAL.md`, que quedan archivados en `docs/history/status/` y ya no son vigentes:
se contradecían entre sí y describían el estado de julio.

```
BASE COMMIT:    27f70bb (origin/main, 2026-09-13; 0 commits desde la auditoría del 2026-10-15)
LAST VERIFIED:  2026-10-15 (código en 27f70bb; runtime de backup re-medido 2026-10-15 21:01 UTC)
RUNTIME:        perfil compose `production`, 12 servicios, imágenes de 3 commits distintos (ver Operations)
VEREDICTO:      NO funcional como producto: recorrido de usuario de extremo a extremo = 0 %
```

## Índice

- [Functional](#functional)
- [Partial](#partial)
- [Blocked](#blocked)
- [Operations](#operations)
- [Security](#security)
- [Known issues](#known-issues)
- [Next priorities](#next-priorities)
- [Verificación](#verificación)

## Functional

**FUNCIONA ACTUALMENTE.** Lo que sigue está verificado con tests o en runtime, sin depender de stubs:

- **Motor de simulación:**
  - movimiento y colisión (Rapier 2D);
  - armas, daño y blindaje por sector;
  - sensores (lidar, radar, proximidad) y acústica;
  - modos deathmatch, team deathmatch, CTF y control de zona;
  - determinismo por semilla y hash de estado;
  - replay del motor.

  Ver [docs/technical/engine.md](../technical/engine.md).
- **Cuentas:**
  - registro, login y logout;
  - refresh con rotación y revocación de la familia si se reutiliza;
  - 2FA y sesiones, sólo por API;
  - RBAC por dueño en bots, loadouts, versiones y código fuente.
- **Bots:** crear, pegar el código, versionar y guardar el loadout validado contra el catálogo (31 módulos, 5 chasis).
- **Mapas:** importar, generar y publicar desde la web con rol organizer. Persisten en `maps`/`map_versions`.
- **Cola de trabajos:** tabla `jobs` en PostgreSQL con `FOR UPDATE SKIP LOCKED`, reintentos con backoff y `needs_review`.
- **Backup:** cron diario con restic sobre SFTP y `pg_dump`, con un healthcheck que mira la copia y no el demonio. Hay una copia correcta del 2026-10-15.
- **CI principal:** `ci.yml` y `e6-security.yml` en verde sobre `27f70bb`.

## Partial

**PARCIAL:**

| Área | Qué funciona | Qué no | Deuda |
|---|---|---|---|
| Equipamiento | catálogo, validación, persistencia | efecto parcial en batalla; campos sin efecto | [TD-016](technical-debt.md#td-016) |
| Equipos | crear, invitar (por UUID) | asignar un bot desde la UI, borrar; formato `teams` | [TD-011](technical-debt.md#td-011) |
| Mapas | importar, generar, publicar | el editor no guarda; su export no se importa | [TD-010](technical-debt.md#td-010) |
| Torneos | `round_robin` con bracket y Elo (**con stub**) | `mapPool`; `failed` bloquea el cierre | [TD-015](technical-debt.md#td-015) |
| Replays | generación, persistencia en disco, `replay_ref` | reproducción rota en navegador; `#/replays` falla tras TLS | [TD-009](technical-debt.md#td-009), [TD-014](technical-debt.md#td-014) |
| Visor en directo | emisión de ticket y canal WebSocket en código | roto en navegador; el worker no puede verificar tickets | [TD-009](technical-debt.md#td-009), [TD-028](technical-debt.md#td-028) |
| Ranking y estadísticas | cálculo, persistencia y API | en la web sólo el ranking, y sale vacío por un desajuste de temporada; sin datos en producción | [TD-022](technical-debt.md#td-022), [TD-029](technical-debt.md#td-029) |
| Administración | web: roles, mapas, equipos, auditoría | backup, restore, readiness y drift sólo por SSH | [TD-023](technical-debt.md#td-023) |
| Instalación / readiness | compose, `cli.ts bootstrap`, paquete readiness en código | instalación limpia no reproducible; readiness no desplegado | [TD-024](technical-debt.md#td-024) |
| Recuperación | drill de restore de agosto; `restore.sh --snapshot` | sin ensayo reciente; nightly de restore en rojo | [TD-025](technical-debt.md#td-025) |

## Blocked

**PENDIENTE / BLOQUEADO.** Estas tres cosas, juntas, anulan el recorrido de producto:

1. **Publicar un bot.** El build falla cerrado porque falta el sandbox real. Ver [TD-001](technical-debt.md#td-001).
2. **Crear una batalla desde la web.** Da `400 rulesetId desconocido` en los cuatro modos. Ver [TD-003](technical-debt.md#td-003).
3. **Ejecutar código de usuario.** Toda batalla la juega el worker con el stub HunterBot. El camino real está apagado, y activarlo hoy provocaría una doble ejecución. Ver [TD-002](technical-debt.md#td-002).

## Operations

**Runtime** (medido en la auditoría; las imágenes siguen siendo las mismas):

| Commit | Servicios | Identidad de build |
|---|---|---|
| `4d469dc` | 9 servicios de aplicación | sin `BUILD_COMMIT` ni `/version` |
| `0daa500` | `tournament-worker` | con `BUILD_COMMIT` |
| `ad0a42b` | `backup` | con `BUILD_COMMIT`; bloque versionado aparte a propósito |

PostgreSQL 16.14 y Redis 7.4.9 están fijados por digest. Ver [TD-006](technical-debt.md#td-006).

- **Perfil:** `production`, con 12 servicios. Los documentos antiguos que hablan de otro perfil con 7 servicios están obsoletos. Ver [docs/operations/docker.md](../operations/docker.md).
- **Backup:**
  - **Opera.** `backup SUCCESS` el 2026-10-15 a las 04:15 UTC, `restic check` sin errores, healthcheck `healthy`.
  - Sigue abierto: no hay alertas (el perfil de observabilidad no corre), no hay **ningún snapshot de la VM** y el apagado limpio de PostgreSQL no está garantizado. Ver [TD-007](technical-debt.md#td-007) y [docs/operations/backup.md](../operations/backup.md).
- **CI:** `nightly.yml` está en rojo crónico, y `deploy-staging` daría un verde falso si se configurara. Ver [TD-019](technical-debt.md#td-019).
- **Árbol desplegado en el host:** es ancestro de `main` y va 12 commits por detrás. Lo que le falta son documentación, CI, tests y el parche de dependencias.

## Security

| Problema | Estado | Deuda |
|---|---|---|
| Replays legibles por anónimos a través del gateway | ABIERTO | [TD-004](technical-debt.md#td-004) |
| Batallas con bots privados ajenos; `rating-history` ajeno | ABIERTO | [TD-005](technical-debt.md#td-005) |
| Runtime sin el Carril I/J ni el parche de dependencias de `main` | ABIERTO | [TD-006](technical-debt.md#td-006) |
| Registro abierto (rol developer); clave de límites colapsada a la IP del proxy | ABIERTO | [TD-012](technical-debt.md#td-012) |
| Topología de infraestructura en el repositorio público | ABIERTO; la consolidación documental lo reduce en `docs/` | [TD-008](technical-debt.md#td-008) |
| Ejecución real y espectador público | **apagados por defecto**, con su gate de activación | [docs/technical/security.md](../technical/security.md) |

Modelo de seguridad completo: [docs/technical/security.md](../technical/security.md).

## Known issues

Los síntomas que ven el usuario y el operador están en [known-issues.md](known-issues.md). Los
principales:
- no se puede publicar un bot;
- crear una batalla da error;
- el replay y el visor no se reproducen;
- el editor de mapas no guarda;
- `#/replays` falla tras HTTPS;
- los errores de la UI son silenciosos.

## Next priorities

Orden derivado de la auditoría (seguridad > falsa confirmación > primer bloqueo de producto):

1. [TD-001](technical-debt.md#td-001): sandbox real en el build.
2. [TD-002](technical-debt.md#td-002): un único camino de ejecución, con idempotencia.
3. [TD-003](technical-debt.md#td-003): costura de ruleset.
4. [TD-009](technical-debt.md#td-009) y [TD-010](technical-debt.md#td-010): reproductor y visor; guardado del editor.
5. [TD-004](technical-debt.md#td-004), [TD-005](technical-debt.md#td-005) y [TD-012](technical-debt.md#td-012), antes de abrir a terceros.
6. [TD-006](technical-debt.md#td-006) y [TD-007](technical-debt.md#td-007): alinear el runtime, alertas del backup, snapshot de la VM y apagado limpio. Requiere una ventana autorizada por el operador.
7. [TD-018](technical-debt.md#td-018): E2E de navegador y pruebas que se pongan rojas con las mutaciones de seguridad.

Funciones pendientes de diseño: [pending-features.md](pending-features.md).

## Documentación relacionada

- [technical-debt.md](technical-debt.md) · [known-issues.md](known-issues.md) · [pending-features.md](pending-features.md)
- [Auditoría 2026-10-15](../audits/2026-10-15/README.md) · [AUDIT-DELTA](../audits/2026-10-15/AUDIT-DELTA-2026-10.md)
- [Visión general](../overview/project.md) · [Arquitectura](../overview/architecture.md)
- [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Base `27f70bb`, 0 commits nuevos | CODE_VERIFIED | `git rev-parse origin/main` y `git rev-list --count 27f70bb..origin/main` = 0 (2026-10-15) |
| Perfil `production` = 12 servicios | CODE_VERIFIED | `infrastructure/docker-compose.yml` (`profiles:` de gateway, web, api, arena-engine, tournament-worker, bot-manager, bot-build-worker, map-service, replay-service, queue, postgres, backup) |
| Runtime con 3 commits | RUNTIME_VERIFIED (en la auditoría) | `docker image inspect`; las 12 image ID se volvieron a medir el 2026-10-15 y no habían cambiado |
| Backup operando | RUNTIME_VERIFIED | estado de salud y logs del servicio backup, 2026-10-15 21:01 UTC |
| Build fail-closed | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:31` |
| 400 de ruleset | CODE_VERIFIED | `apps/api/src/routes/battles.ts:400-401` |
| Stub HunterBot | CODE_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:51` |
| Cola en PostgreSQL | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts:26-179` |
| Motor verificado | CODE_VERIFIED + TEST (en la auditoría) | suites de `apps/arena-engine`; resultado de la suite: 2625 passed, rc=0 |
