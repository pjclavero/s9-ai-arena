from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Captura la bandera en equipo: el compañero con el id más bajo ataca y el
    resto defiende la base. Todos disparan a lo que vea su radar."""

    weapons = []
    role = "attacker"
    own_base = {"x": 10, "y": 40}
    enemy_base = {"x": 110, "y": 40}

    def on_welcome(self, welcome):
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]
        # Todos los miembros del equipo ordenan la misma lista, así que reparten
        # los papeles sin hablar: sólo el id más bajo es el atacante.
        escuadra = sorted([welcome["selfId"], *welcome.get("teammates", [])])
        self.role = "attacker" if escuadra[0] == welcome["selfId"] else "defender"
        for base in welcome["map"].get("bases", []):
            if base["team"] == welcome["team"]:
                self.own_base = base["position"]
            else:
                self.enemy_base = base["position"]

    def on_observation(self, observation):
        me = observation["self"]
        radar = observation.get("sensors", {}).get("radar", [])
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]

        if me.get("carryingFlag"):  # llevo la bandera rival: a mi base
            destino = self.own_base
        elif self.role == "attacker":
            destino = self.enemy_base  # la bandera rival está en su base
        else:
            destino = self.own_base  # el defensor guarda la suya

        giro = angle_diff(me["heading"], angle_to(me["position"], destino))
        parado = self.role == "defender" and distance(me["position"], destino) < 8
        cmd = {"move": {"throttle": 0.0 if parado else 0.8, "steer": max(-1.0, min(1.0, giro * 2))}}
        if rivales:
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            cmd["turret"] = {"targetPoint": blanco["position"]}
            cmd["fire"] = self.weapons
        return cmd
