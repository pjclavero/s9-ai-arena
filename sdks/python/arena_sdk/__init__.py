"""arena-sdk · SDK de referencia en Python para bots de S9 AI Arena (protocolo arena/1)."""
from .bot import ArenaBot
from .simulator import LocalSimulator
from .types import Command, Event, Observation, Shutdown, Vec2, Welcome, angle_diff, angle_to, distance

__all__ = [
    "ArenaBot",
    "LocalSimulator",
    "Command",
    "Event",
    "Observation",
    "Shutdown",
    "Vec2",
    "Welcome",
    "angle_diff",
    "angle_to",
    "distance",
]

__version__ = "0.1.0"
