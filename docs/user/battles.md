# Batallas

## Resumen

Una **batalla de práctica** enfrenta a dos bots publicados (rojo contra azul) en un mapa publicado. No cuenta para el ranking. Se crea en **«Batallas» → «+ Nueva batalla de práctica»**. Puedes usar **tus bots** (aunque sean privados), bots **públicos** de otros y bots de un **equipo** del que eres miembro; nunca los bots privados de otra persona.

**La batalla la juega el código de cada bot**, cada uno en su propio contenedor aislado y con su loadout: lo que hace tu bot en la batalla es lo que programaste.

Necesitas dos bots con versión publicada ([Bots](bots.md)). Las batallas oficiales, que sí cuentan para el ranking, salen de los **torneos** ([Torneos](tournaments.md)).

## Índice

- [Crear una batalla de práctica](#crear-una-batalla-de-práctica)
- [Qué pasa después](#qué-pasa-después)
- [Lista de batallas](#lista-de-batallas)
- [Resultado](#resultado)
- [Ejecutar batalla real](#ejecutar-batalla-real)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Crear una batalla de práctica

**FUNCIONA ACTUALMENTE.** Pantalla «Nueva batalla de práctica»:

| Campo | Opciones |
|---|---|
| **Modo** | `deathmatch`, `team_deathmatch`, `capture_the_flag`, `zone_control` ([Modos de juego](game-modes.md)) |
| **Ruleset** | Las reglas disponibles para ese modo |
| **Mapa publicado** | Mapas en estado `published` que admiten el modo |
| **Semilla (opcional)** | La misma semilla repite la misma batalla |
| **Equipo rojo** / **Equipo azul (opcional)** | Filtra los bots por equipo |
| **Bot rojo** / **Bot azul** | Bots con versión publicada, `nombre (vN)` |

Pulsa **«Crear batalla»**. Puedes ver:

- «Elige un mapa publicado que soporte el modo.», «Elige dos bots con versión publicada.» o «Elige dos bots distintos.»: falta algo en el formulario.
- «Necesitas al menos 2 bots con versión publicada.» o «No hay mapas publicados que soporten el modo …»: el botón está deshabilitado.

Mientras la página carga, los selectores salen vacíos unos instantes.

## Qué pasa después

Al crearla:

1. Ves «Batalla encolada» y el identificador de la batalla.
2. La plataforma la reclama de la cola y la juega sola.
3. Aparece en «Batallas» como `running` (con «Ver en directo») y, al terminar, como `finished`, con el enlace «Ver replay».

**FUNCIONA ACTUALMENTE.** Los vehículos los conduce **el código de cada bot**, con su equipamiento. La batalla se juega una sola vez, aunque pulses dos veces o la plataforma reintente. Dura lo que dicen las reglas (unos 5 minutos en tiempo real a lo sumo), así que puede verse `running` en directo.

Si la ejecución de batallas no estuviera activada en la plataforma, la batalla se quedaría en `scheduled` («en cola»): nunca se juega con un bot de prueba en su lugar.

## Lista de batallas

**FUNCIONA ACTUALMENTE.** «Batallas» muestra todas las batallas de la plataforma, no sólo las tuyas, con:

- participantes (`4de60bd0 v1 vs …`, el identificador del bot abreviado);
- modo y mapa;
- estado;
- torneo (enlace);
- **Ver**: «Ver en directo» si está en curso, «Ver replay» si terminó o «en cola».

Puedes filtrar por **Estado** (todas, `scheduled`, `running`, `finished`, `failed`). Desde «Mis bots», el enlace «batallas» filtra por un bot (sólo sobre la primera página de resultados).

## Resultado

**FUNCIONA ACTUALMENTE.** La lista muestra el resultado (ganador o empate), el marcador y la duración ([TD-022](../roadmap/technical-debt.md#td-022)). Las estadísticas por bot se consultan por API, `GET /api/v1/battles/{id}/stats` ([Estadísticas](statistics.md)).

Estados de una batalla:

| Estado | Significado |
|---|---|
| `scheduled` | Encolada |
| `running` | En juego (hasta unos 5 minutos en tiempo real) |
| `finished` | Terminada |
| `failed (infrastructure)` | No pudo jugarse. También ocurre cuando la combinación de modo y mapa es imposible |

## Ejecutar batalla real

Ya no hace falta y el botón «Ejecutar batalla real» ya no existe: **toda** batalla se ejecuta con el código publicado de sus bots al crearla. Tras «Crear batalla», sigue su estado en **Batallas** y abre el replay cuando termine.

## Errores / limitaciones

- No se pueden elegir más de 2 bots, equipos, ni un loadout distinto por batalla.
- El mismo bot no puede estar dos veces en una batalla (ni con dos versiones distintas).
- Si eliges un bot privado de otra persona, la plataforma responde como si no existiera («no existe o no es accesible»).
- Si tu bot no llega a conectarse a la batalla, pierde por descalificación; si deja de responder durante la batalla, queda `disqualified`.
- Si el mapa no admite el modo, la plataforma rechaza la batalla (409) y no llega a encolarse.

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear la batalla desde la web ([TD-003](../roadmap/technical-debt.md#td-003), cerrada), la ejecución con el código real de los bots ([TD-002](../roadmap/technical-debt.md#td-002), cerrada), la propiedad de los bots, la lista y el resultado (ganador por bot, marcador; estadísticas por API).

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Bots](bots.md), [Replays](replays.md), [Visor](viewer.md), [Torneos](tournaments.md)
- Técnica: [battles.md](../technical/battles.md) (ciclo completo paso a paso)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-003](../roadmap/technical-debt.md#td-003), [TD-005](../roadmap/technical-debt.md#td-005)
