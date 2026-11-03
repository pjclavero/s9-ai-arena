# Roadmap — índice

## Resumen

Esta carpeta responde a cuatro preguntas, cada una en un documento distinto:

| Pregunta | Documento | Para quién |
|---|---|---|
| ¿En qué estado está el proyecto hoy? | [current-status.md](current-status.md) | todo el mundo. Es la **fuente única de estado** |
| ¿Qué está mal y cómo se sabe? | [technical-debt.md](technical-debt.md) | quien desarrolla y quien prioriza. Ids `TD-XXX` estables |
| ¿Qué notará el usuario o el operador? | [known-issues.md](known-issues.md) | soporte, operación y usuarios |
| ¿Qué falta por construir? | [pending-features.md](pending-features.md) | quien planifica. Solo lo que no está hecho: parcial, pendiente o descartado |
| ¿Cómo se comprobó cada elemento pendiente? | [../audits/2026-11/PENDING-AUDIT.md](../audits/2026-11/PENDING-AUDIT.md) | quien audita |
| ¿Qué se completó y ya no es pendiente? | [../history/status/completadas-2026-11.md](../history/status/completadas-2026-11.md) | historial |

## Cómo se usa

- **Para saber si algo funciona**, empieza por `current-status.md`. Cada fila enlaza a su deuda.
- **Para trabajar en un defecto**, abre su `TD-XXX`. La «condición de cierre» dice qué prueba hace falta para darlo por cerrado.
- **Para planificar**, separa lo roto (deuda) de lo que no existe (pendiente). Una función pendiente no se empieza si depende de una deuda P0 abierta.

## Mantenimiento

- Un TD sólo se crea con evidencia: código en una ruta:línea, runtime medido o test.
- Un TD se cierra cuando se cumple su condición de cierre, no cuando se mergea el PR.
- `current-status.md` solo contiene el estado de hoy (`MAIN_SHA`, fecha de revisión, código, despliegue, P0/P1/P2, funciones y bloqueos). Cuando una versión deja de ser la actual, el documento anterior se archiva en [../history/status/](../history/index.md#status), no se acumula aquí.
- Una función completada sale de `pending-features.md` y se anota en el historial con el PR y la evidencia.
- Lo que se afirma como estado lleva evidencia `fichero:línea` o un test; una afirmación sin evidencia se marca como «reportado».
- La auditoría que dio origen a este estado: [docs/audits/2026-10-15/](../audits/2026-10-15/README.md).

## Documentación relacionada

- [Visión general](../overview/index.md) · [Documentación técnica](../technical/index.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Los cuatro documentos existen y se enlazan entre sí | CODE_VERIFIED | `docs/roadmap/*.md` |
| Los documentos vigentes no citan un SHA ni un RC antiguo como estado actual; los pendientes no incluyen funciones completadas | CODE_VERIFIED | `tests/acceptance/doc-b-roadmap-docs.test.ts` |
