# Batalla smoke containerizada (R6.2)

Cierra el primer circuito real y seguro: `bot → contenedor aislado → ProtocolServer →
motor → replay`. Los bots son código no confiable y corren SIEMPRE en contenedores
restringidos lanzados por `s9-docker-proxy` (fuera de Compose); nunca en el motor ni
en el host, sin docker.sock, sin acceso a Postgres/Redis/API, sin red externa.

## Piezas

| Pieza | Dónde |
|---|---|
| Orquestador | `apps/bot-manager/src/container-battle.ts` → `runContainerBattle()` |
| Puente WS↔motor | `apps/arena-engine/src/protocol-server.ts` (+ `whenAllConnected()`) |
| Runner vía proxy | `apps/bot-manager/src/docker-proxy.ts` → `ProxyContainerRunner` |
| Contrato de seguridad | `apps/bot-manager/src/container-runner.ts` (`SandboxSpec`/`SecurityPosture`) |
| Bot de referencia | `bots/s9-smoke-bot/` |
| Runtime (imagen base) | `runtimes/python` (GHCR, digest en `runtimes/DIGESTS.lock`) |

## Flujo

1. `runContainerBattle()` crea un `Battle` real + `ProtocolServer` (puerto libre, sin arrancar el bucle).
2. Lanza **un contenedor por bot** vía el `ContainerRunner` inyectado, con env
   `WS_URL` / `BATTLE_TOKEN` / `BOT_ID` (nunca secretos).
3. Espera a que **todos** hagan handshake (`whenAllConnected`) y arranca el bucle
   (agentes enganchados desde el tick 0).
4. Recoge `BattleResult` + `Replay` reales; **limpia SIEMPRE** los contenedores
   (éxito, error o timeout global).

## Cómo se prueba en CI (sin Docker)

`apps/bot-manager/tests/container-battle.test.ts`: un `ContainerRunner` mock arranca
el bot EN PROCESO por WebSocket real y juega el protocolo — misma orquestación, sin
contenedor. Verifica: batalla real, `verify(replay)` reproduce el hash final bit a
bit, el `SandboxSpec` produce un `create` que el docker-proxy ADMITE, un `create`
manipulado (privileged / red host) se RECHAZA, y la limpieza para los contenedores ya
lanzados si uno falla.

## Ejecución REAL en VM108 (GATEADA — no incluida en este PR)

> Trabajo de seguridad: ejecutar por primera vez código no confiable con el proxy
> Docker. Hacerlo en ventana controlada, con la red del runner cerrada.

1. **Instalar `s9-docker-proxy`** (systemd, fuera de Compose):
   `infrastructure/systemd/s9-docker-proxy.service` + `infrastructure/scripts/install-docker-proxy.sh`.
   Validar en vivo: arranca, health OK, lanza runner permitido, **rechaza** imagen no
   permitida / `privileged` / bind / red del host, no expone Docker completo.
2. **Construir y firmar** la imagen del `s9-smoke-bot` **FROM** el runtime fijado por
   digest (bot-build-worker), copiando `main.py` a `/bot/main.py`; fijar su digest.
3. **Lanzar** `runContainerBattle()` con `ProxyContainerRunner(DOCKER_PROXY_URL)`,
   red `arena`, `engineHost` = hostname del worker en esa red, y los 2 digests del bot.
4. Verificar: 7/7 núcleo sano, batalla termina por condición válida, replay generado y
   persistido (replay-service), contenedores limpiados, logs sin errores.

## Qué NO hacer

No montar `/var/run/docker.sock` en contenedores de app. No activar runners
permanentes. No abrir puertos en el router. No relajar la postura de seguridad del
`SandboxSpec`. Recordatorio: tras actualizar VM108, `docker exec -w /app
infrastructure-api-1 npx tsx apps/api/src/db/cli.ts migrate`.
