# Órdenes (comandos)

Lo que devuelve tu `on_observation` / `onObservation` es la orden del ciclo (`COMMAND`). **Todos los campos son opcionales**: `{}` significa «sin cambios» y es una orden válida. El SDK añade `forTick` por ti.

```python
return {
    "move":   {"throttle": 0.8, "steer": -0.2},
    "turret": {"targetPoint": {"x": 70, "y": 40}},
    "fire":   ["turret_main"],
}
```

| Campo | Qué ordena |
|---|---|
| `move` | Acelerar y girar. |
| `turret` | Hacia dónde apuntar la torreta. |
| `fire` | Qué armas disparar. |
| `deployMine` | Soltar una mina. |
| `modules` | Encender o apagar módulos. |
| `radio` | Enviar mensajes de radio ([guía](radio.md)). |
| `utility` | Activar una utilidad. **Se acepta pero no hace nada**: el catálogo no tiene utilidades. |
| `debug` | Anotaciones tuyas para depurar (hasta 16 claves). La simulación las ignora por completo; sólo se guardan en tus replays privados. |

## Movimiento: `move`

```python
{"move": {"throttle": 1.0, "steer": 0.0}}
```

- `throttle` de `-1` (marcha atrás a fondo) a `1` (avance a fondo). `0` es parar.
- `steer` de `-1` (girar a la derecha a fondo) a `1` (girar a la izquierda a fondo).
- Es un control **arcade**: tú das la intención y el motor la convierte en velocidad según tu módulo de movimiento y tu masa (ver [Movimiento](../equipment-catalog.md#movimiento)). Aceleras y giras poco a poco, no instantáneamente.
- Si no mandas `move`, el vehículo **sigue con el último**. Para pararte tienes que ordenar `throttle: 0`.
- Sin un módulo de movimiento operativo el vehículo queda inmóvil (la torreta sigue funcionando).

Para ir hacia un punto:

```python
from arena_sdk import angle_diff, angle_to
giro = angle_diff(me["heading"], angle_to(me["position"], punto))   # cuánto girar, en [-π, π]
move = {"throttle": 0.8, "steer": max(-1.0, min(1.0, giro * 2))}
```

## Torreta: `turret`

Da **una** de estas dos cosas (las dos a la vez es un error):

- `targetHeading`: un ángulo absoluto en radianes (`[-π, π]`).
- `targetPoint`: un punto `{x, y}` del mapa; el motor calcula el ángulo desde tu posición.

La torreta **gira a su velocidad** (rad/s, depende del arma) hacia ese objetivo: no se teletransporta. Como el proyectil sale **hacia donde apunta la torreta en ese momento** (más una pequeña dispersión), dispara cuando `turretHeading` ya esté cerca del ángulo que quieres. Si no mandas `turret`, mantiene el último objetivo. Un punto con valores no numéricos se ignora.

## Disparo: `fire`

```python
{"fire": ["turret_main"]}
```

- Lista de **ranuras de arma** (hasta 8, sin repetir). Usa las de tu loadout: las encuentras en `welcome.vehicle.modules` con `category == "weapon"`.
- Es una **intención**, no un hecho: el arma sólo dispara si está operativa, no está en recarga, tiene munición y energía. Si no, recibes un evento `rejected_action` con el motivo ([Armas y munición](armas-y-municion.md)).
- Pide `fire` en cada ciclo en que quieras disparar; la cadencia la limita la recarga del arma, no tú.

## Minas: `deployMine`

```python
{"deployMine": {"slot": "mine_bay", "armDelayTicks": 30}}
```

Suelta una mina **donde estás**. Necesitas una mina montada en la bahía de minas (sólo chasis medio y pesado). `armDelayTicks` (0 a 300) es la espera hasta que se arma; se usa el mayor entre éste y el propio de la mina. Hay un máximo de minas activas por vehículo, cooldown, cargas y energía; si falla, `rejected_action` (`cooldown`, `no_charges`, `no_energy`, `limit_exceeded`, `invalid_position`…). El motor crea la mina, nunca tú.

## Módulos: `modules`

```python
{"modules": [{"slot": "sensor_b", "enabled": False}]}
```

Enciende o apaga módulos (hasta 16 por orden) para ahorrar energía. Un módulo apagado no consume ni funciona; volver a encenderlo tarda 15 ticks (medio segundo), y si lo pides antes recibes `rejected_action` con el motivo `reactivating`. Una ranura que no existe da `unknown_slot`.

## Radio: `radio`

Hasta 2 mensajes por orden: `[{"slot": "radio_a", "data": "<base64>", "to": "v_2"}]`. Detalle en [Radio](radio.md).

## Rangos obligatorios

Si una orden incumple el contrato, **se descarta entera** y recibes un `rejected_action` con `invalid_command: <campo> <regla>`. Cuenta como una decisión perdida. Los límites:

| Campo | Límite |
|---|---|
| `throttle`, `steer` | números entre `-1` y `1` |
| `targetHeading` | número entre `-π` y `π` (suma y resta con cuidado: `heading + angle` puede salirse del rango) |
| `targetPoint` | `{x, y}` numéricos |
| `fire` | hasta 8 ranuras distintas |
| `modules` | hasta 16 elementos, cada uno con `slot` y `enabled` |
| `radio` | hasta 2 mensajes por orden |
| `debug` | hasta 16 claves |
| Cualquier otro campo | no se permiten campos que no estén en esta tabla |

Un valor `NaN` o infinito en el movimiento o la torreta se ignora (se conserva el anterior), pero no confíes en eso: el SDK no valida por ti. Una función auxiliar para ajustar ángulos:

```python
import math
def envuelve(a):            # lleva cualquier ángulo a [-π, π]
    return math.atan2(math.sin(a), math.cos(a))
```

```javascript
const envuelve = (a) => Math.atan2(Math.sin(a), Math.cos(a));
```

Siguiente: [Armas y munición](armas-y-municion.md) · [Radio](radio.md).
