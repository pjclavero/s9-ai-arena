# Auditorías

## Resumen

Esta carpeta guarda las auditorías del proyecto como **evidencia histórica**. No es documentación de
uso. Una auditoría dice lo que se encontró en una fecha concreta. Lo que funciona hoy está en la
[documentación canónica](../README.md#documentación-canónica). El estado vigente está en
[roadmap/current-status.md](../roadmap/current-status.md).

Los informes de auditoría no se reescriben después de publicarse. Los cambios posteriores se
registran en un **delta** aparte.

## Índice

- [Auditoría de desarrollador externo del 2026-10-27](#auditoría-de-desarrollador-externo-del-2026-10-27)
- [Auditoría del 2026-10-15](#auditoría-del-2026-10-15)
- [Consolidación documental de 2026-10](#consolidación-documental-de-2026-10)
- [Auditorías anteriores](#auditorías-anteriores)
- [Qué no está en el repositorio](#qué-no-está-en-el-repositorio)

## Auditoría de desarrollador externo del 2026-10-27

Auditoría sobre `35a4fb9`, con producción en RC4 (`f32ab2c`). Pregunta: ¿puede una persona externa,
o una IA externa con credenciales normales, completar el ciclo de un bot sin ayuda interna?
Trabajaron cinco auditores y un REVIEW que reprodujo los puntos clave. Veredicto: el producto
funciona en producción (PRODUCTION_CORE = PASS), pero **EXTERNAL_USER_READY = NO** y
**AI_AGENT_READY = NO**, por descubrimiento, documentación y señales de depuración. Incluye
matriz de gaps, propuesta de manual de bots y perfil de RAM.

- [2026-10-27/EXTERNAL-DEVELOPER-AUDIT.md](2026-10-27/EXTERNAL-DEVELOPER-AUDIT.md)

## Auditoría del 2026-10-15

Auditoría profunda en dos pasadas sobre `27f70bb`. Tres auditores trabajaron en paralelo
(código y runtime, producto y navegador real, documentación y operación), y un supervisor cruzó sus
resultados e intentó falsarlos. Veredicto: el producto **no es funcional de extremo a extremo**.
Tiene ocho bloqueos de prioridad máxima, entre ellos el build de bots, la ejecución con código de
usuario y la creación de batallas desde la web.

- [2026-10-15/README.md](2026-10-15/README.md): resumen público del método, el veredicto, los
  hallazgos por área y cómo se calcularon los porcentajes.
- [2026-10-15/AUDIT-DELTA-2026-10.md](2026-10-15/AUDIT-DELTA-2026-10.md): estado de cada hallazgo
  después de la auditoría (CLOSED, IMPROVED, UNCHANGED, REGRESSED, SUPERSEDED, UNKNOWN). Incluye los
  hallazgos nuevos y las correcciones a la propia auditoría.

## Consolidación documental de 2026-10

Reorganización de toda la documentación en la estructura canónica actual, tomando la auditoría
como base.

- [DOCUMENTATION-CONSOLIDATION-REPORT.md](DOCUMENTATION-CONSOLIDATION-REPORT.md): qué cambió,
  recuentos, coherencia código ↔ documentación y huecos pendientes.
- [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md): destino de cada documento anterior.

## Auditorías anteriores

Auditorías de julio de 2026 y la auditoría visual R16. Describen un estado del proyecto ya superado.

→ [anteriores/index.md](anteriores/index.md)

## Qué no está en el repositorio

El repositorio es público. La evidencia completa de la auditoría del 2026-10-15 es **interna** y no
se publica: informes de cada pasada, salidas de comandos sobre el despliegue real, capturas de
navegador y detalle de las vulnerabilidades abiertas. En el repositorio solo hay resúmenes sin
topología y sin recetas de explotación.

## Documentación relacionada

- Estado actual: [../roadmap/current-status.md](../roadmap/current-status.md)
- Deuda técnica: [../roadmap/technical-debt.md](../roadmap/technical-debt.md)
- Informes de pruebas: [../testing/index.md](../testing/index.md)
- Histórico: [../history/index.md](../history/index.md)
