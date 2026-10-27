/**
 * UX-B · B3 (G-02) — plantillas del editor de código: el área de texto NO empieza
 * vacía. Un bot mínimo por runtime, ejecutable tal cual y que pasa el build REAL
 * (lo comprueba apps/bot-manager/tests/build-sandbox-docker.test.ts con estas
 * mismas cadenas): implementa el hook (`on_observation` / `onObservation`), lee
 * del WELCOME las ranuras de arma de TU loadout (no asume `turret_main`) y sólo
 * usa el SDK de la plataforma.
 */
export type BotRuntime = "python" | "node";

export const PYTHON_TEMPLATE = `from arena_sdk import ArenaBot, angle_diff, angle_to


class Bot(ArenaBot):
    """Plantilla mínima: patrulla y, si el radar ve a alguien, apunta y dispara."""

    weapons = []

    def on_welcome(self, welcome):
        # Tu vehículo es el loadout de esta versión: se dispara con SUS armas.
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]

    def on_observation(self, observation):
        # OBLIGATORIO: se llama en cada ciclo de decisión. {} = sin cambios.
        me = observation["self"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r.get("contacts", [])]
        if not contacts:
            return {"move": {"throttle": 0.6, "steer": 0.3}}
        target = contacts[0]
        turn = angle_diff(me["heading"], angle_to(me["position"], target["position"]))
        return {
            "move": {"throttle": 0.5, "steer": max(-1.0, min(1.0, turn * 1.5))},
            "turret": {"targetPoint": target["position"]},
            "fire": self.weapons,
        }
`;

export const JAVASCRIPT_TEMPLATE = `import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";

// Plantilla mínima (JavaScript ESM, no TypeScript): patrulla y, si el radar ve a
// alguien, apunta y dispara.
export default class Bot extends ArenaBot {
  weapons = [];

  onWelcome(welcome) {
    // Tu vehículo es el loadout de esta versión: se dispara con SUS armas.
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
  }

  onObservation(observation) {
    // OBLIGATORIO: se llama en cada ciclo de decisión. {} = sin cambios.
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);
    if (contacts.length === 0) return { move: { throttle: 0.6, steer: 0.3 } };
    const target = contacts[0];
    const turn = angleDiff(me.heading, angleTo(me.position, target.position));
    return {
      move: { throttle: 0.5, steer: Math.max(-1, Math.min(1, turn * 1.5)) },
      turret: { targetPoint: target.position },
      fire: this.weapons,
    };
  }
}
`;

export const BOT_TEMPLATES: Record<BotRuntime, string> = { python: PYTHON_TEMPLATE, node: JAVASCRIPT_TEMPLATE };

/** Texto del contrato, junto al editor (sin necesidad de leer el repo). */
export const HOOK_HELP: Record<BotRuntime, string> = {
  python:
    "Python 3.11. Una clase que extiende ArenaBot (de arena_sdk) e implementa on_observation(self, observation), que devuelve la orden del ciclo; {} = sin cambios.",
  node: 'JavaScript ESM (Node 20; TypeScript no se acepta). export default class … extends ArenaBot (de "@arena/sdk") con onObservation(observation), que devuelve la orden del ciclo; {} = sin cambios.',
};

/** ¿El texto es vacío o una plantilla sin tocar? Entonces cambiar de runtime puede sustituirlo. */
export function isUntouchedTemplate(code: string): boolean {
  const t = code.trim();
  return t === "" || Object.values(BOT_TEMPLATES).some((tpl) => tpl.trim() === t);
}
