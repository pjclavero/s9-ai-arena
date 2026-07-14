"""Runner genérico: instancia una clase ArenaBot de un archivo .py y la conecta a
una batalla ya arrancada. Lo usa el test de integración CTF cross-lenguaje
(example-bots/ctf-integration.test.ts) para lanzar los bots de Python como
subprocesos reales, exactamente como correría un bot en producción.

Uso: python _run_bot.py <archivo.py> <NombreClase> <botId> <url_ws> <battleToken>
"""
import importlib.util
import sys
from pathlib import Path


def main() -> None:
    bot_file, class_name, bot_id, url, token = sys.argv[1:6]
    spec = importlib.util.spec_from_file_location("bot_module", Path(bot_file))
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    bot_cls = getattr(module, class_name)
    bot = bot_cls(bot_id)
    bot.run(url, token)


if __name__ == "__main__":
    main()
