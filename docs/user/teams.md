# Equipos

En **«Equipos»** gestionas tu equipo desde la web: crearlo (pasas a ser capitán), renombrarlo, borrarlo, añadir y quitar miembros **por email** y asignar o quitar bots. Un **equipo** es un grupo permanente de personas y bots; no es lo mismo que el **bando** (rojo o azul) que ocupa un bot en una batalla concreta. Para practicar no necesitas equipo.

Para qué sirve un equipo:

- **Compartir bots** con tus compañeros: los bots del equipo se pueden elegir en las batallas de cualquier miembro (sin llegar a ser públicos).
- **Elegir bots por equipo** al crear una batalla: «Equipo A / Equipo B» en las batallas por equipos, y un filtro por equipo en cada bando de una batalla individual ([Batallas](battles.md)).

La lista pública de equipos **no muestra identificadores de usuarios**.

## Crear un equipo

Escribe el nombre en «nombre del equipo» (hasta 48 caracteres, único) y pulsa **«Crear equipo»**. Aparece una tarjeta con tu equipo y «eres capitán».

## Renombrar y borrar (sólo el capitán)

- **Renombrar**: escribe el nuevo nombre y pulsa «Renombrar».
- **Borrar**: «Borrar equipo» pide confirmación. Los bots del equipo **no se borran**: quedan sin equipo.

## Miembros (sólo el capitán)

- **Añadir**: escribe el **email** de la persona y pulsa «Añadir miembro».
- **Quitar**: «Quitar» junto a su nombre. Sus bots dejan de pertenecer al equipo.
- La tarjeta lista a los miembros por su nombre visible, con su papel (capitán o miembro).

## Bots del equipo

- **Añadir**: elige uno de **tus** bots en «— uno de mis bots —» y pulsa «Añadir bot». Cualquier miembro puede añadir sus propios bots.
- **Quitar**: «Quitar del equipo». Puede hacerlo el dueño del bot o el capitán.

## Hacer públicos los bots que administras

En la tarjeta del equipo, **«Hacer públicos los bots que administras»** pone en **Público** los bots del equipo **de los que eres dueño**. Ser capitán no da permiso sobre los bots de otros: sólo cambia la visibilidad su dueño.

1. Pulsa el botón: antes de cambiar nada verás **«Se harán públicos: ✓ …»**, los que **ya son públicos** y los que **no se modificarán porque no eres su dueño**, y «No se modificarán: el código fuente, las versiones ni el equipamiento». La lista la calcula el servidor con la misma regla que aplicará al confirmar.
2. El **código no cambia** por defecto. La casilla aparte **«Hacer también público el código de la versión publicada de esos bots»** lo cambia sólo en la versión publicada más reciente de cada bot tuyo.
3. Pulsa **«Confirmar»** (o «Cancelar»). El resultado dice bot a bot qué cambió y qué no, también cuando sólo se cambian algunos («2 bots pasan a público · 1 sin autorización: no se han tocado»).

Los bots que sí cambian lo hacen todos a la vez; cada cambio queda registrado como si lo hubieras hecho en el bot.

## Usar el equipo en una batalla

En «Nueva batalla», el tipo **batalla por equipos** te deja elegir dos equipos (hasta 4 bots por bando). En una batalla individual, «Equipo rojo» y «Equipo azul» (opcionales) limitan los bots de cada bando a los de ese equipo.

## Otros equipos

En «Otros equipos» ves sólo el nombre y cuántos miembros y bots tiene cada uno.

## Quién puede hacer qué

| Acción | Quién |
|---|---|
| Crear equipo | Cualquier usuario |
| Renombrar, borrar, añadir o quitar miembros | Sólo el capitán (o un administrador) |
| Añadir un bot | Su dueño, si es miembro del equipo |
| Quitar un bot | Su dueño o el capitán |
| Hacer públicos los bots del equipo | Cualquier miembro, pero cada bot sólo si es suyo |
| Ver miembros y bots | Los miembros del equipo |
| Ver nombre y recuentos | Todo el mundo, incluso sin cuenta |

## Errores frecuentes

| Situación | Lo que ves |
|---|---|
| Email que no existe | «Usuario no encontrado (email o userId)» |
| Nombre repetido | «Ya existe un equipo con ese nombre» |
| Acción de capitán sin serlo | «Solo el capitán del equipo puede hacer esto» |
| Fallo al cargar | Mensaje de error con «Reintentar» |

El capitán no puede salir de su propio equipo ni ceder la capitanía. Los torneos de formato «Por equipos» no se pueden alimentar desde la web ([Torneos](tournaments.md)).

Siguiente: [Batallas](battles.md) · [Torneos](tournaments.md).
