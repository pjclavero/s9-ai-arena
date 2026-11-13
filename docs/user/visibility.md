# Visibilidad: bot, código y retransmisión

Un bot tiene **dos visibilidades independientes**, y las decides tú:

- la **del bot** (su ficha: nombre, versiones, equipamiento y estadísticas), y
- la **del código** de cada versión.

Participar en un torneo o salir en una retransmisión **no cambia ninguna de las dos**.

## Visibilidad del bot

| Visibilidad | Quién ve la ficha del bot |
|---|---|
| **Privado** (por defecto) | Sólo tú. |
| **Equipo** | Tú y los miembros del equipo del bot. Si el bot no tiene equipo, es como «Privado». |
| **Público** | Cualquier usuario o visitante. |

Se cambia en **Mis bots → el bot → Visibilidad**. Esa tarjeta reúne la visibilidad del bot y la del código de cada versión, y es el único sitio donde se cambian (el resto de la web sólo las muestra). Arriba resume el estado actual, por ejemplo «Bot ● Público · Código v5 ● Privado». Sólo el dueño ve los controles y sólo él puede cambiarlas; ni otros usuarios ni la organización pueden. Cada cambio queda registrado.

**Hacer público el bot NO hace público automáticamente su código**, y hacer público el código de una versión NO hace público el bot.

## Visibilidad del código

Cada versión tiene su propio interruptor: **«Código de vN [Privado][Público]»**, en la misma tarjeta **Visibilidad**: el de la versión publicada más reciente arriba, como acción rápida, y el de las demás en «Código de las demás versiones». Sólo lo ve y lo usa el dueño. La tabla de «Versiones y build» enseña si el código es público o privado, pero no lo cambia.

Desde **Equipos** puedes hacer públicos de una vez los bots del equipo **de los que eres dueño** ([Equipos](teams.md#hacer-públicos-los-bots-que-administras)); su código no cambia salvo que marques la casilla aparte.

| | Bot privado | Bot de equipo | Bot público |
|---|---|---|---|
| **Código privado** | Ficha: sólo tú. Código: sólo tú. | Ficha: tú y tu equipo. Código: tú y tu equipo. | Ficha: todos. Código: tú y tu equipo. |
| **Código público** | Ficha: sólo tú. Como nadie más ve el bot, nadie más llega a su código. | Ficha: tú y tu equipo. Código: tú y tu equipo. | Ficha: todos. Código: cualquiera con cuenta puede leerlo y descargarlo (si la versión está publicada). |

La moderación y la administración de la plataforma pueden ver cualquier bot y cualquier código para supervisar el juego limpio; no pueden cambiar ninguna de las dos visibilidades.

- Publicar una versión **no** hace público su código: la web siempre publica con el código privado.
- Puedes volver a poner en privado un código que hiciste público. A partir de ese momento nadie más puede leerlo ni descargarlo desde la plataforma, pero **quien ya lo descargó conserva su copia**.
- Cambiar el código de privado a público, o al revés, no cambia la versión: sigue igual de publicada, puede seguir jugando y sus replays se siguen viendo.

## Torneos y retransmisión

- **Puedes inscribir un bot privado, de equipo o público** en un torneo. Basta con que la versión esté publicada y sea elegible ([Torneos](tournaments.md)). Inscribirlo no cambia su visibilidad ni la de su código, y cerrar inscripciones tampoco.
- Un torneo puede crearse con **«Retransmisión pública»**. Lo decide el organizador al crearlo y no se cambia después, así que al inscribirte ya sabes si el torneo se va a retransmitir. El torneo lo indica con la etiqueta «retransmisión pública».
- En un torneo con retransmisión pública, sus batallas se pueden ver en directo, en replay, en el cuadro y en la emisión. De cada bot se muestra **sólo lo de la competición**: nombre, versión, equipo o bando, vehículo y equipamiento en el campo, vida, marcador, resultado y estadísticas deportivas. Esto vale también para los bots privados y de equipo.
- **Nunca** se muestra: el código, el nombre de sus ficheros, tus datos de cuenta (correo, nombre de usuario), el diagnóstico ni la CPU de tu bot, ni el historial de tus revisiones de equipamiento.
- La ficha de un bot privado sigue sin existir para los demás aunque el bot salga en una emisión. Su código sigue privado.
- En un torneo **sin** retransmisión pública, y en las batallas de práctica, una batalla en la que participa un bot privado o de equipo sólo la ven sus participantes, su equipo y la organización.

Al inscribir un bot privado en un torneo con retransmisión pública verás: «Este bot es privado. Durante las batallas públicas se mostrarán únicamente sus datos de competición; su código seguirá privado.»

## Por qué una batalla de práctica con un bot privado no se puede emitir

La autorización para mostrar en público a un bot privado la da **el torneo**, porque se anuncia antes de inscribirse. Una batalla de práctica no tiene ese aviso previo, y el dueño de un bot privado no ha aceptado que se vea. Por eso la administración de Streaming la rechaza con el motivo `battle_not_public`. Si quieres emitir una batalla de práctica, sus bots tienen que ser públicos. Si la batalla es de un torneo sin retransmisión pública, el motivo es `tournament_not_broadcastable`.

## Próxima frontera pública OLA 2 (pendiente de integración)

Los PR de OLA 2 añaden una frontera pública única (`projectFrame()`), identificadores públicos por audiencia y la política **EQUIPMENT_PRIVATE**. Cuando el conjunto se integre y pase `ENGINE_HARDENING_READY=PASS`, la emisión/replay público no deberá exponer el loadout completo ni valores internos como masa, coste o daño absoluto de bots ajenos. Esta mejora todavía no se describe como comportamiento activo de `main` hasta cerrar la integración.

## Detalles que conviene saber

- **El nombre que ves es el actual.** El replay, el cuadro y la emisión muestran el nombre que el bot tiene hoy. Si lo renombras, tus batallas pasadas muestran el nombre nuevo. La versión y el equipo que jugaron sí se guardan con cada batalla.
- **El equipamiento se ve en el replay.** Un replay público muestra el vehículo y el equipamiento con que jugó cada bot, igual que la emisión. No muestra el historial de cambios de equipamiento de tu ficha.
- **El cuadro de un torneo con retransmisión pública muestra el nombre** del ganador de cada partido. En un torneo sin retransmisión, un ganador privado que no puedes ver sale como «Bot privado».
- **Si pasas a privado un bot mientras se emite una batalla de práctica**, la batalla deja de verse en público al momento, pero la emisión no se para sola: la detiene la administración de Streaming. En un torneo con retransmisión pública, cambiar la visibilidad no afecta a la emisión.
- **La organización de torneos no ve la ficha ni el código de tu bot privado.** Quien organiza un torneo decide si se retransmite, pero no ve tu ficha ni tu código; sólo la moderación y la administración pueden verlos. Sí ve el **nombre** de tu bot en los replays y en el cuadro del torneo, aunque el torneo no se retransmita.

Siguiente: [Bots](bots.md) · [Torneos](tournaments.md) · [Replays](replays.md).
