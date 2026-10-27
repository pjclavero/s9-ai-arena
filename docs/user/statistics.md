# Estadísticas

## Resumen

La plataforma calcula muchas estadísticas de cada batalla: daño, disparos, aciertos, precisión, derribos, banderas, minas y uso de cada módulo. También calcula el rating y su historial.

En la web, las estadísticas de **cada batalla** se ven en su detalle (**«Batallas» → la batalla**, dirección `#/battles/<id>`), junto con el **diagnóstico de tus bots**. El ranking está en [Clasificaciones](rankings.md). No hay pantalla de estadísticas por bot ni por mapa, ni gráficas.

## Índice

- [Qué se calcula](#qué-se-calcula)
- [Dónde verlo](#dónde-verlo)
- [Diagnóstico de tus bots](#diagnóstico-de-tus-bots)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Qué se calcula

| Métrica | Se calcula | Visible en la web |
|---|---|---|
| Victorias, derrotas y empates por bot | Sí | Sí, en «Ranking» (hoy vacío) |
| Rating Elo | Sí | Sí, en «Ranking» (hoy vacío) |
| Historial de rating | Sí | **No** |
| Daño hecho y recibido, por bot y por módulo | Sí | Sí, en el detalle de la batalla |
| Disparos, aciertos, precisión | Sí | Sí, en el detalle de la batalla |
| Bajas, supervivencia, recorrido | Sí | Sí, en el detalle de la batalla |
| Objetivos (banderas, zonas) | Sí | Sí, en el detalle de la batalla y en el marcador del visor |
| Uso de cada módulo, rechazos y estado final | Sí | Sí, en el detalle de la batalla |
| Turnos sin respuesta del bot | Sí | Sí, en el detalle de la batalla |
| Tiempo de CPU del bot | Sí: CPU real del contenedor de tu bot (aprox., cota inferior) | **Sólo de tus bots**, en su diagnóstico |
| Clasificación por equipos de un torneo | Sí (formato `teams`) | **No** |
| Ganador de cada enfrentamiento de torneo | Sí | Sí, en el cuadro |

Las estadísticas reflejan **lo que hizo tu código**: si tu bot nunca dispara, sus disparos salen a 0 (comprobado con dos bots de comportamiento distinto en un entorno de pruebas, [TD-002](../roadmap/technical-debt.md#td-002)). El historial de rating de un bot privado sólo lo ves tú (o tu equipo).

## Dónde verlo

- **Web**:
  - el detalle de cada batalla (`#/battles/<id>`): resultado, estadísticas por bot y el diagnóstico de tus bots. Justo al terminar puede decir «Calculando estadísticas…»: la página vuelve a preguntar sola;
  - «Ranking» y el cuadro de cada torneo.
- **API** (para quien programe contra la plataforma):
  - `GET /api/v1/battles/{id}/stats`;
  - `GET /api/v1/bots/{id}/rating-history`;
  - `GET /api/v1/tournaments/{id}/team-standings`.

  Ver [api.md](../technical/api.md#recursos-por-área).

## Diagnóstico de tus bots

En el detalle de una batalla en la que juega uno de **tus** bots aparece su diagnóstico: si arrancó y completó el saludo (HELLO), cuántas decisiones aplicó, los turnos que no respondió a tiempo, si fue descalificado y por qué, los COMMAND recibidos y los inválidos (con el primer motivo, p. ej. `invalid_command: /move/throttle maximum`), las acciones que rechazó el motor por motivo, si su contenedor terminó antes de tiempo y la CPU.

**Sólo lo ves tú** (y el staff de la plataforma). De los bots rivales, aunque sean de tu equipo, ves la batalla y sus estadísticas, pero no su diagnóstico ni su CPU.

## Errores / limitaciones

**PENDIENTE**:

- ficha de bot con historial;
- estadísticas por mapa o por modo;
- gráficas.

## Estado actual

**FUNCIONA ACTUALMENTE** en el código: estadísticas y diagnóstico por batalla en la web. **PENDIENTE**: historial por bot, estadísticas por mapa o modo y gráficas.

## Documentación relacionada

- Usuario: [Clasificaciones](rankings.md), [Batallas](battles.md), [Replays](replays.md)
- Técnica: [battles.md — estadísticas](../technical/battles.md#8-cierre-exactamente-una-vez-finishbattle), [replays.md](../technical/replays.md)
