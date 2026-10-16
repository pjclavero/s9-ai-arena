# Roadmap — índice

## Resumen

Esta carpeta responde a cuatro preguntas, cada una en un documento distinto:

| Pregunta | Documento | Para quién |
|---|---|---|
| ¿En qué estado está el proyecto hoy? | [current-status.md](current-status.md) | todo el mundo. Es la **fuente única de estado** |
| ¿Qué está mal y cómo se sabe? | [technical-debt.md](technical-debt.md) | quien desarrolla y quien prioriza. Ids `TD-XXX` estables |
| ¿Qué notará el usuario o el operador? | [known-issues.md](known-issues.md) | soporte, operación y usuarios |
| ¿Qué falta por construir? | [pending-features.md](pending-features.md) | quien planifica |

## Cómo se usa

- **Para saber si algo funciona**, empieza por `current-status.md`. Cada fila enlaza a su deuda.
- **Para trabajar en un defecto**, abre su `TD-XXX`. La «condición de cierre» dice qué prueba hace falta para darlo por cerrado.
- **Para planificar**, separa lo roto (deuda) de lo que no existe (pendiente). Una función pendiente no se empieza si depende de una deuda P0 abierta.

## Mantenimiento

- Un TD sólo se crea con evidencia: código en una ruta:línea, runtime medido o test.
- Un TD se cierra cuando se cumple su condición de cierre, no cuando se mergea el PR.
- `current-status.md` se actualiza con cada verificación, junto con su `LAST VERIFIED`.
- La auditoría que dio origen a este estado: [docs/audits/2026-10-15/](../audits/2026-10-15/README.md).

## Documentación relacionada

- [Visión general](../overview/index.md) · [Documentación técnica](../technical/index.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Los cuatro documentos existen y se enlazan entre sí | CODE_VERIFIED | `docs/roadmap/*.md` |
