# Workers

## Resumen

Hay dos procesos sin HTTP de negocio que reclaman trabajos de la tabla `jobs` (ver [queue.md](queue.md)):

| Worker | Qué hace | Estado |
|---|---|---|
| **tournament-worker** | **autoridad única de ejecución**: reserva cada batalla, lanza un contenedor por bot con su código, aloja motor + `ProtocolServer` + espectador, cierra la batalla una vez; procesa resultados, calendarios y clasificaciones | **PARCIAL** (verificado en aislado e integrado con el proveedor de DEV-A; en producción no reclama `run_battle` hasta desplegar el compose con `DOCKER_PROXY_URL` y la clave pública) |
| **bot-build-worker** | ejecuta el pipeline de validación de versiones de bot | **falla cerrado siempre**: no hay sandbox |

El tournament-worker ejecuta el código de usuario en contenedores cuando tiene configurado el sandbox; sin él **no ejecuta batallas** (ya no cae al stub). Ver [TD-001](../roadmap/technical-debt.md#td-001) y [TD-002](../roadmap/technical-debt.md#td-002).

## Índice

- [tournament-worker](#tournament-worker)
- [bot-build-worker](#bot-build-worker)
- [Señales de vida e identidad](#señales-de-vida-e-identidad)
- [Errores / limitaciones](#errores--limitaciones)
- [Tests](#tests)
- [Verificación](#verificación)

## tournament-worker

### Trabajos que atiende

| `kind` | Handler | Efecto |
|---|---|---|
| `run_battle` | `makeRunBattleHandler` (`battle-runner.ts`) | simula la batalla y la cierra (ver más abajo) |
| `generate_schedule` | `handleGenerateSchedule` (`scheduler.ts`) | crea `matches` y `battles` del torneo y encola sus `run_battle` |
| `process_result` | `handleProcessResult` (`results.ts`) | avanza el match o el torneo; ratings y standings sólo si la batalla es `official` |
| `update_standings` | `handleUpdateStandings` (`standings.ts`) | materializa la clasificación |
| `tournament_dry_run` | `handleTournamentDryRun` | ensayo del calendario |

### Ciclo de `run_battle`

Detalle paso a paso en [battles.md](battles.md#flujo-de-datos-paso-a-paso). Resumen:

1. **Reserva atómica** `claimBattle`: `UPDATE battles … WHERE status='scheduled'` (o `running` con lease caducado) `RETURNING *`, con `claimed_by` y `lease_expires_at`. Si no la gana: `finished` → sólo stats que falten; `failed` → nada; `running` con lease vivo → `battle_busy` (duplicado).
2. **Lease** renovado cada `lease/3` (def. 45 s) junto con `jobs.locked_at`; si no se puede renovar, la ejecución se aborta y no se escribe nada.
3. **Descalificaciones administrativas**: versión fuera de `published|frozen`, `suspensions` (si se inyecta; `main.ts` no la cablea) y `artifactGuard` (cableado en `main.ts` desde la integración).
4. **Motor + agentes** (`engine-executor.ts`): mapa, ruleset (`resolveBattleRuleset`), catálogo y loadout reales; el `AgentDriver` es obligatorio. En producción `containerAgents` (`container-agents.ts`): contenedores por `ProxyContainerRunner`, postura comprobada, handshake de todos, ritmo real, CPU muestreada.
5. **Cierre** `finishBattle` en una transacción condicionada al titular: resultado (`battle-result/v1`), replay, `participants.outcome`/`cpu_ms`, `process_result`. Después `runStatsJob`.
6. **Fallos**: `SportingFailure` → derrota del culpable, sin reintento. `InfrastructureFailure` → la batalla vuelve a `scheduled` (si sigue siendo nuestra) y la cola reintenta; agotado, `failed (infrastructure)`. Error no clasificado tras reservar → se libera la reserva y el trabajo va a `needs_review`.

Una batalla `failed` sigue impidiendo que el match o el torneo se cierren ([TD-015](../roadmap/technical-debt.md#td-015)).

### Sin stub en producción

`HunterBot` sólo existe ya en `testing/stub-agents.ts`, se pide explícitamente y **lanza con `NODE_ENV=production`**. `main.ts` construye `containerAgents` si hay `DOCKER_PROXY_URL` + `ARENA_ENGINE_HOST` y cargan la clave PÚBLICA de verificación (`ARTIFACT_VERIFY_KEY_FILE`) y los digests de runtime (`createBattleLaunchHost` de DEV-A, importación estática); cablea además `DbArtifactLaunchGuard` (firma por participante antes de lanzar); si falta algo, registra «EJECUCIÓN DE BATALLAS DESACTIVADA» y **no registra el handler** `run_battle` (las batallas quedan `scheduled`, visibles como pendientes). Un test comprueba que `main.ts` no importa stubs.

### Concurrencia

Lanza `computeConcurrency()` bucles, como mínimo 1: `min(cpus − 1, floor(RAM_MB / 2048))`. Cada
bucle procesa un trabajo a la vez. Sin trabajo, espera `pollMs` (1 s) en `BLPOP` o en `sleep`.

### Espectador en directo

El worker crea un `SpectateGateway` en `SPECTATE_PORT`, porque la batalla vive en su memoria (también ahora que la conducen contenedores: el `ProtocolServer` y el motor están en este proceso). El
gateway verifica el ticket con un secreto que **este contenedor no recibe**, así que hoy rechaza
todos los tickets ([TD-028](../roadmap/technical-debt.md#td-028)). Protocolo: [websocket.md](websocket.md).

## bot-build-worker

### Trabajos que atiende

Sólo `bot_build`, con payload `{ buildId, botId, version, runtime }`. Los encola la API cuando se
envía una versión a validación (`QueueBotManager`).

### Ciclo

1. Reclama el trabajo con `FOR UPDATE SKIP LOCKED`. Los trabajos `running` cuyo bloqueo tiene más de 10 min se consideran huérfanos y se vuelven a reclamar.
2. Ejecuta `E6PipelineBotManager.enqueueBuild`, que recorre estas etapas: `structure`, `static_analysis` (AST: `acorn` para Node y `python3` para Python), `dependencies`, `build`, **`protocol_test`, `smoke_battle`, `resource_limits`**, `secret_scan`, `sign` y `publish`.
3. Las tres etapas en negrita **necesitan ejecutar el bot**, y para eso hace falta un `agentResolver` (sandbox en contenedor). `build-worker-main.ts` no lo pasa, así que esas etapas son «no ejecutables». El build queda `failed` y la versión `rejected` con este motivo: *«sandbox no verificado: etapa(s) de ejecución no ejecutable(s) [...]»*.
4. Si el ejecutor lanza una excepción y se agotan los reintentos, el resultado es el mismo: `failed`/`rejected` «no verificable». **Nunca** queda `validated` sin el pipeline completo.

### Fail-closed

| Falta | Efecto |
|---|---|
| Clave de firma (`ARTIFACT_SIGNING_KEY_FILE`) | el proceso **no arranca** |
| Configuración de BD | el proceso no arranca |
| `agentResolver` | todo build se rechaza (hoy, siempre) |

El rechazo es correcto como medida de seguridad. El defecto es que el sandbox nunca se cableó
([TD-001](../roadmap/technical-debt.md#td-001)).

## Señales de vida e identidad

| Worker | Latido | Identidad de build |
|---|---|---|
| tournament-worker | `/tmp/heartbeat` cada 30 s; healthcheck < 120 s | `/tmp/version.json` (mismo cuerpo que `/version`), que lee el gate con `docker exec` |
| bot-build-worker | `/tmp/heartbeat` cada 30 s; healthcheck < 120 s | `/version` en la imagen de bot-manager |

El latido es un `setInterval` aparte del bucle de trabajo, así que demuestra que el proceso está
vivo, **no** que avance. Para ver el avance hay que consultar `jobs` (ver [docs/operations/diagnostics.md](../operations/diagnostics.md)).

## Errores / limitaciones

- [TD-001](../roadmap/technical-debt.md#td-001): ningún build puede aprobarse.
- [TD-002](../roadmap/technical-debt.md#td-002): PARCIAL — camino único y código real verificados en aislado; falta activarlo en producción.
- [TD-015](../roadmap/technical-debt.md#td-015): guardas no cableadas; `failed` bloquea los torneos.
- [TD-026](../roadmap/technical-debt.md#td-026): el aviso Redis no tiene productor.
- [TD-028](../roadmap/technical-debt.md#td-028): espectador sin secreto.

## Tests

- tournament-worker: `tournament-e2e.test.ts` (BD real, torneo completo con stub), `queue.test.ts`, `worker-degradation.test.ts`, `ratings.test.ts`, `battle-stats-canonical.test.ts`, `spectate-live.test.ts`, `redis-signal-semantics.test.ts` (requiere `REDIS_TEST_URL`; sin ella se omite).
- bot-build-worker: `apps/bot-manager/tests/pipeline.test.ts`, `static-analysis.test.ts`, `ast-analysis.test.ts`; `apps/api/src/r25-cola-builds.test.ts`.
- `battle-lifecycle.test.ts` (reserva, lease, cierre único, sin driver por defecto, DQ del motor).
- `container-battle-e2e.test.ts`: batalla REAL con el código de dos bots en contenedores (opt-in `S9_RUN_REAL_DOCKER_E2E=1`, necesita Docker; no corre en el CI normal).

## Documentación relacionada

- [queue.md](queue.md) · [battles.md](battles.md) · [bots.md](bots.md) · [tournaments.md](tournaments.md) · [engine.md](engine.md) · [services.md](services.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Handlers del worker | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:78-85` |
| Idempotencia sobre `finished` | CODE_VERIFIED | `battle-runner.ts:275` |
| Reserva atómica con lease | CODE_VERIFIED + test | `battle-runner.ts:164`; `battle-lifecycle.test.ts` |
| Versión no jugable ⇒ DQ administrativa (siempre); `suspensions`/`artifactGuard` siguen sin cablearse en `main.ts` | CODE_VERIFIED + test | `battle-runner.ts:232`; `battle-lifecycle.test.ts` («SUSPENDIDA…») |
| Driver obligatorio; contenedores en producción | CODE_VERIFIED + RUNTIME_VERIFIED (aislado) | `engine-executor.ts:133`; `main.ts:72`; `container-battle-e2e.test.ts` |
| Cierre condicionado y `process_result` en la misma transacción | CODE_VERIFIED + test | `battle-runner.ts:452-515` |
| Revisión manual al agotar (sin tocar leases vivos) | CODE_VERIFIED | `battle-runner.ts:522` |
| Concurrencia | CODE_VERIFIED | `apps/tournament-worker/src/worker.ts:71-80,178-183` |
| Etapas del pipeline | CODE_VERIFIED | `apps/bot-manager/src/pipeline.ts:239-453` |
| Rechazo sin `agentResolver` | CODE_VERIFIED | `pipeline.ts:172,467-473`; `build-worker-main.ts:31` |
| Bloqueo huérfano de 10 min | CODE_VERIFIED | `apps/bot-manager/src/build-worker.ts:52` |
| Producción: 22 builds `failed` | RUNTIME_VERIFIED (en la auditoría) | consulta de sólo lectura a la BD |
