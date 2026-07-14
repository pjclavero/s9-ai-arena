"""
Tipos de observación/comando del protocolo arena/1, en espejo de
packages/protocol/schemas/*.json.

Elección: TypedDict, no dataclasses. Los mensajes llegan del socket como dicts ya
parseados de JSON; un TypedDict los tipa para el editor y mypy SIN necesitar un
paso de conversión (round-trip dict->objeto->dict) y, sobre todo, sin arriesgarse a
que ese paso de conversión rechace un campo que el SDK todavía no conoce. Es
justo la regla 5 del protocolo ("ignora lo que no conoces"): un TypedDict no
valida en tiempo de ejecución, así que un campo nuevo del esquema que este SDK no
haya modelado todavía simplemente viaja sin tocar, en vez de hacer fallar un
constructor estricto.

Ningún campo de aquí es exhaustivo del esquema completo (E1 es la fuente de
verdad); son los que un bot típico necesita para decidir.
"""
from __future__ import annotations

from typing import Literal, NotRequired, TypedDict


class Vec2(TypedDict):
    x: float
    y: float


class EnergyState(TypedDict):
    storedEU: float
    capacityEU: float
    netFlowEUs: NotRequired[float]


class ModuleState(TypedDict):
    slot: str
    state: Literal["operational", "damaged", "critical", "destroyed", "offline"]
    healthFraction: NotRequired[float]
    cooldownTicks: NotRequired[int]
    ammo: NotRequired[int]


class SelfState(TypedDict):
    position: Vec2
    heading: float
    velocity: Vec2
    turretHeading: NotRequired[float]
    hullHp: float
    hullHpMax: NotRequired[float]
    energy: EnergyState
    armor: NotRequired[dict]
    modules: list[ModuleState]
    carryingFlag: NotRequired[str | None]


class LidarRay(TypedDict):
    angle: float
    distanceM: float
    hit: str


class LidarBlock(TypedDict):
    slot: str
    originHeading: float
    fovRad: float
    rays: list[LidarRay]


class RadarContact(TypedDict):
    entityId: NotRequired[str]
    kind: NotRequired[str]
    team: NotRequired[str]
    position: Vec2
    velocity: NotRequired[Vec2]
    errorM: float
    confidence: NotRequired[float]


class RadarBlock(TypedDict):
    slot: str
    contacts: list[RadarContact]


class Sensors(TypedDict, total=False):
    lidar: list[LidarBlock]
    radar: list[RadarBlock]
    proximity: list[dict]
    acoustic: list[dict]


# 'from' es palabra reservada en Python: sintaxis funcional de TypedDict para poder
# usarla como nombre de campo real (así coincide con la clave JSON tal cual llega).
RadioMessage = TypedDict("RadioMessage", {"from": str, "data": str, "sentTick": NotRequired[int]})


class Observation(TypedDict):
    tick: int
    self: SelfState
    sensors: NotRequired[Sensors]
    radio: NotRequired[list[dict]]
    score: NotRequired[dict]
    objectives: NotRequired[list[dict]]


class MoveIntent(TypedDict, total=False):
    throttle: float
    steer: float


class TurretIntent(TypedDict, total=False):
    targetHeading: float
    targetPoint: Vec2


class Command(TypedDict, total=False):
    forTick: int
    move: MoveIntent
    turret: TurretIntent
    fire: list[str]
    deployMine: dict
    modules: list[dict]
    utility: list[dict]
    radio: list[dict]
    debug: dict


class WelcomeTiming(TypedDict):
    tickHz: int
    decisionEveryNTicks: int
    decisionDeadlineMs: int
    maxConsecutiveTimeouts: int


class Welcome(TypedDict):
    battleId: str
    selfId: str
    team: str
    timing: WelcomeTiming
    rules: dict
    vehicle: dict
    map: dict
    versions: dict
    teammates: NotRequired[list[str]]


class Event(TypedDict):
    tick: int
    kind: str


class Shutdown(TypedDict):
    reason: str
    detail: NotRequired[str]
    result: NotRequired[dict]
    gracePeriodMs: NotRequired[int]


def distance(a: Vec2, b: Vec2) -> float:
    """Distancia euclídea en metros (D1)."""
    return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5


def angle_to(from_pos: Vec2, to_pos: Vec2) -> float:
    """Ángulo absoluto (radianes, antihorario, 0 = eje +X, D1) de from_pos a to_pos."""
    import math

    return math.atan2(to_pos["y"] - from_pos["y"], to_pos["x"] - from_pos["x"])


def angle_diff(a: float, b: float) -> float:
    """Diferencia angular normalizada a [-pi, pi]: cuánto girar desde a hasta b."""
    import math

    d = b - a
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d
