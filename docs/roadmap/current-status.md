# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado actual del proyecto**. Solo contiene el estado de hoy; lo anterior (versiones candidatas previas, SHA antiguos, el
estado de la auditoría de octubre) está archivado en [../history/status/](../history/status/) y no es vigente.

Hay dos planos y no se mezclan: lo que contiene `main` y lo que corre en producción.

```
MAIN_SHA:        e3bf2fa83650559267ef269994c667fabfb29e46  (origin/main, merge del PR #225)
REVISADO:        2026-11-02
CÓDIGO:          main protegida; CI de main = 31 check-runs, 30 success + 1 neutral, 0 pendientes
DESPLEGADO:      RC5.5 a1a6c4e (según el registro del operador)
MAIN VS PROD:    111 commits por delante de producción, sin desplegar
MOTOR / API:     motor 0.4.0 · contrato OpenAPI 0.12.0 · migraciones 001–016
P0 / P1 / P2:    ninguno abierto según la revisión de integración del 2026-11-02
P3 CONOCIDOS:    7 (ver más abajo)
```

## Índice

- [Código y despliegue](#código-y-despliegue)
- [Diferencia entre main y producción](#diferencia-entre-main-y-producción)
- [Prioridades abiertas](#prioridades-abiertas)
- [Functional](#functional)
- [Partial](#partial)
- [Blocked](#blocked)
- [Security](#security)
- [Next priorities](#next-priorities)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Código y despliegue

| Plano | Estado | Cómo se sabe |
|---|---|---|
| `main` | `e3bf2fa`. Protegida: cuatro checks obligatorios (`semaforo`, `functional-e2e / golden`, `functional-e2e / docker-e2e`, `functional-e2e / container-proxy-e2e`), también para administradores. CI del commit: 31 check-runs, 30 `success` y 1 `neutral`, ninguno pendiente | `gh api repos/pjclavero/s9-ai-arena/branches/main/protection`; `gh api …/commits/e3bf2fa…/check-runs` (2026-11-02) |
| Producción | RC5.5, commit `a1a6c4e`. Es ascendiente de `main`; contiene el cierre funcional (PR #152), el *Production Readiness Closure* (PR #158), el cierre del proxy de Docker (PR #164) y la frontera de privilegio del proxy (PR #167) | registro del operador; `git merge-base --is-ancestor`. El repositorio no puede comprobar lo que corre en producción |

## Diferencia entre main y producción

`main` lleva 111 commits por delante de RC5.5. Nada de esto está desplegado:

| Bloque | PR | Qué cambia para el usuario o el operador |
|---|---|---|
| Motor 0.4.0 y reglas oficiales | #201 | Reglas de batalla con presets y copia inmutable por batalla y torneo, `maxRespawns`, desempates por familia, CTF con prórroga y salvaguarda técnica de 20 min, migración `016_battle_rules` ([ADR-022](../adr/ADR-022-motor-0-4-0-reglas-ctf-prorroga.md)). El procedimiento de despliegue y de vuelta atrás está en [upgrades.md](../operations/upgrades.md) |
| Ayuda | #207, #210 | Centro de Ayuda integrado y sin conexión, generado desde las fuentes de verdad; componente ⓘ de ayuda contextual |
| UX | #209 | Navegación agrupada por rol, «Mis bots» y equipos maestro-detalle, replays con filtros en el servidor |
| Streaming | #211 | Director de torneo, vídeo limpio y auditoría real de la emisión ([streaming.md](../operations/streaming.md)) |
| Clasificación | #220 | La clasificación de temporada y modo agrega todos los torneos |
| Paginación | #221 | Cursor con precisión completa y clave total; un cursor forjado da 400, no 500 |
| Robustez de pruebas | #208, #214, #225 | Concurrencia de `initPhysics`, tests que no dejan procesos huérfanos, sin nombres internos en comentarios |

## Prioridades abiertas

**P0 / P1 / P2:** la revisión de integración del 2026-11-02 no dejó ningún hallazgo abierto de estas prioridades.

La deuda heredada de la auditoría del 2026-10-15 conserva la prioridad con la que se registró y no es un hallazgo nuevo. La que sigue abierta (tipo operación o seguridad del host, no bloquea el uso del producto en `main`):

| Id | Prioridad original | Estado | Resumen |
|---|---|---|---|
| [TD-006](technical-debt.md#td-006) | P0 | MEJORADA | confirmar con `runtime-drift-scan` que producción corre un único commit con `/version` |
| [TD-007](technical-debt.md#td-007) | P0 | MEJORADA | alerta del backup probada, snapshot de la VM y apagado limpio |
| [TD-008](technical-debt.md#td-008) | P0 | ABIERTA | nombres internos todavía en código, tests, CI y configuración (los documentos vigentes están limpios) |
| [TD-012](technical-debt.md#td-012) | P1 | ABIERTA | registro abierto, recuperación de cuenta inoperante, sin pantallas de 2FA ni sesiones |
| [TD-025](technical-debt.md#td-025) | P1 | ABIERTA | restauración sin ensayo reciente |
| [TD-031](technical-debt.md#td-031) | P1 | ABIERTA | imágenes de servicio con vulnerabilidades HIGH/CRITICAL |
| [TD-033](technical-debt.md#td-033) | P1 | ABIERTA (aceptada) | el anfitrión de bots tiene credenciales de BD en la red `arena` |

**P3 conocidos** (cada uno comprobado en el código de `main`):

| Id | Qué ocurre | Dónde |
|---|---|---|
| [TD-067](technical-debt.md#td-067) | `runCursorQuery` atribuye al cursor errores de conversión que vienen de los filtros | `apps/api/src/serialize.ts:168-175` |
| [TD-072](technical-debt.md#td-072) | carrera en la spec de navegador `review-h3-perimeter` (sin reproducir) | `tests/browser/specs/review-h3-perimeter.spec.ts` |
| [TD-068](technical-debt.md#td-068) | `listBots` puede devolver páginas más cortas que `limit` | `apps/api/src/routes/bots.ts:205-223` |
| [TD-069](technical-debt.md#td-069) | el comparador del desempate por enfrentamientos directos no es transitivo | `apps/tournament-worker/src/results.ts:275-285` |
| [TD-071](technical-debt.md#td-071) | el filtro `result=aborted` no incluye `technical_limit` | `apps/api/src/services/replay-list.ts:222-226` |
| [TD-070](technical-debt.md#td-070) | CTF en torneos: bandos A/B frente a red/blue; se rechaza con motivo | `apps/api/src/services/battle-rules.ts:353-361` |
| [TD-066](technical-debt.md#td-066) | streaming: la clave va en el argv de FFmpeg, no hay retención de MP4 ni alerta, y YouTube está BLOCKED | `apps/streamer/src/ffmpeg.ts:115-118` |

## Functional

**FUNCIONA EN `main`.** Lo ejerce la CI obligatoria (golden path en navegador real, sin mocks de servicios de S9) y las suites de cada área:

- **Recorrido completo del jugador** (`tests/browser/specs/golden-path.spec.ts`): registro, bot con código propio, build en el sandbox real, publicación, equipo, mapa (importar, guardar, reabrir, publicar), batalla en el mapa propio ejecutada con el artefacto firmado de la versión exacta de cada bot, visor en directo, resultado con estadísticas y replay reproducido en la web.
- **Bots y versionado:** versión inmutable, historial, diff, clonado y procedencia; plantillas Python y JavaScript; SDK reales en `sdks/python` y `sdks/javascript` ([bots.md](../technical/bots.md), [bot-versioning.md](../technical/bot-versioning.md)).
- **Batallas:** modos `deathmatch`, `team_deathmatch`, `capture_the_flag` y `zone_control`; equipos hasta 4 contra 4; validación modo, reglas y mapa en la API; una sola autoridad de ejecución con cierre exactamente una vez; diagnóstico por bot ([battles.md](../technical/battles.md), [game-modes.md](../technical/game-modes.md)).
- **Torneos:** los seis formatos se aceptan y se ofrecen en la web; pool de mapas; calendario generado al cerrar inscripciones ([tournaments.md](../technical/tournaments.md)).
- **Ranking:** Elo con temporada activa única entre API y worker; clasificación de temporada agregada entre torneos.
- **Replays y directo:** lectura gobernada por una sola autoridad (propios, equipo, staff; públicos solo con la capability); visor con zoom, minimapa y móvil ([replays.md](../technical/replays.md)).
- **Mapas y equipos:** editor visual que guarda en el servidor, borradores privados, equipos completos.
- **Ayuda:** Centro de Ayuda y onboarding en la web.
- **Seguridad de la ejecución:** sandbox de bots sin `docker.sock` ni `privileged`; proxy de Docker con ámbito, red dedicada y firewall como código; protección de rama de `main` ([security.md](../technical/security.md)).

## Partial

Detalle completo, con evidencia, en [pending-features.md](pending-features.md#parciales).

| Área | Qué funciona | Qué falta | Deuda |
|---|---|---|---|
| Espectador y replays públicos | código y capabilities, apagadas por defecto | decidir la activación y cumplir las condiciones del gate | [pending-features.md](pending-features.md#parciales) |
| Torneos | seis formatos, `mapPool` | E2E de los formatos distintos de `single_elimination`; una batalla `failed` bloquea el cierre; CTF no admitido | [TD-015](technical-debt.md#td-015), [TD-070](technical-debt.md#td-070) |
| Equipamiento | catálogo, validación, persistencia | campos del catálogo sin efecto en el motor (`effect-status.ts`) | [TD-016](technical-debt.md#td-016) |
| Streaming | cadena local verificada | YouTube real, clave fuera del argv, retención, alerta, despliegue | [TD-066](technical-debt.md#td-066) |
| Cuenta | login con TOTP, API de 2FA y sesiones | pantallas; la recuperación no entrega el token | [TD-012](technical-debt.md#td-012) |
| Administración web | roles, auditoría, hallazgos, catálogo, estado | backup, restore, readiness y drift solo por CLI | [TD-023](technical-debt.md#td-023) |
| Observabilidad | perfil con 11 alertas, entre ellas las del backup | desplegarlo y probar las alertas | [TD-007](technical-debt.md#td-007) |

## Blocked

**BLOQUEOS REALES:**

1. **Desplegar `main`:** exige una ventana autorizada por el operador, la migración `016_battle_rules`, el motor 0.4.0 y haber leído el procedimiento de vuelta atrás ([upgrades.md](../operations/upgrades.md)). El cambio de reglas afecta a las batallas nuevas; las históricas no se reescriben.
2. **Emisión a YouTube:** BLOCKED hasta que el operador facilite una clave y un canal de prueba.
3. **Espectador y replays públicos:** decisión del operador y condiciones del gate de activación.
4. **Recuperación de contraseña:** no existe canal de entrega; ningún usuario puede recuperar su cuenta sin intervención del operador.

## Security

| Problema | Estado | Deuda |
|---|---|---|
| Replays legibles por anónimos a través del gateway | CERRADO (PR #158) | [TD-004](technical-debt.md#td-004) |
| Batallas y estadísticas con participantes de bots privados | CERRADO (PR #178) | [TD-047](technical-debt.md#td-047) |
| Proxy de Docker sin ámbito; frontera de privilegio del proxy | CERRADO en `main` (PR #164, PR #167) | [TD-051](technical-debt.md#td-051), [TD-062](technical-debt.md#td-062) |
| Anfitrión de bots con credenciales de BD en la red `arena` | ABIERTO (aceptado) | [TD-033](technical-debt.md#td-033) |
| Worker con el secreto de sesión raíz | ABIERTO | [TD-043](technical-debt.md#td-043) |
| Altas de equipo por email: oráculo de cuentas | ABIERTO (sin re-comprobar) | [TD-041](technical-debt.md#td-041) |
| Registro abierto; límites por IP | ABIERTO | [TD-012](technical-debt.md#td-012) |
| Imágenes con vulnerabilidades HIGH/CRITICAL | ABIERTO | [TD-031](technical-debt.md#td-031) |
| Nombres internos en código, tests, CI y configuración | ABIERTO | [TD-008](technical-debt.md#td-008) |
| Permisos de `.env` y `secrets/` en el host | ABIERTO (sin re-medir) | [TD-060](technical-debt.md#td-060) |

## Next priorities

1. Decidir y planificar el despliegue de `main` (motor 0.4.0 y reglas), con ventana del operador.
2. Cerrar la cuenta: canal de recuperación de contraseña y pantallas de 2FA y sesiones ([TD-012](technical-debt.md#td-012)).
3. Hardening antes de abrir a terceros: [TD-041](technical-debt.md#td-041), [TD-043](technical-debt.md#td-043), [TD-033](technical-debt.md#td-033).
4. Runtime y backup en el host: [TD-006](technical-debt.md#td-006), [TD-007](technical-debt.md#td-007), [TD-025](technical-debt.md#td-025).
5. Retirar los P3 de la lista de arriba (cursor, paginación de bots, filtro `aborted`, desempate directo).

Funciones pendientes de diseño: [pending-features.md](pending-features.md).

## Documentación relacionada

- [technical-debt.md](technical-debt.md) · [known-issues.md](known-issues.md) · [pending-features.md](pending-features.md)
- [Auditoría de pendientes](../audits/2026-11/PENDING-AUDIT.md)
- [Visión general](../overview/project.md) · [Arquitectura](../overview/architecture.md) · [Operación](../operations/index.md)
- Estados anteriores (históricos): [../history/status/](../history/status/)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| `MAIN_SHA` = `e3bf2fa…` | CODE_VERIFIED | `git rev-parse origin/main` (2026-11-02) |
| CI de `e3bf2fa`: 31 check-runs, 30 `success` y 1 `neutral` | RUNTIME_VERIFIED (GitHub) | `gh api repos/pjclavero/s9-ai-arena/commits/e3bf2fa83650559267ef269994c667fabfb29e46/check-runs` |
| Cuatro checks obligatorios en la protección de `main` | RUNTIME_VERIFIED (GitHub) | `gh api repos/pjclavero/s9-ai-arena/branches/main/protection` |
| Producción en `a1a6c4e` | REPORTADO por el operador (no verificable desde el repositorio) | registro del operador (encargo de la auditoría) |
| `a1a6c4e` es ascendiente de `main`; 111 commits de diferencia | CODE_VERIFIED | `git rev-list --count a1a6c4e..e3bf2fa` |
| Motor 0.4.0, OpenAPI 0.12.0, migraciones 001–016 | CODE_VERIFIED | `apps/arena-engine/src/engine-deps.json`, `apps/api/openapi.yaml:50`, `apps/api/src/db/migrations.ts` |
| Los siete P3 | CODE_VERIFIED, salvo TD-072 | ruta:línea de la tabla; TD-072 no se ha reproducido |
| «Sin P0/P1/P2 abiertos» | REPORTADO por la revisión de integración | revisión de integración del 2026-11-02 |
