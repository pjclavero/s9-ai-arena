# Batallas

## Resumen

Una **batalla de práctica** enfrenta a dos de tus bots publicados (rojo contra azul) en un mapa publicado. No cuenta para el ranking. Se crea en **«Batallas» → «+ Nueva batalla de práctica»**.

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

**Lo que debes saber**: los vehículos los conduce un bot de prueba interno de la plataforma, **no tu código**. Tu equipamiento sí se aplica. La pantalla no lo avisa ([TD-002](../roadmap/technical-debt.md#td-002)).

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

Tras crear una batalla aparece el botón **«Ejecutar batalla real»**, que ejecutaría tu código de verdad en un entorno aislado. **PENDIENTE**:

- está desactivado en este entorno: «Ejecución real no disponible en este entorno (deshabilitada).»;
- si no eres administrador, el botón sale siempre deshabilitado.

## Errores / limitaciones

- No se pueden elegir más de 2 bots, equipos, ni un loadout distinto por batalla.
- La plataforma no comprueba que el mapa admita el modo.
- La nota de la pantalla habla del «runner containerizado» y de un «arnés»: es información técnica que puedes ignorar.

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

**PENDIENTE desde la web**; la lista funciona.

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Bots](bots.md), [Replays](replays.md), [Visor](viewer.md), [Torneos](tournaments.md)
- Técnica: [battles.md](../technical/battles.md) (ciclo completo paso a paso)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-003](../roadmap/technical-debt.md#td-003)
