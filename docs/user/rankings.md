# Clasificaciones (ranking)

## Resumen

**«Ranking»** (`#/ranking`) es una página pública, sin cuenta, con la clasificación por modo de juego: posición, bot, rating y victorias-derrotas-empates. El rating sigue el sistema Elo (1000 de partida) y **sólo lo mueven las batallas de torneo**; las de práctica no cuentan.

La página muestra la **temporada activa** (hoy `season-1`), la misma en la que se guardan los resultados de los torneos ([TD-029](../roadmap/technical-debt.md#td-029), corregido). Si sale «Todavía no hay clasificación para este modo.», es que aún no se ha jugado ningún torneo en ese modo. Detalle técnico en [tournaments.md](../technical/tournaments.md#clasificación-y-rating).

## Índice

- [Uso](#uso)
- [Cómo se calcula](#cómo-se-calcula)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Uso

1. Abre «Ranking», desde la barra o directamente en `#/ranking`.
2. Elige el **modo**: `deathmatch`, `team_deathmatch`, `capture_the_flag` o `zone_control`.
3. Columnas: **#**, **Bot**, **Rating**, **V-D-E**.

## Cómo se calcula

- Cada batalla oficial de torneo actualiza el rating Elo de los bots participantes.
- Al terminar cada batalla se recalcula la clasificación de la temporada del torneo.
- La página se actualiza como mucho cada minuto.

## Errores / limitaciones

- Tras un torneo, la clasificación puede tardar hasta un minuto en verse (caché).
- **PENDIENTE**:
  - clasificación de un torneo concreto;
  - clasificación por equipos (existe en la plataforma sin pantalla);
  - historial del rating de un bot;
  - elegir temporada.

## Estado actual

**FUNCIONA ACTUALMENTE** la lectura de la temporada correcta. Sólo hay datos cuando se juegan torneos: las batallas de práctica no cuentan para el rating.

## Documentación relacionada

- Usuario: [Torneos](tournaments.md), [Estadísticas](statistics.md)
- Técnica: [tournaments.md — clasificación](../technical/tournaments.md#clasificación-y-rating), [ADR-E9-002](../adr/ADR-E9-002-rating-elo.md)
