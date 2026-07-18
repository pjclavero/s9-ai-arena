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

## Tres modos — no confundirlos

| Modo | Runner | Docker | Dónde | Declara |
|---|---|---|---|---|
| **Mock CI** | mock en proceso (WS real) | no | CI normal (`container-battle.test.ts`, `tests/e2e/e2e-real-battle-smoke.test.ts`) | nada de prod |
| **Arnés real (opt-in)** | `ProxyContainerRunner` | **sí** | VM108, `scripts/e2e-real-battle-smoke.ts` con `S9_RUN_REAL_DOCKER_E2E=1` | evidencia real |
| **Ejecución VM108** | igual que arnés, dentro del bloque gateado | sí | VM108 en ventana controlada | dictamen A |

El **arnés** `scripts/e2e-real-battle-smoke.ts` es OPT-IN y **no corre en el CI normal**:
sin `S9_RUN_REAL_DOCKER_E2E=1` es un NO-OP. Su lógica (config + orquestación + escritura
del replay) se prueba en CI con un runner mock; solo la ejecución con contenedores
reales es un paso de VM108.

### Variables del arnés

| Variable | Def. | Significado |
|---|---|---|
| `S9_RUN_REAL_DOCKER_E2E` | — | `1` para ejecutar de verdad (si no, NO-OP). |
| `DOCKER_PROXY_URL` | `http://docker-proxy.internal:2375` | URL del `s9-docker-proxy`. |
| `ARENA_NETWORK` | `arena` | red Docker de los bots. **Debe llamarse EXACTAMENTE `arena`** (lo exige `compliance.mjs`); el Compose la declara con `name: arena`. |
| `ENGINE_HOST` | `arena-engine` | host del ProtocolServer alcanzable desde `ARENA_NETWORK` (por IP si los bots no tienen DNS). |
| `SMOKE_BOT_DIGEST` | — (**obligatoria**) | imagen del `s9-smoke-bot` fijada por **repo digest** `name@sha256:…` (nunca tag, nunca placeholder, nunca Image ID pelado). |
| `SMOKE_TICKS`/`SMOKE_SEED`/`SMOKE_MAP`/`SMOKE_TIMEOUT_MS`/`REPLAY_OUT` | ver script | parámetros de la batalla y ruta del replay. |
| `REPLAY_SERVICE_URL` | — (opcional, R7) | si se define, el replay se **ingesta** en el replay-service (`POST /replays/:battleId`) → recurso gestionado, recuperable por `GET /replays/{battleId}` y visible en el visor (`#/replay/<battleId>`). Sin él, solo se escribe a disco. |

### R7 · replay real como recurso gestionado

El arnés ya escribe el replay a disco (`REPLAY_OUT`). Con **`REPLAY_SERVICE_URL`** (p. ej.
`http://replay-service:8083` desde la red `platform`, o `http://127.0.0.1:8083` si el
replay-service publica el puerto) hace además `POST /replays/:battleId` con el MISMO JSONL:
el servicio valida `header.battleId`, lo almacena+indexa y queda disponible en el visor
existente. La ingesta es **best-effort**: si falla, la batalla no se invalida — el CLI
reporta `ingested`/`ingestStatus` en su JSON de resultado. Pendiente (no bloqueante): en
el despliegue VM108 el replay-service no publica el puerto por defecto; para ingestar desde
el host hay que alcanzarlo por su red interna o exponerlo temporalmente.

## Troubleshooting (bugs reales encontrados en VM108, 2026-07-18)

| Síntoma | Causa | Estado |
|---|---|---|
| `start` 500 `Decoding seccomp profile failed: invalid character '/'` | la Docker Engine API exige el **JSON inline** del perfil, no una ruta | **corregido**: `ProxyContainerRunner` inyecta el JSON (`inlineSeccompProfile`) |
| create 403 `red no permitida: infrastructure_arena` | `compliance.mjs` exige la red literal `arena` | **corregido**: `ARENA_NETWORK=arena` + `name: arena` en el Compose |
| create 403 `imagen sin digest sha256 fijado (sha256:…)` | el proxy exige repo digest `name@sha256:`, no el Image ID | **corregido**: `build.sh --local`/`--push` imprime el repo digest real |

## Prerequisitos antes de VM108

- **Red `arena`**: nombre exacto `arena` (lo crea el Compose vía `name: arena`, o a mano
  `docker network create arena`). La red del stack es `internal: true` (bots sin Internet):
  si ejecutas el arnés en el HOST, su ProtocolServer debe ser alcanzable desde `arena`
  (usa `ENGINE_HOST` = IP de una interfaz que los contenedores de esa red alcancen, o
  ejecuta el arnés dentro de un contenedor en `arena`).
- **Imagen y digest**: `bash bots/s9-smoke-bot/build.sh --local` (registry local, sin GHCR)
  o `--push` (GHCR). Copia el `RepoDigest` que imprime → `SMOKE_BOT_DIGEST`.

## Ejecución REAL en VM108 · checklist de reintento (GATEADA — NO en este PR; NO declara A)

> Trabajo de seguridad: ejecutar por primera vez código no confiable con el proxy
> Docker. Hacerlo en ventana controlada, con la red del runner cerrada.

1. Confirmar CI de `main` verde.
2. Snapshot Proxmox nuevo + backup ligero.
3. Actualizar VM108 al nuevo `main`; **migrar BD**: `docker exec -w /app infrastructure-api-1 npx tsx apps/api/src/db/cli.ts migrate`.
4. Validar núcleo 7/7 healthy.
5. Confirmar `s9-docker-proxy` activo; ajustar `/etc/s9-ai-arena/docker-proxy.env`
   (`ARENA_NETWORK=arena`) y `systemctl restart s9-docker-proxy`.
6. Validar rechazos en vivo (privileged / host-net / docker.sock / red no permitida / exec) → 403.
7. `bash bots/s9-smoke-bot/build.sh --local` → fijar `SMOKE_BOT_DIGEST` con el repo digest.
8. `S9_RUN_REAL_DOCKER_E2E=1 DOCKER_PROXY_URL=http://172.17.0.1:2375 ARENA_NETWORK=arena
   ENGINE_HOST=<ip alcanzable desde arena> SMOKE_BOT_DIGEST=<repo digest>
   npx tsx scripts/e2e-real-battle-smoke.ts`.
9. Verificar: 2 contenedores reales, 2 handshakes, ticks avanzan, batalla termina,
   **replay real generado y verificable** (`verify()`), contenedores limpiados, 7/7 núcleo
   sano, logs sin errores. **Solo entonces: dictamen A.**

## Qué NO hacer

No montar `/var/run/docker.sock` en contenedores de app. No activar runners
permanentes. No abrir puertos en el router. No relajar la postura de seguridad del
`SandboxSpec`. Recordatorio: tras actualizar VM108, `docker exec -w /app
infrastructure-api-1 npx tsx apps/api/src/db/cli.ts migrate`.
