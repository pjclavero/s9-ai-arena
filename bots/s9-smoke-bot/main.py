#!/usr/bin/env python3
"""s9-smoke-bot · bot mínimo OFICIAL para la batalla E2E de humo (R6.2).

Corre DENTRO del runtime de bots (runtimes/python), aislado en un contenedor sin
red externa ni acceso a la plataforma. Lee su configuración SOLO del entorno (nunca
secretos) y conecta por WebSocket al ProtocolServer del motor:

    WS_URL        ws://<engineHost>:<puerto>   (lo inyecta el orquestador)
    BATTLE_TOKEN  token de esta batalla para este bot
    BOT_ID        identificador del bot

Estrategia mínima y determinista (misma del bot tutorial del SDK): apunta al contacto
más cercano y dispara; si no ve a nadie, patrulla. No usa IA externa ni dependencias
fuera del SDK. Su único fin es cerrar el primer circuito real de extremo a extremo.

AVISO CRUZADO (B3): apps/api/src/db/seeds/demo-teams.ts deriva de ESTE fichero el
bot "Artillero" de la plantilla de demo-teams (función deriveArtilleroSource),
recortando el lanzador de proceso (la función de entrada, el import del módulo
de entorno, el import de compatibilidad de anotaciones) y quedándose solo con la
definición de la clase del bot. Esa función depende de dos marcadores TEXTUALES
exactos de este fichero, que por eso NO se citan aquí letra por letra (citarlos
haría que el propio texto de este aviso coincidiera con ellos): el inicio de la
línea "class" + nombre de la clase, y las tres líneas en blanco que separan esa
clase de la función de entrada del proceso, más abajo en este fichero. Si
renombras la clase, mueves su función de entrada, o cambias cuántas líneas en
blanco las separan, revisa y actualiza deriveArtilleroSource en demo-teams.ts.
La derivación falla EN RUIDOSO si no encuentra los marcadores donde los espera
(lanza con un mensaje explícito), no en silencio — pero mejor evitar el susto:
si tocas la forma de este fichero, mira primero quién depende de ella.
"""
from __future__ import annotations

import os
import sys

from arena_sdk import ArenaBot, angle_diff, angle_to


class SmokeBot(ArenaBot):
    """Bot determinista mínimo: perseguir-apuntar-disparar / patrullar."""

    def on_observation(self, observation):
        me = observation["self"]
        contacts = [
            c
            for r in observation.get("sensors", {}).get("radar", [])
            for c in r["contacts"]
        ]

        if not contacts:
            # Sin nadie a la vista: patrulla suave para explorar.
            return {"move": {"throttle": 0.8, "steer": 0.2}}

        target = min(
            contacts,
            key=lambda c: (c["position"]["x"] - me["position"]["x"]) ** 2
            + (c["position"]["y"] - me["position"]["y"]) ** 2,
        )
        turn = angle_diff(me["heading"], angle_to(me["position"], target["position"]))
        return {
            "move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, turn * 1.5))},
            "turret": {"targetPoint": target["position"]},
            "fire": ["turret_main"],
        }


def main() -> int:
    ws_url = os.environ.get("WS_URL")
    battle_token = os.environ.get("BATTLE_TOKEN")
    bot_id = os.environ.get("BOT_ID", "s9-smoke-bot")

    if not ws_url or not battle_token:
        print(
            "s9-smoke-bot: faltan WS_URL y/o BATTLE_TOKEN en el entorno",
            file=sys.stderr,
        )
        return 2

    # sdk_name usa el valor por defecto "arena-sdk-python" (el HELLO exige un nombre
    # del enum del protocolo; ver hello.schema.json → sdk.name).
    bot = SmokeBot(bot_id=bot_id, bot_version="0.1.0")
    bot.run(ws_url, battle_token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
