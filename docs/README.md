# Documentación de S9 AI Arena

## Resumen

Esta es la entrada a toda la documentación del proyecto. Está dividida en dos bloques que no se
mezclan:

- **Documentación canónica.** Explica cómo funciona S9 AI Arena **hoy**. La forman visión
  general, usuario, técnica, operaciones, desarrollo y roadmap.
- **Evidencia.** Explica **cómo se llegó hasta aquí**. La forman auditorías, informes de pruebas,
  decisiones (ADR) e histórico. Sirve para entender el pasado, no para operar ni para usar el
  producto.

Si un documento de evidencia contradice a uno canónico, manda el canónico. Si un documento canónico
contradice al código, el error está en el documento: [cómo corregirlo](development/workflow.md).

Estado verificado: `27f70bb`, 2026-10-15.

## Índice

- [Por dónde empezar](#por-dónde-empezar)
- [Preguntas frecuentes y dónde se responden](#preguntas-frecuentes-y-dónde-se-responden)
- [Documentación canónica](#documentación-canónica)
- [Evidencia e histórico](#evidencia-e-histórico)
- [Cómo está escrita esta documentación](#cómo-está-escrita-esta-documentación)

## Por dónde empezar

| Si eres… | Empieza por |
|---|---|
| alguien que quiere saber qué es esto | [overview/project.md](overview/project.md) y después [overview/architecture.md](overview/architecture.md) |
| usuario de la web | [user/getting-started.md](user/getting-started.md) |
| quien escribe bots | [user/bots.md](user/bots.md) y [technical/bots.md](technical/bots.md) |
| administrador u operador | [operations/index.md](operations/index.md) |
| desarrollador nuevo | [development/workflow.md](development/workflow.md) |
| quien decide prioridades | [roadmap/current-status.md](roadmap/current-status.md) |

## Preguntas frecuentes y dónde se responden

| Pregunta | Documento |
|---|---|
| ¿Qué es S9 AI Arena y qué no es? | [overview/project.md](overview/project.md) |
| ¿Qué tecnologías usa y para qué? | [overview/technologies.md](overview/technologies.md) |
| ¿Qué servicios existen y cómo se comunican? | [technical/services.md](technical/services.md), [technical/data-flow.md](technical/data-flow.md) |
| ¿Qué servicio crea una batalla, quién la ejecuta y dónde se guarda el resultado? | [technical/battles.md](technical/battles.md) |
| ¿Cómo se genera un replay? | [technical/replays.md](technical/replays.md) |
| ¿Cómo se compila un bot? | [technical/bots.md](technical/bots.md) |
| ¿Dónde se guardan los mapas? | [technical/maps.md](technical/maps.md) |
| ¿Qué guarda PostgreSQL? ¿Para qué está Redis? | [technical/database.md](technical/database.md), [technical/queue.md](technical/queue.md) |
| ¿Qué modos de juego hay? | [user/game-modes.md](user/game-modes.md), [technical/game-modes.md](technical/game-modes.md) |
| ¿Qué hace cada módulo de equipamiento? | [user/equipment.md](user/equipment.md), [technical/equipment.md](technical/equipment.md) |
| ¿Cómo se instala? | [operations/installation.md](operations/installation.md) |
| ¿Cómo funciona Docker en este proyecto? | [operations/docker.md](operations/docker.md) |
| ¿Cómo se hace backup y restore? | [operations/backup.md](operations/backup.md), [operations/restore.md](operations/restore.md) |
| ¿Cómo arranco el proyecto para desarrollar? ¿Cómo ejecuto los tests? | [development/setup.md](development/setup.md), [development/testing.md](development/testing.md) |
| ¿Cómo hago un cambio y un PR? | [development/workflow.md](development/workflow.md) |
| ¿Qué está roto ahora mismo? | [roadmap/known-issues.md](roadmap/known-issues.md), [roadmap/technical-debt.md](roadmap/technical-debt.md) |
| ¿Qué viene después? | [roadmap/current-status.md](roadmap/current-status.md#next-priorities), [roadmap/pending-features.md](roadmap/pending-features.md) |

## Documentación canónica

### Visión general — [overview/](overview/index.md)

Qué es el proyecto, para quién y por qué existe. Incluye la arquitectura real de los 12 servicios en
una página, las tecnologías con el papel de cada una dentro de S9 y un glosario de los términos
internos (bot, versión, artefacto, ruleset, loadout, replay, runtime drift…). Es la lectura
recomendada antes de cualquier otra.

### Usuario — [user/](user/index.md)

Cómo usar la web paso a paso: crear la cuenta, escribir y versionar un bot, equiparlo, formar
equipos, crear mapas, lanzar batallas, organizar torneos, ver el directo y los replays, y consultar
clasificaciones y estadísticas. Cada capítulo distingue lo que **funciona actualmente**, lo
**parcial** y lo **pendiente**, y no oculta que hoy el flujo se corta en la publicación del bot.

### Técnica — [technical/](technical/index.md)

Cómo está construido el sistema por dentro. Explica la API, el motor, el ciclo de batalla, el
pipeline de bots, el equipamiento, los mapas, los torneos, los replays, el WebSocket, el frontend,
la base de datos, la cola, los workers, el gateway y la seguridad. Cada documento termina con una
tabla de verificación que indica la línea de código de la que sale cada afirmación.

### Operaciones — [operations/](operations/index.md)

Cómo instalar el stack desde una máquina nueva y cómo administrarlo después: configuración, Docker,
red, copias, restauración, readiness, diagnóstico, actualizaciones, apagado y resolución de
problemas. Los comandos peligrosos van en bloques **DANGER / PRECONDITION / EFFECT / ROLLBACK**.

### Desarrollo — [development/](development/index.md)

Cómo trabajar en el código: preparar el entorno, entender el monorepo, el flujo completo de un
cambio (rama, tests, controles negativos, documentación, PR, CI, review y merge), la CI, las
releases y las convenciones. Responde a «soy nuevo, ¿cómo hago un cambio correctamente?».

### Estado y roadmap — [roadmap/](roadmap/index.md)

La **única fuente** del estado del proyecto ([current-status.md](roadmap/current-status.md)), la
deuda técnica confirmada con id `TD-xxx` ([technical-debt.md](roadmap/technical-debt.md)), los
síntomas que verán usuarios y operadores ([known-issues.md](roadmap/known-issues.md)) y lo diseñado
o previsto que aún no existe ([pending-features.md](roadmap/pending-features.md)).

## Evidencia e histórico

Nada de esta sección describe cómo funciona el sistema hoy.

| Carpeta | Contenido |
|---|---|
| [audits/](audits/README.md) | Auditorías del proyecto: la del 2026-10-15 (resumen público y delta), las anteriores y el informe de esta consolidación documental. |
| [testing/](testing/index.md) | Informes de pruebas: drills de backup, game days, checklists de validación, spikes, smoke y bloqueos de regresión del motor. |
| [adr/](adr/index.md) | Decisiones de arquitectura con su contexto y fecha. Los documentos canónicos enlazan el ADR que justifica cada comportamiento, pero no dependen de él. |
| [history/](history/index.md) | Estados antiguos, entregas del dosier E1-E12, rondas, programas, diseños previos y runbooks retirados. |

Qué pasó con cada documento antiguo y dónde está ahora: [DOC-MIGRATION-MAP.md](DOC-MIGRATION-MAP.md).

Algunos ficheros siguen fuera de esta estructura porque el código los lee o los genera:
[recuperacion.md](recuperacion.md) (histórico; lo vigila un test), `aceptacion/ultimo-informe.md`
y `balance/` (generados).

## Cómo está escrita esta documentación

- Español, con la estructura común: Resumen, Índice, Qué es, Cómo funciona, Uso, Ejemplo,
  Errores / limitaciones, Estado actual y Documentación relacionada. Los documentos técnicos añaden
  arquitectura, contratos, persistencia, configuración, seguridad y tests cuando aplica.
- Cada afirmación verificada se marca **CODE_VERIFIED**, **RUNTIME_VERIFIED** o **DESIGN_ONLY**.
  Lo DESIGN_ONLY nunca se presenta como comportamiento existente.
- El repositorio es público: no hay direcciones, nombres de máquinas ni secretos reales. Los
  ejemplos usan rangos de documentación (192.0.2.x, 198.51.100.x, 203.0.113.x) y `example.internal`.
- Convenciones completas: [development/conventions.md](development/conventions.md).
