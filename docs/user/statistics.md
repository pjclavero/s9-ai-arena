# Estadísticas y diagnóstico

La plataforma mide cada batalla: daño, disparos, aciertos, precisión, derribos, banderas, minas y uso de cada módulo. Las estadísticas de **cada batalla** se ven en su detalle (**«Batallas» → la batalla**), junto con el **diagnóstico de tus bots**. El rating y el V-D-E están en el [Ranking](rankings.md).

## Qué se mide

| Métrica | Dónde se ve |
|---|---|
| Victorias, derrotas y empates por bot | [Ranking](rankings.md) (batallas de torneo) |
| Rating Elo | [Ranking](rankings.md) |
| Daño hecho y recibido, por bot y por módulo | Detalle de la batalla |
| Disparos, aciertos y precisión | Detalle de la batalla |
| Bajas, supervivencia y recorrido | Detalle de la batalla |
| Objetivos (banderas, zonas) | Detalle de la batalla y marcador del visor |
| Uso de cada módulo, rechazos y estado final | Detalle de la batalla |
| Turnos sin respuesta del bot | Detalle de la batalla |
| Tiempo de CPU del bot | Diagnóstico de la batalla; **sólo de tus bots** |
| Ganador de cada enfrentamiento de torneo | Cuadro del torneo |

Las estadísticas reflejan **lo que hizo tu código**: si tu bot nunca dispara, sus disparos salen a 0. Justo al terminar una batalla puede decir «Calculando estadísticas…»: la página vuelve a preguntar sola.

## Diagnóstico de tus bots

En el detalle de una batalla en la que juega uno de **tus** bots aparece su diagnóstico:

- si **arrancó** y completó el saludo;
- cuántas **decisiones** aplicó y cuántos turnos **no respondió a tiempo**;
- si fue **descalificado** y por qué;
- las órdenes recibidas y las **inválidas**, con el primer motivo (por ejemplo, `invalid_command: /move/throttle maximum`: un `throttle` por encima de 1);
- las **acciones que rechazó el motor**, agrupadas por motivo ([Eventos](bots/eventos.md));
- si su proceso terminó antes de tiempo;
- la **CPU** real que gastó (una cota inferior aproximada).

**Sólo lo ves tú** (y el staff). De los bots rivales, aunque sean de tu equipo, ves la batalla y sus estadísticas, pero no su diagnóstico ni su CPU.

Es la herramienta para saber **por qué** tu bot hizo lo que hizo: si dispara pero no acierta, si pierde decisiones por ser lento, si da órdenes mal formadas.

## Lo que todavía no hay

- Una ficha de bot con su historial de batallas y de rating.
- Estadísticas agregadas por mapa o por modo.
- Gráficas.

Siguiente: [Ranking](rankings.md) · [Batallas](battles.md) · [Replays](replays.md).
