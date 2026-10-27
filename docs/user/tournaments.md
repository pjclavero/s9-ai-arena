# Torneos

## Resumen

Un torneo enfrenta a los bots inscritos según un formato (liga, eliminatoria, suizo…). Sus batallas son **oficiales**: cuentan para el rating. Crear un torneo y cerrar sus inscripciones exige el rol **organizador**; cualquier usuario puede inscribir sus bots publicados.

Hoy es la **única vía de la web que llega a jugar batallas**, pero:

- necesita bots publicados, que no se pueden obtener ([TD-001](../roadmap/technical-debt.md#td-001));
- se juega siempre en el mapa `mvp-arena-01` ([TD-015](../roadmap/technical-debt.md#td-015));
- los vehículos los conduce el código de cada bot inscrito, en su contenedor; en este servidor la ejecución aún no está activada y las batallas quedan en cola ([TD-002](../roadmap/technical-debt.md#td-002)).

## Índice

- [Ver torneos](#ver-torneos)
- [Crear un torneo](#crear-un-torneo)
- [Inscribir un bot](#inscribir-un-bot)
- [Cerrar inscripciones](#cerrar-inscripciones)
- [Seguir el torneo](#seguir-el-torneo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Ver torneos

**FUNCIONA ACTUALMENTE.** «Torneos» lista todos los torneos con nombre, formato, modo y estado, en palabras («Eliminación directa», «Deathmatch por equipos», «inscripciones abiertas»). Pulsa el nombre para abrir el detalle.

## Crear un torneo

**PARCIAL: sólo organizadores.** En «Crear torneo»:

| Campo | Opciones |
|---|---|
| **Nombre** | Hasta 64 caracteres |
| **Formato** | Liga, Todos contra todos (liguilla), Eliminación directa, Doble eliminación, Sistema suizo, Por equipos |
| **Modo** | Los 4 modos ([Modos de juego](game-modes.md)) |
| **Ruleset** | Texto libre; déjalo en `mvp-default` |

Sin el rol verás «Requiere rol organizer» después de pulsar crear. El torneo se crea con las inscripciones abiertas. No se pueden configurar desde la web el mapa, el presupuesto, las fechas ni el número de partidas por enfrentamiento.

## Inscribir un bot

**PARCIAL.** En el detalle del torneo, **«Inscribir bot»** → elige uno de tus bots → **«Inscribir»**. Se inscribe su **última versión publicada**, junto con su loadout, y ambos quedan fijados para el torneo.

| Mensaje | Causa |
|---|---|
| «X inscrito (vN)» | Correcto |
| «Ese bot no tiene ninguna versión publicada» | Hoy, siempre ([TD-001](../roadmap/technical-debt.md#td-001)) |
| «El bot ya está inscrito en este torneo» | Ya inscrito |
| «Las inscripciones no están abiertas» | Torneo cerrado |

## Cerrar inscripciones

**PARCIAL: sólo organizadores.** El botón **«Cerrar inscripciones»** se ve siempre, pero sin el rol responde «Requiere rol organizer». Al cerrar:

1. Verás «Inscripciones cerradas: versiones congeladas y semillas reveladas».
2. Las versiones inscritas quedan **congeladas** (`frozen`).
3. La plataforma genera el calendario y empieza a jugar sola.

## Seguir el torneo

**PARCIAL.**

- **Detalle**: la sección «Batallas» se refresca cada 5 s. Tiene **Cuadro** por rondas e **Historial**, con enlaces «Ver en directo» o «Ver replay». Los bots aparecen por su nombre y la versión que juega.
- **«Ver cuadro»** (`#/tournaments/<id>/bracket`): por ronda, «Partido 1», «Partido 2»…, su estado (pendiente, en juego, terminado, falló) y el ganador de cada enfrentamiento. Es de sólo lectura. El ganador sale como «bot» y su identificador abreviado: el cuadro aún no trae los nombres.
- **Clasificación del torneo**: no se muestra. El ranking general está en [Clasificaciones](rankings.md), que hoy sale vacío.
- **Directo y replay**: los enlaces llevan al visor y al reproductor, que hoy no se dibujan ([TD-009](../roadmap/technical-debt.md#td-009)).

## Errores / limitaciones

- **Versiones congeladas**: después de un torneo, tu versión queda `frozen` y no puede inscribirse en otro. Una versión nueva tampoco se puede publicar hoy.
- **Formato `teams`**: no se puede usar en la práctica, porque no hay forma de asignar bots a equipos ([TD-011](../roadmap/technical-debt.md#td-011)).
- **Carreras**: cerrar inscripciones dos veces a la vez puede dar un error interno ([TD-013](../roadmap/technical-debt.md#td-013)).
- **Batalla fallida**: si una batalla del torneo falla por un problema técnico, su enfrentamiento puede quedarse sin cerrar ([TD-015](../roadmap/technical-debt.md#td-015)).

## Estado actual

**PARCIAL**: el circuito completo funciona para un organizador con bots publicados; hoy no hay bots publicados.

## Documentación relacionada

- Usuario: [Batallas](battles.md), [Clasificaciones](rankings.md), [Equipos](teams.md), [Replays](replays.md)
- Técnica: [tournaments.md](../technical/tournaments.md)
- Deuda: [TD-015](../roadmap/technical-debt.md#td-015)
