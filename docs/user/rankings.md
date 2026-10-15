# Clasificaciones (ranking)

## Resumen

**«Ranking»** (`#/ranking`) es una página pública, sin cuenta, con la clasificación por modo de juego: posición, bot, rating y victorias-derrotas-empates. El rating sigue el sistema Elo (1000 de partida) y **sólo lo mueven las batallas de torneo**; las de práctica no cuentan.

**Hoy la página sale vacía**, con el mensaje «Todavía no hay clasificación para este modo.», incluso después de jugar torneos. La página pide una temporada distinta de aquella en la que se guardan los resultados. Es un hallazgo de esta documentación y su deuda está pendiente de id (ver [tournaments.md](../technical/tournaments.md#clasificación-y-rating)).

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

- **Sale vacía**: siempre, hoy (ver Resumen). Antes se atribuía sólo a la caché de un minuto.
- **PENDIENTE**:
  - clasificación de un torneo concreto;
  - clasificación por equipos (existe en la plataforma sin pantalla);
  - historial del rating de un bot;
  - elegir temporada.

## Estado actual

**PARCIAL**: la página funciona; los datos no llegan.

## Documentación relacionada

- Usuario: [Torneos](tournaments.md), [Estadísticas](statistics.md)
- Técnica: [tournaments.md — clasificación](../technical/tournaments.md#clasificación-y-rating), [ADR-E9-002](../adr/ADR-E9-002-rating-elo.md)
