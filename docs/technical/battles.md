# Ciclo de vida de una batalla

## Resumen

Documento central del ciclo de batalla de S9 AI Arena: desde que alguien la pide hasta que se ve su replay. Cubre cada paso con su servicio, los datos que entran y salen, las tablas y estados reales de PostgreSQL y los errores posibles.

Estado actual, en una línea: **hay UN solo camino de ejecución y ejecuta el código real de cada bot** (cierre funcional 2026-10, DEV-B). La API agenda; el `tournament-worker` reserva la batalla de forma atómica, lanza un contenedor por bot con su código sobre el runtime fijado, aloja el motor y el `ProtocolServer` y cierra la batalla **exactamente una vez**. El stub `HunterBot` ya no es seleccionable en producción. Verificado de punta a punta en un entorno aislado con Docker rootless ([Verificación](#verificación)). En producción **no está activado**: falta integrar el proveedor de artefactos de DEV-A ([TD-001](../roadmap/technical-debt.md#td-001)) y aplicar los cambios de compose; mientras tanto el worker **no reclama** `run_battle` (las batallas quedan `scheduled`) en vez de jugarlas con un stub.

## Índice

- [Qué es](#qué-es)
- [Arquitectura](#arquitectura)
- [Flujo de datos paso a paso](#flujo-de-datos-paso-a-paso)
- [Autoridad única de ejecución](#autoridad-única-de-ejecución)
- [Persistencia y estados](#persistencia-y-estados)
- [BATTLE_RESULT: forma de `battles.result`](#battle_result-forma-de-battlesresult)
- [Uso](#uso)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Una **batalla** es una simulación del motor 2D ([engine.md](engine.md)) entre 1 y 8 vehículos. Se juega en un mapa publicado ([maps.md](maps.md)) con las reglas de un *ruleset* del motor ([game-modes.md](game-modes.md)). Cada vehículo sale del *loadout* de una versión de bot ([equipment.md](equipment.md)) y lo **conduce el código de esa versión** ([bots.md](bots.md)). Hay dos orígenes:

- **Práctica**: `POST /api/v1/battles` (rol mínimo `user`). `official=false`, no afecta al rating.
- **Torneo**: el `tournament-worker` la crea al materializar el calendario ([tournaments.md](tournaments.md)). `official=true`, afecta al rating Elo.

## Arquitectura

| Componente | Código | Papel en la batalla |
|---|---|---|
| Web (SPA) | `apps/web/src/pages/BattleNewPage.tsx`, `BattlesPage.tsx` | Formulario de práctica y listado |
| API | `apps/api/src/routes/battles.ts` | Valida (incluida la propiedad de los bots), persiste y **encola**; nunca ejecuta |
| PostgreSQL | `apps/api/src/db/migrations.ts` | Fuente de verdad: `battles`, `participants`, `jobs`, `battle_stats` ([database.md](database.md)) |
| Cola | tabla `jobs` (+ aviso opcional por Redis) | `run_battle` con `dedupe_key = run_battle:<battleId>` ([queue.md](queue.md)) |
| tournament-worker | `apps/tournament-worker/src/{battle-runner,engine-executor,container-agents}.ts` | **Autoridad única**: reserva, ejecuta, cierra; aloja `ProtocolServer` y espectador ([workers.md](workers.md)) |
| Sandbox de bots | `apps/bot-manager/src/{docker-proxy,container-runner}.ts` | `ProxyContainerRunner` → `s9-docker-proxy` → un contenedor por bot (tabla 18.2) |
| Proveedor de lanzamiento | `apps/tournament-worker/src/bot-launch-provider.ts` → `apps/bot-manager/src/bot-launch.ts` (DEV-A) | Dice QUÉ lanzar por (bot, versión): imagen fijada, env, cmd (artefacto firmado) |
| Motor | `apps/arena-engine/src/sim/*`, `protocol-server.ts` | Simulación determinista + protocolo arena/1 por WebSocket |
| replay-service | `apps/replay-service/src/*` | Almacén de replays + estadísticas re-simuladas ([replays.md](replays.md)) |
| Camino legado | `apps/api/src/battle-run.ts`, `services/battle-run-http-launcher.ts`, `apps/arena-engine/src/service.ts` | **Ya no lo usa nadie**: `POST /battles/{id}/run` delega en la cola. Queda como librería probada |

## Flujo de datos paso a paso

### 1. El usuario la pide (web)

- `#/battles/new` → `POST /api/v1/battles` con `{mode, rulesetId, mapId, mapVersion?, seed?, participants:[{botId, version, team}]}` (contrato BATTLE_CREATE).
- El `rulesetId` y su catálogo son de DEV-C ([TD-003](../roadmap/technical-debt.md#td-003)).

### 2. La API valida (`createPracticeBattle`)

En orden:

1. `mode` ∈ `deathmatch`, `team_deathmatch`, `capture_the_flag`, `zone_control` → si no, `400 mode inválido`.
2. Entre 1 y 8 `participants` → si no, `400`.
3. **Contenido** (integración REVIEW): `checkBattleContent` de DEV-C (`routes/catalog.ts`), la MISMA regla que usa la web → `400 ruleset_unknown`, `409 ruleset_mode_mismatch` (ruleset de otro modo), `400 map_not_published`, `409 map_mode_unsupported` (el mapa no declara el modo). Antes estos fallos aparecían tarde, en el worker.
4. **Forma de cada participante**: `botId` cadena, `version` entero ≥ 1, `team` `[A-Za-z0-9_-]{1,32}`, y **cada bot una sola vez** → si no, `400` (antes un bot repetido daba `500` por la PK).
5. **Propiedad / visibilidad** ([TD-005](../roadmap/technical-debt.md#td-005)): el bot debe ser propio, `public`, o `team` de un equipo del que el solicitante es miembro (un `admin`, cualquiera). Si no → **`404 bot_not_found`, idéntico al de un bot inexistente** (no se revela que existe).
6. Cada `(botId, version)` en `published`/`frozen` → si no, `409 bot_not_published`.

**No valida todavía** la composición por modo (equipos compartidos en deathmatch, zonas/banderas que exija el modo; ver [Errores](#errores--limitaciones)).

### 3. Persistencia (una transacción)

`INSERT battles (status='scheduled', official=false, …)` + `INSERT participants` + `INSERT jobs (kind='run_battle', dedupe_key='run_battle:<id>')`, en **una sola transacción** (antes eran tres escrituras sueltas). Respuesta `202` con la batalla (`battleToJson`).

### 4. Cola

El `tournament-worker` reclama trabajos con `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` ([queue.md](queue.md)). Mientras la batalla corre, el worker **renueva `jobs.locked_at`** para que el trabajo no parezca huérfano (una batalla real dura minutos y el umbral de huérfano es 60 s).

### 5. Worker: reserva atómica (`claimBattle`)

```sql
UPDATE battles SET status='running', started_at=now(), finished_at=NULL,
       claimed_by=:owner, lease_expires_at=now()+:lease, run_attempts=run_attempts+1
 WHERE id=:battleId
   AND (status='scheduled' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < now())))
RETURNING *
```

- `owner = <workerId>:<jobId>:<attempts>`. El lease (45 s por defecto, por debajo del umbral de huérfano de la cola) se renueva cada `lease/3`.
- Si no se gana la reserva: batalla `finished` → sólo completa estadísticas que falten; `failed` → nada; `running` con lease vivo de otro → `InfrastructureFailure battle_busy` (es un trabajo duplicado; el reintento la verá `finished`).
- Si el worker **pierde** la reserva a mitad (no puede renovar: otro la recuperó tras caducar), se aborta la ejecución (`AbortSignal`), se paran los contenedores y no se escribe nada.

### 6. Descalificaciones administrativas (antes de lanzar)

- Versión que ya no está `published`/`frozen` (p. ej. `suspended` tras agendar) → descalificada.
- `suspensions` (registro E6) y `artifactGuard` (firma) si se inyectan.
- Si queda un solo bando → cierre por *walkover* (`endReason: "walkover"`).

### 7. Worker: motor y agentes

`makeEngineExecutor` (`engine-executor.ts`):

- **Mapa**: `map_versions.content` → `toEngineMap()`; sin contenido → `InfrastructureFailure map_unavailable`.
- **Reglas**: `resolveBattleRuleset` (el mismo resolutor que usaba el launcher: `rulesets.config.engineRulesetId` o el defecto del modo, exigiendo que el modo coincida) + `budget_credits` del torneo/ruleset. Antes el worker ignoraba `config.engineRulesetId`.
- **Catálogo** congelado del torneo o el último importado; **vehículos** del loadout congelado (`entries.loadout_revision` o `bot_versions.loadout_revision`).
- **Agentes**: el `AgentDriver` es **obligatorio**; sin él `makeEngineExecutor` lanza. En producción, `containerAgents()` (`container-agents.ts`):
  1. abre el host de la batalla con `createBattleLaunchHost` (DEV-A, `apps/bot-manager/src/bot-launch.ts`, integrado por REVIEW): un `SandboxHost` (HTTP del artefacto + WebSocket del protocolo en un puerto);
  2. crea el `ProtocolServer` con ese `wss` y, por vehículo, pide el plan: `resolveBotLaunch` verifica que `(botId, version)` está `published|frozen`, que el artefacto es el DE SU build, su sha256 y la firma ed25519 con la clave PÚBLICA (`ARTIFACT_VERIFY_KEY_FILE`), y devuelve la imagen de RUNTIME fijada en `runtimes/DIGESTS.lock` + el bootstrap (`Cmd`) + `ARTIFACT_URL/TOKEN/SHA256`. El contenedor descarga el artefacto, vuelve a comprobar el sha256 y ejecuta el código del usuario. Se lanza por `ProxyContainerRunner` con `WS_URL`, `BATTLE_TOKEN`, `BOT_ID` (asa del cable, no el uuid), `AutoRemove`, límites `DEFAULT_LIMITS` y seccomp restrictivo. Antes, además, `DbArtifactLaunchGuard` comprueba la firma por participante: un artefacto manipulado DESCALIFICA a ese bot (walkover del íntegro) en vez de tumbar la batalla;
  3. **inspecciona la postura** de cada contenedor y aborta si `complianceViolations` no está vacío;
  4. espera el handshake de TODOS (tick 0 con todos enganchados) y arranca el bucle a ritmo real (34 ms/tick por defecto);
  5. muestrea la **CPU del cgroup** de cada contenedor durante la batalla (Docker la devuelve a 0 en cuanto el bot sale tras `SHUTDOWN`);
  6. al terminar, replay del `ProtocolServer` y limpieza incondicional.
- **Descalificaciones del motor**: el motor descalifica **vehículos** (`veh_N`); el ejecutor las traduce a **bots** (antes no: un bot descalificado por timeouts nunca quedaba `disqualified`).
- **Espectador**: `attachBattle` al empezar, `detachBattle` 3 s después ([websocket.md](websocket.md)).

### 8. Cierre exactamente una vez (`finishBattle`)

En **una transacción**:

1. `UPDATE battles SET status='finished', finished_at, failure_kind, result, final_state_hash, engine_versions, lease_expires_at=NULL WHERE id AND status='running' AND claimed_by=:owner`. **Si no es exactamente 1 fila → rollback y no se escribe nada** (otro titular la cerró o recuperó).
2. Ingesta del replay (`ingestReplay`) **dentro** de la transacción, con la fila bloqueada: un finalizador perdedor nunca pisa `<battleId>.replay`. `replay_ref`, `replay_hash`.
3. `participants.outcome` (`win|loss|draw|disqualified`) y `participants.cpu_ms` (sólo si se midió; nunca una estimación).
4. `jobs.process_result` con `dedupe_key=process_result:<id>`.

Después, `runStatsJob` (re-simulación del replay) escribe `battle_stats` (forma canónica: daño, disparos, aciertos, precisión, kills, banderas, minas, timeouts, `perModule`, `cpuMs` desde `participants.cpu_ms`).

### 9. Replay y visor

`GET /api/v1/battles/{id}` (con `result`, `startedAt`, `finishedAt`, `replayAvailable`, `replayHash`, `participants[].outcome/cpuMs`), `GET /battles/{id}/stats`, `GET /replays/{id}`, `POST /replays/{id}/verify`. Visor y reproductor: [frontend.md](frontend.md) (DEV-D).

## Autoridad única de ejecución

| Paso | Quién | Dónde |
|---|---|---|
| Crea (agenda) | API | `createPracticeBattle` / scheduler de torneos |
| Encola | API / scheduler | `jobs.run_battle`, dedupe `run_battle:<id>` |
| Reserva | tournament-worker | `claimBattle` (UPDATE condicionado + lease) |
| Ejecuta | tournament-worker | `makeEngineExecutor` + `containerAgents` → contenedores de los bots |
| Finaliza y escribe result, outcome, replay_ref/hash, cpu_ms | tournament-worker | `finishBattle` (condicionado al titular) |
| Stats | tournament-worker (librería del replay-service) | `runStatsJob` |
| Rating / standings | tournament-worker | `process_result` → `update_standings` |

`POST /api/v1/battles/{id}/run` **ya no ejecuta**: si la batalla está `scheduled`, se asegura de que su trabajo está encolado (idempotente) y responde `202 {delegatedTo:"tournament-worker"}`; si no, `409 invalid_state`. La API ya no tiene reserva propia ni techo de concurrencia: el techo es el número de huecos del worker (`computeConcurrency`).

Garantías (cada una con test que se pone rojo, ver Verificación): doble POST `/run` → un trabajo; trabajos duplicados + dos workers → una ejecución; worker muerto → otro recupera tras caducar el lease; titular caducado → no puede cerrar; sin driver → no hay HunterBot implícito.

## Persistencia y estados

| Tabla | Columnas relevantes | Estados (CHECK) |
|---|---|---|
| `battles` | `status`, `official`, `mode`, `ruleset_id`, `map_id`, `map_version`, `seed`, `result`, `failure_kind`, `replay_ref`, `replay_hash`, `final_state_hash`, `engine_versions`, `started_at`, `finished_at`, **`claimed_by`, `lease_expires_at`, `run_attempts`** (migración `013_battle_claim`) | `status ∈ scheduled, running, finished, failed`; `failure_kind ∈ none, bot_timeout, bot_crash, infrastructure` |
| `participants` | `battle_id`, `bot_id`, `version`, `team`, `outcome`, `cpu_ms` | `outcome ∈ win, loss, draw, disqualified` |
| `jobs` | `kind`, `payload`, `status`, `attempts`, `locked_by`, `locked_at`, `dedupe_key`, `last_error`, `error_class` | `queued, running, done, failed, needs_review` |
| `battle_stats` | `battle_id`, `bot_id`, `stats` | — |

Transiciones de `battles.status` (BATTLE_STATUS):

- `scheduled → running` sólo por `claimBattle`; `running → running` (nuevo titular) sólo con el lease caducado.
- `running → finished` sólo por el titular vigente (`finishBattle`).
- `running → scheduled` ante fallo técnico, sólo si la reserva sigue siendo del que falla.
- `scheduled|running(lease caducado) → failed (infrastructure)` al agotar reintentos (`markBattleForReview`); nunca toca una `finished` ni una con lease vivo de otro.

**PK de `participants` = (battle_id, bot_id)**: un mismo bot no puede estar en dos bandos ni dos veces en la misma batalla. La API lo rechaza con 400. No impide nada útil hoy (un bot contra sí mismo se juega con dos versiones distintas… que también comparten `bot_id`, así que **tampoco** es posible enfrentar v1 contra v2 del mismo bot). Si se quisiera, haría falta cambiar la PK a `(battle_id, bot_id, version)` o a un id de participante.

## BATTLE_RESULT: forma de `battles.result`

```json
{
  "schema": "battle-result/v1",
  "winner": "red",
  "ticks": 726,
  "score": { "red": 1, "blue": 0 },
  "disqualified": [],
  "endReason": "completed",
  "agents": "container"
}
```

| Campo | Significado |
|---|---|
| `schema` | Versión de la forma (`battle-result/v1`) |
| `winner` | Equipo ganador o `"draw"`. El ganador **por bot** es `participants.outcome` |
| `ticks`, `score` | Del motor |
| `disqualified` | botIds descalificados (motor + administrativos + culpable deportivo) |
| `endReason` | `completed`, `walkover` (un solo bando tras DQ administrativas), `sporting_failure` (bot culpable, sin simulación) |
| `agents` | Quién condujo los vehículos: `container` (código real, producción), `in_process_stub` (tests), `scripted` (tests de cola) |

Los campos `winner/ticks/score/disqualified` son los históricos (los leen `results.ts`, la API pública y la web); el resto es aditivo. Junto al resultado: `started_at`, `finished_at`, `replay_ref`, `replay_hash`, `final_state_hash`, `engine_versions` (incluye `rulesetEngine`) y `participants.cpu_ms`.

## Uso

Crear y seguir una batalla por API:

```bash
curl -X POST https://arena.example.internal/api/v1/battles -H "Authorization: Bearer $TOKEN" \
  -d '{"mode":"deathmatch","rulesetId":"mvp-default","mapId":"mvp-arena-01",
       "participants":[{"botId":"<mi-bot>","version":1,"team":"red"},{"botId":"<bot-publico>","version":3,"team":"blue"}]}'
# 202 {id, status:"scheduled", …}
curl https://arena.example.internal/api/v1/battles/<id>        # status, result, participants[].outcome
curl https://arena.example.internal/api/v1/battles/<id>/stats  # battle_stats por bot
```

## Errores / limitaciones

| Situación | Dónde | Lo que se ve |
|---|---|---|
| Bot privado ajeno o inexistente | API | `404 bot_not_found` |
| Bot repetido / `team` inválido | API | `400` |
| Versión no publicada | API | `409 bot_not_published` |
| Sandbox no configurado en el worker (`DOCKER_PROXY_URL`, `ARENA_ENGINE_HOST`, clave de verificación o `DIGESTS.lock` ausentes) | worker | Log «EJECUCIÓN DE BATALLAS DESACTIVADA»; las batallas quedan `scheduled` |
| No se puede lanzar un contenedor, ningún bot conecta, postura no conforme | worker | Infraestructura: reintento ×3 y `failed (infrastructure)` |
| Un bot conecta y otro no | worker | Derrota deportiva del ausente (`bot_crash`, `endReason: sporting_failure`) |
| Bot que deja de responder | motor | Descalificado por timeouts → `participants.outcome = disqualified` |
| Ruleset de otro modo / mapa que no declara el modo | API | `409 ruleset_mode_mismatch` / `409 map_mode_unsupported` |
| Artefacto manipulado o firma ajena | worker | el guard lo descalifica antes de lanzar; si llegara al proveedor, `InfrastructureFailure artifact_unavailable` (fallo cerrado, ningún contenedor) |
| Deathmatch con equipos compartidos, ZC sin zonas, CTF sin banderas | motor | `failed (infrastructure)` tras 3 reintentos (error de configuración del usuario clasificado como infraestructura; pendiente validarlo en la API) |
| Trabajo duplicado de una batalla en curso | worker | `needs_review` con `[battle_busy]`; la batalla no se toca |

Limitaciones:

- **CPU**: es la última muestra (cada 500 ms) del contador del cgroup antes de que el bot salga: cota inferior de lo consumido, incluye arranque del intérprete y SDK.
- La batalla corre a **ritmo real** (≈5 min para 9 000 ticks); el `tickIntervalMs` sólo se acelera en tests.
- Los contenedores de bots se lanzan con `AutoRemove` (el proxy no expone `DELETE`): la Engine los borra al salir.
- La API no valida la composición por modo.
- Arranque del contenedor medido en pared: bajo carga un bot Python puede pasar de 5 s en el build (TD-034).

## Estado actual

- **FUNCIONA (entorno aislado, RUNTIME_VERIFIED)**: web → API → cola → worker → contenedores con el ARTEFACTO FIRMADO de la versión exacta de cada bot (buildeado en el sandbox real) → motor → resultado, outcome, replay verificable, stats y CPU reales; también desde el navegador (golden path).
- **FUNCIONA (producción)**: desplegado con RC4 (`f32ab2c`) y verificado el 2026-10-27 con una batalla real: el código del usuario juega en contenedores con el artefacto firmado de su versión.
- **PENDIENTE**: composición por modo en la API; separar el anfitrión de bots del proceso con credenciales de BD (TD-033).

## Documentación relacionada

- Usuario: [Batallas](../user/battles.md), [Estadísticas](../user/statistics.md), [Visor](../user/viewer.md), [Replays](../user/replays.md)
- Técnica: [workers.md](workers.md), [queue.md](queue.md), [engine.md](engine.md), [tournaments.md](tournaments.md), [bots.md](bots.md), [replays.md](replays.md), [websocket.md](websocket.md)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-005](../roadmap/technical-debt.md#td-005), [TD-013](../roadmap/technical-debt.md#td-013), [TD-015](../roadmap/technical-debt.md#td-015)

## Verificación

Verificado sobre la integración del cierre funcional (`integration/functional-closure`) (base `0b8c12b`) y, tras la integración, sobre `integration/functional-closure` (filas marcadas REVIEW).

| Afirmación | Estado | Evidencia |
|---|---|---|
| La API encola con dedupe en la misma transacción que la batalla | CODE_VERIFIED | `apps/api/src/routes/battles.ts:52`, `:468` |
| Propiedad/visibilidad de participantes; 404 indistinguible | CODE_VERIFIED + test | `routes/battles.ts:416`; `apps/api/src/battles-create-ownership.test.ts` |
| `/run` delega y no ejecuta | CODE_VERIFIED + test | `routes/battles.ts:626`; `apps/api/src/battle-run.test.ts` |
| Reserva atómica con lease | CODE_VERIFIED + test | `apps/tournament-worker/src/battle-runner.ts:164`; `battle-lifecycle.test.ts` («8 reservas…», «trabajos DUPLICADOS…») |
| Cierre sólo por el titular vigente | CODE_VERIFIED + test | `battle-runner.ts:470`; `battle-lifecycle.test.ts` («titular cuya reserva caducó…») |
| `markBattleForReview` no toca batallas con lease vivo | CODE_VERIFIED | `battle-runner.ts:522` |
| Sin driver de agentes no hay ejecutor | CODE_VERIFIED + test | `engine-executor.ts:133`; `battle-lifecycle.test.ts` («sin driver LANZA») |
| Ruleset resuelto con `resolveBattleRuleset` | CODE_VERIFIED | `engine-executor.ts:155` |
| DQ del motor traducida a bot | CODE_VERIFIED + test | `engine-executor.ts:310`; `battle-lifecycle.test.ts` («B6…») |
| Postura de contenedor verificada; no-show = deportivo | CODE_VERIFIED | `container-agents.ts:190`, `:210` |
| Producción: worker con `containerAgents`, sin stub, no reclama `run_battle` sin sandbox | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:72`, `:115` |
| E2E real: código de dos bots en contenedores, ganador y stats lo prueban | RUNTIME_VERIFIED (aislado, Docker rootless) | `apps/tournament-worker/src/container-battle-e2e.test.ts` con `S9_RUN_REAL_DOCKER_E2E=1`: Artillero `win` (1 kill, 13 disparos aceptados, 122 intentos, 461,7 de daño), Pacifista `loss` (0 intentos), `agents:"container"`, CPU 570/537 ms, `verify.matches=true` |
| REVIEW · el worker lanza el artefacto firmado de la versión exacta (no imagen por versión) | RUNTIME_VERIFIED (aislado) | `apps/tournament-worker/src/container-battle-e2e.test.ts` (`S9_RUN_REAL_DOCKER_E2E=1`, rc=0, 3/3): bots buildeados por la API en el sandbox real; Artillero `win` (11 disparos, 101 intentos), Pacifista `loss` (0 intentos); procedencia = artefacto y build de cada versión; artefacto manipulado ⇒ no se lanza |
| REVIEW · `createBattleLaunchHost` falla cerrado (no publicada, manipulado, firma ajena) | CODE_VERIFIED + test | `apps/bot-manager/src/bot-launch.ts`; `apps/bot-manager/tests/battle-launch-host.test.ts` |
| REVIEW · `checkBattleContent` en POST /battles | CODE_VERIFIED + test | `routes/battles.ts` (`createPracticeBattle`); `apps/api/src/battles-create-content.test.ts` (mutación «saltar la comprobación» ⇒ 4 rojos) |
| REVIEW · golden path en navegador | RUNTIME_VERIFIED (aislado) | `tests/browser/specs/golden-path.spec.ts` (`npm run test:browser`, fase golden rc=0) |
| Producción sin activar | DESIGN_ONLY | compose preparado (`infrastructure/docker-compose.yml`, bloque `tournament-worker`); despliegue fuera del cierre funcional |
