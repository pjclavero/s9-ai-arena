from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Atacante: va hacia la salida del rival; si el radar ve a alguien, apunta y dispara."""

    weapons = []
    goal = {"x": 60, "y": 40}

    def on_welcome(self, welcome):
        # Se dispara con las armas de TU loadout: sus ranuras salen del WELCOME.
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]
        rivales = [s["position"] for s in welcome["map"]["spawns"] if s["team"] != welcome["team"]]
        if rivales:
            self.goal = rivales[0]

    def on_observation(self, observation):
        me = observation["self"]
        radar = observation.get("sensors", {}).get("radar", [])
        # Un contacto con "team" es un aliado: aquí sólo nos interesan los rivales.
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]
        if not rivales:
            return {"move": self.conducir(me, self.goal, 0.9)}
        blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
        d = distance(me["position"], blanco["position"])
        # Mantiene la distancia: se acerca si está lejos, retrocede si está encima.
        throttle = 0.6 if d > 30 else (-0.3 if d < 15 else 0.0)
        return {
            "move": {**self.conducir(me, blanco["position"], 0.0), "throttle": throttle},
            "turret": {"targetPoint": blanco["position"]},
            "fire": self.weapons,
        }

    def conducir(self, me, punto, throttle):
        giro = angle_diff(me["heading"], angle_to(me["position"], punto))
        return {"throttle": throttle, "steer": max(-1.0, min(1.0, giro * 2))}
