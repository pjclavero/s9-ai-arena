from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        # Se llama en cada ciclo de decisión. Devuelve la orden del ciclo:
        # avanzar recto a media potencia. {} significaría "sin cambios".
        return {"move": {"throttle": 0.5, "steer": 0.0}}
