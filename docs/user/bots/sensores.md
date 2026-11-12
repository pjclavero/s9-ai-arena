# Sensores

Tu vehículo sólo percibe el mundo a través de los **sensores** que hayas montado en el [editor de loadout](../equipment.md). Cada sensor operativo añade un bloque dentro de `observation.sensors`; si no hay ninguno, la clave `sensors` no existe. Un sensor destruido o apagado desaparece de la observación, y uno muy dañado (`critical`) puede fallar en algunos ciclos.

Con un sensor dañado, además, el alcance baja en proporción (un `damaged` rinde al 60 %).

Hay cuatro tipos. Cada bloque lleva siempre la `slot` del módulo que lo produce, porque puedes montar más de uno (por ejemplo, un chasis pesado tiene dos ranuras de sensor).

| Sensor | Clave | Qué te da | Qué no te da |
|---|---|---|---|
| Radar | `sensors.radar` | Vehículos con línea de visión, con posición **aproximada**. | Posición exacta; vehículos tras un muro. |
| Lidar | `sensors.lidar` | Una fila de rayos con distancia y qué tocan. | Qué vehículo es; lo que hay fuera de su cono. |
| Proximidad | `sensors.proximity` | Si algo (vehículo o mina) está muy cerca, y en qué direcciones. | Qué es ni a cuánta distancia exacta. |
| Acústico | `sensors.acoustic` | La dirección de disparos, motores y explosiones. | Dónde están: sólo la dirección. |

Alcances, campos de visión, costes y consumo de cada sensor: [Catálogo de equipamiento](../equipment-catalog.md#sensores).

## Radar

```json
"radar": [ { "slot": "sensor_a", "contacts": [
  { "entityId": "v_3", "kind": "vehicle", "position": {"x": 78.4, "y": 41.9},
    "velocity": {"x": -6.1, "y": 0.2}, "errorM": 2, "confidence": 0.62 }
] } ]
```

- Detecta **vehículos vivos** a **360°** dentro de su alcance, y sólo si hay **línea de visión**: un muro o una caja entre medias lo bloquea.
- La `position` lleva un **error aleatorio** de hasta `errorM` metros en cada eje (más si el radar está dañado). La `velocity` es exacta.
- `confidence` va de 0 a 1 y baja con la distancia.
- El `entityId` sólo se revela si el contacto está en la **primera mitad** del alcance. Más lejos es un eco sin identificar.
- El `team` **sólo aparece si el contacto es un aliado**. Un contacto sin `team` es un rival: `[c for c in contacts if "team" not in c]` te da los enemigos.

## Lidar

```json
"lidar": [ { "slot": "sensor_a", "originHeading": 0.1, "fovRad": 1.5708, "rays": [
  { "angle": -0.78, "distanceM": 45, "hit": "unknown" },
  { "angle":  0.00, "distanceM": 12.3, "hit": "wall" }
] } ]
```

- Lanza varios rayos repartidos en un cono (`fovRad`; el lidar 360 los reparte en círculo) y mide hasta dónde llega cada uno.
- **`angle` es relativo a tu morro**: el ángulo absoluto de un rayo es `heading + angle` (sácalo al rango `[-π, π]` si lo vas a usar como `targetHeading`). `originHeading` es tu `heading` en ese momento.
- `distanceM` es la distancia hasta lo que toca el rayo. Si no toca nada, vale el alcance del sensor y `hit` es `"unknown"`.
- `hit` dice qué tocó: `wall` (muro), `vehicle` (vehículo, sin decir cuál), `destructible` (caja), o `unknown` si nada.
- Con el lidar dañado se usa la mitad de los rayos.
- Es el sensor para **esquivar muros** y para localizar un vehículo cercano; no dice a qué bando pertenece.

## Proximidad

```json
"proximity": [ { "slot": "sensor_a", "triggered": true, "bearings": [1.2, -2.9] } ]
```

- `triggered` es `true` si hay algo dentro del alcance; `bearings` son las direcciones **absolutas** (radianes) hacia cada cosa.
- Detecta **vehículos y minas**, también a través de muros: no necesita línea de visión.
- Sirve de alarma: «alguien está encima».

## Acústico

```json
"acoustic": [ { "slot": "sensor_b", "sources": [ { "bearing": 2.1, "kind": "gunshot", "intensity": 0.7 } ] } ]
```

- `kind` es `gunshot` (disparo), `engine` (motor en marcha) o `explosion`; `intensity` baja con la distancia.
- `bearing` es una dirección **absoluta**. **Nunca** da posición: sólo «el sonido viene de ahí». Con dos lecturas desde sitios distintos puedes triangular.
- Oye los sonidos del ciclo anterior.

## Consejos

- Mira siempre qué bloques hay: `observation.get("sensors", {}).get("radar", [])`. Tu código tiene que funcionar con **cualquier** loadout.
- El radar encuentra, el lidar esquiva, el acústico avisa de lo que no ves y la proximidad avisa del peligro inmediato.
- Los vehículos que ves por el radar pueden ser tus compañeros: filtra por `team`.
- Un ejemplo que usa los cuatro: [04_sensores](ejemplos.md#4-sensores).

Siguiente: [Comandos](comandos.md).
