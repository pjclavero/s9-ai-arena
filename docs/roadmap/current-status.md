# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado actual del proyecto**. Solo contiene el estado de hoy; los estados anteriores están archivados en [../history/status/](../history/status/) y no son vigentes.

Hay dos planos y no se mezclan: lo que contiene `main` y lo que corre en producción. Para cada afirmación se distingue en qué **fase de madurez** está, porque no son lo mismo:

| Fase | Qué significa |
|---|---|
| **Implementado** | Existe código. No dice nada más. |
| **Integrado** | Está en `main` (la rama protegida). |
| **Probado** | Lo ejerce la CI obligatoria de `main` (navegador y contenedores reales) o una suite de tests citada. |
| **Validado en laboratorio** | Se ejecutó de punta a punta en un entorno aislado (API, base de datos y motor reales; bots simulados en proceso) con un rc citado. |
| **Desplegado** | Corre en producción. |
| **Verificado en producción** | Hay una evidencia citada de que, ya desplegado, se comprobó en producción. Sin evidencia se escribe «no verificado». |

```
MAIN_SHA:        80f4952d732a7bdc5ad2786590e3ce14dc998577  (origin/main, merge del PR #309)
REVISADO:        2026-11-20
CÓDIGO:          main protegida; foto fija: CI de 80f4952 el 2026-11-20 = 31 check-runs, 30 success + 1 neutral
DESPLEGADO:      8f380eb (reinstalación del 19-nov-2026, según los informes de migración; el repositorio no puede comprobarlo)
MAIN VS PROD:    main lleva 36 commits por delante de lo desplegado (#169, #303, #304, #309); sólo #169 y #309 tocan el producto
MOTOR / API:     motor 0.5.0 · contrato OpenAPI 0.26.0 (113 operaciones) · migraciones 001–023
P0 / P1 / P2:    el registro de deuda conserva 3 P0, 7 P1 y 13 P2 abiertos; los hallazgos nuevos de V1 están en el roadmap
P3 CONOCIDOS:    19 P3 y 4 P4 abiertos en el registro (ver technical-debt.md)
```

## Índice

- [Código y despliegue](#código-y-despliegue)
- [Diferencia entre main y producción](#diferencia-entre-main-y-producción)
- [Estado por área y fase](#estado-por-área-y-fase)
- [Trabajo en PR abiertos](#trabajo-en-pr-abiertos)
- [Prioridades abiertas](#prioridades-abiertas)
- [Blocked](#blocked)
- [Security](#security)
- [Next priorities](#next-priorities)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Código y despliegue

| Plano | Estado | Cómo se sabe |
|---|---|---|
| `main` | `80f4952`. Protegida: cuatro checks obligatorios (`semaforo`, `functional-e2e / golden`, `functional-e2e / docker-e2e`, `functional-e2e / container-proxy-e2e`), también para administradores. CI del commit (foto fija del 2026-11-20, sin recontar después): 31 check-runs, 30 `success` y 1 `neutral`, ninguno pendiente | `gh api repos/pjclavero/s9-ai-arena/commits/80f4952d732a7bdc5ad2786590e3ce14dc998577/check-runs --paginate` (2026-11-20) |
| Producción | Instalación nueva del 19-nov-2026 sobre `8f380eb` (motor 0.5.0, migraciones hasta la 022), con el streaming desactivado. Ese día se verificó: 13 contenedores sanos, backup y restauración reales, import de 37 bots, una batalla con replay válido, un torneo individual, un torneo por equipos 2v2, la cancelación y las comprobaciones de propiedad y de mínimo de inscritos (ver [Verificación](#verificación)). **No se ha vuelto a medir desde entonces**: la versión que corre hoy es «no verificado» | informes de migración MIG6, MIG12 y MIG16 del 2026-11-19, no versionados en el repositorio |

## Diferencia entre main y producción

`main` contiene lo desplegado (`8f380eb` es ascendiente de `main`) más:

| PR | Qué cambia | ¿Toca el producto? |
|---|---|---|
| #169 | `init-secrets.sh` no sigue enlaces simbólicos ni escribe en directorios ajenos; `S9_SECRETS_ADOPT` para root | sí, en la instalación |
| #309 | La web: «Por equipos» fija el modo Team Deathmatch y el torneo nace con tamaño de equipo; ya se pueden seleccionar equipos | sí, en la web. **No está desplegado**: la web de producción es anterior |
| #303, #304 | `AGENTS.md` saneado; tests rescatados de revisiones antiguas | no |

Qué hay en PR abiertos (y por tanto **no** está en `main`) se lista en [Trabajo en PR abiertos](#trabajo-en-pr-abiertos).

## Estado por área y fase

Columnas: **I** = implementado, **M** = integrado en `main`, **P** = probado en CI, **L** = validado en laboratorio (si lleva «#317», la prueba vive en un PR abierto y no está integrada), **D** = desplegado, **V** = verificado en producción. «sí» siempre lleva evidencia; «—» = no aplica o no; «no verificado» = no hay evidencia.

| Área | I | M | P | L | D | V | Evidencia |
|---|---|---|---|---|---|---|---|
| Recorrido del jugador (cuenta, bot, build en sandbox, publicación, batalla con artefacto firmado, visor, replay) | sí | sí | sí | — | sí | batalla y replay: sí; resto no verificado | `tests/browser/specs/golden-path.spec.ts` (CI); informe MIG12 |
| Batallas 1v1 y por equipos hasta 4v4 | sí | sí | sí | sí (pendiente de integrar, #317) | sí | 1v1: sí (replay `valid=true`); 4v4: no verificado | `team-battle-4v4.spec.ts` (CI); MIG12 |
| Motor 0.5.0 y replays | sí | sí | sí | — | sí | sí (replay grabado con 0.5.0) | `regression-battles` (CI); MIG12 |
| Torneo todos contra todos | sí | sí | parcial | sí (pendiente de integrar, #317) | sí | sí (1 partido, Elo actualizado) | `tournament-e2e.test.ts`; ciclo completo en PR #317 (laboratorio); MIG12 |
| Torneo eliminación simple y suizo | sí | sí | parcial | sí (pendiente de integrar, #317) | sí | no verificado | PR #317 (laboratorio) |
| Torneo Team Deathmatch por equipos 2v2 | sí | sí | parcial | sí (pendiente de integrar, #317) | sí | sí (finished, Elo actualizado) | PR #317; MIG12. El selector web corregido (#309) no está desplegado |
| Torneo Team Deathmatch 3v3 y 4v4 | sí | sí | parcial (4v4 en navegador) | sí (pendiente de integrar, #317) | sí | no verificado | `team-battle-4v4.spec.ts`; PR #317 |
| Doble eliminación y liga | sí | sí | sólo generador | — | sí | no verificado | `apps/tournament-worker/src/formats.test.ts` |
| Torneos CTF y control de zona | sí (acepta el modo) | sí | — | **falla** (pendiente de integrar, #317) | sí | no verificado | PR #317 (`v1-tournament-ctf-zone.e2e.test.ts`): la batalla no arranca. **Fuera de V1** |
| Cancelar torneo; propiedad; mínimo 2 inscritos | sí | sí | sí | — | sí | sí (200, 403 y 409) | `tournament-cancel.test.ts`; MIG12 |
| Copias, restauración y export portable | sí | sí | sí | — | sí | sí (restauración: 41 de 41 tablas idénticas; import: 37 bots, idempotente) | CI (`e2e-backup-sftp`); MIG3, MIG12, MIG16 |
| Ajustes de runtime del acceso público | sí | sí | sí | — | sí | no verificado | `mg-runtime-settings.test.ts`, `mg-runtime-failclosed.test.ts` |
| Espectador y replays públicos | sí | sí | sí | — | sí (apagados) | no verificado | `vis-broadcast.spec.ts` |
| Streaming a YouTube real | sí | sí | local | — | sí (desactivado) | **no verificado**; imagen en blanco en emisión real | issue #256; TD-066 |
| Streaming V2 y Broadcast Manager | **no**: sólo diseño | no | — | — | — | — | PR #275 (borrador); ver [v1-roadmap.md](v1-roadmap.md#streaming-v2-y-broadcast-manager) |
| Cambio y recuperación de contraseña | cambio: en PR; recuperación: no | no | — | — | — | — | PR #315; TD-012 |

## Trabajo en PR abiertos

Ninguno está en `main`. Todos son borradores y esperan autorización de merge.

| PR | Contenido | Estado de revisión (2026-11-20) |
|---|---|---|
| #311, #312 | Acotar el rol `organizer` a sus torneos (issue #306) y su documentación del acceso público | CONFORME con observaciones; **decisión del operador pendiente** sobre el alcance |
| #313 | `GET /bots?ownerId` valida UUID (issue #305) y `DELETE /auth/sessions` | CONFORME |
| #314 | `nightly` con userns y ffmpeg reales | CONFORME |
| #315 | Cambio de contraseña y «Mi cuenta» | CONFORME; squash obligatorio |
| #316 | `listBots` completa la página (TD-068) | CONFORME con observaciones |
| #317 | Pruebas E2E de ciclo completo de torneos y 17 mutantes (sólo tests) | CONFORME con observaciones |
| #307, #308 | `SECURITY.md` y `CHANGELOG.md`; rescate de la deuda de `init-secrets` | borradores |
| #295 | Reset competitivo previo a la 0.5 (operación) | borrador |
| #275 | Diseño de Streaming V2 (MS-1) | borrador, sólo documentación |
| #277 | Refresco anterior del roadmap y los manuales (2026-11-12) | abierto; solapa con este documento y quedó obsoleto |

## Prioridades abiertas

El registro de deuda ([technical-debt.md](technical-debt.md)) conserva, sin re-priorizar, 3 P0, 7 P1 y 13 P2 heredados de la auditoría de octubre. Recuento del índice a 2026-11-20, contando como abiertas las que no están CERRADAS (ABIERTA, MEJORADA o PARCIAL):

| Prioridad | Abiertas en el registro |
|---|---|
| P0 | 3 (TD-006, TD-007, TD-008) |
| P1 | 7 (TD-012, TD-013, TD-015, TD-016, TD-025, TD-031, TD-033) |
| P2 | 13 |
| P3 | 19 |
| P4 | 4 |

Las P0 y las P1 más relevantes:

| Id | Prioridad | Estado | Resumen |
|---|---|---|---|
| [TD-006](technical-debt.md#td-006) | P0 | MEJORADA | confirmar con `runtime-drift-scan` que producción corre un único commit |
| [TD-007](technical-debt.md#td-007) | P0 | MEJORADA | alerta del backup probada, snapshot de la máquina y apagado limpio |
| [TD-008](technical-debt.md#td-008) | P0 | ABIERTA | nombres internos todavía en código, tests, CI y configuración |
| [TD-012](technical-debt.md#td-012) | P1 | ABIERTA | recuperación de cuenta inoperante, sin pantallas de 2FA ni sesiones |
| [TD-015](technical-debt.md#td-015) | P1 | PARCIAL | la batalla `failed` ya no bloquea el cierre; faltan pruebas de doble eliminación y liga |
| [TD-025](technical-debt.md#td-025) | P1 | ABIERTA | restauración sin ensayo periódico (se hizo un ensayo real el 19-nov) |
| [TD-031](technical-debt.md#td-031) | P1 | ABIERTA | imágenes de servicio con vulnerabilidades HIGH/CRITICAL |
| [TD-033](technical-debt.md#td-033) | P1 | ABIERTA (aceptada) | el anfitrión de bots tiene credenciales de BD en la red `arena` |

Hallazgos de V1 que aún no tienen TD propio (defectos del roadmap): rol `organizer` global (issue #306), torneos CTF y de zona aceptados y no jugables ([TD-070](technical-debt.md#td-070)), emisión de YouTube en blanco (issue #256). Detalle y propuesta en [v1-roadmap.md](v1-roadmap.md#defectos-y-exclusiones-de-v1).

## Blocked

**BLOQUEOS REALES:**

1. **Emisión a YouTube:** sin prueba real; hay una imagen en blanco abierta (issue #256) y falta una clave y un canal de prueba que facilite el operador.
2. **Espectador y replays públicos:** decisión del operador y condiciones del gate de activación; hoy están apagados.
3. **Alcance del rol `organizer`:** decisión del operador antes de mergear #311 y #312.
4. **CTF y control de zona en torneos:** decisión del operador sobre cómo excluirlos (cambia el contrato de la API).
5. **Recuperación de contraseña:** no existe canal de entrega; ningún usuario puede recuperar su cuenta sin intervención del operador. El cambio de contraseña llega con #315.
6. **Validación con navegador real del torneo por equipos:** pendiente (#309 sólo se probó con tests de componente y de API).

## Security

| Problema | Estado | Deuda |
|---|---|---|
| Replays legibles por anónimos a través del gateway | CERRADO (PR #158) | [TD-004](technical-debt.md#td-004) |
| Batallas y estadísticas con participantes de bots privados | CERRADO (PR #178); el rol `organizer` sigue viendo más de lo documentado | [TD-047](technical-debt.md#td-047), issue #306 |
| Proxy de Docker sin ámbito; frontera de privilegio del proxy | CERRADO en `main` (PR #164, PR #167); instalado en la instalación del 19-nov con `preflight` en verde | [TD-051](technical-debt.md#td-051), [TD-062](technical-debt.md#td-062) |
| `init-secrets.sh` seguía enlaces simbólicos | CERRADO en `main` (PR #169, tras la instalación del 19-nov) | PR #308 (rescata su registro de deuda) |
| Anfitrión de bots con credenciales de BD en la red `arena` | ABIERTO (aceptado) | [TD-033](technical-debt.md#td-033) |
| Worker con el secreto de sesión raíz | ABIERTO | [TD-043](technical-debt.md#td-043) |
| Altas de equipo por correo: oráculo de cuentas | ABIERTO (sin re-comprobar) | [TD-041](technical-debt.md#td-041) |
| Registro abierto; límites por IP | ABIERTO | [TD-012](technical-debt.md#td-012) |
| Imágenes con vulnerabilidades HIGH/CRITICAL | ABIERTO | [TD-031](technical-debt.md#td-031) |
| Nombres internos en código, tests, CI y configuración | ABIERTO | [TD-008](technical-debt.md#td-008) |
| Permisos de `.env` y `secrets/` en el host | ABIERTO (sin re-medir) | [TD-060](technical-debt.md#td-060) |

## Next priorities

1. Decidir los merges de los PR conformes (#311–#317) y las tres decisiones del operador (alcance del `organizer`, exclusión de CTF y zona, tabla por equipos con bye).
2. Desplegar `main` en una ventana autorizada (incluye #309 y #169) y repetir los smokes de torneos por equipos con navegador real.
3. Cerrar la cuenta: canal de recuperación de contraseña y pantallas de 2FA y sesiones ([TD-012](technical-debt.md#td-012)).
4. Hardening antes de abrir a terceros: [TD-041](technical-debt.md#td-041), [TD-043](technical-debt.md#td-043), [TD-033](technical-debt.md#td-033).
5. Runtime y backup en el host: [TD-006](technical-debt.md#td-006), [TD-007](technical-debt.md#td-007), [TD-025](technical-debt.md#td-025).

La clasificación completa (V1, OLA 2, futura, defectos) está en [v1-roadmap.md](v1-roadmap.md); funciones pendientes de diseño: [pending-features.md](pending-features.md).

## Documentación relacionada

- [v1-roadmap.md](v1-roadmap.md) · [technical-debt.md](technical-debt.md) · [known-issues.md](known-issues.md) · [pending-features.md](pending-features.md)
- [Auditoría de pendientes](../audits/2026-11/PENDING-AUDIT.md)
- [Visión general](../overview/project.md) · [Arquitectura](../overview/architecture.md) · [Operación](../operations/index.md)
- Estados anteriores (históricos): [../history/status/](../history/status/)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| `MAIN_SHA` = `80f4952…` | CODE_VERIFIED | `git rev-parse origin/main` (2026-11-20) |
| CI de `80f4952`: 31 check-runs, 30 `success` y 1 `neutral` | RUNTIME_VERIFIED (GitHub) | `gh api repos/pjclavero/s9-ai-arena/commits/80f4952d732a7bdc5ad2786590e3ce14dc998577/check-runs --paginate` |
| Cuatro checks obligatorios en la protección de `main` | RUNTIME_VERIFIED (GitHub, 2026-11-02; sin re-comprobar) | `gh api repos/pjclavero/s9-ai-arena/branches/main/protection` |
| Producción en `8f380eb` el 19-nov | REPORTADO (informes de migración MIG6 y MIG12; no verificable desde el repositorio) | `gh api` no lo ve; sin comprobación posterior al 19-nov |
| `8f380eb` es ascendiente de `main`; 36 commits de diferencia | CODE_VERIFIED | `git rev-list --count 8f380eb..80f4952d` |
| Producción: 13 contenedores sanos, migraciones hasta la 022, bootstrap sin usuarios | REPORTADO (MIG6, 2026-11-19) | informe de migración MIG6 |
| Producción: import de 37 bots idempotente, batalla con replay `valid=true`, torneos individual y 2v2 `finished`, cancelación, 403 de propiedad y 409 de mínimo de inscritos | REPORTADO (MIG12, 2026-11-19, 18 gates PASS) | informe de migración MIG12 |
| Producción: copia restic y restauración real, 41 de 41 tablas idénticas | REPORTADO (MIG16, 2026-11-19) | informe de migración MIG16 |
| Motor 0.5.0, OpenAPI 0.26.0 con 113 operaciones, migraciones 001–023 (ADM-1: `system_settings` y `admin_operations`, rama del PR #334, aún sin integrar en `main`) | CODE_VERIFIED | `packages/game-rules/rules-doc.ts`, `apps/api/openapi.yaml`, `apps/api/src/db/migrations.ts` |
| Ciclo completo de torneos validado en laboratorio (RR, eliminación simple, suizo, TDM 2v2/3v3/4v4) | LAB (PR #317, aún sin merge) | informe V1-C: 32 tests, rc=0 dos veces seguidas; 17 de 17 mutantes muertos |
| CTF y zona en torneos fallan al jugar | LAB (PR #317) | `v1-tournament-ctf-zone.e2e.test.ts` |
| Streaming V2 y Broadcast Manager no existen en `main` | CODE_VERIFIED | `git grep -n "StreamSession\|BroadcastQueue" -- apps packages infrastructure` (vacío) |
| Los 19 P3 y los P0, P1 y P2 abiertos | CODE_VERIFIED (recuento) | índice de [technical-debt.md](technical-debt.md) |
