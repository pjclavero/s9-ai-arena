"""
DOC-A · BOT_EXAMPLES (Python).

Los seis ejemplos de la guía del programador de bots (docs/user/bots/examples/python/)
se ejecutan aquí de verdad con el SDK real contra el motor real (LocalSimulator), y cada
COMMAND que envían se valida contra el esquema arena/1 de packages/protocol. Además, el
bloque de código de la guía (docs/user/bots/ejemplos.md) es idéntico al fichero.

Límite honesto: LocalSimulator reparte los bots en equipos alternos (rojo, azul). Con tres
bots, el primero y el tercero son compañeros: así se prueba 05_radio (dos compañeros y un
rival). La cooperación REAL de 06_equipo se prueba con los ejemplos JavaScript
(sdks/javascript/tests/docs-examples.test.ts); aquí 06_equipo se ejecuta en solitario
(sin compañeros), que es el caso "escuadra de uno" de su propia lógica.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from arena_sdk import ArenaBot, LocalSimulator
from arena_sdk.simulator import repo_root

ROOT = repo_root()
EX_DIR = ROOT / "docs" / "user" / "bots" / "examples" / "python"
SCHEMA_DIR = ROOT / "packages" / "protocol" / "schemas"
FILES = sorted(p.name for p in EX_DIR.glob("*.py"))


def _validator() -> Draft202012Validator:
    resources = [(f.name, Resource.from_contents(json.loads(f.read_text(encoding="utf-8")))) for f in SCHEMA_DIR.glob("*.json")]
    envelope = json.loads((SCHEMA_DIR / "envelope.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(envelope, registry=Registry().with_resources(resources))


VALIDATOR = _validator()


def _load(name: str) -> type[ArenaBot]:
    spec = importlib.util.spec_from_file_location("doc_example_" + name.replace(".py", ""), EX_DIR / name)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module.Bot


def _recorded(base: type[ArenaBot]) -> type[ArenaBot]:
    """Envuelve un ejemplo SIN tocar su lógica: sólo graba lo que envía y lo que recibe."""

    class Recorded(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self.sent: list[dict] = []
            self.observations: list[dict] = []

        def _debug_on_send(self, msg: dict) -> None:
            if msg.get("type") == "COMMAND":
                self.sent.append(msg)

        def on_observation(self, observation):
            self.observations.append(observation)
            return super().on_observation(observation)

    return Recorded


def _assert_valid_commands(bot) -> None:
    assert len(bot.sent) > 10
    for m in bot.sent:
        errors = [e.message for e in VALIDATOR.iter_errors(m)]
        assert errors == [], f"COMMAND inválido {m}: {errors}"


def _sim(ticks: int, map: str = "empty", ruleset: str = "dm_practice@1") -> LocalSimulator:
    return LocalSimulator(map=map, ruleset=ruleset, ticks=ticks, seed="doc-a-" + str(ticks), tick_interval_ms=6)


def test_hay_seis_ejemplos() -> None:
    assert FILES == ["01_minimo.py", "02_patrulla.py", "03_atacante.py", "04_sensores.py", "05_radio.py", "06_equipo.py"]


@pytest.mark.parametrize("name", FILES)
def test_el_ejemplo_es_una_subclase_con_el_hook(name: str) -> None:
    bot_cls = _load(name)
    assert issubclass(bot_cls, ArenaBot)
    assert bot_cls.on_observation is not ArenaBot.on_observation


def test_01_minimo_avanza() -> None:
    bot = _recorded(_load("01_minimo.py"))("bot_ex01")
    result = _sim(600).run([(bot, "scout")], stub_bots=[("bot_idle01", "scout", "idle")])
    assert result["disqualified"] == []
    _assert_valid_commands(bot)
    first, last = bot.observations[0]["self"]["position"], bot.observations[-1]["self"]["position"]
    assert ((last["x"] - first["x"]) ** 2 + (last["y"] - first["y"]) ** 2) ** 0.5 > 10


def test_02_patrulla_completa_tramos() -> None:
    bot = _recorded(_load("02_patrulla.py"))("bot_ex02")
    result = _sim(1500).run([(bot, "scout")], stub_bots=[("bot_idle02", "scout", "idle")])
    assert result["disqualified"] == []
    _assert_valid_commands(bot)
    assert len(bot.route) == 4
    assert bot.leg >= 1


def test_03_atacante_gana_a_un_rival_inmovil() -> None:
    bot = _recorded(_load("03_atacante.py"))("bot_ex03")
    result = _sim(1800).run([(bot, "gunner")], stub_bots=[("bot_idle03", "scout", "idle")])
    assert result["disqualified"] == []
    _assert_valid_commands(bot)
    assert result["winner"] == "red"


@pytest.mark.parametrize("archetype", ["scout", "gunner", "heavy"])
def test_04_sensores_con_cada_sensor(archetype: str) -> None:
    bot = _recorded(_load("04_sensores.py"))("bot_ex04")
    result = _sim(900).run([(bot, archetype)], stub_bots=[("bot_hunt04", "scout", "hunter")])
    assert result["disqualified"] == []
    _assert_valid_commands(bot)
    kinds = {k for o in bot.observations for k in o.get("sensors", {})}
    assert kinds, "la observación no trajo ningún bloque de sensor"


def test_05_radio_envia_y_recibe() -> None:
    cls = _recorded(_load("05_radio.py"))
    # Bandos alternos: veh_1 y veh_3 son compañeros (rojo); veh_2 es el rival (azul).
    a, rival, b = cls("bot_ex05a"), cls("bot_ex05r"), cls("bot_ex05b")
    result = _sim(900, ruleset="tdm_mvp@1").run([(a, "gunner"), (rival, "gunner"), (b, "gunner")])
    assert result["disqualified"] == []
    _assert_valid_commands(a)
    assert a.teammates == ["veh_3"] and b.teammates == ["veh_1"] and rival.teammates == []
    assert any("radio" in m["payload"] for m in a.sent + b.sent)
    # Los compañeros se oyen entre ellos, y sólo entre ellos.
    assert a.heard + b.heard, "ningún compañero recibió ni decodificó un mensaje de radio"
    assert all(h["from"] == "veh_3" for h in a.heard)
    assert all(h["from"] == "veh_1" for h in b.heard)
    assert all(h["x"] >= 0 and h["y"] >= 0 for h in a.heard + b.heard)
    # El rival no recibe nada: ni mensajes ni una clave "radio" en su observación.
    assert rival.heard == []
    assert not any("radio" in o for o in rival.observations)
    # Sin compañeros, el ejemplo no gasta radio.
    assert not any("radio" in m["payload"] for m in rival.sent)


def test_06_equipo_en_solitario_es_atacante_y_no_falla() -> None:
    bot = _recorded(_load("06_equipo.py"))("bot_ex06")
    result = _sim(900, map="ctf").run([(bot, "gunner")], stub_bots=[("bot_idle06", "scout", "idle")])
    assert result["disqualified"] == []
    _assert_valid_commands(bot)
    assert bot.role == "attacker"


def test_los_bloques_de_la_guia_son_identicos_a_los_ficheros() -> None:
    guia = (ROOT / "docs" / "user" / "bots" / "ejemplos.md").read_text(encoding="utf-8")
    bloques = re.findall(r"```python\n(.*?)```", guia, re.S)
    for name in FILES:
        assert (EX_DIR / name).read_text(encoding="utf-8") in bloques, f"{name} no aparece tal cual en la guía"
