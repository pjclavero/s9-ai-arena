# Equipos

## Resumen

En **«Equipos»** gestionas tu equipo entero desde la web: crearlo (pasas a ser capitán), renombrarlo, borrarlo, añadir y quitar miembros **por email**, y asignar o quitar bots. Al crear una batalla puedes tomar los bots de un bando de uno de tus equipos.

La lista pública de equipos ya **no muestra identificadores de usuarios** ([TD-011](../roadmap/technical-debt.md#td-011)).

## Índice

- [Uso](#uso)
- [Quién puede hacer qué](#quién-puede-hacer-qué)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Uso

### Crear un equipo — **FUNCIONA ACTUALMENTE**

Escribe el nombre en «nombre del equipo» (hasta 48 caracteres, único) y pulsa **«Crear equipo»**. Aparece una tarjeta con tu equipo, «eres capitán».

### Renombrar y borrar — **FUNCIONA ACTUALMENTE** (sólo el capitán)

- **Renombrar**: escribe el nuevo nombre y pulsa «Renombrar».
- **Borrar**: «Borrar equipo» pide confirmación. Los bots del equipo **no se borran**: quedan sin equipo.

### Miembros — **FUNCIONA ACTUALMENTE** (sólo el capitán)

- **Añadir**: escribe el **email** de la persona en el campo y pulsa «Añadir miembro». Ya no hace falta su identificador interno.
- **Quitar**: «Quitar» junto a su nombre. Sus bots dejan de pertenecer al equipo.
- La tarjeta lista a los miembros por su nombre visible, con su papel (capitán o miembro).

### Bots del equipo — **FUNCIONA ACTUALMENTE**

- **Añadir**: elige uno de **tus** bots en «— uno de mis bots —» y pulsa «Añadir bot». Cualquier miembro puede añadir sus propios bots.
- **Quitar**: «Quitar del equipo». Puede hacerlo el dueño del bot o el capitán.

### Usar el equipo en una batalla — **FUNCIONA ACTUALMENTE**

En «Nueva batalla», «Equipo rojo» y «Equipo azul» (opcionales) limitan los bots de ese bando a los de tu equipo. Ver [Batallas](battles.md).

### Otros equipos

En «Otros equipos» ves sólo el nombre y cuántos miembros y bots tiene cada uno.

## Quién puede hacer qué

| Acción | Quién |
|---|---|
| Crear equipo | Cualquier usuario |
| Renombrar, borrar, añadir o quitar miembros | Sólo el capitán (o un admin) |
| Añadir un bot | Su dueño, si es miembro del equipo |
| Quitar un bot | Su dueño o el capitán |
| Ver miembros y bots | Los miembros del equipo |
| Ver nombre y recuentos | Todo el mundo, incluso sin cuenta |

## Errores / limitaciones

| Situación | Lo que ves |
|---|---|
| Email que no existe | «Usuario no encontrado (email o userId)» |
| Nombre repetido | «Ya existe un equipo con ese nombre» |
| Acción de capitán sin serlo | «Solo el capitán del equipo puede hacer esto» |
| Fallo al cargar | Mensaje de error con «Reintentar» (ya no una lista vacía) |

Además:

- El capitán no puede salir de su propio equipo ni ceder la capitanía.
- Al añadir por email se sabe si esa cuenta existe: la acción está reservada al capitán.
- Los torneos por equipos (formato `teams`) siguen sin poder alimentarse desde la web ([Torneos](tournaments.md)).

## Estado actual

**FUNCIONA ACTUALMENTE**: gestión completa del equipo y de sus bots desde la web, y uso en el formulario de batalla. Comprobado con un navegador real. **PENDIENTE**: ceder la capitanía y los torneos por equipos desde la web.

## Documentación relacionada

- Usuario: [Batallas](battles.md), [Bots](bots.md), [Torneos](tournaments.md)
- Técnica: [api.md — equipos](../technical/api.md#recursos-por-área), [tournaments.md — formatos](../technical/tournaments.md#formatos)
- Deuda: [TD-011](../roadmap/technical-debt.md#td-011)
