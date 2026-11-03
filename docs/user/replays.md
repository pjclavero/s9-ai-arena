# Replays

Cada batalla terminada deja un **replay** que puedes volver a ver. **«Replays»** los lista y el **reproductor** los reproduce, con velocidades, salto en el tiempo y enlace para compartir un instante.

## Quién puede ver un replay

Puedes ver el replay de una batalla (lista, reproductor y descarga) si:

- **uno de tus bots participó** en ella;
- eres **miembro del equipo** de un bot participante y ese bot no es privado (visibilidad «equipo» o «pública»);
- tienes rol de **organizador, moderador o administrador**;
- o la plataforma tiene activado el **acceso público a replays** y **todos** los bots de la batalla son públicos. Activarlo no hace públicas las batallas en las que participa algún bot privado o de equipo.

En cualquier otro caso el replay **no existe para ti**: la lista no lo muestra y el reproductor dice «no existe o no está disponible», exactamente igual que con un identificador inventado. Un enlace a un replay público se abre sin cuenta.

## Lista de replays

**«Replays»** (requiere sesión) muestra sólo los replays que puedes ver. Columnas: batalla, resultado («gana *equipo*» o «empate»), duración, oficial (sí o no), fecha y «Ver replay».

**Buscar y filtrar.** El panel «Filtros» busca en el servidor, no sólo en lo que ves en pantalla:

| Filtro | Qué hace |
|---|---|
| ID de batalla | Un identificador concreto. |
| Desde / Hasta | Un intervalo de fechas. |
| Modo | Uno de los cuatro modos. |
| Resultado | Victoria, derrota, empate o «Abortada o con incidencia». Se refiere al bot, equipo o usuario filtrado; sin ellos, a tus bots. |
| Bot, Equipo, Usuario | Por nombre o identificador (hasta 48 caracteres). |

«Quitar filtros» vuelve a la lista completa. Los filtros viajan en la dirección de la página, así que puedes guardarla o compartirla. La lista se pagina; si no hay replays, «No hay replays todavía. Se crean al terminar una batalla.», con enlace a «Batallas». Si la plataforma no responde verás «Servicio no disponible» o «El servidor tarda demasiado» con **«Reintentar»**, nunca una lista vacía engañosa.

## Reproductor

Controles:

- **reproducir / pausa** (al terminar, «Reproducir» vuelve a empezar);
- velocidades de **0,5× a 8×**;
- **línea de tiempo** para saltar a cualquier momento;
- las mismas **cámaras y atajos** que el [visor](viewer.md): «Vista global», una por bando, seguir a un vehículo (teclas 1–8), zoom, minimapa y, si las reglas lo permiten, **niebla de guerra** desde la perspectiva de un bando;
- «← Todos los replays».

Estados: «cargando…» → «inicializando visor…» → «reproduciendo» → «fin del replay». Si el replay no existe o no tienes permiso: «replay no disponible: No existe o no está disponible». Si el servicio falla a mitad: «error al cargar el replay: …» con «Reintentar». El título dice quién juega («Replay: Alfa vs Beta»).

## Compartir

**«Compartir este instante»** copia un enlace al momento actual (`…?t=<tick>`). Quien lo abra empieza en ese punto, **si tiene permiso** para ver ese replay.

## Cuánto se conservan

Los replays de las batallas oficiales de torneo se conservan siempre. Los de las batallas de práctica son **temporales**: su ficha los da por caducados a los 7 días y la plataforma puede limpiarlos pasado ese tiempo. Si un replay de práctica te importa, míralo pronto.

## Para depurar tu bot

El replay es la mejor forma de ver **qué hizo tu código de verdad**. Junto con el campo `debug` de tus órdenes (se guarda en tus replays privados) y el [diagnóstico](statistics.md#diagnóstico-de-tus-bots) de la batalla, es la base para mejorar: [Probar tu bot](bots/probar.md).

Siguiente: [Estadísticas](statistics.md).
