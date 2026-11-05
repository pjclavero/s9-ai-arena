import base64
import struct

from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Avisa a su equipo por radio de dónde ve a un rival (x, y en decímetros,
    4 bytes) y guarda lo que oye. Respeta el límite de mensajes por segundo."""

    radio_slot = None
    teammates = []
    last_sent = -1000
    center = {"x": 60, "y": 40}

    def on_welcome(self, welcome):
        self.heard = []
        # La radio sólo llega a tu equipo: sin compañeros, no hay a quién avisar.
        self.teammates = welcome.get("teammates", [])
        self.center = {"x": welcome["map"]["widthM"] / 2, "y": welcome["map"]["heightM"] / 2}
        self.radio_slot = next(
            (m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "radio"), None
        )

    def on_observation(self, observation):
        me = observation["self"]
        tick = observation["tick"]
        # Avanza hacia el centro del mapa, donde se cruzan los caminos.
        giro = angle_diff(me["heading"], angle_to(me["position"], self.center))
        cmd = {"move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, giro * 2))}}

        # Lo recibido llega en observation["radio"]; "data" es base64 opaco.
        for msg in observation.get("radio", []):
            x, y = struct.unpack(">HH", base64.b64decode(msg["data"]))
            self.heard.append({"from": msg["from"], "x": x / 10, "y": y / 10})

        radar = observation.get("sensors", {}).get("radar", [])
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]
        if rivales and self.radio_slot and self.teammates and tick - self.last_sent >= 30:  # a lo sumo 1 mensaje por segundo
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            # Máximo 32 bytes por mensaje; aquí son 4. Se acota para que quepa en 16 bits.
            x = max(0, min(65535, int(blanco["position"]["x"] * 10)))
            y = max(0, min(65535, int(blanco["position"]["y"] * 10)))
            data = base64.b64encode(struct.pack(">HH", x, y)).decode("ascii")
            cmd["radio"] = [{"slot": self.radio_slot, "data": data}]
            self.last_sent = tick
        return cmd
