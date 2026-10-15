# Auditoría profunda 2026-10-15 — resumen público

## Resumen

El 2026-10-15 se hizo una auditoría de **sólo lectura** de S9 AI Arena: código, tests, git,
runtime de producción, base de datos, documentación y uso en un navegador real. Durante la
auditoría no se hizo ningún cambio en producción.

**Veredicto:** S9 AI Arena **no es funcional como producto** en su despliegue actual.
- El motor de simulación es sólido.
- La plataforma es amplia en código.
- Ningún recorrido de usuario llega a término desde la web: el bot no se publica, la batalla no se crea y el replay no se reproduce.

| Medida | Valor | Cómo se calcula |
|---|---|---|
| Madurez por capacidades | **≈ 47 %** | media no ponderada de 16 áreas (detalle abajo) |
| Recorrido de producto de extremo a extremo en producción | **0 %** | un bloqueo P0 anula el recorrido completo |

Este documento es la versión pública y saneada de la auditoría:
- No incluye topología de infraestructura.
- No incluye el detalle explotable de las vulnerabilidades abiertas: describe la clase de problema y su estado.
- La evidencia completa (capturas, logs, consultas a la BD, inventarios del host) es **interna** y no se publica.

## Índice

- [Base auditada](#base-auditada)
- [Metodología](#metodología)
- [Hallazgos por área](#hallazgos-por-área)
- [Puntuación por área](#puntuación-por-área)
- [Bloqueos P0 y trabajo P1](#bloqueos-p0-y-trabajo-p1)
- [Qué falta para "funcional"](#qué-falta-para-funcional)
- [Estado actual](#estado-actual)
- [Verificación](#verificación)

## Base auditada

| Elemento | Valor |
|---|---|
| Repositorio | `pjclavero/s9-ai-arena`, `origin/main = 27f70bb` (2026-09-13) |
| Árbol de despliegue | ancestro de `main`, 12 commits por detrás, sin cambios locales |
| Runtime | 12 contenedores del perfil compose `production`; las imágenes mezclan **tres** commits (`4d469dc`, `0daa500`, `ad0a42b`) |
| Datos de producción | 1 usuario, 11 bots (12 versiones, todas `rejected`), 22 builds `failed`, 0 artefactos, 3 equipos, 1 mapa publicado, 31 módulos, 1 ruleset; **0 batallas, 0 torneos, 0 estadísticas** |
| Suite de tests de `main` | 2629 tests: 2625 passed, 0 failed, 4 skipped, rc=0 |

## Metodología

La auditoría se hizo en **dos pasadas** con tres agentes independientes. Cada agente trabajó en su
propio worktree aislado sobre el mismo commit:

- **A**: código, git y runtime.
- **B**: producto, web y UX, con Chromium real.
- **C**: documentación, administración y operación.

1. **Pasada 1 (inventario):** cada agente levanta su matriz con la fuente de cada afirmación: CODE, TEST, RUNTIME, GIT, DOCUMENTATION, BROWSER o DATABASE.
2. **Cruce del supervisor:** se contrastan las tres matrices. Salen 15 contradicciones o huecos (K1–K15), que vuelven a los agentes.
3. **Pasada 2 (hostil):** cada agente intenta **refutar** lo de la pasada 1. Para ello:
   - verifica el código desplegado por contenido (hash de ficheros dentro del contenedor frente al commit);
   - recorre los flujos en navegador real, en un entorno aislado y, sólo con GET anónimos, contra producción;
   - lanza ataques entre usuarios en el entorno aislado;
   - ejecuta **mutaciones**: cambia una garantía de seguridad y comprueba si algún test se pone rojo.
4. **Falsación del supervisor:** re-verifica en el código las conclusiones de las que depende el veredicto.

Reglas: producción sólo en lectura; ningún secreto leído por valor. Un hallazgo sin evidencia
queda como UNKNOWN y no se convierte en aprobado.

## Hallazgos por área

| Área | Estado | Resumen |
|---|---|---|
| Usuarios | PARCIAL | Registro, login, logout y refresh con rotación funcionan (si se reutiliza un refresh, se revoca toda la familia). El registro está abierto con rol de desarrollador. No hay cambio de contraseña ni recuperación con canal. Los límites por IP se debilitan por la configuración de proxy. |
| Bots | **BLOQUEADO** | Se pueden crear, editar el código y versionar. **Ninguna versión puede publicarse**: el build falla cerrado porque falta el sandbox de ejecución. |
| Equipamiento | PARCIAL | El catálogo, el validador y la persistencia del loadout funcionan. En batalla el efecto es parcial y varios campos del catálogo no hacen nada. |
| Equipos | PARCIAL | Se pueden crear e invitar. No se puede asignar un bot desde la UI. El listado anónimo expone identificadores. |
| Mapas | PARCIAL | Importar, generar y publicar funciona (rol organizer). El editor sólo trabaja en el cliente y su exportación no se puede importar. |
| Batallas | **BLOQUEADO** | Crear una batalla desde la web falla por la costura de ruleset. Las batallas que llegan a ejecutarse usan un bot de relleno (stub), no el código del usuario. Activar el camino real provocaría una doble ejecución. Hay un fallo de autorización entre usuarios. |
| Torneos | PARCIAL | `round_robin` completo con bracket y Elo, pero con stub. No hay selección de mapa. Una batalla fallida impide el cierre. |
| Visor en directo | PARCIAL (roto) | Roto en navegador: la escena se usa antes de que el motor gráfico arranque. |
| Replays | PARCIAL | La generación y la persistencia funcionan. La reproducción está rota en navegador. **La política de visibilidad no se aplica en el borde.** |
| Ranking / estadísticas | PARCIAL / sólo código | Se calculan y persisten, pero en producción no hay datos. La web sólo muestra el ranking. |
| Administración | PARCIAL | La web cubre roles, mapas, equipos y auditoría. Backup, restore, readiness y drift sólo se operan desde el host. |
| Instalación | PARCIAL | Existen compose y `bootstrap`. La instalación limpia no es reproducible desde la documentación. |
| Backup | NO OPERABA | Sin copias desde el 13-sep, sin alertas y sin snapshots de la VM. *Ver el estado actual: ya opera.* |
| Recuperación | PARCIAL | Drill de restore de agosto correcto. Hay pasos de la documentación antigua que fallan. |
| Motor | SÓLIDO | Movimiento, colisión, armas, daño, sensores, acústica, CTF, control de zona, determinismo y replay verificados con tests. La radio es parcial. |
| Pruebas | PARCIAL | Unitarias y CI en verde. No hay E2E de navegador real. Dos mutaciones de seguridad no ponen ningún test en rojo. El nightly está en rojo crónico. |
| Documentación | PARCIAL | 139 documentos, sin guía de usuario web, con dos «fuentes de verdad» contradictorias, runbooks rotos o peligrosos y topología interna publicada. |

Las vulnerabilidades abiertas se describen aquí sólo por su clase:
- visibilidad de replays no aplicada en el borde;
- autorización de participantes;
- registro abierto y límites por IP debilitados;
- versiones de seguridad sin desplegar;
- información de infraestructura en el repositorio.

Su seguimiento está en el [registro de deuda técnica](../../roadmap/technical-debt.md).

## Puntuación por área

**Método:** cada área se puntúa con la lista de capacidades que pedía el encargo, según su estado **en producción**.

| Estado de la capacidad | Puntos |
|---|---|
| VERIFIED | 1 |
| IMPLEMENTED o PARTIAL | 0,5 |
| BLOCKED, MISSING o UNKNOWN | 0 |

En Administración se puntúa distinto:

| Dónde se puede operar | Puntos |
|---|---|
| Web | 1 |
| Sólo por API | 0,5 |
| Sólo por SSH | 0,25 |
| No existe | 0 |

Lo que sólo funciona con stubs puntúa la mecánica, no el producto; se marca con *.

| Área | % |
|---|---|
| Motor | 82 % |
| Torneos* | 70 % |
| Estadísticas* | 70 % |
| Equipamiento | 67 % |
| Ciclo de batalla* | 56 % |
| Replays | 50 % |
| Administración | 48 % |
| Documentación | 44 % |
| Equipos | 42 % |
| Flujos de usuario | 38 % |
| Bots | 36 % |
| Instalación / readiness | 36 % |
| Pruebas | 36 % |
| UX web | 35 % |
| Mapas | 33 % |
| Operación | 13 % |
| **Media (16 áreas)** | **≈ 47 %** |

**Corrección obligatoria:** el 47 % mide capacidades sueltas. Como ningún bot se publica y ninguna
batalla ejecuta código de usuario, el recorrido de extremo a extremo en producción es **0 %**.

## Bloqueos P0 y trabajo P1

El backlog de la auditoría se tradujo a entradas del registro de deuda:

| Id de la auditoría | Deuda técnica |
|---|---|
| P0-1 | [TD-001](../../roadmap/technical-debt.md#td-001) |
| P0-2 | [TD-002](../../roadmap/technical-debt.md#td-002) |
| P0-3 | [TD-003](../../roadmap/technical-debt.md#td-003) |
| P0-4 | [TD-004](../../roadmap/technical-debt.md#td-004) |
| P0-5 | [TD-005](../../roadmap/technical-debt.md#td-005) |
| P0-6 | [TD-006](../../roadmap/technical-debt.md#td-006) |
| P0-7 | [TD-007](../../roadmap/technical-debt.md#td-007) |
| P0-8 | [TD-008](../../roadmap/technical-debt.md#td-008) |
| P1-1 | [TD-009](../../roadmap/technical-debt.md#td-009) |
| P1-2 | [TD-010](../../roadmap/technical-debt.md#td-010) |
| P1-3 | [TD-011](../../roadmap/technical-debt.md#td-011) |
| P1-4 | [TD-012](../../roadmap/technical-debt.md#td-012) |
| P1-5 | [TD-013](../../roadmap/technical-debt.md#td-013) |
| P1-6 | [TD-014](../../roadmap/technical-debt.md#td-014) |
| P1-7 | [TD-015](../../roadmap/technical-debt.md#td-015) |

El cruce completo hallazgo por hallazgo está en [AUDIT-DELTA-2026-10.md](AUDIT-DELTA-2026-10.md).

## Qué falta para "funcional"

**Para que sea funcional** hay que cerrar TD-001, TD-002, TD-003, TD-009 y TD-010. Entonces un
usuario puede, desde la web:
1. crear un bot;
2. compilarlo y publicarlo;
3. guardar un mapa;
4. lanzar una batalla con su código;
5. ver el ganador y las estadísticas;
6. reproducir el replay.

**Para abrirlo a terceros**, además:
- TD-004, TD-005, TD-006 y TD-007;
- el gate de activación (custodia externa, backup verificado, readiness).

## Estado actual

El estado vigente se mantiene en [docs/roadmap/current-status.md](../../roadmap/current-status.md).
Desde la auditoría no hay commits nuevos. La única novedad es que **el backup volvió a operar**
el 2026-10-15; siguen sin resolver las alertas, los snapshots de la VM y el apagado limpio. Los
detalles están en [AUDIT-DELTA-2026-10.md](AUDIT-DELTA-2026-10.md).

## Documentación relacionada

- [AUDIT-DELTA-2026-10.md](AUDIT-DELTA-2026-10.md)
- [Registro de deuda técnica](../../roadmap/technical-debt.md)
- [Problemas conocidos](../../roadmap/known-issues.md)
- [Arquitectura real](../../overview/architecture.md)
- [Auditorías anteriores](../anteriores/)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Veredicto y porcentajes | auditoría (interna) | informe final interno de la auditoría, secciones VERDICT y PRODUCT READINESS |
| Base `27f70bb` | CODE_VERIFIED | `git rev-parse HEAD` |
| Build fail-closed sin sandbox | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:31` |
| Costura de ruleset | CODE_VERIFIED | `apps/web/src/pages/BattleNewPage.tsx:17-21`; `apps/api/src/routes/battles.ts:400-401` |
| Arranque de Phaser | CODE_VERIFIED | `apps/web/src/pages/ReplayPage.tsx:75` |
| Backup operando de nuevo | RUNTIME_VERIFIED | estado de salud y logs del servicio backup, 2026-10-15 |
