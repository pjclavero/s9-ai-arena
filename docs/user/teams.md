# Equipos

## Resumen

En **«Equipos»** puedes crear un equipo, del que pasas a ser capitán, e invitar miembros. Hoy el equipo no se conecta con nada más: no puedes asignar bots a un equipo desde la web ni jugar por equipos ([TD-011](../roadmap/technical-debt.md#td-011)).

## Índice

- [Uso](#uso)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Uso

### Crear un equipo — **FUNCIONA ACTUALMENTE**

1. Escribe el nombre en el campo «nombre del equipo»: hasta 48 caracteres y **único entre todos los equipos**.
2. Pulsa **«Crear equipo»**.
3. Apareces como capitán («eres capitán») y recibes el rol `team_captain`.

### Invitar a un miembro — **PARCIAL**

Si eres capitán, junto a tu equipo aparece el campo **«userId a invitar»** y el botón **«Invitar»**. Hay que escribir el **identificador interno (UUID)** de la otra persona, porque no hay búsqueda ni listado de usuarios. La web no muestra a nadie su propio identificador, así que en la práctica sólo sirve si un administrador te lo facilita.

### Ver el equipo — **PARCIAL**

La tabla muestra el nombre y «N miembros», sin los nombres de los miembros.

## Errores / limitaciones

- **PENDIENTE**:
  - quitar miembros, renombrar o borrar un equipo;
  - asignar bots a un equipo;
  - jugar torneos por equipos: el formato `teams` existe, pero no se puede alimentar desde la web.
- **Errores al cargar la página**: no se muestran. Si falla la carga verás una tabla vacía ([TD-022](../roadmap/technical-debt.md#td-022)).
- **Privacidad**: la lista de equipos es pública y expone los identificadores del capitán y de los miembros ([TD-011](../roadmap/technical-debt.md#td-011)).
- El capitán no puede salir de su propio equipo.

## Estado actual

**PARCIAL**: crear sí; el resto, no o con identificadores manuales.

## Documentación relacionada

- Usuario: [Torneos](tournaments.md), [Bots](bots.md), [Cuentas](accounts.md)
- Técnica: [api.md — equipos](../technical/api.md#recursos-por-área), [tournaments.md — formatos](../technical/tournaments.md#formatos)
