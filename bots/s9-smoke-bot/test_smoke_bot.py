"""Test de protocolo del s9-smoke-bot SIN red ni Docker.

Comprueba que `on_observation` devuelve COMMANDs válidos de forma:
 - sin contactos: patrulla (solo `move`),
 - con un contacto: se mueve, apunta al objetivo y dispara.

La ejecución REAL (WS + contenedor + batalla completa) es un paso de VM108, gateado
aparte. Este test protege el contrato mínimo que el orquestador espera del bot.
"""
import importlib.util
import os

_HERE = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location("s9_smoke_bot_main", os.path.join(_HERE, "main.py"))
assert _spec and _spec.loader
_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_main)
SmokeBot = _main.SmokeBot


def _obs(contacts):
    return {
        "self": {"position": {"x": 0.0, "y": 0.0}, "heading": 0.0},
        "sensors": {"radar": [{"contacts": contacts}]},
    }


def test_patrulla_sin_contactos():
    bot = SmokeBot(bot_id="t")
    cmd = bot.on_observation(_obs([]))
    assert "move" in cmd
    assert "fire" not in cmd
    assert -1.0 <= cmd["move"]["steer"] <= 1.0


def test_apunta_y_dispara_con_contacto():
    bot = SmokeBot(bot_id="t")
    cmd = bot.on_observation(_obs([{"position": {"x": 10.0, "y": 0.0}}]))
    assert "move" in cmd
    assert cmd.get("turret", {}).get("targetPoint") == {"x": 10.0, "y": 0.0}
    assert cmd.get("fire") == ["turret_main"]
    assert -1.0 <= cmd["move"]["steer"] <= 1.0
