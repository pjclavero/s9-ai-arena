# arena-sdk (Python)

SDK de referencia en Python para bots de [S9 AI Arena](../../README.md), protocolo `arena/1`.

## Instalar

```bash
cd sdks/python
python -m venv .venv
.venv/Scripts/activate        # Windows. En Linux/Mac: source .venv/bin/activate
pip install -e ".[dev]"
```

Necesitas Node.js 22+ en el `PATH` además de Python: el simulador local (`arena-sim`,
`LocalSimulator`) levanta el motor **real** de E2 como subproceso — no hay una
reimplementación de la física ni de las reglas en Python. Si `npx` no está en el
`PATH`, `LocalSimulator.run()` lo dice explícitamente en el error.

## Tu primer bot, en 30 líneas

```python
from arena_sdk import ArenaBot, angle_diff, angle_to


class TutorialBot(ArenaBot):
    def on_observation(self, observation):
        me = observation["self"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r["contacts"]]

        if not contacts:
            return {"move": {"throttle": 0.8, "steer": 0.2}}  # sin nadie a la vista: patrulla

        target = min(contacts, key=lambda c: (c["position"]["x"] - me["position"]["x"]) ** 2
                     + (c["position"]["y"] - me["position"]["y"]) ** 2)
        bearing = angle_to(me["position"], target["position"])
        turn = angle_diff(me["heading"], bearing)

        return {
            "move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, turn * 1.5))},
            "turret": {"targetPoint": target["position"]},
            "fire": ["turret_main"],
        }
```

Guárdalo como `my_bot.py` y córrelo contra un bot inmóvil en el simulador local:

```bash
arena-sim my_bot.py --archetype gunner --opponent idle --ticks 1800
```

Imprime el `BattleResult` real (ganador, marcador, hash de estado). El propio
código de arriba es exactamente `tests/_tutorial_bot.py`, que
`tests/test_contract.py::test_tutorial_bot_defeats_an_immobile_bot` ejecuta de
verdad en cada `pytest`: si el README miente, el test falla.

## El ciclo de vida

```python
class MiBot(ArenaBot):
    def on_welcome(self, welcome):
        """Una vez, al aceptar la batalla. welcome['timing'] trae los valores REALES
        de esta batalla (decisionDeadlineMs, decisionEveryNTicks...) — nunca asumas
        constantes hardcodeadas, esta batalla puede tener un ruleset distinto."""

    def on_observation(self, observation) -> dict:
        """Se llama cada ciclo de decisión. Devuelve un dict con la intención del
        siguiente ciclo (move/turret/fire/deployMine/modules/utility/radio); un
        dict vacío significa 'sin cambios'. No hace falta poner 'forTick': el SDK
        lo calcula solo a partir de observation['tick']."""
        return {}

    def on_event(self, event):
        """Impactos, capturas, rechazos de acción (rejected_action)... Un evento
        solo llega si tu bot podía percibirlo (niebla de guerra, D8)."""

    def on_shutdown(self, shutdown):
        """Último mensaje. shutdown['result'] trae outcome/score/ticks si la razón
        es 'battle_finished'. Dispones de shutdown['gracePeriodMs'] (500 ms por
        defecto) para persistir algo antes de que el proceso se corte."""
```

Conectar contra una batalla real (fuera del simulador local, p. ej. la plataforma):

```python
bot = MiBot("bot_mio01")
bot.run("wss://arena.example/ws", battle_token="el-token-que-te-dio-la-plataforma")
```

`run()` **no reconecta**. Si el transporte cae, el bucle termina y el proceso sale;
reconectar (o no) es decisión de quien opera el bot, no del SDK — igual que un
comando que llega tarde no se reintenta, se descarta.

## Tipos

`arena_sdk.types` usa `TypedDict`, no `dataclasses` ni Pydantic. La razón: los
mensajes llegan del socket como `dict` ya parseados de JSON, y un `TypedDict` los
tipa para el editor/mypy **sin** un paso de conversión que pueda rechazar un campo
que el SDK todavía no conoce — es la regla 5 del protocolo ("ignora lo que no
entiendes") aplicada al sistema de tipos: un dict con un campo extra sigue siendo
válido para el TypedDict (no hay validación en tiempo de ejecución), así que un bot
viejo no se rompe cuando el protocolo añade un campo en un release menor.

## Geometría

```python
from arena_sdk import distance, angle_to, angle_diff

d = distance(me["position"], target["position"])          # metros
bearing = angle_to(me["position"], target["position"])     # radianes absolutos, D1
turn = angle_diff(me["heading"], bearing)                  # cuánto girar, en [-pi, pi]
```

## Simulador local sin la CLI

```python
from arena_sdk import LocalSimulator
from my_bot import MiBot

bot = MiBot("bot_mio01")
sim = LocalSimulator(map="mvp", ruleset="tdm_mvp@1", ticks=3000, seed="prueba-1")
result = sim.run(
    bots=[(bot, "gunner")],                              # tus bots reales, por WebSocket
    stub_bots=[("bot_rival01", "scout", "hunter")],       # oponentes internos del motor (sin escribir código)
)
print(result["winner"], result["finalStateHash"])
```

`stub_bots` acepta `idle` (quieto), `hunter` (persigue y dispara), `circle` (gira) y
`forward` (avanza recto) — los mismos `BotStub`s que usa el motor de E2 para sus
propios tests, útiles para probar tu bot sin escribir un segundo bot.

## Tests

```bash
pytest tests/ -v
```

Dos capas: la suite compartida de `sdks/shared-contract-tests/cases/*.json` (los
mismos casos que usa el SDK de JavaScript) y mensajes **reales** capturados de una
batalla real contra el motor, ambos validados contra
`packages/protocol/schemas/*.json` de E1.
