# Ranking

El **Ranking** (menú «Ranking») es una página pública —se ve sin cuenta— con la clasificación de cada modo de juego: posición, bot, **rating** y **V-D-E** (victorias, derrotas y empates). Es de sólo lectura. Se actualiza solo al terminar las batallas de torneo (la página puede tardar hasta un minuto en reflejarlo).

## Qué cuenta y qué no

- **Sólo cuentan las batallas oficiales de torneo.** Las que creas con «Nueva batalla» son de práctica y **no cambian nada** en el ranking.
- **Cada modo tiene su propio ranking**, y cada temporada el suyo: un bot tiene un rating distinto en Deathmatch, Deathmatch por equipos, Captura la bandera y Control de zona.
- Una batalla de captura de bandera **detenida por el límite técnico** de la prórroga no tiene resultado deportivo: no cuenta ni para el rating ni para V-D-E.
- Si una batalla se anula a posteriori, su efecto en el rating se **revierte** y deja de contar también en V-D-E y en la posición.
- **Inscribirse en un torneo no te hace aparecer** en la clasificación: hace falta haber disputado al menos un enfrentamiento oficial. Un torneo sin batallas jugadas no añade a nadie (nunca verás a un bot con 0-0-0 sólo por estar inscrito) y un torneo en borrador no aporta nada.
- **Un torneo en marcha ya cuenta**: la clasificación refleja lo que se ha disputado hasta ahora, sin esperar a que termine.
- **Un torneo cancelado conserva lo ya jugado**: cancelarlo no borra los resultados, salvo las batallas que se hayan anulado.

## Las columnas

### Rating

Es un **Elo** (como en el ajedrez). Todos los bots **empiezan con 1000**. Después de cada batalla oficial:

- ganar a un rival con **más rating** que tú sube más que ganar a uno con menos;
- perder resta exactamente lo que gana el rival: **la suma de todos los cambios de una batalla es cero**;
- un empate cuenta como medio punto para cada uno;
- para el rating, **una descalificación cuenta como derrota**.

En las batallas por equipos, el cambio se reparte por parejas de bots rivales, así que la suma sigue siendo cero. Cada torneo puede fijar su propia sensibilidad (el factor K); por defecto, 24.

### V-D-E

Victorias, derrotas y empates, contados por **enfrentamientos de los torneos** (no por batallas sueltas: un enfrentamiento puede tener varias batallas) y **sumados en todos los torneos de la temporada en ese modo**. Un enfrentamiento terminado sin ganador cuenta como empate; uno detenido por el límite técnico, como si no existiera. **Pasar una ronda sin rival (*bye*) no suma victoria** en esta clasificación, porque no es un enfrentamiento disputado (la tabla interna del propio torneo sí lo cuenta como victoria). Si un enfrentamiento aún está **en juego**, cuenta con lo ya disputado; si va igualado, cuenta como empate hasta que se resuelva.

### La posición (#)

La posición **no se ordena por el rating**, sino por los resultados de los enfrentamientos: **3 puntos por victoria, 1 por empate y 0 por derrota**, sumados en todos los torneos del modo en la temporada (sólo cuentan los que ya tienen algo disputado: ver arriba). Si dos bots empatan a puntos, desempatan por este orden: el resultado de los enfrentamientos directos entre ellos, la diferencia de puntuación acumulada, el orden de inscripción y, por último, el identificador del bot (para que el orden sea siempre el mismo). Por eso un bot con menos rating puede ir por delante de otro si ha ganado más enfrentamientos.

## Cómo leer la página

1. Abre «Ranking».
2. Elige el **modo**: la ayuda `ⓘ` explica cada uno.
3. Mira las columnas **#**, **Bot**, **Rating** y **V-D-E**. Un bot privado que no es tuyo aparece como «Bot privado».

Si aún no se ha jugado ningún torneo en ese modo, verás «Todavía no hay clasificación oficial para este modo.»

## Lo que todavía no hay

- La clasificación de un torneo concreto (sí se ve su cuadro: [Torneos](tournaments.md)).
- Una pantalla de clasificación por equipos, un historial gráfico del rating de cada bot y elegir temporada. El historial de rating de un bot existe en la plataforma pero no tiene pantalla.

## Para quien quiera la fórmula

Para cada pareja de bots rivales (A, B) de una batalla oficial con N parejas cruzadas:

- puntuación esperada de A: `E_A = 1 / (1 + 10^((rating_B − rating_A) / 400))`;
- resultado de la pareja: 1 si A gana, 0,5 si empatan, 0 si pierde;
- cambio de A: `(K / N) · (resultado − E_A)`; el de B es el opuesto.

La idempotencia está garantizada: reprocesar una batalla no aplica el rating dos veces.

Siguiente: [Torneos](tournaments.md) · [Estadísticas](statistics.md).
