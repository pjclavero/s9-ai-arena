# s9-smoke-bot

Bot mínimo **oficial** para cerrar el primer circuito real de S9 AI Arena: la
**batalla E2E de humo** con runners containerizados (R6.2). No es una plataforma de
subida pública de bots; es el bot de referencia controlado para validar el flujo
seguro `bot → contenedor → ProtocolServer → motor → replay`.

## Qué hace

Estrategia determinista mínima (la del bot tutorial del SDK): apunta al contacto más
cercano y dispara; si no ve a nadie, patrulla. Sin red externa, sin IA externa, sin
dependencias fuera de `arena_sdk`.

## Contrato de ejecución

Corre dentro del runtime `runtimes/python` (usuario `10001`, `ENTRYPOINT ["python"]`,
`CMD ["/bot/main.py"]`). Lee su configuración **solo del entorno** (nunca secretos):

| Variable | Significado |
|---|---|
| `WS_URL` | `ws://<engineHost>:<puerto>` del ProtocolServer (lo inyecta el orquestador) |
| `BATTLE_TOKEN` | token de esta batalla para este bot (autenticación del `HELLO`) |
| `BOT_ID` | identificador del bot |

Conecta con `arena_sdk.ArenaBot.run(WS_URL, BATTLE_TOKEN)`.

## Ficheros

- `main.py` — el bot (entrypoint del contenedor en `/bot/main.py`).
- `manifest.json` — nombre, versión, runtime, env y checksum sha256 de la fuente.
- `test_smoke_bot.py` — test de protocolo (contrato de `on_observation`), sin red ni Docker.

## Cómo se ejecuta de verdad (VM108, gateado)

1. El `bot-build-worker` construye la imagen del bot **FROM** el runtime fijado por
   digest, copiando `main.py` a `/bot/main.py`, y firma el artefacto (digest real).
2. El **orquestador** (`apps/bot-manager/src/container-battle.ts`) levanta un
   `ProtocolServer` real y lanza 2 contenedores de este bot vía `s9-docker-proxy`
   (`ProxyContainerRunner`), pasando `WS_URL`/`BATTLE_TOKEN`/`BOT_ID`.
3. La batalla corre, se recoge `BattleResult` + `Replay` y se limpian los contenedores.

En CI la orquestación se prueba con un runner mock que arranca el bot en proceso por
WebSocket (ver `apps/bot-manager/tests/container-battle.test.ts`); la ejecución con
Docker real es un paso de VM108.
