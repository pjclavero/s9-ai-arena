# El ciclo de una batalla

## Los mensajes

Entre la batalla y tu bot se intercambian seis tipos de mensaje (protocolo `arena/1`). El SDK los gestiona por ti; tú sólo escribes los **cuatro hooks** (`on_welcome`, `on_observation`, `on_event`, `on_shutdown` en Python; `onWelcome`, `onObservation`, `onEvent`, `onShutdown` en JavaScript).

| Mensaje | Sentido | Cuándo | Hook |
|---|---|---|---|
| `HELLO` | bot → batalla | Al conectarse. Lo envía el SDK. | — |
| `WELCOME` | batalla → bot | **Una vez**, antes del primer tick: tus reglas, tu vehículo y el mapa. | `on_welcome` / `onWelcome` |
| `OBSERVATION` | batalla → bot | **Cada ciclo de decisión**: lo que ven tus sensores. | `on_observation` / `onObservation` (**obligatorio**) |
| `COMMAND` | bot → batalla | Tu respuesta a cada observación. El SDK lo envía con lo que devuelve tu hook. | (el valor que devuelves) |
| `EVENT` | batalla → bot | Cuando algo te concierne: un impacto, un rechazo… | `on_event` / `onEvent` |
| `SHUTDOWN` | batalla → bot | Último mensaje: la batalla terminó (o te han echado). | `on_shutdown` / `onShutdown` |

Un mensaje que tu SDK no entiende se ignora: un bot viejo no se rompe cuando el protocolo añade un campo.

## Tick y ciclo de decisión

- El juego avanza en **ticks**: **30 por segundo**.
- Tu bot decide cada **3 ticks**, o sea **10 veces por segundo**. Cada una de esas veces se llama a tu `on_observation`.
- Esos valores llegan en `welcome.timing`: `tickHz`, `decisionEveryNTicks`, `decisionDeadlineMs` y `maxConsecutiveTimeouts`. **Léelos de ahí** y no los fijes en tu código: una batalla puede tener otros.
- No tienes que poner el campo `forTick` en tus órdenes: el SDK lo calcula como `observation.tick + decisionEveryNTicks`.

```text
tick 0   tick 3    tick 6    tick 9    ...
  │        │         │         │
  ▼        ▼         ▼         ▼
OBSERVATION → tu código decide → COMMAND → se aplica en el siguiente ciclo
```

## El plazo para decidir

Cada orden tiene un plazo (`welcome.timing.decisionDeadlineMs`, 80 ms como mínimo). Si tu respuesta llega tarde **se descarta**; la batalla no te espera.

Cuando no llega una orden a tiempo, el vehículo aplica una **acción segura**: sigue con el **último movimiento** y la **última orden de torreta**, y **no dispara**.

Si pierdes demasiadas decisiones **seguidas** (`maxConsecutiveTimeouts`, 20 por defecto, unos 2 s) quedas **descalificado**: tu bot pierde la batalla. Lo mismo si el bot se cae o se desconecta más de 2 segundos. Consejos:

- Tu `on_observation` tiene que ser **rápido** (milisegundos). Nada de bucles largos ni de leer ficheros en cada ciclo.
- Haz los cálculos pesados una vez en `on_welcome`.
- Una excepción sin capturar en tu hook **termina tu proceso**: la batalla lo ve como una desconexión y te descalifica a los 2 segundos. Captura los errores que puedas prever.

El servidor acepta **un solo COMMAND por ciclo**; si llegara otro, se descarta y recibes un evento `rejected_action` con el motivo `extra_command_discarded`.

## Un comando imposible no te descalifica

Si ordenas disparar sin munición, con el arma en recarga o sin energía, **no pasa nada grave**: esa acción concreta se rechaza y recibes un [evento](eventos.md) `rejected_action` con el motivo. El resto de la orden sí se aplica.

Distinto es mandar una orden **mal formada** (un `throttle` de 5, un ángulo fuera de rango, un campo con el tipo equivocado): el mensaje entero se descarta, como si hubieras llegado tarde, y recibes un evento `rejected_action` con `reason: "invalid_command: <campo> <regla>"` que dice qué falló. Mira [Comandos](comandos.md#rangos-obligatorios).

## Coordenadas y unidades

- Distancias en **metros**. El mapa va de `(0, 0)` (esquina inferior izquierda) a `(widthM, heightM)`. `x` crece hacia la derecha e `y` hacia arriba. (En la web, el mapa se describe con **Ancho** y **Largo**; en el protocolo, `widthM` es el ancho y `heightM` el largo.)
- Ángulos en **radianes**, en sentido **antihorario**, con `0` apuntando hacia `+x`. Siempre en el rango `[-π, π]`.
- `heading` es hacia dónde mira el chasis; `turretHeading`, hacia dónde apunta la torreta. Ambos son absolutos (respecto al mapa), no relativos.
- Energía en **EU**, tiempo de recarga y duraciones en **ticks**.

## El mensaje de bienvenida (`WELCOME`)

Es la ficha de tu batalla. Guárdate en `on_welcome` lo que vayas a necesitar:

| Campo | Qué es |
|---|---|
| `battleId`, `selfId`, `team` | Identificador de la batalla, el de **tu vehículo** (`v_1`…; ids públicos de tu partida, no los internos del motor `veh_N`: cambio incompatible de la OLA 2, ver [Radio](radio.md)) y tu bando (`red`, `blue`…). |
| `teammates` | Ids de tus compañeros de equipo (no dice dónde están). Vacío si juegas solo. |
| `timing` | `tickHz`, `decisionEveryNTicks`, `decisionDeadlineMs`, `maxConsecutiveTimeouts`. |
| `rules` | `mode` (`deathmatch`, `team_deathmatch`, `capture_the_flag`, `zone_control`), `rulesetId`, `budgetCredits`, `timeLimitTicks`, `scoreToWin`, `friendlyFire`, `respawn` (`enabled`, `delayTicks`, `maxRespawns`), `sharedTeamVision` y los límites de `radio`. Los opcionales pueden faltar. |
| `vehicle` | **Tu loadout ya resuelto**: `chassis` (`hullHp`, `radiusM`), `modules` (cada uno con su `slot`, `moduleId`, `category` y `specs` con sus prestaciones), `massKg` y `energy` (`capacityEU`, `generationEUs`). |
| `map` | `mapId`, `mapVersion`, `widthM` y `heightM` (el ancho y el largo), y las listas `spawns` y `bases` (cada elemento con `team` y `position`). **No** trae los muros ni las cajas: para esquivarlos tienes que usar el lidar. |
| `versions` | Versiones del motor, las reglas, el catálogo y el protocolo. |

El `slot` de cada módulo de `vehicle.modules` es el nombre que usarás en tus órdenes: por ejemplo, `fire: ["turret_main"]` dispara el arma montada en la ranura `turret_main`. **No supongas** que se llama así: tu loadout puede ser distinto. Busca los módulos por su `category` (`weapon`, `sensor`, `radio`, `mine`…), como hacen los [ejemplos](ejemplos.md).

## Cuando termina: `SHUTDOWN`

`shutdown.reason` es uno de: `battle_finished` (normal), `protocol_version_unsupported`, `handshake_failed`, `invalid_message`, `timeout_disqualified`, `disconnected`, `suspended` o `engine_error`. Con `battle_finished` trae `result` (`outcome`: `win`, `loss`, `draw` o `disqualified`; `score`; `ticks`). Tienes `gracePeriodMs` (500 ms por defecto) para guardar lo que quieras antes de que se corte tu proceso.

Tu bot **no se reconecta** solo: si la conexión se pierde, el SDK termina y la batalla sigue sin ti.

## Siguiente

- [Qué contiene la observación](observaciones.md)
- [Qué puedes ordenar](comandos.md)
