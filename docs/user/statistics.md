# Estadísticas

## Resumen

La plataforma calcula muchas estadísticas de cada batalla: daño, disparos, aciertos, precisión, derribos, banderas, minas y uso de cada módulo. También calcula el rating y su historial. Pero **la web sólo muestra el ranking** ([Clasificaciones](rankings.md)): no hay ninguna pantalla de estadísticas de batalla, de bot ni de mapa, ni gráficas. Las estadísticas sólo se pueden consultar por la API.

## Índice

- [Qué se calcula](#qué-se-calcula)
- [Dónde verlo](#dónde-verlo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Qué se calcula

| Métrica | Se calcula | Visible en la web |
|---|---|---|
| Victorias, derrotas y empates por bot | Sí | Sí, en «Ranking» (hoy vacío) |
| Rating Elo | Sí | Sí, en «Ranking» (hoy vacío) |
| Historial de rating | Sí | **No** |
| Daño hecho y recibido, por bot, equipo y módulo | Sí | **No** |
| Disparos, aciertos, precisión | Sí | **No** |
| Derribos, supervivencia | Sí | **No** |
| Banderas tomadas y capturadas | Sí | Sólo en el marcador del visor (que hoy no se dibuja) |
| Minas puestas y activadas | Sí | **No** |
| Turnos sin respuesta del bot | Sí | **No** |
| Tiempo de CPU del bot | Sí: CPU real del contenedor de tu bot (aprox., cota inferior) | **No** |
| Clasificación por equipos de un torneo | Sí (formato `teams`) | **No** |
| Ganador de cada enfrentamiento de torneo | Sí | Sí, en el cuadro |

Las estadísticas reflejan **lo que hizo tu código**: si tu bot nunca dispara, sus disparos salen a 0 (comprobado con dos bots de comportamiento distinto en un entorno de pruebas, [TD-002](../roadmap/technical-debt.md#td-002)). El historial de rating de un bot privado sólo lo ves tú (o tu equipo).

## Dónde verlo

- **Web**: «Ranking» y el cuadro de cada torneo.
- **API** (para quien programe contra la plataforma):
  - `GET /api/v1/battles/{id}/stats`;
  - `GET /api/v1/bots/{id}/rating-history`;
  - `GET /api/v1/tournaments/{id}/team-standings`.

  Ver [api.md](../technical/api.md#recursos-por-área).

## Errores / limitaciones

**PENDIENTE**:

- ficha de batalla con ganador, marcador y estadísticas;
- ficha de bot con historial;
- estadísticas por mapa o por modo;
- gráficas.

## Estado actual

**PARCIAL**: los datos existen; casi ninguno tiene pantalla.

## Documentación relacionada

- Usuario: [Clasificaciones](rankings.md), [Batallas](battles.md), [Replays](replays.md)
- Técnica: [battles.md — estadísticas](../technical/battles.md#8-cierre-exactamente-una-vez-finishbattle), [replays.md](../technical/replays.md)
