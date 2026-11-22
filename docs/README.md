# Documentación de S9 AI Arena

S9 AI Arena es una arena de programación: escribes el código de un bot en Python o JavaScript, eliges el equipamiento de su vehículo y lo enfrentas a otros bots en batallas y torneos. Elige tu entrada.

```
MAIN_SHA:   80f4952d732a7bdc5ad2786590e3ce14dc998577  (main a 2026-11-20)
```

## Elige tu entrada

| Si quieres… | Empieza aquí | Qué encontrarás |
|---|---|---|
| **Quiero jugar** | [Guía del jugador](user/index.md) | Crear la cuenta y tu primer bot, programarlo (Python y JavaScript), equiparlo, lanzar batallas, torneos, ranking, mapas y replays. No hace falta leer nada más. |
| **Quiero administrar** | [Operaciones](operations/index.md) | Instalar, configurar, hacer copias y restaurar, actualizar, diagnosticar y apagar el servidor. La administración dentro del juego (usuarios, torneos) está en [user/administration.md](user/administration.md). |
| **Quiero desarrollar** | [Desarrollo](development/index.md) | Entorno, flujo de un cambio y de un PR, tests, CI, releases; después [visión general](overview/index.md) y [documentación técnica](technical/index.md). |
| **Estado del proyecto** | [Estado actual](roadmap/current-status.md) | Qué hay en `main` y qué en producción, deuda técnica, problemas conocidos y funciones pendientes. |

## Dónde está cada cosa

| Carpeta | Para quién | Contenido |
|---|---|---|
| [user/](user/index.md) | jugador | La guía del jugador y del programador de bots. Es la fuente del Centro de Ayuda. |
| [operations/](operations/index.md) | operador del servidor | Instalación, configuración, backup, restore, red, observabilidad, streaming. |
| [development/](development/index.md), [overview/](overview/index.md), [technical/](technical/index.md) | desarrollador | Cómo trabajar en el código y cómo está construido el sistema. |
| [roadmap/](roadmap/index.md) | quien decide | Estado actual, deuda técnica, problemas conocidos, funciones pendientes. |
| [audits/](audits/README.md), [testing/](testing/index.md), [adr/](adr/index.md) | desarrollador | Evidencia: auditorías, informes de pruebas y decisiones de arquitectura. Describen una fecha, no el presente. |
| [history/](history/index.md) | archivo | DOCUMENTACIÓN HISTÓRICA: estados, entregas y diseños anteriores. No es vigente. |

Qué pasó con cada documento antiguo: [DOC-MIGRATION-MAP.md](DOC-MIGRATION-MAP.md). Auditoría de esta reorganización: [audits/2026-11/DOCS-AUDIT.md](audits/2026-11/DOCS-AUDIT.md).

## Quién lee qué (separación entre usuario y desarrollo)

- **Quien sólo quiere jugar** no necesita salir de [user/](user/index.md): esa carpeta no contiene informes, decisiones internas, números de PR ni identificadores de deuda, y un test (`packages/game-rules/user-docs-current.test.ts`) lo impide. Desde ahí sólo se enlaza a operaciones (para administradores) y al índice de desarrollo.
- **Quien administra** vive en [operations/](operations/index.md).
- **Todo lo histórico está archivado, no borrado**, y fuera del camino del usuario: [history/](history/index.md) (estados, entregas, diseños y rondas anteriores), [audits/](audits/README.md) (auditorías fechadas) y [testing/](testing/index.md) (informes de pruebas). Los dos informes generados `aceptacion/ultimo-informe.md` y `balance/` se quedan donde están porque los escriben scripts y la CI.
- **Estado, límites y qué entra en cada versión:** [roadmap/](roadmap/index.md); la clasificación de V1 está en [roadmap/v1-roadmap.md](roadmap/v1-roadmap.md).

## Reglas de lectura

- Si un documento de evidencia contradice a uno canónico, manda el canónico. Si un canónico contradice al código, el error está en el documento: [cómo corregirlo](development/workflow.md).
- Las tablas de **Verificación** sin nota de re-auditoría 2026-11 indican la verificación original de octubre, no el estado actual. El estado actual está sólo en [roadmap/current-status.md](roadmap/current-status.md).
- **Alcance de la verificación:** documentación técnica parcialmente re-verificada. La guía del jugador (`user/`), el roadmap y las operaciones principales se contrastaron con `main` en noviembre; los documentos de `technical/` que no llevan nota de re-auditoría conservan la verificación de octubre (arquitectura, flujo de datos, servicios, WebSocket, frontend, versionado de bots, cola y workers). El 2026-11-20 se recontrastaron con `main` `80f4952` `api.md`, `engine.md`, `equipment.md`, `database.md`, `tournaments.md`, `battles.md` y `websocket.md`.
- Fuera de esta estructura quedan [recuperacion.md](recuperacion.md) (histórico; lo vigila un test), `aceptacion/ultimo-informe.md` y `balance/` (generados).
- Hay rutas `docs/…` ya inexistentes citadas en comentarios de código y en ficheros compose; son anteriores a esta reorganización y quedan fuera de su alcance.
- El repositorio es público: ejemplos con rangos de documentación (192.0.2.x, 198.51.100.x, 203.0.113.x) y `example.internal`. Convenciones: [development/conventions.md](development/conventions.md).
