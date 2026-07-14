"""El bot de 30 líneas del README. Vive en tests/ para que el propio contract test
(test_tutorial_bot_defeats_an_immobile_bot) lo importe y lo demuestre en una
batalla real: si esto se rompe, el README miente."""
from arena_sdk import ArenaBot, angle_diff, angle_to


class TutorialBot(ArenaBot):
    def on_observation(self, observation):
        me = observation["self"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r["contacts"]]

        if not contacts:
            return {"move": {"throttle": 0.8, "steer": 0.2}}  # sin nadie a la vista: patrulla

        target = min(contacts, key=lambda c: (c["position"]["x"] - me["position"]["x"]) ** 2
                     + (c["position"]["y"] - me["position"]["y"]) ** 2)
        bearing = angle_to(me["position"], target["position"])
        turn = angle_diff(me["heading"], bearing)

        return {
            "move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, turn * 1.5))},
            "turret": {"targetPoint": target["position"]},
            "fire": ["turret_main"],
        }
