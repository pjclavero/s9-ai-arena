# Batallas

## Resumen

Una **batalla de práctica** enfrenta a dos bots publicados (rojo contra azul) en un mapa publicado. No cuenta para el ranking. Se crea en **«Batallas» → «+ Nueva batalla de práctica»**. Puedes usar **tus bots** (aunque sean privados), bots **públicos** de otros y bots de un **equipo** del que eres miembro; nunca los bots privados de otra persona.

**Cuando la plataforma la ejecuta, la juega el código de cada bot**, cada uno en su propio contenedor aislado: lo que hace tu bot en la batalla es lo que programaste (comprobado en un entorno de pruebas; en este servidor la ejecución aún no está activada, ver [Estado actual](#estado-actual)).

**Hoy, crear una batalla desde la web falla siempre** con el mensaje rojo «rulesetId desconocido», en cualquier modo ([TD-003](../roadmap/technical-debt.md#td-003)). Además necesitas dos versiones publicadas, que hoy no se pueden obtener ([TD-001](../roadmap/technical-debt.md#td-001)). La única forma de que se jueguen batallas desde la web es un **torneo** ([Torneos](tournaments.md)).

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

**PENDIENTE (falla al crear).** Pantalla «Nueva batalla de práctica»:

| Campo | Opciones |
|---|---|
| **Modo** | `deathmatch`, `team_deathmatch`, `capture_the_flag`, `zone_control` ([Modos de juego](game-modes.md)) |
| **Mapa publicado** | Mapas en estado `published` |
| **Semilla (opcional)** | La misma semilla repite la misma batalla |
| **Bot rojo** / **Bot azul** | Bots con versión publicada, `nombre (vN)` |

Pulsa **«Crear batalla»**. Puedes ver:

- «Elige un mapa publicado.», «Elige dos bots con versión publicada.» o «Elige dos bots distintos.»: falta algo en el formulario.
- «Necesitas al menos 2 bots con versión publicada.» o «No hay mapas publicados disponibles.»: el botón está deshabilitado.
- **«rulesetId desconocido»**: es lo que verás hoy siempre al crear. La web pide unas reglas con un nombre que la plataforma no tiene registrado.

Mientras la página carga, los selectores salen vacíos unos instantes.

## Qué pasa después

Si la batalla llegara a crearse:

1. Verías «Batalla encolada» y el identificador de la batalla.
2. La plataforma la juega sola en pocos segundos.
3. Aparecería en «Batallas» como `finished`, con el enlace «Ver replay».

**PARCIAL.** Los vehículos los conduce **el código de cada bot**, con su equipamiento. La batalla se juega una sola vez, aunque pulses dos veces o la plataforma reintente. Dura lo que dicen las reglas (unos 5 minutos en tiempo real a lo sumo), así que puede verse `running` en directo.

Si en este servidor la ejecución no está activada, la batalla se queda en `scheduled` («en cola»): no se juega con ningún bot de prueba en su lugar.

## Lista de batallas

**FUNCIONA ACTUALMENTE.** «Batallas» muestra todas las batallas de la plataforma, no sólo las tuyas, con:

- participantes (`4de60bd0 v1 vs …`, el identificador del bot abreviado);
- modo y mapa;
- estado;
- torneo (enlace);
- **Ver**: «Ver en directo» si está en curso, «Ver replay» si terminó o «en cola».

Puedes filtrar por **Estado** (todas, `scheduled`, `running`, `finished`, `failed`). Desde «Mis bots», el enlace «batallas» filtra por un bot (sólo sobre la primera página de resultados).

## Resultado

**PARCIAL.** La lista no muestra ganador ni marcador. El estado `finished` aparece con un «(none)» en rojo que **no es un error**: significa «sin fallos» ([TD-022](../roadmap/technical-debt.md#td-022)). El ganador, el marcador y las estadísticas existen en la plataforma, pero no tienen pantalla ([Estadísticas](statistics.md)).

Estados de una batalla:

| Estado | Significado |
|---|---|
| `scheduled` | Encolada |
| `running` | En juego (dura segundos) |
| `finished` | Terminada |
| `failed (infrastructure)` | No pudo jugarse. También ocurre cuando la combinación de modo y mapa es imposible |

## Ejecutar batalla real

Ya no hace falta y el botón «Ejecutar batalla real» ya no existe: **toda** batalla se ejecuta con el código publicado de sus bots al crearla. Tras «Crear batalla», sigue su estado en **Batallas** y abre el replay cuando termine.

## Errores / limitaciones

- No se pueden elegir más de 2 bots, equipos, ni un loadout distinto por batalla.
- El mismo bot no puede estar dos veces en una batalla (ni con dos versiones distintas).
- Si eliges un bot privado de otra persona, la plataforma responde como si no existiera («no existe o no es accesible»).
- Si tu bot no llega a conectarse a la batalla, pierde por descalificación; si deja de responder durante la batalla, queda `disqualified`.
- La plataforma no comprueba que el mapa admita el modo.
- La nota de la pantalla habla del «runner containerizado» y de un «arnés»: es información técnica que puedes ignorar.

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

- **PARCIAL**: la ejecución con el código real de los bots, la propiedad de los bots y el resultado (ganador por bot, marcador, estadísticas) funcionan y están comprobados en un entorno de pruebas aislado. En este servidor la ejecución **todavía no está activada** (falta completar el entorno de ejecución de bots, [TD-001](../roadmap/technical-debt.md#td-001)); las batallas quedan en cola.
- **PENDIENTE desde la web**: crear la batalla depende de [TD-003](../roadmap/technical-debt.md#td-003). La lista funciona.

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Bots](bots.md), [Replays](replays.md), [Visor](viewer.md), [Torneos](tournaments.md)
- Técnica: [battles.md](../technical/battles.md) (ciclo completo paso a paso)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-003](../roadmap/technical-debt.md#td-003), [TD-005](../roadmap/technical-debt.md#td-005)
