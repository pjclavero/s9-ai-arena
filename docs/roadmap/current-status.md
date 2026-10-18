# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado del proyecto**. Sustituye a los antiguos `docs/estado-proyecto.md`
y `docs/ESTADO_ACTUAL.md`, que quedan archivados en `docs/history/status/` y ya no son vigentes.

Hay dos planos y no se mezclan:
- **Código (`main`):** contiene el cierre funcional (PR #152) y el *Production Readiness Closure* (PR #158). `main` está protegida: no se fusiona nada si falla el golden path real de `functional-e2e`. Informes: [functional-closure-report.md](../development/functional-closure-report.md) y [production-readiness-report.md](../development/production-readiness-report.md).
- **Producción:** no ha cambiado. Nada de lo fusionado se ha desplegado todavía.

```
MAIN:           59322e2 (tras #152 → debdf8a y #158 → 59322e2)
LAST VERIFIED:  2026-10-19 (CI de main en verde, functional-e2e incluido; protección de rama verificada)
RUNTIME:        sin cambios desde la auditoría: perfil `production`, 12 servicios, imágenes de 3 commits
VEREDICTO CÓDIGO:     el recorrido de usuario completo funciona y lo exige la CI (golden path en navegador real)
VEREDICTO PRODUCCIÓN: NO funcional como producto hasta desplegar main (fase Release Candidate)
READINESS:      PRODUCTION_READY (código y gobernanza); despliegue pendiente de autorización del operador
```

Informe del cierre: [functional-closure-report.md](../development/functional-closure-report.md).

## Índice

- [Functional](#functional)
- [Partial](#partial)
- [Blocked](#blocked)
- [Operations](#operations)
- [Security](#security)
- [Known issues](#known-issues)
- [Next priorities](#next-priorities)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Functional

**FUNCIONA ACTUALMENTE (integración, entorno aislado).** Verificado con tests que se ponen rojos con su mutación y con el golden path en Chromium real, sin mocks de servicios de S9:

- **Recorrido completo de usuario** (golden path, `tests/browser/specs/golden-path.spec.ts`): registro → bot con código pegado → build en el sandbox real (contenedor por `s9-docker-proxy`) → `published` → segundo bot → equipo → mapa (importar, guardar, F5, reabrir, publicar) → batalla en el mapa propio → la ejecuta el `tournament-worker` con el **artefacto firmado** de la versión exacta de cada bot → visor en directo → `finished` con ganador → estadísticas → replay reproducido en la web. Los bots son distinguibles (uno dispara, otro nunca): el resultado prueba que corrió SU código.
- **Bots y versionado:** sandbox real del build ([bots.md](../technical/bots.md)); versión inmutable en BD; historial, diff, clonado y procedencia ([bot-versioning.md](../technical/bot-versioning.md)).
- **Batallas:** una sola autoridad de ejecución (reserva atómica + lease + cierre exactamente una vez); validación modo ↔ ruleset ↔ mapa en la API; resultado `battle-result/v1`, outcome por bot, CPU real, replay verificable ([battles.md](../technical/battles.md)).
- **Mapas, equipos y rulesets:** editor que guarda y reabre desde la API, borradores privados, equipos completos, rulesets servidos por la API ([maps.md](../technical/maps.md), [game-modes.md](../technical/game-modes.md)).
- **Web:** estados de error comunes (timeout, red, 403/404/5xx, API caída al arrancar), 404, reproductor y visor con Phaser real, resultados de batalla ([frontend.md](../technical/frontend.md)).
- **Ranking:** temporada activa única entre API y worker (TD-029).
- **Motor, cuentas, cola de trabajos, backup y CI principal:** como en la auditoría ([engine.md](../technical/engine.md), [backup.md](../operations/backup.md)).

## Partial

**PARCIAL:**

| Área | Qué funciona | Qué no | Deuda |
|---|---|---|---|
| Build de bots | sandbox real en aislado, en navegador y en CI; dos relojes de arranque (plataforma / bot) en la integración PRC | proxy del host sin operar | [TD-001](technical-debt.md#td-001), [TD-034](technical-debt.md#td-034) (cerrada en la integración) |
| Equipamiento | catálogo, validación, persistencia; la UI dice qué campos tienen efecto | efecto parcial en batalla | [TD-016](technical-debt.md#td-016) |
| Torneos | `round_robin` con el código real de los bots (worker integrado) | `mapPool`; `failed` bloquea el cierre | [TD-015](technical-debt.md#td-015) |
| Visor / emisión | visor en directo con batalla viva (aislado) | emisión (`#/broadcast`) sin E2E | [TD-009](technical-debt.md#td-009) |
| Web | estados y errores comunes en todas las páginas de A, C y D | onboarding / enlace al SDK | [TD-022](technical-debt.md#td-022) |
| Administración | web: roles, mapas, equipos, auditoría | backup, restore, readiness y drift sólo por SSH | [TD-023](technical-debt.md#td-023) |
| Instalación / readiness | compose preparado para la ejecución real | instalación limpia no reproducible; readiness no desplegado | [TD-024](technical-debt.md#td-024) |
| Recuperación | drill de restore de agosto; `restore.sh --snapshot` | sin ensayo reciente | [TD-025](technical-debt.md#td-025) |

## Blocked

**PENDIENTE / BLOQUEADO en producción.** Los tres bloqueos de la auditoría (publicar un bot, crear una batalla, ejecutar código de usuario) están resueltos **en `main`**, no en producción. Para verlos en producción hace falta, con una ventana autorizada por el operador (fase Release Candidate):

1. Construir las imágenes de `main` con su identidad de build.
2. Generar `artifact_verify_key.pem` (`init-secrets.sh` lo deriva de la clave de firma) y operar el `s9-docker-proxy` en el host.
3. Recrear `api`, `tournament-worker` y `bot-build-worker` (más `backup`/`postgres`/`queue` según el contrato de despliegue) y aplicar las migraciones `012_bot_versioning` y `013_battle_claim`.

## Operations

**Runtime** (medido en la auditoría; sin cambios):

| Commit | Servicios | Identidad de build |
|---|---|---|
| `4d469dc` | 9 servicios de aplicación | sin `BUILD_COMMIT` ni `/version` |
| `0daa500` | `tournament-worker` | con `BUILD_COMMIT` |
| `ad0a42b` | `backup` | con `BUILD_COMMIT`; bloque versionado aparte a propósito |

PostgreSQL 16.14 y Redis 7.4.9 están fijados por digest. Ver [TD-006](technical-debt.md#td-006).

- **Perfil:** `production`, con 12 servicios ([docker.md](../operations/docker.md)). `map-service` sigue en él ([TD-017](technical-debt.md#td-017)).
- **Despliegue de la integración:** exige recrear `api`, `bot-build-worker` y `tournament-worker` (lo mide `infrastructure/tests/compose-canonical-check.test.ts`) y un secreto nuevo, `artifact_verify_key` ([configuration.md](../operations/configuration.md#secretos)).
- **Backup:** opera; sin alertas, sin snapshot de la VM y sin apagado limpio garantizado ([TD-007](technical-debt.md#td-007)).
- **CI:** `nightly.yml` en rojo crónico ([TD-019](technical-debt.md#td-019)). `functional-e2e` (golden en navegador real + E2E Docker, gateway de TD-004 incluido) corre en todo PR y en `main`, está calibrado en CI real y es **check obligatorio** de la protección de rama de `main`, que incluye a los administradores ([TD-045](technical-debt.md#td-045) CERRADA, [ci.md](../development/ci.md#protección-de-rama)).

## Security

| Problema | Estado | Deuda |
|---|---|---|
| Replays legibles por anónimos a través del gateway | **CERRADO en `main`** (gateway 404 en `/replays*`, API única autoridad); abierto en producción hasta desplegar | [TD-004](technical-debt.md#td-004) |
| Batallas con bots privados ajenos; `rating-history` ajeno | **CERRADO en `main`** | [TD-005](technical-debt.md#td-005) |
| Batallas y stats exponen participantes de bots privados | ABIERTO | [TD-047](technical-debt.md#td-047) |
| Anfitrión de bots con credenciales de BD en la red `arena` | ABIERTO (aceptado) | [TD-033](technical-debt.md#td-033) |
| Worker con el secreto de sesión raíz | ABIERTO | [TD-043](technical-debt.md#td-043) |
| Altas de equipo por email: oráculo de cuentas | ABIERTO | [TD-041](technical-debt.md#td-041) |
| Runtime sin el Carril I/J ni el parche de dependencias de `main` | ABIERTO | [TD-006](technical-debt.md#td-006) |
| Registro abierto; clave de límites colapsada a la IP del proxy | ABIERTO | [TD-012](technical-debt.md#td-012) |
| Imágenes de servicio con vulnerabilidades HIGH/CRITICAL | ABIERTO | [TD-031](technical-debt.md#td-031) |
| Topología de infraestructura en el repositorio público | ABIERTO | [TD-008](technical-debt.md#td-008) |
| Ejecución real y espectador público | en producción, **apagados** hasta desplegar con su gate | [docs/technical/security.md](../technical/security.md) |

## Known issues

Síntomas vigentes en [known-issues.md](known-issues.md).

## Next priorities

1. Fase Release Candidate, con autorización del operador: imágenes de `main`, migraciones `012`/`013`, `artifact_verify_key`, `s9-docker-proxy`, backup/readiness, gate A-G, despliegue controlado y golden path tras desplegar ([Blocked](#blocked)).
2. Mantener la protección de `main` tal como está documentada ([ci.md](../development/ci.md#protección-de-rama)); cualquier cambio de reglas es decisión del operador.
3. [TD-047](technical-debt.md#td-047), [TD-041](technical-debt.md#td-041), [TD-012](technical-debt.md#td-012): antes de abrir a terceros.
4. [TD-033](technical-debt.md#td-033) y [TD-043](technical-debt.md#td-043): reducir el privilegio de los procesos que hablan con bots.
5. [TD-006](technical-debt.md#td-006) y [TD-007](technical-debt.md#td-007): runtime y backup (ventana del operador).

Funciones pendientes de diseño: [pending-features.md](pending-features.md).

## Documentación relacionada

- [technical-debt.md](technical-debt.md) · [known-issues.md](known-issues.md) · [pending-features.md](pending-features.md)
- [Informe del cierre funcional](../development/functional-closure-report.md)
- [Auditoría 2026-10-15](../audits/2026-10-15/README.md) · [AUDIT-DELTA](../audits/2026-10-15/AUDIT-DELTA-2026-10.md)
- [Visión general](../overview/project.md) · [Arquitectura](../overview/architecture.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Base `0b8c12b` = `origin/main` al integrar | CODE_VERIFIED | `git rev-parse origin/main` (2026-10-17) |
| Golden path completo en navegador real | RUNTIME_VERIFIED (aislado) | `npm run test:browser`: golden rc=0, fase1 14/14, fase2 2/2, fase3 1/1, sonda TD-028 rc=0 |
| El worker ejecuta el artefacto firmado de la versión exacta | RUNTIME_VERIFIED (aislado) | `apps/tournament-worker/src/container-battle-e2e.test.ts` (`S9_RUN_REAL_DOCKER_E2E=1`, 3/3) |
| Mutaciones del cierre en rojo | CODE_VERIFIED | HunterBot disfrazado (golden rc=1), READY de Phaser (golden y replay rc=1), sandbox fuera (rc=1), cierre doble (rc=1), bot privado ajeno (rc=1), persistencia del mapa (rc=1); ver el informe |
| Perfil `production` = 12 servicios | CODE_VERIFIED | `infrastructure/tests/compose.test.ts`, `deploy-contract-gate.test.ts` |
| Runtime de producción sin cambios | DESIGN_ONLY | el cierre funcional no despliega (sin SSH ni compose contra producción) |
| TD-004 / TD-034 cerradas en la integración PRC; `functional-e2e` verde y calibrado en CI real | RUNTIME_VERIFIED (aislado y GitHub Actions) | [production-readiness-report.md](../development/production-readiness-report.md); runs 39141675080 (verde), 39141682346 y 39141685353 (calibraciones en rojo) |
| #152 y #158 fusionados; `main` = `59322e2` con CI en verde (`functional-e2e` y `semaforo` incluidos) | RUNTIME_VERIFIED (GitHub Actions) | `git rev-parse origin/main`; run 39173546382 (25 jobs en verde) (2026-10-19) |
| `main` protegida y el bloqueo funciona | RUNTIME_VERIFIED | `gh api repos/…/branches/main/protection`; PR #161: merge rechazado con `functional-e2e` en rojo, también con `--admin` (2026-10-19) |
