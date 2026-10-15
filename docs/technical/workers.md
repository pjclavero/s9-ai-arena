# Workers

## Resumen

Hay dos procesos sin HTTP de negocio que reclaman trabajos de la tabla `jobs` (ver [queue.md](queue.md)):

| Worker | Qué hace | Estado |
|---|---|---|
| **tournament-worker** | ejecuta las batallas (en proceso, **con el stub HunterBot**), procesa resultados, calendarios y clasificaciones, y aloja el WebSocket de espectador | **PARCIAL** |
| **bot-build-worker** | ejecuta el pipeline de validación de versiones de bot | **falla cerrado siempre**: no hay sandbox |

Ninguno ejecuta hoy código de usuario. Ver [TD-001](../roadmap/technical-debt.md#td-001) y [TD-002](../roadmap/technical-debt.md#td-002).

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

1. Carga la batalla y sus participantes. Si ya está `finished`, sólo completa las estadísticas que falten y termina (idempotencia frente a re-entregas).
2. Calcula las descalificaciones administrativas. **No se aplican en producción**: `suspensions` y `artifactGuard` no se cablean en `main.ts` ([TD-015](../roadmap/technical-debt.md#td-015)).
3. `UPDATE battles SET status='running'`, **sin comprobar el estado previo** ([TD-002](../roadmap/technical-debt.md#td-002)).
4. Ejecuta el motor **en el propio proceso** (`engine-executor.ts`):
   - el mapa sale de `map_versions.content`;
   - el ruleset del motor sale del modo;
   - cada participante recibe su **loadout completo** (`resolveVehicle`);
   - el comportamiento lo pone `defaultAgentResolver = (botId) => new HunterBot(botId)`.

   Si hay espectadores conectados, se adjunta la batalla al gateway de espectador.
5. `finishBattle`, que hace lo siguiente:
   - escribe el replay en `/data/replays` (`ingestReplay`);
   - marca la batalla `finished` con resultado, ganador, hashes y `replay_ref`/`replay_hash`;
   - escribe el `outcome` de cada participante;
   - calcula `battle_stats`;
   - encola `process_result` (con `dedupe_key`).
6. Clasificación de fallos:
   - **`SportingFailure`** (timeout o crash del bot): la batalla termina con derrota del culpable y no se reintenta.
   - **`InfrastructureFailure`**: la batalla vuelve a `scheduled` y la cola reintenta con backoff. Agotados los intentos, `markBattleForReview` la deja `failed` con `failure_kind = 'infrastructure'`, y el trabajo pasa a `needs_review`.

Una batalla `failed` impide que el match o el torneo se cierren ([TD-015](../roadmap/technical-debt.md#td-015)).
El detalle paso a paso, junto con el camino real `/run`, está en [battles.md](battles.md).

### El stub HunterBot

`HunterBot` es un agente determinista del motor (`apps/arena-engine/src/stubs.ts`). Hoy juega
**todas** las batallas en nombre de cada bot. El vehículo (chasis, armas, blindaje, sensores) sí
es el del loadout del usuario. El resultado, por tanto, depende del equipamiento y de la semilla,
**no del código** del bot. Esto vale también para los torneos y para el ranking.

### Concurrencia

Lanza `computeConcurrency()` bucles, como mínimo 1: `min(cpus − 1, floor(RAM_MB / 2048))`. Cada
bucle procesa un trabajo a la vez. Sin trabajo, espera `pollMs` (1 s) en `BLPOP` o en `sleep`.

### Espectador en directo

El worker crea un `SpectateGateway` en `SPECTATE_PORT`, porque la batalla vive en su memoria. El
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
- [TD-002](../roadmap/technical-debt.md#td-002): el stub y la carrera con `/run`.
- [TD-015](../roadmap/technical-debt.md#td-015): guardas no cableadas; `failed` bloquea los torneos.
- [TD-026](../roadmap/technical-debt.md#td-026): el aviso Redis no tiene productor.
- [TD-028](../roadmap/technical-debt.md#td-028): espectador sin secreto.

## Tests

- tournament-worker: `tournament-e2e.test.ts` (BD real, torneo completo con stub), `queue.test.ts`, `worker-degradation.test.ts`, `ratings.test.ts`, `battle-stats-canonical.test.ts`, `spectate-live.test.ts`, `redis-signal-semantics.test.ts` (requiere `REDIS_TEST_URL`; sin ella se omite).
- bot-build-worker: `apps/bot-manager/tests/pipeline.test.ts`, `static-analysis.test.ts`, `ast-analysis.test.ts`; `apps/api/src/r25-cola-builds.test.ts`.
- **No hay** test con un `agentResolver` real en CI. El E2E Docker real sólo se ejecuta con `S9_RUN_REAL_DOCKER_E2E=1`.

## Documentación relacionada

- [queue.md](queue.md) · [battles.md](battles.md) · [bots.md](bots.md) · [tournaments.md](tournaments.md) · [engine.md](engine.md) · [services.md](services.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Handlers del worker | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:78-85` |
| Idempotencia sobre `finished` | CODE_VERIFIED | `battle-runner.ts:116-119` |
| `running` sin condición | CODE_VERIFIED | `battle-runner.ts:142` |
| Guardas no cableadas | CODE_VERIFIED | `battle-runner.ts:122-139`; `main.ts:80` |
| HunterBot y loadout completo | CODE_VERIFIED | `engine-executor.ts:51,172` |
| Cierre y `process_result` | CODE_VERIFIED | `battle-runner.ts:229-281` |
| Revisión manual al agotar | CODE_VERIFIED | `battle-runner.ts:285-292` |
| Concurrencia | CODE_VERIFIED | `apps/tournament-worker/src/worker.ts:71-80,178-183` |
| Etapas del pipeline | CODE_VERIFIED | `apps/bot-manager/src/pipeline.ts:239-453` |
| Rechazo sin `agentResolver` | CODE_VERIFIED | `pipeline.ts:172,467-473`; `build-worker-main.ts:31` |
| Bloqueo huérfano de 10 min | CODE_VERIFIED | `apps/bot-manager/src/build-worker.ts:52` |
| Producción: 22 builds `failed` | RUNTIME_VERIFIED (en la auditoría) | consulta de sólo lectura a la BD |
