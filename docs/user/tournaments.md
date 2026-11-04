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

El formulario se muestra a todos, pero sin el rol verás «Requiere rol organizer» al pulsar. Desde la web no se configuran el conjunto de mapas, el presupuesto, las fechas ni el número de partidas por enfrentamiento; por defecto el torneo se juega en el mapa de serie `mvp-arena-01`. La plataforma guarda una **copia inmutable de las reglas** del torneo al crearlo: aunque un conjunto de reglas cambie después, el torneo conserva las suyas.

## Inscribir un bot

En el detalle del torneo, **«Inscribir bot»** → elige uno de tus bots → **«Inscribir»**. Se inscribe una **versión publicada y elegible**, junto con su equipamiento, y ambos quedan fijados para el torneo.

| Mensaje | Causa |
|---|---|
| «X inscrito (vN)» | Correcto. |
| «Ese bot no tiene ninguna versión publicada» | Publica primero una versión ([Bots](bots.md)). |
| «El bot ya está inscrito en este torneo» | Ya inscrito. |
| «Las inscripciones no están abiertas» | Torneo cerrado. |
| La versión «no es elegible» | Su equipamiento ya no cumple la validación: crea una versión nueva ([Bots](bots.md#publicar)). |

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
