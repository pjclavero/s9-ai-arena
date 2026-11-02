# SDK de Python

El SDK de Python (`arena-sdk`, módulo `arena_sdk`) es el que usa la plataforma para ejecutar tus bots en Python 3.11. Está en el repositorio, en `sdks/python`.

## El contrato mínimo

Un fichero Python con **una subclase de `ArenaBot`** (si defines varias, llama `Bot` a la que debe jugar) que **implementa `on_observation(self, observation)`** y devuelve la orden del ciclo (`{}` = sin cambios).

```python
from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.8, "steer": 0.2}}
```

- Si tu clase no implementa `on_observation` —o lo escribes mal, por ejemplo `on_observaton`— la validación lo **rechaza** con un mensaje que te dice cómo se escribe. Un bot que se queda quieto a propósito implementa el hook y devuelve `{}`.
- No hace falta conectar nada: la plataforma instancia tu clase, la conecta a la batalla y llama a tus hooks.
- Al pegar un único fichero en la web, la plataforma lo coloca como `src/bot.py` junto con un `requirements.txt` que fija la versión del SDK.

## Los hooks

```python
class MiBot(ArenaBot):
    def on_welcome(self, welcome):
        """Una vez, antes del primer tick. Guarda aquí lo que necesites del mapa y de tu vehículo."""

    def on_observation(self, observation) -> dict:
        """Cada ciclo de decisión (10 por segundo). OBLIGATORIO. Devuelve la orden."""
        return {}

    def on_event(self, event):
        """Impactos, rechazos de órdenes, capturas..."""

    def on_shutdown(self, shutdown):
        """Último mensaje. Tienes shutdown.get("gracePeriodMs", 500) ms para guardar algo."""
```

`welcome`, `observation`, `event` y `shutdown` son **diccionarios** con los campos de la guía ([ciclo](ciclo.md), [observación](observaciones.md), [eventos](eventos.md)). Tras el `WELCOME`, `self.welcome` también los conserva. No hace falta rellenar `forTick`: el SDK lo calcula.

## Tipos y ayudas

- `arena_sdk.types` define `TypedDict` (`Observation`, `Command`, `Welcome`, `Event`, `Shutdown`, `Vec2`…) para que tu editor autocomplete. No validan nada en ejecución: son sólo ayuda para escribir.
- Geometría, en metros y radianes:

```python
from arena_sdk import distance, angle_to, angle_diff

d = distance(me["position"], blanco["position"])        # metros
rumbo = angle_to(me["position"], blanco["position"])    # ángulo absoluto hacia el blanco
giro = angle_diff(me["heading"], rumbo)                 # cuánto girar, en [-π, π]
```

## Qué puedes importar

La plataforma analiza tu código antes de ejecutarlo. Puedes usar la **biblioteca estándar de Python** salvo los módulos que dan acceso al sistema, y los paquetes `arena_sdk`, `websocket-client` y `numpy`.

Se rechazan, entre otros: `os`, `subprocess`, `socket`, `ctypes`, `multiprocessing`, `asyncio`, `pickle`, `shutil`, `pathlib`, `tempfile`, `importlib`, `eval`/`exec` dinámicos y cualquier paquete no permitido. No puedes añadir dependencias desde la web. Más en [Probar tu bot](probar.md#qué-comprueba-la-validación).

## Probarlo en tu ordenador

Necesitas el repositorio (es público: `git clone https://github.com/pjclavero/s9-ai-arena.git`; sin él puedes escribir y validar el bot en el editor de la web, pero no usar el simulador local), Python 3.11 o superior y Node.js 22 o superior (el simulador local ejecuta el **motor real**; no hay una reimplementación en Python).

```bash
cd sdks/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
arena-sim mi_bot.py --archetype gunner --opponent idle --ticks 1800
```

`arena-sim` juega tu bot contra un rival interno (`idle`, `hunter`, `circle` o `forward`) y escribe el resultado de la batalla. Sin la CLI:

```python
from arena_sdk import LocalSimulator
from mi_bot import Bot

bot = Bot("bot_mio01")
sim = LocalSimulator(map="empty", ruleset="dm_practice@1", ticks=1800, seed="prueba-1")
result = sim.run(bots=[(bot, "gunner")], stub_bots=[("bot_rival01", "scout", "hunter")])
print(result["winner"])
```

Los arquetipos son loadouts de ejemplo del catálogo (`scout`, `gunner`, `miner`, `heavy`); mapas: `empty`, `mvp` y `ctf`. Más en [Probar tu bot](probar.md).

## Versión y estado

Versión del SDK: la que fija el fichero `requirements.txt` que genera la plataforma (hoy, la 0.1.0 del repositorio). Hay un SDK de referencia en JavaScript con el mismo ciclo de vida: [SDK de JavaScript](javascript.md).
