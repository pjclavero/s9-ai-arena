"""
T5.2 · Clase base ArenaBot.

Sin reconexión: si la conexión cae, run() simplemente termina. Reconectar (o no)
es responsabilidad de quien opere el proceso del bot (el runner de la plataforma,
o tú mismo probando en local), no del SDK — igual que el motor no reintenta un
tick que ya pasó.

decide() del lado del motor no necesita que este cliente implemente ningún
temporizador de deadline: el servidor de protocolo (T5.1) ya descarta cualquier
COMMAND que llegue tarde. Este SDK simplemente responde tan rápido como puede a
cada OBSERVATION.
"""
from __future__ import annotations

import json
from typing import Any

import websocket  # paquete "websocket-client"

from .types import Command, Event, Observation, Shutdown, Welcome

PROTO = "arena/1"


class ArenaBot:
    """Clase base para un bot. Sobreescribe on_welcome/on_observation/on_event/on_shutdown."""

    def __init__(self, bot_id: str, bot_version: str = "0.1.0", sdk_name: str = "arena-sdk-python"):
        self.bot_id = bot_id
        self.bot_version = bot_version
        self.sdk_name = sdk_name
        self.sdk_version = "0.1.0"

        self._ws: websocket.WebSocket | None = None
        self._seq = 0
        self._decision_every_n_ticks = 3  # valor por defecto hasta que llegue WELCOME
        self.welcome: Welcome | None = None

    # ------------------------------------------------------------ ciclo de vida
    def on_welcome(self, welcome: Welcome) -> None:
        """Se llama una vez, al aceptar la batalla. self.welcome ya está poblado."""

    def on_observation(self, observation: Observation) -> Command:
        """Devuelve la intención para el ciclo siguiente. Un dict vacío = sin cambios."""
        return {}

    def on_event(self, event: Event) -> None:
        """Se llama por cada EVENT recibido (impactos, banderas, rechazos...)."""

    def on_shutdown(self, shutdown: Shutdown) -> None:
        """Última llamada antes de que run() retorne. Dispones de shutdown['gracePeriodMs']."""

    # ------------------------------------------------------------------- run()
    def run(self, url: str, battle_token: str) -> None:
        """Conecta, hace el handshake y corre el bucle hasta SHUTDOWN o desconexión."""
        self._ws = websocket.create_connection(url)
        try:
            self._send("HELLO", {
                "botId": self.bot_id,
                "botVersion": self.bot_version,
                "sdk": {"name": self.sdk_name, "version": self.sdk_version},
                "battleToken": battle_token,
            })
            self._loop()
        finally:
            try:
                self._ws.close()
            except Exception:
                pass

    def _loop(self) -> None:
        assert self._ws is not None
        while True:
            try:
                raw = self._ws.recv()
            except Exception:
                return  # transporte caído: sin reconexión, se termina sin más.
            if not raw:
                return

            # Regla 5 del protocolo: un mensaje que no se entiende NUNCA hace fallar al SDK.
            try:
                msg: Any = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(msg, dict) or msg.get("proto") != PROTO:
                continue

            mtype = msg.get("type")
            payload = msg.get("payload")
            if not isinstance(payload, dict):
                continue
            self._debug_on_message(msg)

            if mtype == "WELCOME":
                self.welcome = payload  # type: ignore[assignment]
                self._decision_every_n_ticks = payload.get("timing", {}).get("decisionEveryNTicks", 3)
                self.on_welcome(payload)  # type: ignore[arg-type]
            elif mtype == "OBSERVATION":
                self._handle_observation(payload)  # type: ignore[arg-type]
            elif mtype == "EVENT":
                self.on_event(payload)  # type: ignore[arg-type]
            elif mtype == "SHUTDOWN":
                self.on_shutdown(payload)  # type: ignore[arg-type]
                return
            # Cualquier otro type: se ignora sin más (mensajes de ciclo de batalla futuros).

    def _handle_observation(self, observation: Observation) -> None:
        command = dict(self.on_observation(observation) or {})
        for_tick = observation["tick"] + self._decision_every_n_ticks
        command["forTick"] = for_tick
        self._send("COMMAND", command, tick=for_tick)

    def _send(self, type_: str, payload: dict, tick: int | None = None) -> None:
        assert self._ws is not None
        msg: dict[str, Any] = {"proto": PROTO, "type": type_, "seq": self._seq, "payload": payload}
        self._seq += 1
        if tick is not None:
            msg["tick"] = tick
        self._debug_on_send(msg)
        self._ws.send(json.dumps(msg))

    # ---------------------------------------------------------- hooks de prueba
    def _debug_on_message(self, msg: dict) -> None:
        """No-op por defecto. tests/test_contract.py lo sobreescribe para capturar
        cada envelope entrante y validarlo contra los esquemas de E1."""

    def _debug_on_send(self, msg: dict) -> None:
        """No-op por defecto. Igual que _debug_on_message, pero para lo que el bot envía."""
