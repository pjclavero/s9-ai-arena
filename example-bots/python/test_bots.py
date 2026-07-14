"""
T5.4 · DoD de los bots oficiales en Python: cada uno gana >=95% de 20 batallas
contra un stub inmóvil, con semilla distinta por batalla (winrate exacto, sin
redondear). Requiere `pip install -e sdks/python` (ver sdks/python/README.md).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))


def _load_bot_class(filename: str, class_name: str):
    spec = importlib.util.spec_from_file_location(filename.replace(".py", ""), HERE / filename)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return getattr(module, class_name)


@pytest.mark.parametrize(
    "filename,class_name,archetype",
    [
        ("explorer.py", "ExplorerBot", "scout"),
        ("defender.py", "DefenderBot", "heavy"),
    ],
)
def test_bot_beats_immobile_opponent_at_least_95_percent(filename: str, class_name: str, archetype: str) -> None:
    from arena_sdk import LocalSimulator

    bot_cls = _load_bot_class(filename, class_name)
    n = 20
    wins = 0
    for i in range(n):
        # botId debe cumplir hello.schema.json: ^bot_[0-9a-zA-Z]{1,24}$ (sin guion bajo tras el prefijo).
        bot = bot_cls(f"bot_{class_name.lower()}wr{i}")
        # tick_interval_ms acelerado (15 ms): ventana de decisión 45 ms, holgada para el
        # round-trip de un subproceso Python, sin correr 20 batallas en tiempo real.
        sim = LocalSimulator(map="empty", ruleset="dm_practice@1", ticks=900,
                             seed=f"{class_name}-winrate-{i}", tick_interval_ms=15)
        result = sim.run(bots=[(bot, archetype)], stub_bots=[(f"bot_immobile{i}", "scout", "idle")])
        if result["winner"] == "red" and "veh_1" not in result["disqualified"]:
            wins += 1

    winrate = wins / n
    print(f"\n{class_name} vs inmóvil: {wins}/{n} = {winrate * 100:.1f}%")
    assert winrate >= 0.95, f"{class_name}: solo {wins}/{n} ({winrate * 100:.1f}%), se exige >=95%"
