# s9-smoke-bot — bot de prueba para E2E arena/1

Ubicación: `bots/s9-smoke-bot/`

## Propósito

Bot mínimo que implementa el protocolo `arena/1` (WebSocket). Su único objetivo es
facilitar pruebas E2E de la infraestructura de batallas sin necesidad de un bot con IA
real. No usa servicios externos, no requiere compilación, arranca en menos de 1 s.

## Archivos

| Archivo | Descripción |
|---|---|
| `main.js` | Lógica del bot (CJS, Node 20+, sin dependencias propias) |
| `package.json` | Nombre `@s9/smoke-bot`, declara dependencia `ws ^8.18.0` |
| `Dockerfile` | Imagen basada en `bot-runtime-node@sha256:…` (digest fijado en `runtimes/DIGESTS.lock`) |

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `ARENA_WS_URL` | URL WebSocket del ProtocolServer (`ws://host:port`) |
| `BOT_ID` | ID del bot en la batalla (enviado en HELLO) |
| `BATTLE_TOKEN` | Token para el handshake arena/1 |
| `BOT_VERSION` | Versión del bot (default: `"1"`) |
| `LOG_FORMAT` | `"json"` para logs estructurados; cualquier otro valor para texto plano |

## Comportamiento

1. Conecta al WebSocket de `ARENA_WS_URL`.
2. En `open`: envía `HELLO { botId, battleToken, version }`.
3. En `WELCOME`: escribe `/tmp/alive` (señal de healthcheck).
4. En `OBSERVATION`: responde `COMMAND { move: { throttle: 0.6, steer: ±0.4 }, turret: { targetHeading } }`;
   si hay contactos radar, también `fire: ["turret_main"]`.
5. En `SHUTDOWN`: cierra el WS y sale con código 0.
6. En error WS: sale con código 1.
7. Timeout de arranque de 30 s (sin respuesta = exit 1).

## Construir la imagen

```bash
# Desde la raíz del repo:
docker build -t s9-smoke-bot:local -f bots/s9-smoke-bot/Dockerfile bots/s9-smoke-bot/
```

El runtime base tiene `ws` ya instalado en `/usr/local/lib/node_modules`.
El bot no tiene `node_modules` propios; resuelve `ws` mediante `NODE_PATH` o la cadena de
`require` de Node (busca en `/usr/local/lib/node_modules`).

## Usar fuera de Docker (in-process)

```bash
# Requiere ws en node_modules del repo:
npm install
ARENA_WS_URL=ws://localhost:9001 BOT_ID=bot-a BATTLE_TOKEN=testtoken123456 \
  node bots/s9-smoke-bot/main.js
```

O con NODE_PATH si no hay `node_modules` locales:
```bash
NODE_PATH=$(pwd)/node_modules node bots/s9-smoke-bot/main.js
```

## Suite de tests E2E

`tests/e2e/smoke-battle-real.e2e.test.ts` contiene 2 grupos de pruebas:

- **Contenedores Docker** (5 tests): se saltan automáticamente si Docker no está disponible.
  Cuando Docker sí está disponible, verifican imagen, red, batalla real y aislamiento de red.
- **Protocolo arena/1 en proceso** (1 test): spawnea el bot como subprocess; verifica que
  el handshake HELLO/WELCOME funciona con un `ProtocolServer` real. No requiere Docker.

```bash
# Ejecutar solo el smoke test:
npx vitest run tests/e2e/smoke-battle-real.e2e.test.ts --reporter=verbose

# Con Docker disponible, pasar la imagen:
SMOKE_BOT_IMAGE=s9-smoke-bot:local npx vitest run tests/e2e/smoke-battle-real.e2e.test.ts
```

## Seguridad

- El contenedor corre como usuario `10001:10001` (no-root), heredado del runtime base.
- No monta el socket Docker.
- No tiene `privileged: true`.
- La red Docker `arena` (creada por el test) es `--internal`: sin acceso a Internet,
  sin acceso a Postgres, Redis, ni API de la plataforma.
- `assertRealDigest` del `ProxyContainerRunner` rechaza imágenes sin digest `@sha256:`.

## Limite de scope

El smoke-bot NO es un bot de producción. No debe usarse en torneos reales. Su objetivo
es unicamente verificar que la maquinaria de arena/1 (ProtocolServer, bot-manager,
docker-proxy, ContainerBattleOrchestrator) funciona de extremo a extremo.
