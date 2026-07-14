"""
T5.2 · Simulador local: motor REAL de E2 (vía apps/arena-engine/src/local-sim.ts)
levantado como subproceso Node, sin Docker ni plataforma. Conecta bots de Python
locales por WebSocket contra ese motor real.

La prueba de que no hay una reimplementación paralela en Python: el WELCOME que
recibe cada bot trae versions.engine con el mismo valor que
apps/arena-engine/src/engine-deps.json (ver tests/test_contract.py).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from .bot import ArenaBot


def repo_root() -> Path:
    env = os.environ.get("ARENA_REPO_ROOT")
    if env:
        return Path(env)
    # sdks/python/arena_sdk/simulator.py -> parents[3] == raíz del repo.
    return Path(__file__).resolve().parents[3]


def _node_script() -> Path:
    return repo_root() / "apps" / "arena-engine" / "src" / "local-sim.ts"


class LocalSimulator:
    """Levanta una batalla real y conecta bots de Python locales, todo en el mismo proceso host."""

    def __init__(self, map: str = "empty", ruleset: str = "dm_practice@1", ticks: int = 900, seed: str = "local-sim",
                 tick_interval_ms: int | None = None):
        self.map = map
        self.ruleset = ruleset
        self.ticks = ticks
        self.seed = seed
        # Acelera el bucle (por defecto tiempo real ~33 ms/tick). Útil para correr
        # muchas batallas seguidas en un test sin esperar en tiempo real.
        self.tick_interval_ms = tick_interval_ms
        self._proc: subprocess.Popen | None = None

    def run(self, bots: list[tuple[ArenaBot, str]], stub_bots: list[tuple[str, str, str]] | None = None) -> dict[str, Any]:
        """bots: [(instancia_ArenaBot, arquetipo_de_catalogo), ...].
        stub_bots opcional: [(botId, arquetipo, kind), ...] para oponentes internos
        del motor (idle/hunter/circle/forward), sin necesidad de escribir un bot real."""
        npx = shutil.which("npx")
        if npx is None:
            raise RuntimeError(
                "No se encuentra 'npx' en el PATH. El simulador local necesita Node.js "
                "instalado (el motor real de E2 corre en Node, no hay reimplementación en Python)."
            )
        bots_arg = ",".join(f"{b.bot_id}:{arch}" for b, arch in bots)
        cmd = [
            npx, "tsx", str(_node_script()),
            "--map", self.map, "--ruleset", self.ruleset,
            "--ticks", str(self.ticks), "--seed", self.seed,
            "--bots", bots_arg,
        ]
        if stub_bots:
            cmd += ["--stub-bots", ",".join(f"{bid}:{arch}:{kind}" for bid, arch, kind in stub_bots)]
        if self.tick_interval_ms is not None:
            cmd += ["--tick-interval-ms", str(self.tick_interval_ms)]

        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(repo_root()),
        )
        assert self._proc.stdout is not None

        ready_line = self._proc.stdout.readline()
        if not ready_line:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"El motor local no arrancó (¿npm install en la raíz del repo?):\n{err}")
        ready = json.loads(ready_line)
        port = ready["port"]
        token_by_bot = {b["botId"]: b["battleToken"] for b in ready["bots"]}

        threads = []
        for bot, _arch in bots:
            token = token_by_bot[bot.bot_id]
            t = threading.Thread(target=bot.run, args=(f"ws://127.0.0.1:{port}", token), daemon=True)
            t.start()
            threads.append(t)

        result = None
        for line in self._proc.stdout:
            data = json.loads(line)
            if data.get("event") == "result":
                result = data["result"]
                break

        for t in threads:
            t.join(timeout=2)
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()

        if result is None:
            raise RuntimeError("El motor local terminó sin emitir un resultado")
        return result


def cli() -> None:
    """`arena-sim`: corre el bot del tutorial (example-bots o el tuyo) contra un stub inmóvil."""
    import argparse
    import importlib.util

    parser = argparse.ArgumentParser(prog="arena-sim", description="Simulador local de S9 AI Arena (motor real, sin Docker).")
    parser.add_argument("bot_file", help="Ruta a un .py con una clase ArenaBot (usa la primera que encuentre).")
    parser.add_argument("--archetype", default="scout", help="Arquetipo del catálogo (scout|gunner|miner|heavy).")
    parser.add_argument("--opponent", default="idle", choices=["idle", "hunter", "circle", "forward"])
    parser.add_argument("--opponent-archetype", default="scout")
    parser.add_argument("--map", default="empty")
    parser.add_argument("--ruleset", default="dm_practice@1")
    parser.add_argument("--ticks", type=int, default=900)
    parser.add_argument("--seed", default="cli-sim")
    args = parser.parse_args()

    spec = importlib.util.spec_from_file_location("user_bot_module", args.bot_file)
    if spec is None or spec.loader is None:
        raise SystemExit(f"No se pudo cargar {args.bot_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    bot_cls = None
    for name in dir(module):
        obj = getattr(module, name)
        if isinstance(obj, type) and issubclass(obj, ArenaBot) and obj is not ArenaBot:
            bot_cls = obj
            break
    if bot_cls is None:
        raise SystemExit(f"{args.bot_file} no define ninguna subclase de ArenaBot")

    bot = bot_cls("bot_cli01")
    sim = LocalSimulator(map=args.map, ruleset=args.ruleset, ticks=args.ticks, seed=args.seed)
    result = sim.run(
        bots=[(bot, args.archetype)],
        stub_bots=[("bot_opp01", args.opponent_archetype, args.opponent)],
    )
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    cli()
