"""
T5.2 · Contract tests del SDK Python contra los esquemas reales de E1.

Dos capas:
1. La suite COMPARTIDA de sdks/shared-contract-tests/cases/*.json (generada por E1
   vía sdks/shared-contract-tests/generate-cases.mjs a partir de
   packages/protocol/examples/): cada caso trae un envelope y si debe validar o no.
   Este mismo directorio lo consume también el SDK de JavaScript (T5.3) — no hay una
   copia de la suite por lenguaje.
2. Mensajes REALES capturados de una batalla real contra el motor de E2 (vía
   LocalSimulator/protocol-server.ts): demuestra que lo que el SDK realmente
   envía y recibe, no solo los ejemplos estáticos, valida contra el contrato.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

sys.path.insert(0, str(Path(__file__).parent))
from arena_sdk import ArenaBot, LocalSimulator
from arena_sdk.simulator import repo_root

SCHEMA_DIR = repo_root() / "packages" / "protocol" / "schemas"
CASES_DIR = repo_root() / "sdks" / "shared-contract-tests" / "cases"
ENGINE_DEPS = json.loads((repo_root() / "apps" / "arena-engine" / "src" / "engine-deps.json").read_text(encoding="utf-8"))


def _build_validator() -> Draft202012Validator:
    resources = []
    for f in SCHEMA_DIR.glob("*.json"):
        schema = json.loads(f.read_text(encoding="utf-8"))
        resources.append((f.name, Resource.from_contents(schema)))
    registry = Registry().with_resources(resources)
    envelope_schema = json.loads((SCHEMA_DIR / "envelope.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(envelope_schema, registry=registry)


VALIDATOR = _build_validator()


def _load_cases() -> list[dict]:
    return [json.loads(f.read_text(encoding="utf-8")) for f in sorted(CASES_DIR.glob("*.json"))]


CASES = _load_cases()


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_case(case: dict) -> None:
    errors = list(VALIDATOR.iter_errors(case["envelope"]))
    if case["kind"] == "valid":
        assert errors == [], f"{case['name']} debía validar: {[e.message for e in errors]}"
    else:
        assert errors != [], f"{case['name']} debía SER RECHAZADO ({case.get('why')}) pero validó"


def test_shared_cases_directory_is_not_empty() -> None:
    # Si esto falla, alguien apuntó CASES_DIR mal: el resto de la suite pasaría "vacía y en verde".
    assert len(CASES) >= 30


# --------------------------------------------------------- mensajes reales del SDK
class RecordingBot(ArenaBot):
    """Bot que registra cada envelope entrante/saliente real, para validarlos."""

    def __init__(self, bot_id: str):
        super().__init__(bot_id)
        self.captured: list[dict] = []

    def on_observation(self, observation):
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r["contacts"]]
        if contacts:
            return {"move": {"throttle": 0.5, "steer": 0.1}, "turret": {"targetPoint": contacts[0]["position"]}, "fire": ["turret_main"]}
        return {"move": {"throttle": 0.7, "steer": 0.05}}

    def _debug_on_message(self, msg: dict) -> None:
        self.captured.append(msg)

    def _debug_on_send(self, msg: dict) -> None:
        self.captured.append(msg)


@pytest.fixture(scope="module")
def real_battle_capture() -> list[dict]:
    bot = RecordingBot("bot_contract1")
    sim = LocalSimulator(map="empty", ruleset="dm_practice@1", ticks=300, seed="contract-capture")
    sim.run(bots=[(bot, "gunner")], stub_bots=[("bot_opp01", "scout", "hunter")])
    return bot.captured


def test_real_messages_validate_against_e1_schemas(real_battle_capture: list[dict]) -> None:
    assert len(real_battle_capture) > 5  # de verdad hubo tráfico (WELCOME + varias OBSERVATION/COMMAND)
    by_type: dict[str, int] = {}
    for msg in real_battle_capture:
        errors = list(VALIDATOR.iter_errors(msg))
        assert errors == [], f"{msg.get('type')} (seq {msg.get('seq')}) no valida: {[e.message for e in errors]}"
        by_type[msg["type"]] = by_type.get(msg["type"], 0) + 1
    assert by_type.get("HELLO", 0) >= 1
    assert by_type.get("WELCOME", 0) >= 1
    assert by_type.get("OBSERVATION", 0) >= 1
    assert by_type.get("COMMAND", 0) >= 1


def test_welcome_reports_the_real_engine_version(real_battle_capture: list[dict]) -> None:
    """La prueba de que el simulador local usa el motor REAL de E2, no una
    reimplementación en Python: la versión que reporta WELCOME es la misma que
    apps/arena-engine/src/engine-deps.json."""
    welcome = next(m for m in real_battle_capture if m["type"] == "WELCOME")
    assert welcome["payload"]["versions"]["engine"] == ENGINE_DEPS["engine"]["version"]
    assert welcome["payload"]["versions"]["physics"] == f"{ENGINE_DEPS['physics']['package']}@{ENGINE_DEPS['physics']['version']}"


# ------------------------------------------------------------------------ E2E
def test_tutorial_bot_defeats_an_immobile_bot() -> None:
    """El bot del README (ver sdks/python/README.md) derrota a un bot inmóvil de verdad."""
    tutorial_path = repo_root() / "sdks" / "python" / "tests" / "_tutorial_bot.py"
    import importlib.util

    spec = importlib.util.spec_from_file_location("tutorial_bot", tutorial_path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]

    bot = module.TutorialBot("bot_tutorial01")
    sim = LocalSimulator(map="empty", ruleset="dm_practice@1", ticks=1800, seed="tutorial-vs-immobile")
    result = sim.run(bots=[(bot, "gunner")], stub_bots=[("bot_immobile01", "scout", "idle")])

    assert result["winner"] == "red"
    assert "veh_1" not in result["disqualified"]
