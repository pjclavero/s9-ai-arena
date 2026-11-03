from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Patrulla: recorre las cuatro esquinas interiores del mapa, sin sensores."""

    route = []
    leg = 0

    def on_welcome(self, welcome):
        # Las medidas del mapa llegan en el WELCOME: nunca las supongas.
        ancho = welcome["map"]["widthM"]
        largo = welcome["map"]["heightM"]
        margen = 15  # metros de separación respecto a los muros
        self.route = [
            {"x": margen, "y": margen},
            {"x": ancho - margen, "y": margen},
            {"x": ancho - margen, "y": largo - margen},
            {"x": margen, "y": largo - margen},
        ]

    def on_observation(self, observation):
        if not self.route:
            return {}
        me = observation["self"]
        goal = self.route[self.leg]
        if distance(me["position"], goal) < 6:  # llegado: siguiente tramo
            self.leg = (self.leg + 1) % len(self.route)
            goal = self.route[self.leg]
        giro = angle_diff(me["heading"], angle_to(me["position"], goal))
        # Si el destino queda muy desviado, frena y gira; si no, acelera.
        throttle = 0.9 if abs(giro) < 0.6 else 0.2
        return {"move": {"throttle": throttle, "steer": max(-1.0, min(1.0, giro * 2))}}
