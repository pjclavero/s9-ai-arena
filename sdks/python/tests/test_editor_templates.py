"""
UX-F (DEF-R7) · dos bots de la PLANTILLA Python del editor (apps/web/src/bot-templates.ts),
con el loadout de artillero (radar + cañón), se encuentran y disparan en el mapa MVP.

Antes la plantilla «patrullaba» girando en el sitio: con el radar a 50 m y las salidas a
100 m, dos plantillas no se veían nunca (5 min sin un disparo, medido por la revisión).
Aquí corre el texto de la plantilla TAL CUAL, con el SDK real, contra el motor real
(LocalSimulator). Se cuentan las órdenes de disparo que da cada bot; el gemelo de la
plantilla JS (apps/arena-engine/tests/uxf-editor-templates.test.ts) cuenta además los
disparos aceptados por el motor con las estadísticas de producción.
"""
from __future__ import annotations

import re

from arena_sdk import ArenaBot, LocalSimulator
from arena_sdk.simulator import repo_root

TEMPLATES = repo_root() / "apps" / "web" / "src" / "bot-templates.ts"


def _template_class() -> type[ArenaBot]:
    source = TEMPLATES.read_text(encoding="utf-8")
    m = re.search(r"export const PYTHON_TEMPLATE = `(.*?)`;", source, re.S)
    assert m, "no se encuentra PYTHON_TEMPLATE en bot-templates.ts"
    ns: dict = {}
    exec(compile(m.group(1), "bot.py", "exec"), ns)
    return ns["Bot"]


def test_two_templates_find_and_shoot_each_other_within_five_minutes() -> None:
    base = _template_class()

    class Counted(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self.fire_orders = 0

        def on_observation(self, observation):
            cmd = super().on_observation(observation)
            if cmd.get("fire"):
                self.fire_orders += 1
            return cmd

    red, blue = Counted("bot_tplred"), Counted("bot_tplblue")
    sim = LocalSimulator(map="mvp", ticks=9000, seed="uxf-templates", tick_interval_ms=4)
    result = sim.run([(red, "gunner"), (blue, "gunner")])
    assert result["ticks"] > 0
    assert red.fire_orders > 0, f"la plantilla roja no disparó: {result}"
    assert blue.fire_orders > 0, f"la plantilla azul no disparó: {result}"
