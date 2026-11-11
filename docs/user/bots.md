# Bots: crear, versiones y publicación

En **«Mis bots»** creas bots, configuras su equipamiento, subes versiones de código y las envías a validación. Cada envío se **ejecuta en un entorno aislado** y se prueba en una batalla corta; si la supera, puedes **publicar** la versión, y sólo las versiones publicadas combaten. Cada versión conserva su propio código, equipamiento y paquete, y **no cambia nunca**: para modificarla creas una versión nueva a partir de ella.

Cómo se **programa** un bot (ciclo, observaciones, órdenes, sensores, radio) está en la [guía de programación](bots/index.md).

## Crear un bot

1. «Mis bots» → campo **«Nombre del bot»** (hasta 48 caracteres, único entre tus bots) → **«Crear bot»**. Un nombre vacío, demasiado largo o repetido se explica junto al formulario («Ya tienes un bot llamado «Tanque».»).
2. Aparece en la lista de **Activos** con su visibilidad entre paréntesis. Todos los bots nacen **privados**.

Pulsa el nombre del bot para abrirlo a la derecha de la lista (ver [Navegación del bot](#navegación-del-bot)). Un bot recién creado se abre directamente en **Equipamiento**, que es el siguiente paso.

**Retirar un bot.** En **Resumen**, «Retirar bot» lo pasa a la lista de **Retirados**: no borra versiones, batallas ni replays ni cambia qué versión juega; «Reactivar bot» lo devuelve a Activos. No hay forma de borrar un bot ni de cambiar su nombre desde la web. La **visibilidad del bot** y la **del código**, versión a versión, se cambian juntas en la sección **Visibilidad** ([Visibilidad](visibility.md)).

## Navegación del bot

Hay una sola pantalla: **[lista de tus bots] | [el bot elegido: menú de secciones + UNA sección]**. Al pulsar una sección cambia el contenido de la derecha; la página **no se desplaza** y el foco pasa al título de la sección. La dirección (`#/bots/<id>/<sección>`) se puede guardar o recargar (F5) y vuelve al mismo bot y sección.

| Sección | Qué hay (y sólo aquí) |
|---|---|
| **Resumen** | Visibilidad (sólo texto, con enlace para cambiarla), qué versión usan las batallas nuevas, número de versiones, fecha de creación y «Retirar / Reactivar bot». |
| **Visibilidad** | La visibilidad del bot **y** la del código de cada versión, en la misma tarjeta. Es el único sitio donde se cambian. |
| **Equipamiento** | El editor de loadout y el historial de revisiones («usada por vN»). |
| **Código** | El editor para crear una versión nueva, el visor del código de cualquier versión y la comparación entre dos versiones. |
| **Versiones y build** | La versión que estás mirando, el diagnóstico si fue rechazada, la tabla de versiones con sus acciones y el pipeline de build con etapas, registros, métricas y artefacto. |
| **Batallas** | Las últimas batallas del bot y el enlace a todas en «Batallas». |
| **Replays** | Sus últimos replays y el enlace a todos en «Replays». |

En escritorio el menú de secciones está a la izquierda de la sección; en tablet y móvil pasa a una fila de pestañas encima. Si el bot es de otra persona (por ejemplo, de tu equipo), todo es de sólo lectura.

## Equiparlo

En la sección **Equipamiento** está el **«Editor de loadout»**: elige el chasis, llena las ranuras y pulsa **«Guardar revisión»**. Detalle en [Equipamiento](equipment.md). **Necesitas un loadout guardado para poder subir código**: si no lo tienes, en **Código** verás «Guarda antes una configuración en Equipamiento para poder subir código.».

## Subir código

1. Sección **Código** → tarjeta **«Nueva versión»**.
2. Elige el **Runtime**: Python o JavaScript (Node).
3. El área **«Código»** arranca con una **plantilla válida**: va hacia el rival, usa tu radar o lidar y dispara con las armas de tu loadout. Pasa la validación tal cual. Si cambias de runtime sin haberla tocado, se cambia por la del otro; si ya escribiste algo, se respeta. «Restaurar la plantilla» vuelve a ella.
4. Pulsa **«Subir como versión nueva»**: se crea la versión siguiente (v1, v2…) en estado `draft`, ligada a tu revisión de loadout actual, y el panel pasa a **Versiones y build**, donde está «Enviar a validación».

Para partir del código de una versión anterior: en el visor de **Código** elige la versión y pulsa **«Editar en una versión nueva desde vN»**; se carga en el mismo editor (vN no cambia).

Si la sesión caduca mientras escribes, el código sin subir de esa pestaña se recupera al volver a entrar.

Detalles del código:

- Sólo se puede **pegar** texto; no hay botón para elegir un archivo. Máximo 10 MB.
- No puedes añadir dependencias desde la web: el código se empaqueta con el SDK oficial. Qué se puede importar: [Probar tu bot](bots/probar.md#qué-comprueba-la-validación).
- **Python** (3.11): una clase que herede de `ArenaBot` (llámala `Bot` si defines varias) con `on_observation(self, observation)`. **JavaScript** (Node 20): un **módulo ES** que exporte una clase que extienda `ArenaBot` con `onObservation(observation)`. **TypeScript no se acepta**.
- **El hook es obligatorio.** Si tu clase no lo implementa —por ejemplo, por una errata en el nombre— la validación lo rechaza y te dice cómo escribirlo. Un bot que sí lo implementa y devuelve `{}` («sin cambios») es válido.
- Un paquete de varios ficheros no se puede subir desde la web (la web edita el fichero de entrada).

## Versiones y estados

La tabla de versiones (sección **Versiones y build**) muestra para cada una su número, estado, fecha, acción pendiente, runtime, si su código es público o privado (sólo se muestra: se cambia en Visibilidad) y el motivo de rechazo:

| Estado | Qué significa | Qué ves |
|---|---|---|
| `draft` | Subida, sin enviar. | «sin enviar — pulsa «Enviar a validación»» |
| `validating` | En validación. | «Validación en curso…» |
| `rejected` | No superó la validación. | El motivo, y «Reenviar vN» o «Corregir el código» |
| `validated` | Superó la validación. | «pendiente de publicar» y el botón «Publicar vN» |
| `published` | Jugable. | `vN publicada` junto al nombre del bot |
| `frozen` | Congelada al cerrarse las inscripciones del torneo en el que participa. Sigue pudiendo jugar. | — |
| `suspended`, `retired` | Suspendida por moderación / retirada. | — |

La tarjeta **«Mirando vN · estado»** resume la versión que estás mirando; cambia con «Ver vN» y refresca con **«Actualizar estado»**.

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

El **pipeline de build** de la versión que miras muestra cada etapa con su mensaje, su registro y sus métricas (tiempo de arranque, tiempo de decisión, órdenes válidas y CPU) y la huella del artefacto firmado. Si la validación no responde, tras unos 30 sondeos verás «El pipeline sigue sin dar un resultado… Pulsa «Actualizar estado»».

## Publicar

El botón **«Publicar vN»** sólo aparece en versiones `validated`. Al publicar, el código **no** se hace público: la web siempre publica con el código privado. Para hacerlo público (o volver a ocultarlo) usa «Código de vN [Privado][Público]» en la sección **Visibilidad** ([Visibilidad](visibility.md)). Una versión publicada antigua **sigue pudiendo jugar** aunque la última esté rechazada o en validación.

**«Publicada · No elegible».** Si el equipamiento de una versión publicada ya no cumple la validación actual (por ejemplo, un cañón con munición que no puede disparar), aparece así, deshabilitada y con el motivo. Se conserva con su historia y sus replays se siguen viendo, pero no puede entrar en batallas ni torneos nuevos: usa otra versión o crea una nueva con el equipamiento corregido.

## Historial, comparación y clonado

- En **Versiones y build**, cada fila dice de qué versión se creó; «Ver código» abre esa versión en **Código** y **«Nueva versión desde ésta»** la copia tal cual como borrador nuevo (sirve también para paquetes de varios ficheros).
- En **Código**, «Comparar con» muestra las diferencias línea a línea entre la versión que miras y otra. Si el código no es tuyo y es privado, verás «No tienes permiso para ver el código de esta versión».

Una versión enviada, validada o publicada **no se puede modificar ni borrar**. Las batallas guardan qué versión jugó cada bot, así que publicar una versión nueva no cambia lo que jugó una batalla anterior.

## Usar el bot

- **En una batalla de práctica**: en 1 contra 1, dos bots con versión publicada; en una batalla por equipos, hasta 4 bots por bando (4 contra 4, máximo 8 en total). Eliges qué versión juega cada uno ([Batallas](battles.md)).
- **En un torneo**: inscribes una versión publicada ([Torneos](tournaments.md)). Al cerrarse las inscripciones, la versión inscrita queda `frozen`.
- En la batalla, el vehículo lo conduce **tu código** con el equipamiento de **esa versión**.
- **En un equipo**: añade tu bot a un [equipo](teams.md).
