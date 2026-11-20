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

/** UX-04 · hook mal escrito: arranca y responde, pero con el hook por defecto (inerte). */
export const PY_HOOK_TYPO = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observaton(self, observation):
        return {"move": {"throttle": 1.0, "steer": 0.0}}
`;

/** UX-04 · bot quieto A PROPÓSITO: implementa el hook y devuelve {}. Debe pasar. */
export const PY_QUIET = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {}
`;

/** UX-04 · hook mal escrito en JS (onObservaton). */
export const JS_HOOK_TYPO = `import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservaton(observation) {
    return { move: { throttle: 1, steer: 0 } };
  }
}
`;

/** UX-04 · bot JS quieto a propósito: implementa onObservation y devuelve {}. */
export const JS_QUIET = `import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation() {
    return {};
  }
}
`;

/** UX-02 · excepción en tiempo de ejecución en la línea 6 del código del usuario. */
export const PY_NAME_ERROR = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": velocidad}}
`;

export const pyFiles = (code: string): SourceFile[] => wrapSingleFile("python", code);
export const jsFiles = (code: string): SourceFile[] => wrapSingleFile("node", code);
