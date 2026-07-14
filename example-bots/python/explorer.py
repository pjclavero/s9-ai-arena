"""Explorador — patrulla en círculo amplio esquivando obstáculos con su lidar
frontal y avisa por radio a su equipo en cuanto detecta un vehículo.

Loadout de referencia: arquetipo "scout" del catálogo real de E3
(packages/module-catalog/resolve/archetypes.ts): chasis ligero, ruedas rápidas,
ametralladora, radio corta. Nota honesta: el catálogo real NO monta un lidar de
360° en este arquetipo (solo sensor.lidar_front, un cono de 90°) — ver
docs/balance/v1.md para el porqué de esa decisión de coste/energía. Este bot
compensa el campo de visión estrecho girando de forma continua mientras patrulla,
en vez de asumir que "ve" todo su alrededor de golpe.
"""
from __future__ import annotations

import base64

import math

from arena_sdk import ArenaBot, angle_diff, angle_to


def _wrap(angle: float) -> float:
    """Normaliza a [-pi, pi]: command.schema.json exige que targetHeading esté en ese
    rango. me['heading'] + ray_angle puede salirse; un COMMAND fuera de rango se
    descarta en el servidor y se cuenta como timeout (D2)."""
    return math.atan2(math.sin(angle), math.cos(angle))


class ExplorerBot(ArenaBot):
    ARCHETYPE = "scout"

    def __init__(self, bot_id: str):
        super().__init__(bot_id)
        self._reported_this_sighting = False

    def on_observation(self, observation):
        me = observation["self"]
        lidar_blocks = observation.get("sensors", {}).get("lidar", [])
        rays = lidar_blocks[0]["rays"] if lidar_blocks else []

        # ¿Algún rayo golpea un vehículo? angle es RELATIVO al heading (sensors.ts).
        vehicle_rays = [r for r in rays if r["hit"] == "vehicle"]

        command: dict = {}
        if vehicle_rays:
            nearest = min(vehicle_rays, key=lambda r: r["distanceM"])
            bearing = _wrap(me["heading"] + nearest["angle"])
            if not self._reported_this_sighting:
                self._radio_sighting(command, bearing, nearest["distanceM"])
                self._reported_this_sighting = True
            # Persigue lo que ha visto: gira hacia el rayo que lo detectó y avanza.
            command["move"] = {"throttle": 0.7, "steer": max(-1.0, min(1.0, nearest["angle"] * 2))}
            command["turret"] = {"targetHeading": bearing}
            command["fire"] = ["turret_main"]
            return command

        self._reported_this_sighting = False

        # Patrulla: evita paredes con el rayo frontal más corto, si no hay nada
        # que esquivar gira en círculo amplio (barre el cono de 90° por la arena).
        front = [r for r in rays if abs(r["angle"]) < 1.0]
        if front and min(r["distanceM"] for r in front) < 8:
            freest = max(rays, key=lambda r: r["distanceM"]) if rays else None
            steer = max(-1.0, min(1.0, freest["angle"])) if freest else 0.6
            return {"move": {"throttle": 0.5, "steer": steer}}

        return {"move": {"throttle": 0.9, "steer": 0.25}}

    def _radio_sighting(self, command: dict, bearing: float, distance_m: float) -> None:
        # Mensaje compacto: 1 byte de tipo + bearing (2 bytes) + distancia (1 byte, m).
        payload = bytes([1, int((bearing % 6.2832) * 40) & 0xFF, int((bearing % 6.2832) * 40) >> 8, min(255, int(distance_m))])
        radio_slot = self._radio_slot()
        if radio_slot:
            command["radio"] = [{"slot": radio_slot, "data": base64.b64encode(payload).decode("ascii")}]

    def _radio_slot(self) -> str | None:
        if not self.welcome:
            return None
        for m in self.welcome["vehicle"]["modules"]:
            if m["category"] == "radio":
                return m["slot"]
        return None
