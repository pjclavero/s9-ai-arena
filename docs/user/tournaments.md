# Torneos

Un torneo enfrenta a los bots inscritos según un **formato** (liga, eliminatoria, suizo…). Sus batallas son **oficiales**: son las únicas que cambian el [ranking](rankings.md). Crear un torneo y cerrar sus inscripciones exige el rol **organizador**; cualquier jugador puede inscribir sus bots con una versión publicada.

## Cómo funciona

1. Un **organizador** crea el torneo con su formato y su modo. Nace con las **inscripciones abiertas**.
2. El dueño de cada bot lo **inscribe** con una de sus versiones publicadas y elegibles (con su equipamiento).
3. Al **cerrar las inscripciones**, las versiones inscritas quedan **congeladas** (y se revelan las semillas), la plataforma genera el calendario y **juega las batallas sola**.
4. Cada batalla terminada actualiza el rating de sus bots. Al acabar el último enfrentamiento, el torneo termina.

Estados de un torneo: borrador, inscripciones abiertas, inscripciones cerradas, en juego, terminado o cancelado. Cancelar un torneo **no borra lo ya jugado**: sus batallas oficiales terminadas siguen contando en el [ranking](rankings.md), salvo las que se hayan anulado. Un torneo en borrador no cuenta nada, e inscribirse no te hace aparecer en el ranking hasta que disputes un enfrentamiento.

## Ver torneos

«Torneos» lista todos los torneos con su nombre, formato, modo y estado, en palabras («Eliminación directa», «Deathmatch por equipos», «inscripciones abiertas»). Pulsa el nombre para abrir el detalle.

## Formatos

| Formato | Cómo se juega |
|---|---|
| Liga | Todos contra todos. |
| Todos contra todos (liguilla) | Todos contra todos. |
| Eliminación directa | Cuadro: quien pierde, sale. |
| Doble eliminación | Cuadro con repesca: hay que perder dos veces. |
| Sistema suizo | Rondas en las que se empareja a bots con resultados parecidos. |
| Por equipos | Clasificación por equipos. |

Un enfrentamiento puede tener varias batallas. En el modo por equipos, los bots juegan en el bando de su equipo.

## Crear un torneo (organizadores)

En «Crear torneo»:

| Campo | Opciones |
|---|---|
| **Nombre** | Hasta 64 caracteres. |
| **Formato** | Los de la tabla de arriba. |
| **Modo** | Los cuatro modos ([Modos de juego](game-modes.md)). |
| **Ruleset** | Las reglas del torneo; déjalo en `mvp-default` salvo que sepas lo que haces. |
| **Tamaño** | Sólo en torneos **Por equipos** de **Deathmatch por equipos**: 2 vs 2, 3 vs 3 o 4 vs 4. Fija cuántos bots inscribe cada equipo. |
| **Retransmisión pública** | Si se marca, las batallas del torneo se pueden ver y emitir en público con los datos de competición de cada bot, también de los privados o de equipo. No cambia la visibilidad de ningún bot ni de su código. **No se puede cambiar después** ([Visibilidad](visibility.md)). |

El formulario se muestra a todos, pero sin el rol verás «Requiere rol organizer» al pulsar. Desde la web no se configuran el conjunto de mapas, el presupuesto, las fechas ni el número de partidas por enfrentamiento; por defecto el torneo se juega en el mapa de serie `mvp-arena-01`. La plataforma guarda una **copia inmutable de las reglas** del torneo al crearlo: aunque un conjunto de reglas cambie después, el torneo conserva las suyas.

## Inscribir un bot

En el detalle del torneo, **«Inscribir bot»** → elige uno de tus bots → elige la **versión** (se propone la más reciente que se puede inscribir) → **«Inscribir»**. Se inscribe una **versión publicada o congelada («Frozen / Inmutable») y elegible**, junto con su equipamiento, y ambos quedan fijados para el torneo. Puedes inscribir bots **privados, de equipo o públicos**: inscribirlo no cambia su visibilidad ni la de su código. Si el torneo tiene retransmisión pública y el bot no es público, la web te avisa: «Este bot es privado. Durante las batallas públicas se mostrarán únicamente sus datos de competición; su código seguirá privado.»

| Mensaje | Causa |
|---|---|
| «X inscrito (vN)» | Correcto. |
| «Ese bot no tiene ninguna versión publicada o congelada que sea elegible» | Publica primero una versión ([Bots](bots.md)). |
| «X inscrito (vN) · Frozen / Inmutable» | Correcto: la versión ya compitió en otro torneo y se inscribe tal cual. |
| «El bot ya está inscrito en este torneo» | Ya inscrito. |
| «Las inscripciones no están abiertas» | Torneo cerrado. |
| La versión «no es elegible» | Su equipamiento ya no cumple la validación: crea una versión nueva ([Bots](bots.md#publicar)). |

## Inscribir un equipo (torneos por equipos)

En un torneo **Por equipos** con tamaño (por ejemplo, 4 vs 4) no se inscriben bots sueltos: se inscribe el **equipo completo**. En el detalle del torneo, **«Inscribir equipo»** → elige uno de tus equipos → la web enseña su plantilla con la **versión** de cada bot (puedes cambiarla) → **«Inscribir equipo»**.

- Se inscriben **exactamente** tantos bots como marque el tamaño; si el equipo tiene más, desmarca los que no juegan.
- Cada bot tiene que ser **del equipo**, no estar retirado, y tener una versión **publicada o congelada («Frozen / Inmutable») y elegible**, como en la inscripción individual.
- **Equipos de varios jugadores**: un bot de otro miembro sólo entra si **su dueño lo autoriza** para ese torneo con una versión concreta. El dueño lo hace en el mismo formulario con **«Autorizar a mi equipo (vN)»**; quien inscribe ve «vN · autorizado por su dueño» y no puede elegir otra versión. Tus propios bots quedan autorizados al inscribir. La autorización sólo muestra bot y versión, nunca el código.
- Si un dueño **retira su autorización** («Retirar autorización») con el equipo ya inscrito, el equipo **sale entero** de la inscripción.
- Si falta o sobra un bot, o alguno no tiene versión elegible, el botón queda **deshabilitado** y la web dice por qué.
- Es **todo o nada**: o entra el equipo completo o no entra ningún bot.
- Inscribir el equipo **no cambia** la visibilidad de los bots, la de su código ni su dueño.

| Mensaje | Causa |
|---|---|
| «Equipo X inscrito (N bots)» | Correcto. |
| «Hacen falta exactamente N bots del equipo» | Marca justo N bots. |
| «Falta la autorización de su dueño para este torneo» | Ese bot es de otro jugador del equipo y aún no lo ha autorizado (o autorizó otra versión). |
| «El equipo ya está inscrito en este torneo» | Ya inscrito. |
| «Algún bot no pertenece a este equipo» | El bot salió del equipo mientras elegías. |

Al **cerrar las inscripciones** la plataforma vuelve a comprobarlo todo: si un bot inscrito salió de su equipo, cambió de equipo o se retiró, su dueño retiró la autorización, o su versión dejó de ser elegible (o fue suspendida o retirada), el cierre se rechaza y no se congela nada. Siempre hay salida: el **organizador puede excluir** esas inscripciones (y, si un equipo queda a medias, también el resto de ese equipo), y el dueño puede retirarla o inscribir otra versión válida. Los torneos por equipos creados sin tamaño (anteriores a esta función) siguen inscribiéndose bot a bot.

## Cerrar inscripciones (organizadores)

El botón **«Cerrar inscripciones»** se ve siempre, pero sin el rol responde «Requiere rol organizer». Al cerrar verás «Inscripciones cerradas: versiones congeladas y semillas reveladas».

## Seguir el torneo

- **Detalle**: la sección «Batallas» se refresca sola. Tiene el **cuadro** por rondas y el **historial**, con enlaces «Ver en directo» o «Ver replay». Los bots aparecen por su nombre y la versión que juega.
- **«Ver cuadro»**: por ronda, cada partido con su estado (pendiente, en juego, terminado, falló) y el ganador. Es de sólo lectura.
- **Directo y replay**: los enlaces llevan al [visor](viewer.md) y al [reproductor](replays.md). El directo de un torneo va con un retardo de 30 segundos, salvo las batallas marcadas como visibles (la final).
- **Clasificación**: el [ranking](rankings.md) suma los resultados de todos los torneos de la temporada en cada modo.

## Cosas a tener en cuenta

- Si una batalla de un torneo falla por un problema técnico, su enfrentamiento puede quedarse sin cerrar y el torneo sin terminar.
- Una batalla de torneo de captura de bandera detenida por el límite técnico de la prórroga no tiene resultado deportivo ([Modos de juego](game-modes.md#captura-la-bandera)).

Siguiente: [Ranking](rankings.md) · [Batallas](battles.md).
