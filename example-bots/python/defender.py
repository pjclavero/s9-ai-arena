"""Defensor — se queda cerca de su base y prioriza intrusos.

Loadout de referencia: arquetipo "heavy" del catálogo real de E3
(packages/module-catalog/resolve/archetypes.ts): chasis pesado, cañón, blindaje
frontal, sensor.lidar360. Nota honesta: el encargo sugiere "radar" para detectar
intrusos, pero el arquetipo pesado real no lleva radar — lleva un lidar de 360°,
que para un defensor que vigila el perímetro de su base es, si acaso, mejor
(cobertura completa en vez de solo alcance largo con error de posición, D8).
"""
from __future__ import annotations

import math

from arena_sdk import ArenaBot, angle_diff, angle_to, distance

HOME_RADIUS_M = 12.0
DETECTION_RANGE_M = 45.0


def _wrap(angle: float) -> float:
    """Normaliza a [-pi, pi]: targetHeading fuera de rango hace que el servidor
    descarte el COMMAND (command.schema.json) y lo cuente como timeout (D2)."""
    return math.atan2(math.sin(angle), math.cos(angle))


class DefenderBot(ArenaBot):
    ARCHETYPE = "heavy"

    def __init__(self, bot_id: str):
        super().__init__(bot_id)
        self._home: dict | None = None
        self._center = {"x": 60.0, "y": 40.0}

    def on_welcome(self, welcome):
        self._center = {"x": welcome["map"]["widthM"] / 2, "y": welcome["map"]["heightM"] / 2}
        for base in welcome["map"].get("bases", []):
            if base["team"] == welcome["team"]:
                self._home = base["position"]
                break

    def on_observation(self, observation):
        me = observation["self"]
        home = self._home or me["position"]

        lidar_blocks = observation.get("sensors", {}).get("lidar", [])
        rays = lidar_blocks[0]["rays"] if lidar_blocks else []
        intruders = [r for r in rays if r["hit"] == "vehicle" and r["distanceM"] <= DETECTION_RANGE_M]

        if intruders:
            nearest = min(intruders, key=lambda r: r["distanceM"])
            bearing = _wrap(me["heading"] + nearest["angle"])
            d_home = distance(me["position"], home)
            # No abandona la base más de lo necesario: si el intruso está lejos de
            # casa, avanza a interceptar; si está encima, se queda plantado y dispara.
            throttle = 0.6 if nearest["distanceM"] > 10 and d_home < HOME_RADIUS_M * 2 else 0.0
            return {
                "move": {"throttle": throttle, "steer": max(-1.0, min(1.0, nearest["angle"] * 2))},
                "turret": {"targetHeading": bearing},
                "fire": ["turret_main"],
            }

        # Sin intrusos y SIN base que defender (p. ej. un mapa sin bases): un defensor
        # que se limita a acampar no gana nunca a un enemigo inmóvil y lejano. Sale a
        # cazar: avanza hacia el territorio contrario barriendo con su lidar 360.
        if self._home is None:
            far_x = self._center["x"] * 1.7 if me["position"]["x"] < self._center["x"] else self._center["x"] * 0.3
            target = {"x": far_x, "y": self._center["y"]}
            turn = angle_diff(me["heading"], angle_to(me["position"], target))
            arrived = distance(me["position"], target) < 12
            if arrived:
                return {"move": {"throttle": 0.5, "steer": 0.6}}
            return {"move": {"throttle": 0.75, "steer": max(-1.0, min(1.0, turn * 1.5))}}

        # Con base: vuelve a/ronda la base (carácter defensivo).
        d_home = distance(me["position"], home)
        if d_home > HOME_RADIUS_M:
            bearing = angle_to(me["position"], home)
            turn = angle_diff(me["heading"], bearing)
            return {"move": {"throttle": 0.5, "steer": max(-1.0, min(1.0, turn * 1.5))}}

        return {"move": {"throttle": 0.15, "steer": 0.3}}  # ronda corta en el sitio
