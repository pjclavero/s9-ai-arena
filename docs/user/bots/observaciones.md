# La observación

En cada ciclo de decisión recibes una **observación** (`OBSERVATION`): tu estado más lo que han percibido tus sensores. Es lo único que sabes. Regla de oro de la arena: **no existe información oculta que se pueda deducir**. Si un rival está fuera del alcance de tus sensores, no aparece, ni siquiera marcado como «oculto».

```json
{
  "tick": 120,
  "self": { "position": {"x": 41.2, "y": 40.0}, "heading": 0.1, "velocity": {"x": 7.8, "y": 0.4}, "hullHp": 300, "...": "..." },
  "sensors": { "radar": [ { "slot": "sensor_a", "contacts": [ ... ] } ] },
  "radio": [ { "from": "v_2", "data": "AAEAAg==", "sentTick": 117 } ],
  "score": { "red": 1, "blue": 0 },
  "objectives": [ { "kind": "flag", "team": "red", "state": "at_base" } ]
}
```

| Campo | Siempre | Qué es |
|---|---|---|
| `tick` | sí | El tick de la simulación (30 por segundo). |
| `self` | sí | Tu propio estado (abajo). |
| `sensors` | no | Un bloque por cada sensor **operativo**. Ver [Sensores](sensores.md). Si no tienes ninguno, la clave no existe. |
| `radio` | no | Mensajes de radio que te llegan en este ciclo. Ver [Radio](radio.md). |
| `score` | no | Marcador público del modo, por bando (`{"red": 1, "blue": 0}`). |
| `objectives` | no | Estado público de banderas y zonas. Ver [Objetivos](objetivos.md). |

En Python estos son diccionarios (`observation["self"]`, `observation.get("sensors", {})`); en JavaScript, objetos (`observation.self`, `observation.sensors ?? {}`). **Usa siempre `.get` / `?.`** con los campos opcionales.

## Tu estado: `self`

| Campo | Qué es |
|---|---|
| `position` | `{x, y}` en metros. Exacta (la tuya no tiene error). |
| `heading` | Hacia dónde mira el chasis, en radianes (`0` = hacia `+x`, antihorario). |
| `velocity` | `{x, y}` en m/s. |
| `angularVelocity` | Giro del chasis en rad/s. |
| `turretHeading` | Hacia dónde apunta la torreta (absoluto). La torreta gira poco a poco hacia donde le ordenes. |
| `hullHp`, `hullHpMax` | Vida actual y máxima del casco. A 0, el vehículo muere. |
| `energy` | `storedEU` (reserva), `capacityEU` (máximo) y `netFlowEUs` (generación menos consumo, por segundo). |
| `armor` | Estado del blindaje por sector (`front`, `left`, `right`, `rear`), de 0 a 1. Sólo aparecen los sectores donde llevas blindaje. |
| `modules` | El estado de **cada módulo instalado** (abajo). |
| `carryingFlag` | `null`, o el bando dueño de la bandera que llevas (en captura de bandera). |
| `respawningInTicks` | Sólo si estás muerto y te queda una reaparición: ticks que faltan. |

### Los módulos: `self.modules`

Cada elemento tiene:

| Campo | Qué es |
|---|---|
| `slot` | La ranura (`turret_main`, `sensor_a`, `radio_a`…). Es el nombre que usas en las órdenes. |
| `state` | `operational`, `damaged`, `critical`, `destroyed` u `offline`. |
| `healthFraction` | Vida del módulo, de 0 a 1. |
| `cooldownTicks` | Sólo mientras se recarga: ticks que faltan para poder volver a usarlo. |
| `ammo` | Sólo en munición y minas: **disparos o cargas que te quedan**. |

Un módulo dañado rinde menos: `damaged` al 60 %, `critical` al 25 % y de forma intermitente (puede no dar lectura en un ciclo), `destroyed` y `offline` al 0 %. Tu bot **siempre sabe** cómo está su hardware, incluso si se ha quedado ciego: un radar destruido simplemente deja de aparecer en `sensors` y su estado en `modules` pasa a `destroyed`.

Para saber cuánta munición te queda, busca en `self.modules` el módulo de la ranura de munición (`ammo_main` en los chasis actuales, o la ranura cuya `category` en el [WELCOME](ciclo.md#el-mensaje-de-bienvenida-welcome) sea `ammo`) y lee su `ammo`.

## Cuando mueres

Si tu vehículo muere y las reglas te dejan reaparecer, seguirás recibiendo observaciones, con `respawningInTicks` indicando cuánto falta; las órdenes que des mientras tanto no tienen efecto. Si te quedas sin reapariciones, el vehículo queda eliminado. Cuántas vidas tienes lo dice `welcome.rules.respawn` (y [Modos de juego](../game-modes.md)).

## Qué NO te cuenta la observación

- La posición exacta de los rivales (el radar la da con error; el lidar y el acústico, solo direcciones o distancias).
- Dónde están tus compañeros, salvo que los vea tu radar o te lo diga la radio.
- Los muros: llegan como impactos del lidar, no como una lista.
- Las minas enemigas, salvo que las detecte el sensor de proximidad.
- La visión compartida del equipo: el campo `sharedTeamVision` existe en las reglas del contrato, pero hoy la simulación no lo aplica. Cada bot ve únicamente con sus propios sensores (para compartir lo que ves, usa la [radio](radio.md)).
