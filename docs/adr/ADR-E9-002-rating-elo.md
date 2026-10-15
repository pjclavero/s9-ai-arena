# ADR-E9-002 · Rating: Elo con K por liga, frente a Glicko-2

**Estado:** aceptada (2026-07-16) · **Ámbito:** E9/T9.3 (cap. 19, 20.3)

## Contexto

Hace falta un rating por batalla oficial, separado por temporada y modo, con
standings materializados (E7/T7.5) e historial reconstruible por bot-versión.
Candidatos: Elo clásico y Glicko-2.

## Decisión

**Elo clásico con K configurable por liga** (`tournaments.elo_k`, por defecto
24), implementado tras la interfaz `RatingSystem` (`ratings.ts`):

```ts
interface RatingSystem { name: string; deltas(sides, k): Map<botId, delta> }
```

- Todo el pipeline (aplicación idempotente, reversión, standings, historial)
  habla con la interfaz, no con Elo: cambiar a Glicko-2 es implementar otro
  `RatingSystem` y una migración de datos, sin tocar el worker.
- En batallas por equipos los deltas se calculan por PAREJAS cruzadas con
  k' = k / nº de parejas: cada intercambio es simétrico y la suma global de
  Elo se CONSERVA exactamente (propiedad testeada; también con Elo clásico
  1v1, del que es la generalización directa).
- Libro mayor `rating_events` (before/delta/after por bot-versión):
  idempotencia por battle_id, reversión de batallas anuladas y `ratingAt()`
  para reconstruir el rating en cualquier fecha.

## Por qué no Glicko-2 (hoy)

- Glicko-2 modela además desviación (RD) y volatilidad: mejor para pools
  humanos con actividad irregular, pero los bots juegan calendarios densos y
  regulares donde la ventaja práctica es pequeña.
- Es sensiblemente más complejo de auditar a mano (el dosier pide auditoría
  pública de resultados; con Elo cualquiera recalcula un delta con una fórmula
  de una línea).
- Requiere periodos de calificación (rating periods) que encajan mal con la
  actualización por batalla exigida por el 19.1.

## Consecuencias

- La incertidumbre inicial se gestiona de forma simple (rating inicial 1000 y
  K por liga); si una liga necesita convergencia rápida, sube su K.
- Si la Fase 10 (IA generadora) trae pools masivos e irregulares, revisar esta
  ADR con datos del libro mayor (que ya guarda todo lo necesario para
  re-simular ratings con otro sistema).
