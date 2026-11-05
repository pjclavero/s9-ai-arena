# Radio

La radio permite que tus vehículos se pasen mensajes cortos. La radio permite compartir información con los bots de tu propio equipo. Los bots rivales no reciben estos mensajes.

Necesitas **un módulo de radio** montado (en los chasis actuales, la ranura `radio_a`; algunos arquetipos, como el pesado, no la llevan). Busca su ranura en `welcome.vehicle.modules` con `category == "radio"`, igual que con las armas.

## Enviar

En tu orden, un campo `radio` con **hasta 2 mensajes**:

```python
{"radio": [{"slot": "radio_a", "data": "AAEAAg=="}]}                    # a todo tu equipo
{"radio": [{"slot": "radio_a", "data": "AAEAAg==", "to": "veh_2"}]}      # sólo a veh_2
```

- `data` es el contenido en **base64**. Para el motor es opaco: tú decides el formato.
- Tamaño máximo: **32 bytes** reales por mensaje (unos 44 caracteres en base64). Los valores exactos de tu batalla están en `welcome.rules.radio`.
- Ritmo máximo: **2 mensajes por segundo** por vehículo. Controla tú el ritmo con `observation.tick` (30 ticks = 1 segundo), como en el [ejemplo de radio](ejemplos.md#5-radio).
- `to` es el `entityId` de un compañero (uno de `welcome.teammates`). Sin `to`, es una **difusión** a todo tu equipo. Un `to` a un rival no llega a nadie.
- Los mensajes llegan con **un ciclo de decisión de retraso** (unas décimas de segundo).

Si un mensaje no se puede enviar, no pasa nada grave: recibes un evento `radio_dropped` con el motivo (`no_radio`, `too_large`, `rate_limited` o `queue_full`).

## Recibir

Los mensajes que te llegan vienen en `observation.radio`, **en el ciclo en que se entregan**:

```json
"radio": [ { "from": "veh_2", "data": "AAEAAg==", "sentTick": 117 } ]
```

Decodifica `data` y haz con él lo que quieras. Un mensaje se entrega **una sola vez**: si lo necesitas, guárdalo.

```python
import base64, struct
x, y = struct.unpack(">HH", base64.b64decode(msg["data"]))
```

```javascript
const bytes = Buffer.from(msg.data, "base64");
const x = bytes.readUInt16BE(0), y = bytes.readUInt16BE(2);
```

Tu propia emisión no te llega a ti.

## Lo que tienes que saber (limitaciones de hoy)

- **No hay alcance.** El catálogo declara un alcance para la radio, pero la simulación no lo aplica: el mensaje llega a cualquier distancia.
- **Sólo tu equipo.** La radio permite compartir información con los bots de tu propio equipo. Los bots rivales no reciben estos mensajes. Si juegas sin compañeros (por ejemplo, en un 1 contra 1), nadie recibe lo que mandas.
- **El replay sí los guarda.** Al terminar la batalla, quien pueda ver su replay (también el dueño de un bot rival) ve los mensajes de radio de los dos bandos. Durante la batalla, ningún bot rival los recibe.
- Para **enviar** necesitas una radio montada. Hoy la simulación entrega los mensajes también a vehículos sin radio, pero no cuentes con ello: es un detalle que puede cambiar.

## Para qué sirve

- Avisar a un compañero de dónde has visto a un rival (tú viste algo que su radar no ve).
- Repartir papeles o coordinar un ataque («voy por la bandera, tú cubre»).
- Pasar un número pequeño, no texto: con 32 bytes cabe un tipo de mensaje, un par de coordenadas y poco más.

Ejemplo completo con codificación y control de ritmo: [05_radio](ejemplos.md#5-radio). Para repartir papeles **sin** gastar radio, mira [06_equipo](ejemplos.md#6-equipo).

Siguiente: [Objetivos](objetivos.md).
