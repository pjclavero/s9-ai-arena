/**
 * DEV-A · código de usuario REAL para los tests del sandbox (lo que un usuario
 * pegaría en la web). Se empaqueta con el mismo `wrapSingleFile` que usa la API.
 */
import { wrapSingleFile } from "../../api/src/services/source-package.js";
import type { SourceFile } from "../src/types.js";

/** Bot mínimo válido: patrulla y, si ve a alguien, apunta y dispara. */
export const PY_GOOD = `import math
from arena_sdk import ArenaBot, angle_diff, angle_to


class Bot(ArenaBot):
    def on_observation(self, observation):
        me = observation["self"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r["contacts"]]
        if not contacts:
            return {"move": {"throttle": 0.8, "steer": 0.2}}
        t = contacts[0]
        turn = angle_diff(me["heading"], angle_to(me["position"], t["position"]))
        return {
            "move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, turn * 1.5))},
            "turret": {"targetPoint": t["position"]},
            "fire": ["turret_main"],
        }
`;

/** Segunda versión distinta (para historial/diff). */
export const PY_GOOD_V2 = PY_GOOD.replace('"throttle": 0.8, "steer": 0.2', '"throttle": 0.9, "steer": -0.3');

/** Compila y pasa el análisis estático, pero viola el protocolo (throttle 5 ∉ [-1,1]). */
export const PY_BAD_PROTOCOL = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 5, "steer": 0}}
`;

/** Se cuelga al importar: nunca hace HELLO (timeout de arranque). */
export const PY_HANG = `from arena_sdk import ArenaBot

n = 0
while True:
    n += 1


class Bot(ArenaBot):
    pass
`;

/** Revienta en cuanto recibe la primera observación. */
export const PY_CRASH = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        raise RuntimeError("fallo deliberado del bot")
`;

/** No es Python válido: lo rechaza el análisis estático (AST) antes del sandbox. */
export const PY_SYNTAX_ERROR = `from arena_sdk import ArenaBot
class Bot(ArenaBot)
    def on_observation(self, o):
        return {}
`;

/** Bot Node mínimo válido (ES module). */
export const JS_GOOD = `import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation(observation) {
    return { move: { throttle: 0.7, steer: 0.1 } };
  }
}
`;

export const pyFiles = (code: string): SourceFile[] => wrapSingleFile("python", code);
export const jsFiles = (code: string): SourceFile[] => wrapSingleFile("node", code);
