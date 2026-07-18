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
| `ARENA_NETWORK` | `infrastructure_arena` | red Docker de los bots (`<proyecto>_arena`; el despliegue usa proyecto `infrastructure`). |
| `ENGINE_HOST` | `arena-engine` | host del ProtocolServer alcanzable desde `ARENA_NETWORK`. |
| `SMOKE_BOT_DIGEST` | — (**obligatoria**) | imagen del `s9-smoke-bot` fijada por digest (nunca placeholder). |
| `SMOKE_TICKS`/`SMOKE_SEED`/`SMOKE_MAP`/`SMOKE_TIMEOUT_MS`/`REPLAY_OUT` | ver script | parámetros de la batalla y ruta del replay. |

## Prerequisitos antes de VM108

- La red `arena` real es **`infrastructure_arena`** (Compose la prefija con el proyecto).
  Crearla si no existe: `docker network create infrastructure_arena` (o levantar un
  servicio que la use). ⚠️ NO `s9-ai-arena_arena`.
- La imagen del `s9-smoke-bot` construida y **publicada** para obtener un digest real:
  `bash bots/s9-smoke-bot/build.sh --push` → usar el `RepoDigest` como `SMOKE_BOT_DIGEST`.
- `ENGINE_HOST` debe ser alcanzable por los contenedores desde `arena` (los bots no
  tienen DNS externo): ejecutar el arnés donde el ProtocolServer sea visible en esa red.

## Ejecución REAL en VM108 (GATEADA — NO en este PR; este PR NO declara A)

> Trabajo de seguridad: ejecutar por primera vez código no confiable con el proxy
> Docker. Hacerlo en ventana controlada, con la red del runner cerrada.

1. Snapshot Proxmox + backup ligero + actualizar a `main` + migrar BD.
2. **Instalar `s9-docker-proxy`** (systemd, fuera de Compose):
   `sudo bash infrastructure/scripts/install-docker-proxy.sh install`, ajustar
   `/etc/s9-ai-arena/docker-proxy.env` (`ARENA_NETWORK=infrastructure_arena`),
   `validate`. Cerrar el puerto al exterior por firewall (ver `docs/ops/docker-proxy.md`).
3. **Validar rechazos en vivo**: `privileged`, `network_mode: host`, `docker.sock`,
   bind peligroso, imagen no allowlisted, verbo fuera de la allowlist → 403.
4. **Construir/publicar** la imagen del bot (`build.sh --push`) y fijar `SMOKE_BOT_DIGEST`.
5. `S9_RUN_REAL_DOCKER_E2E=1 ... npx tsx scripts/e2e-real-battle-smoke.ts` con la config real.
6. Verificar: 2 contenedores reales, 2 handshakes, ticks avanzan, batalla termina,
   **replay real generado y verificable** (`verify()`), contenedores limpiados, 7/7
   núcleo sano, logs sin errores. Solo entonces: dictamen A.

## Qué NO hacer

No montar `/var/run/docker.sock` en contenedores de app. No activar runners
permanentes. No abrir puertos en el router. No relajar la postura de seguridad del
`SandboxSpec`. Recordatorio: tras actualizar VM108, `docker exec -w /app
infrastructure-api-1 npx tsx apps/api/src/db/cli.ts migrate`.
