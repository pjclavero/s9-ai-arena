# Bots: crear, versiones y publicación

En **«Mis bots»** creas bots, configuras su equipamiento, subes versiones de código y las envías a validación. Cada envío se **ejecuta en un entorno aislado** y se prueba en una batalla corta; si la supera, puedes **publicar** la versión, y sólo las versiones publicadas combaten. Cada versión conserva su propio código, equipamiento y paquete, y **no cambia nunca**: para modificarla creas una versión nueva a partir de ella.

Cómo se **programa** un bot (ciclo, observaciones, órdenes, sensores, radio) está en la [guía de programación](bots/index.md).

## Crear un bot

1. «Mis bots» → campo **«Nombre del bot»** (hasta 48 caracteres, único entre tus bots) → **«Crear bot»**. Un nombre vacío, demasiado largo o repetido se explica junto al formulario («Ya tienes un bot llamado «Tanque».»).
2. Aparece en la lista de **Activos** con su visibilidad entre paréntesis. Todos los bots nacen **privados**.

Pulsa el nombre del bot para abrir su detalle: ahí está el editor de equipamiento, la subida de código, las versiones y el estado de la validación.

**Retirar un bot.** En el detalle, «Retirar bot» lo pasa a la lista de **Retirados**: no borra versiones, batallas ni replays ni cambia qué versión juega; «Reactivar bot» lo devuelve a Activos. No hay forma de borrar un bot ni de cambiar su nombre desde la web. La **visibilidad del bot** se cambia en Overview y la **del código**, versión a versión, en Versions ([Visibilidad](visibility.md)).

## Equiparlo

Pulsa el nombre del bot y aparece el **«Editor de loadout»**: elige el chasis, llena las ranuras y pulsa **«Guardar revisión»**. Detalle en [Equipamiento](equipment.md). **Necesitas un loadout guardado para poder subir código**: si no lo tienes, verás «Guarda antes una configuración (loadout) para poder subir código.».

## Subir código

1. En la tarjeta «Versiones de *bot*» → **«Subir código (pegado)»**.
2. Elige el **Runtime**: Python o JavaScript (Node).
3. El área **«Código»** arranca con una **plantilla válida**: va hacia el rival, usa tu radar o lidar y dispara con las armas de tu loadout. Pasa la validación tal cual. Si cambias de runtime sin haberla tocado, se cambia por la del otro; si ya escribiste algo, se respeta. «Restaurar la plantilla» vuelve a ella.
4. Pulsa **«Subir como versión nueva»**: se crea la versión siguiente (v1, v2…) en estado `draft`, ligada a tu revisión de loadout actual.

Si la sesión caduca mientras escribes, el código sin subir de esa pestaña se recupera al volver a entrar.

Detalles del código:

- Sólo se puede **pegar** texto; no hay botón para elegir un archivo. Máximo 10 MB.
- No puedes añadir dependencias desde la web: el código se empaqueta con el SDK oficial. Qué se puede importar: [Probar tu bot](bots/probar.md#qué-comprueba-la-validación).
- **Python** (3.11): una clase que herede de `ArenaBot` (llámala `Bot` si defines varias) con `on_observation(self, observation)`. **JavaScript** (Node 20): un **módulo ES** que exporte una clase que extienda `ArenaBot` con `onObservation(observation)`. **TypeScript no se acepta**.
- **El hook es obligatorio.** Si tu clase no lo implementa —por ejemplo, por una errata en el nombre— la validación lo rechaza y te dice cómo escribirlo. Un bot que sí lo implementa y devuelve `{}` («sin cambios») es válido.
- Un paquete de varios ficheros no se puede subir desde la web (la web edita el fichero de entrada).

## Versiones y estados

La tabla de versiones muestra para cada una su número, estado, runtime, motivo de rechazo y la acción pendiente:

| Estado | Qué significa | Qué ves |
|---|---|---|
| `draft` | Subida, sin enviar. | «sin enviar — pulsa «Enviar a validación»» |
| `validating` | En validación. | «Validación en curso…» |
| `rejected` | No superó la validación. | El motivo, y «Reenviar vN» o «Corregir el código» |
| `validated` | Superó la validación. | «pendiente de publicar» y el botón «Publicar vN» |
| `published` | Jugable. | `vN publicada` junto al nombre del bot |
| `frozen` | Congelada al cerrarse las inscripciones del torneo en el que participa. Sigue pudiendo jugar. | — |
| `suspended`, `retired` | Suspendida por moderación / retirada. | — |

La tarjeta **«Última subida: vN · estado»** resume la versión que estás mirando; cambia con «Ver vN» y refresca con **«Actualizar estado»**.

## Enviar a validación

1. Pulsa **«Enviar a validación vN»**.
2. La tarjeta **«Pipeline de build · vN»** muestra las etapas y «En curso: comprobando cada 2 s…».
3. Al terminar, la versión queda `validated` o `rejected` con el motivo.

Qué comprueba cada etapa y cuáles son los errores típicos: [Probar tu bot](bots/probar.md#2-en-la-plataforma-la-validación).

Si la versión no supera la validación, la tarjeta **«vN: Tu bot no ha superado la validación»** te dice:

- el **origen**: tu código, o la plataforma («tu código no tiene la culpa»);
- la **fase** en la que falló y **dónde**: el fichero y la línea de tu código;
- el **motivo**, que es la última línea del error;
- que **vN NO está publicada**, y qué versión publicada sigue en juego, si la hay;
- qué hacer: el botón **«Corregir el código de vN»** lo carga en el editor para guardarlo como versión nueva, o **«Reenviar vN a validación sin cambios»** si el fallo fue de la plataforma.

**«Ver build»** (en el detalle del bot) muestra cada etapa con su mensaje, su registro y sus métricas: tiempo de arranque, tiempo de decisión, órdenes válidas y CPU. Si la validación no responde, tras unos 30 sondeos verás «El pipeline sigue sin dar un resultado… Pulsa «Actualizar estado»».

## Publicar

El botón **«Publicar vN»** sólo aparece en versiones `validated`. Al publicar, el código **no** se hace público: la web siempre publica con el código privado. Para hacerlo público (o volver a ocultarlo) usa «Código de vN [Privado][Público]» en Versions ([Visibilidad](visibility.md)). Una versión publicada antigua **sigue pudiendo jugar** aunque la última esté rechazada o en validación.

**«Publicada · No elegible».** Si el equipamiento de una versión publicada ya no cumple la validación actual (por ejemplo, un cañón con munición que no puede disparar), aparece así, deshabilitada y con el motivo. Se conserva con su historia y sus replays se siguen viendo, pero no puede entrar en batallas ni torneos nuevos: usa otra versión o crea una nueva con el equipamiento corregido.

## El detalle del bot

En «Mis bots», pulsa el nombre del bot. Tiene cuatro pestañas:

- **Overview**: visibilidad (el dueño la cambia aquí: Privado, Equipo o Público), última versión publicada, número de versiones y enlaces a sus batallas y replays.
- **Code**: elige una versión y ve sus ficheros; puedes editar y pulsar **«Guardar como versión nueva desde vN»**. Si el código no es tuyo y es privado, verás «No tienes permiso para ver el código de esta versión».
- **Equipment**: las revisiones de loadout y qué versiones usa cada una.
- **Versions**: versión (y de cuál se creó), fecha, estado y motivo, resultado del build, paquete (huella), publicación y visibilidad del código (el dueño la cambia aquí); con las acciones «Ver código», «Ver build», «Nueva versión desde ésta» y «Comparar con vN-1», que muestra las diferencias línea a línea.

Una versión enviada, validada o publicada **no se puede modificar ni borrar**. Las batallas guardan qué versión jugó cada bot, así que publicar una versión nueva no cambia lo que jugó una batalla anterior.

## Usar el bot

- **En una batalla de práctica**: en 1 contra 1, dos bots con versión publicada; en una batalla por equipos, hasta 4 bots por bando (4 contra 4, máximo 8 en total). Eliges qué versión juega cada uno ([Batallas](battles.md)).
- **En un torneo**: inscribes una versión publicada ([Torneos](tournaments.md)). Al cerrarse las inscripciones, la versión inscrita queda `frozen`.
- En la batalla, el vehículo lo conduce **tu código** con el equipamiento de **esa versión**.
- **En un equipo**: añade tu bot a un [equipo](teams.md).
