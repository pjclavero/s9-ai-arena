from arena_sdk import ArenaBot, distance


class Bot(ArenaBot):
    """Usa lo que haya montado: lidar para esquivar muros, radar para apuntar,
    acústico para mirar hacia un disparo y proximidad para recular."""

    weapons = []

    def on_welcome(self, welcome):
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]

    def on_observation(self, observation):
        me = observation["self"]
        sensors = observation.get("sensors", {})  # sin sensores operativos no hay clave
        cmd = {"move": {"throttle": 0.7, "steer": 0.2}}

        # Lidar: "angle" es RELATIVO al morro; distanceM es la distancia libre.
        for scan in sensors.get("lidar", []):
            delante = [r["distanceM"] for r in scan["rays"] if abs(r["angle"]) < 0.4]
            if delante and min(delante) < 10:
                libre = max(scan["rays"], key=lambda r: r["distanceM"])
                cmd["move"] = {"throttle": 0.3, "steer": max(-1.0, min(1.0, libre["angle"] * 2))}

        # Radar: posiciones ABSOLUTAS con error (errorM). "team" sólo aparece en aliados.
        rivales = [c for r in sensors.get("radar", []) for c in r["contacts"] if "team" not in c]
        if rivales:
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            cmd["turret"] = {"targetPoint": blanco["position"]}
            cmd["fire"] = self.weapons
        else:
            # Acústico: sólo da dirección absoluta (bearing), nunca posición.
            for ac in sensors.get("acoustic", []):
                for fuente in ac["sources"]:
                    if fuente["kind"] == "gunshot":
                        cmd["turret"] = {"targetHeading": fuente["bearing"]}

        # Proximidad: algo (vehículo o mina) muy cerca; retrocede.
        if any(p["triggered"] for p in sensors.get("proximity", [])):
            cmd["move"] = {"throttle": -0.6, "steer": 0.0}
        return cmd
