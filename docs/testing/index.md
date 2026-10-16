# Evidencias de pruebas (histórico)

## Resumen

Informes de pruebas, simulacros (drills), checklists de validación, smokes y spikes del proyecto,
reunidos aquí en la consolidación de 2026-10. **No es documentación vigente**: cada documento
describe lo que se probó en su fecha, contra el commit que indica, y puede citar rutas, nombres o
procedimientos que ya no existen. Cómo se prueba hoy: [../development/testing.md](../development/testing.md).

## Contenido

| Carpeta / fichero | Qué es | Origen | Lo vigente está en |
|---|---|---|---|
| [drills/gamedays/README.md](drills/gamedays/README.md) | guiones de game days (pruebas de caos) por hito | `docs/gamedays/` | automatizados en `tests/gamedays/gameday-m3.test.ts`; [../development/testing.md](../development/testing.md) |
| [drills/gamedays/acta-2026-07-16-m3.md](drills/gamedays/acta-2026-07-16-m3.md) | acta del game day del hito M3 | `docs/gamedays/` | — |
| [drills/backup-evidencia.md](drills/backup-evidencia.md) | diseño y evidencia del recolector `evidence.sh` (Carril E) | `docs/ops/` | [../operations/backup.md](../operations/backup.md) |
| [acceptance/acceptance-visual.md](acceptance/acceptance-visual.md) | aceptación visual con Playwright (R-DEPLOY R3) | `docs/ops/` | [../development/testing.md](../development/testing.md) |
| [smoke/batalla-smoke-containerizada.md](smoke/batalla-smoke-containerizada.md) | primer circuito real bot → contenedor → motor → replay (R6.2) | `docs/ops/` | [../technical/battles.md](../technical/battles.md) |
| [engine/ENGINE_REGRESSION_LOCKS.md](engine/ENGINE_REGRESSION_LOCKS.md) | candados de regresión del motor (R13.0) — cita un `regression-locks.test.ts` que **nunca existió**; los tests reales son `*-regression.test.ts` | `docs/` | [../development/testing.md](../development/testing.md), [../technical/engine.md](../technical/engine.md) |
| [spikes/R13_5_SLICE2_SPIKE.md](spikes/R13_5_SLICE2_SPIKE.md) | spike: snapshot nativo de Rapier frente a resimulación | `docs/` | [../technical/engine.md](../technical/engine.md) |
| [validacion/CHECKLIST_VALIDACION_V2.md](validacion/CHECKLIST_VALIDACION_V2.md) | checklist de validación del despliegue v2 (topología enmascarada) | `docs/` | [../operations/installation.md](../operations/installation.md) |
| [validacion/CHECKLIST_VALIDACION_V4.md](validacion/CHECKLIST_VALIDACION_V4.md) | checklist de las foundations R10/R11/R12 | `docs/` | — |
| [validacion/CHECKLIST_VALIDACION_V5.md](validacion/CHECKLIST_VALIDACION_V5.md) | checklist R13/R14/R16 + regression locks | `docs/` | — |

Otras evidencias que **no** se movieron porque el código las genera en su ruta:
[../aceptacion/ultimo-informe.md](../aceptacion/ultimo-informe.md) (lo escribe
`acceptance/run-acceptance.mjs`) y [../balance/informe-v1.md](../balance/informe-v1.md) (lo escribe
`packages/module-catalog/balance/run.ts`). Los informes de CI y tests de la Ronda 2 están en
[../history/rondas/ronda2/](../history/index.md#rondas).

## Advertencias

- Las direcciones, identificadores de máquina y nombres de host de estos documentos se han
  sustituido por marcadores (`192.0.2.x`, `<host-arena>`, `<proxy-host>`, …).
- Ninguna cifra de verde/rojo de aquí describe el estado actual de la CI ([../development/ci.md](../development/ci.md)).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Origen de cada fichero | CODE_VERIFIED | `git log --follow` / [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md) |
| `regression-locks.test.ts` no existe en ninguna rama | CODE_VERIFIED | auditoría 2026-10-15 (`git log --all -- <ruta>` vacío) |
| Generadores de `ultimo-informe.md` e `informe-v1.md` | CODE_VERIFIED | `acceptance/run-acceptance.mjs:90`; `packages/module-catalog/balance/run.ts:217` |
