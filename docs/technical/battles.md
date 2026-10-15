# Ciclo de vida de una batalla

## Resumen

Documento central del ciclo de batalla de S9 AI Arena: desde que alguien la pide hasta que se ve su replay. Cubre cada paso con su servicio, los datos que entran y salen, las tablas y estados reales de PostgreSQL y los errores posibles.

Estado actual, en una línea: **la cadena existe de punta a punta, pero hoy no ejecuta el código de ningún usuario**. Ninguna versión de bot llega a `published` ([TD-001](../roadmap/technical-debt.md#td-001)). Desde la web, crear una batalla falla siempre con `400 rulesetId desconocido` ([TD-003](../roadmap/technical-debt.md#td-003)). Las batallas que sí se crean (por API o dentro de un torneo) las juega el `tournament-worker`, con el bot de prueba `HunterBot` en todos los vehículos ([TD-002](../roadmap/technical-debt.md#td-002)). Además, el reproductor y el visor web no arrancan en navegador ([TD-009](../roadmap/technical-debt.md#td-009)).

## Índice

- [Qué es](#qué-es)
- [Arquitectura](#arquitectura)
- [Flujo de datos paso a paso](#flujo-de-datos-paso-a-paso)
- [Los dos caminos de ejecución](#los-dos-caminos-de-ejecución)
- [Persistencia y estados](#persistencia-y-estados)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Una **batalla** es una simulación del motor 2D ([engine.md](engine.md)) entre 1 y 8 vehículos. Se juega en un mapa publicado ([maps.md](maps.md)) con las reglas de un *ruleset* del motor ([game-modes.md](game-modes.md)). Cada vehículo sale del *loadout* de una versión de bot ([equipment.md](equipment.md), [bots.md](bots.md)). Hay dos orígenes:

- **Práctica**: `POST /api/v1/battles` (rol mínimo `user`). Se crea con `official=false` y no afecta al rating.
- **Torneo**: el `tournament-worker` la crea al materializar el calendario ([tournaments.md](tournaments.md)). Se crea con `official=true` y afecta al rating Elo.

## Arquitectura

Componentes que intervienen (la vista de despliegue es de A: [services.md](services.md), [architecture.md](architecture.md)):

| Componente | Código | Papel en la batalla |
|---|---|---|
| Web (SPA) | `apps/web/src/pages/BattleNewPage.tsx`, `BattlesPage.tsx` | Formulario de práctica y listado |
| API | `apps/api/src/routes/battles.ts` | Valida, persiste, encola y expone resultados |
| PostgreSQL | `apps/api/src/db/migrations.ts` | Fuente de verdad: `battles`, `participants`, `jobs`… ([database.md](database.md)) |
| Cola | tabla `jobs` + aviso opcional por Redis | Despacho de `run_battle` ([queue.md](queue.md)) |
| tournament-worker | `apps/tournament-worker/src/{worker,battle-runner,engine-executor}.ts` | Ejecuta el motor **en su propio proceso** y aloja el WebSocket de espectador ([workers.md](workers.md)) |
| Motor | `apps/arena-engine/src/sim/*` | Simulación determinista |
| replay-service | `apps/replay-service/src/*` | Almacén de replays en disco + estadísticas ([replays.md](replays.md)) |
| Camino real (apagado) | `apps/api/src/battle-run.ts`, `services/battle-run-http-launcher.ts`, `apps/arena-engine/src/service.ts` | `POST /battles/{id}/run` → arena-engine → contenedores de bots |

## Flujo de datos paso a paso

### 1. El usuario la pide (web)

- **Servicio**: SPA, `#/battles/new`.
- **Datos**: modo (`deathmatch`, `team_deathmatch`, `capture_the_flag`, `zone_control`), mapa publicado, semilla opcional, bot rojo y bot azul (cada uno con su `latestPublishedVersion`).
- **Envía**: `POST /api/v1/battles` con `{mode, rulesetId, mapId, mapVersion, seed?, participants:[{botId,version,team:"red"},{…,team:"blue"}]}`. El `rulesetId` sale de la tabla `MODE_RULESET` de la página (`dm_practice@1`, `tdm_mvp@1`, `ctf_mvp@1`, `zc_mvp@1`).
- **Además**: `GET /system/status` (rol `admin`) para saber si mostrar el botón «Ejecutar batalla real». Un usuario normal recibe 403, el error se ignora y el botón queda deshabilitado.
- **Errores en cliente**: «Elige un mapa publicado.», «Elige dos bots con versión publicada.», «Elige dos bots distintos.». Con menos de 2 bots publicados o 0 mapas publicados, el botón «Crear batalla» está deshabilitado.

### 2. La API valida

- **Servicio**: API, operación `createPracticeBattle` (`routes/battles.ts:392-443`).
- **Validaciones, en orden**:
  1. `mode` ∈ los 4 modos de arriba; si no, `400 mode inválido`.
  2. Entre 1 y 8 `participants`; si no, `400 participants: entre 1 y 8`.
  3. `rulesetId` existe en la **tabla `rulesets` de la BD**; si no, `400 rulesetId desconocido`. **Aquí se corta hoy la web**: `seedContent` sólo inserta `mvp-default` y la web envía ids del motor ([TD-003](../roadmap/technical-debt.md#td-003)).
  4. Existe `map_versions` publicada para `mapId` (y `mapVersion` si se pasa); si no, `400 Mapa inexistente o no publicado`.
  5. Cada `(botId, version)` está en estado `published` o `frozen`; si no, `409 bot_not_published`.
- **No valida** (estado actual, [TD-005](../roadmap/technical-debt.md#td-005)):
  - que los bots sean del solicitante (se pueden usar bots privados ajenos);
  - que el mapa declare el modo (`supported_modes`);
  - el formato de `team`;
  - la composición que exige el modo. Por ejemplo, deathmatch con dos vehículos en el mismo equipo se acepta y luego falla en el worker.

### 3. Persistencia

En una secuencia sin transacción explícita:

- `INSERT battles` con `status='scheduled'`, `official=false`, `mode`, `ruleset_id`, `map_id`, `map_version`, `seed`.
- `INSERT participants` con `(battle_id, bot_id, version, team)`.
- `INSERT jobs` con `kind='run_battle'`, `payload={battleId}`, sin `dedupe_key`.
- Respuesta `202` con la batalla serializada (`battleToJson`).

### 4. Cola

- El `tournament-worker` reclama trabajos de la tabla `jobs` con `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, filtrando por `kind ∈ {generate_schedule, run_battle, process_result, update_standings, tournament_dry_run}` (`tournament-worker/src/queue.ts`).
- Sin Redis el worker hace sondeo de la BD. Redis sólo acelera el aviso ([queue.md](queue.md), [TD-026](../roadmap/technical-debt.md#td-026)).
- **Reintentos**: sólo los fallos clasificados como infraestructura. Hay hasta `max_attempts=3` con *backoff* exponencial (`min(60 s, 1 s·2^intentos)`). Agotados, el trabajo pasa a `needs_review` y la batalla a `status='failed'`, `failure_kind='infrastructure'` (`markBattleForReview`).

### 5. Worker: preparación

- **Servicio**: `makeRunBattleHandler` (`battle-runner.ts`).
- **Idempotencia**: si la batalla ya está `finished`, no se re-ejecuta (sólo rellena estadísticas si faltan).
- **Descalificaciones administrativas**: el handler admite `suspensions` y `artifactGuard`, pero **`main.ts` no los cablea**. Hoy no se descalifica a nadie antes de lanzar ([TD-015](../roadmap/technical-debt.md#td-015)).
- `UPDATE battles SET status='running', started_at=now()` **sin condición de estado**. Esto es relevante para la doble ejecución: [ver abajo](#los-dos-caminos-de-ejecución).
- Si tras las descalificaciones queda un solo bando, se cierra por *walkover* (`finalStateHash='walkover'`).

### 6. Worker: motor

- **Servicio**: `makeEngineExecutor` (`engine-executor.ts`).
- **Mapa**: `map_versions.content` → `toEngineMap()` → `ArenaMap`. Si no hay contenido o no convierte, `InfrastructureFailure map_unavailable`.
- **Reglas**: `MODE_DEFAULT_ENGINE_RULESET.get(battle.mode)` → `loadRuleset(...)`. **El `ruleset_id` de la BD sólo aporta `budget_credits`** (o el del torneo); su `config.engineRulesetId` no se lee en este camino. Un modo sin ruleset del motor da `InfrastructureFailure engine_start_failure`.
- **Catálogo**: el congelado del torneo (`tournaments.catalog_version`) o, en práctica, la última versión importada.
- **Vehículos**: se lee el loadout de cada participante. En torneo es `entries.loadout_revision`; si no, `bot_versions.loadout_revision`. Después `resolveVehicle(loadout, catalog)` produce el `VehicleSpec` e ids `veh_1…veh_N`.
- **Agentes**: `defaultAgentResolver = (botId) => new HunterBot(botId)` (`engine-executor.ts:51`). **Todos los vehículos los conduce el stub `HunterBot`, no el código subido** ([TD-002](../roadmap/technical-debt.md#td-002)). El equipamiento sí cuenta: chasis, armas, blindaje, movilidad, energía y sensores que lee `HunterBot` (radar, lidar). Radio, minas, acústica y proximidad no se usan porque el stub no las usa ([TD-016](../roadmap/technical-debt.md#td-016)).
- **Simulación**: `Battle.create(...)` y bucle `step()` hasta `isFinished()` o 100 000 ticks. Cede el *event loop* cada 25 ticks (`setImmediate`) para que el gateway de espectador emita. **No hay ritmo de tiempo real**: una batalla de 9 000 ticks termina en segundos.
- **Espectador**: `spectate.attachBattle(battle.id, b, {spectator, meta:{mode, mapId, roster…}})` al empezar y `detachBattle` 3 s después de terminar ([websocket.md](websocket.md)).
- **Produce**: `{winner, ticks, score, finalStateHash, disqualified, versions, replayJsonl}`.

### 7. Resultado

`finishBattle` (`battle-runner.ts:229-282`):

1. Ingiere el replay con la librería del replay-service. Escribe `<battleId>.replay` y `<battleId>.replay.json` en `REPLAYS_DIR`; ver [replays.md](replays.md).
2. En una transacción:
   - `battles`: `status='finished'`, `finished_at`, `failure_kind='none'`, `result={winner,ticks,score,disqualified}`, `final_state_hash`, `engine_versions`, `replay_ref` (ruta del fichero), `replay_hash`;
   - `participants.outcome` ∈ `win|loss|draw|disqualified`.
3. Encola `process_result` (deduplicado por batalla).

### 8. Estadísticas

- `ensureRichStats` → `runStatsJob` (replay-service, `stats.ts`). Re-simula el replay y escribe `battle_stats(battle_id, bot_id, stats jsonb)` con borrado e inserción idempotentes.
- Datos: daño, disparos, aciertos, precisión, kills, banderas, minas, *timeouts*, `perModule` y `cpuMs`. `cpuMs` es `null` en este camino porque sólo lo mide el runner de contenedores.
- `process_result`: en práctica no hace nada. En torneo cierra la serie del *match*, avanza el cuadro y encola `update_standings`, que aplica el Elo y la clasificación ([tournaments.md](tournaments.md)).

### 9. Replay y visor

- **API**: `GET /api/v1/battles/{id}` (resultado), `GET /api/v1/battles/{id}/stats`, `GET /api/v1/replays/{id}` (fichero) y `POST /api/v1/replays/{id}/verify`.
- **Gateway**: `/replays/*` va directo al replay-service y es **anónimo** ([TD-004](../roadmap/technical-debt.md#td-004)).
- **Web**: `#/battles` enlaza «Ver replay» (`#/replay/<id>?t=0`). El reproductor descarga índice y segmentos, pero **falla al arrancar Phaser** (`getScene("viewer")` antes del boot, [TD-009](../roadmap/technical-debt.md#td-009)). Ver [frontend.md](frontend.md).

## Los dos caminos de ejecución

**Estado ACTUAL, no deseado.** Hay dos rutas de código que pueden ejecutar la misma batalla:

| | Camino A — worker (activo) | Camino B — `/run` real (apagado) |
|---|---|---|
| Disparo | Automático: `POST /battles` inserta `jobs.run_battle` | Manual: `POST /api/v1/battles/{id}/run` (rol `user`) |
| Ejecutor | `tournament-worker`, motor en proceso | API → `arena-engine` `POST /run` → contenedores vía `s9-docker-proxy` |
| Agentes | `HunterBot` para todos | Código real del bot, artefacto firmado |
| Reserva | `UPDATE status='running'` sin condición | `claimBattleForRun`: `UPDATE … WHERE status='scheduled'` atómico |
| Cierre | Escribe `finished`, resultado, replay, stats | Con `completed` la deja `running`: **no escribe `finished` ni resultado**. Ingiere el replay si hay replay-service |
| Activación | Siempre | `S9_ENABLE_REAL_BATTLE_RUNS=1` **y** launcher cableado (`ARENA_ENGINE_URL` + secreto). En arena-engine también `DOCKER_PROXY_URL` |
| Hoy | Ejecuta todas las batallas | `503 real_battle_runs_disabled` |

**Riesgo de doble ejecución** si se encendiera B tal cual ([TD-002](../roadmap/technical-debt.md#td-002)):

- **El worker gana la carrera**: `POST /battles` ya encoló `run_battle`. El worker suele reclamarlo en segundos y pone `running`, así que `/run` responde `409 invalid_state`. El usuario nunca vería su código ejecutado.
- **`/run` gana la carrera**: reserva `scheduled→running`. El job del worker sigue en la cola. `loadBattle` no ve `finished` y vuelve a ejecutar la batalla con `HunterBot`, escribe `finished` y un replay bajo el mismo `battleId`.
- **El techo de concurrencia** de `/run` (`S9_MAX_CONCURRENT_REAL_BATTLE_RUNS`, 1 por defecto) cuenta filas `running` de ambos caminos, pero el worker no lo respeta.

Activar B exige antes un único dueño de la ejecución (ver [pending-features.md](../roadmap/pending-features.md) y [readiness.md](../operations/readiness.md)).

## Persistencia y estados

| Tabla | Columnas relevantes | Estados (CHECK) |
|---|---|---|
| `battles` | `status`, `official`, `mode`, `ruleset_id`, `map_id`, `map_version`, `seed`, `seed_commitment`, `seed_reveal_proof`, `result`, `failure_kind`, `replay_ref`, `replay_hash`, `final_state_hash`, `engine_versions`, `tournament_id`, `match_id`, `spectator_mode`, `started_at`, `finished_at` | `status ∈ scheduled, running, finished, failed`. `failure_kind ∈ none, bot_timeout, bot_crash, infrastructure`. `spectator_mode ∈ delayed, visible` |
| `participants` | `battle_id`, `bot_id`, `version`, `team`, `outcome`, `cpu_ms` | `outcome ∈ win, loss, draw, disqualified` (NULL hasta terminar) |
| `jobs` | `kind`, `payload`, `status`, `attempts`, `max_attempts`, `run_after`, `locked_by`, `locked_at`, `last_error`, `error_class`, `dedupe_key` | `status ∈ queued, running, done, failed, needs_review`. `error_class ∈ sporting, infrastructure` |
| `battle_stats` | `battle_id`, `bot_id`, `stats` | — |

Transiciones de `battles.status` en el camino A:

- `scheduled → running → finished`.
- Ante un fallo técnico, `running → scheduled` y reintento. Agotados los reintentos, `→ failed`.

Hay un caso que se ve como error sin serlo: `failure_kind='none'` se pinta en `#/battles` como «finished (none)» en rojo ([TD-022](../roadmap/technical-debt.md#td-022)).

## Errores / limitaciones

| Situación | Dónde | Lo que se ve |
|---|---|---|
| Web crea batalla en cualquier modo | API paso 2.3 | `400` «rulesetId desconocido» en rojo |
| Versión no publicada (todas, hoy) | API paso 2.5 | `409 bot_not_published` |
| Deathmatch con equipos compartidos, `zone_control` en un mapa sin zonas de captura, CTF sin banderas/bases | Motor (`createMode`) | El worker lo clasifica como **infraestructura**. Reintenta 3 veces y deja la batalla `failed (infrastructure)`, aunque el error es de configuración del usuario |
| Batalla muy rápida | Worker | Casi nunca se llega a verla `running` en directo |
| Ejecución real pedida | API `/run` | `503 real_battle_runs_disabled` / `runner_unavailable` |
| Carreras de doble envío | API | Algunas rutas devuelven `500` en lugar de `409` ([TD-013](../roadmap/technical-debt.md#td-013)) |

## Estado actual

- **FUNCIONA ACTUALMENTE**: la API crea batallas con un `rulesetId` presente en la BD (`mvp-default`), siempre que los bots tengan una versión `published`/`frozen`; esa versión sólo existe en datos de prueba. El worker las juega y escribe resultado, replay y estadísticas.
- **PARCIAL**: el torneo es la única vía de la UI que llega a jugar batallas, y requiere rol `organizer` y bots publicados ([tournaments.md](tournaments.md)).
- **PENDIENTE**: ejecución del código real de los bots; un único camino de ejecución; validación de propiedad, modo↔mapa y composición; ganador y estadísticas en la web.

## Documentación relacionada

- Usuario: [Batallas](../user/battles.md), [Visor](../user/viewer.md), [Replays](../user/replays.md)
- Técnica: [api.md](api.md), [engine.md](engine.md), [game-modes.md](game-modes.md), [bots.md](bots.md), [replays.md](replays.md), [websocket.md](websocket.md), [tournaments.md](tournaments.md)
- Arquitectura (A): [data-flow.md](data-flow.md), [queue.md](queue.md), [workers.md](workers.md), [database.md](database.md), [security.md](security.md)
- Operación (C): [readiness.md](../operations/readiness.md), [configuration.md](../operations/configuration.md), [diagnostics.md](../operations/diagnostics.md)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-003](../roadmap/technical-debt.md#td-003), [TD-005](../roadmap/technical-debt.md#td-005), [TD-009](../roadmap/technical-debt.md#td-009), [TD-015](../roadmap/technical-debt.md#td-015), [TD-016](../roadmap/technical-debt.md#td-016)
- Histórico absorbido: R9 (creación de batallas), R6.2 (ejecución real), Carril I (gate de ejecución), R12 (preparación de batallas) y el smoke containerizado, en `docs/history/disenos/` y `docs/testing/smoke/` (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md)).

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| La web envía `rulesetId` del motor (`dm_practice@1`…) | CODE_VERIFIED | `apps/web/src/pages/BattleNewPage.tsx:17-22,112-123` |
| La API busca `rulesetId` en la tabla `rulesets` y devuelve 400 | CODE_VERIFIED | `apps/api/src/routes/battles.ts:400-401` |
| El contenido base sólo crea el ruleset `mvp-default` | CODE_VERIFIED | `apps/api/src/db/seeds/dev.ts:37,75-85` |
| 400 en los 4 modos desde la web, en navegador real | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1b (entorno aislado) |
| Modos aceptados en práctica: 4; participantes 1..8 | CODE_VERIFIED | `routes/battles.ts:394-399` |
| No se valida propiedad de bots ni modo↔mapa | CODE_VERIFIED | `routes/battles.ts:392-443` (ausencia); auditoría B p2 §5 |
| Se encola `run_battle` sin `dedupe_key` | CODE_VERIFIED | `routes/battles.ts:441` |
| El worker usa `HunterBot` para todos los vehículos | CODE_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:51,82,176`; `main.ts:65` |
| El worker resuelve el ruleset por modo e ignora `rulesets.config` | CODE_VERIFIED | `engine-executor.ts:101-117` |
| `suspensions`/`artifactGuard` no se cablean | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:77-107` |
| El worker marca `running` sin condición | CODE_VERIFIED | `apps/tournament-worker/src/battle-runner.ts:142` |
| `/run` reserva atómicamente y no escribe `finished` | CODE_VERIFIED | `routes/battles.ts:62-68,683-689,735-742` |
| `/run` apagado por flag | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/battle-run.ts:83-90`; auditoría B p1 (503) |
| Reintentos 3, backoff exponencial, `needs_review` | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts:150-176`; `battle-runner.ts:285-292` |
| Error de composición tratado como infraestructura | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/arena-engine/src/sim/modes.ts:132-146`, `engine-executor.ts:271-274`; auditoría B p1 §B7 |
| Batallas de 0,2–2,6 s, sin ritmo real | RUNTIME_VERIFIED | Auditoría B p1 §B7/B10; `engine-executor.ts:240-243` |
| Activar `/run` provocaría doble ejecución | DESIGN_ONLY (derivado del código, no ejecutado) | `battle-runner.ts:117-142` + `routes/battles.ts:683` |
