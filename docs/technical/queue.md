# Cola de trabajos

## Resumen

La cola de S9 AI Arena es la **tabla `jobs` de PostgreSQL** (ADR-E9-001). Redis (`queue`) sólo es un
**canal de aviso** opcional para despertar al worker antes de que venza su espera. En el código
actual ese aviso **no tiene productor**: el worker avanza por polling, más o menos cada segundo.
Ver [TD-026](../roadmap/technical-debt.md#td-026). Si Redis cae, nada se pierde: el worker degrada
a polling de la BD y lo dice en sus logs.

## Índice

- [Modelo](#modelo)
- [Tipos de trabajo](#tipos-de-trabajo)
- [Ciclo de un trabajo](#ciclo-de-un-trabajo)
- [Redis: claves y uso real](#redis-claves-y-uso-real)
- [Degradación](#degradación)
- [Errores / limitaciones](#errores--limitaciones)
- [Extensión](#extensión)
- [Verificación](#verificación)

## Modelo

| Elemento | Valor |
|---|---|
| Autoridad | tabla `jobs`: sobrevive a reinicios y a la pérdida de Redis |
| Columnas clave | `kind`, `payload` (jsonb), `status`, `attempts`, `max_attempts` (por defecto 3), `run_after`, `locked_by`, `locked_at`, `last_error`, `error_class` (`sporting`/`infrastructure`), `dedupe_key` |
| Claim | `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, sobre trabajos `queued` o `running` huérfanos (`locked_at` anterior al timeout de bloqueo; por defecto 10 min en builds) |
| Índice | `jobs_claim_idx (status, run_after, created_at) WHERE status IN ('queued','running')` |

## Tipos de trabajo

| `kind` | Productor | Consumidor | Payload |
|---|---|---|---|
| `run_battle` | api (`POST /battles`, siempre); tournament-worker (calendario de torneo, con `dedupe_key`) | tournament-worker | `{ battleId }` |
| `generate_schedule` | api (cerrar inscripciones de un torneo) | tournament-worker | `{ tournamentId }` |
| `tournament_dry_run` | api | tournament-worker | `{ tournamentId }` |
| `process_result` | tournament-worker (al terminar una batalla; `dedupe_key = process_result:<battleId>`) | tournament-worker | `{ battleId }` |
| `update_standings` | tournament-worker (desde `process_result`) | tournament-worker | `{ tournamentId }` |
| `bot_build` | api (`QueueBotManager`, al enviar una versión a validación) | **bot-build-worker** | `{ buildId, botId, version, runtime }` |

## Ciclo de un trabajo

```
queued ──claim──► running ──ok──────────────► done
                     │
                     ├─ fallo deportivo ───────► done (código del fallo deportivo)
                     ├─ fallo de infraestructura ► queued (run_after = ahora + backoff)
                     │        └─ attempts ≥ max_attempts ─► needs_review (+ batalla failed/infrastructure)
                     └─ error no clasificado ──► needs_review
```

- Backoff: `min(60 s, 1 s × 2^attempts)` (`apps/tournament-worker/src/queue.ts:167`).
- Un `running` cuyo worker murió se vuelve a reclamar cuando vence el bloqueo.
- **Idempotencia:** `run_battle` no re-ejecuta una batalla ya `finished`. Pero **sí** puede ejecutar una batalla que esté `running` por otro camino ([TD-002](../roadmap/technical-debt.md#td-002)).

## Redis: claves y uso real

| Clave | Operación | Quién | Estado |
|---|---|---|---|
| `s9:wake:jobs` | `BLPOP` con timeout = `ceil(pollMs/1000)` s (1 s por defecto) | tournament-worker (`RedisSignal.esperarTrabajo`) | activo |
| `s9:wake:<cola>` | `LPUSH` (`RedisSignal.notify`) | **nadie en el código de producción**; sólo los tests | sin productor |

Hay más datos sobre Redis que conviene saber:
- La **API no usa Redis**: no lee `REDIS_URL`, aunque el compose se la pasa.
- Los limitadores de tasa son de PostgreSQL (`api_usage`). El código lo explica: no se incluye una variante para Redis sin verificar.
- El bot-build-worker no usa Redis: hace polling de `jobs`.
- Configuración de Redis: AOF, `maxmemory 256mb`, `noeviction`.

## Degradación

| Situación | Comportamiento |
|---|---|
| Redis no disponible al arrancar | el worker hace polling de la BD y lo registra en el log («Redis no disponible: el worker hará polling de la BD») |
| Redis cae en marcha | se degrada a polling. El cambio se avisa **sólo en las transiciones** (degradación y recuperación), no en cada intento. Reconexión como mucho una vez cada 5 s |
| La espera de Redis no responde | la espera tiene un vencimiento (`timeout + signalGraceMs`), así que el bucle nunca se cuelga. Antes sí se colgaba: fue un defecto medido y corregido |
| PostgreSQL no disponible | el claim falla, el bucle espera y reintenta. El trabajo sigue en la tabla |

## Errores / limitaciones

- Sin productor del aviso, la latencia mínima es el polling (~1 s).
- Un trabajo `needs_review` exige intervención manual. No hay pantalla web para ello ([TD-023](../roadmap/technical-debt.md#td-023)).
- `POST /battles` encola sin comprobar si la ejecución real está activa. Es el origen de la doble ejecución latente ([TD-002](../roadmap/technical-debt.md#td-002)).

## Extensión

1. Añade el `kind` a `JobKind` y `JOB_KINDS` (`apps/tournament-worker/src/queue.ts:26-34`) y, si va a la BD, al CHECK correspondiente con una migración.
2. Registra su handler en `apps/tournament-worker/src/main.ts`.
3. Encola con `enqueueJob(db, kind, payload, { dedupeKey })` para que sea idempotente.
4. Si añades un productor, llama también a `RedisSignal.notify()`. Mientras nadie lo haga, el aviso no existe.

## Documentación relacionada

- [workers.md](workers.md) · [database.md](database.md) · [data-flow.md](data-flow.md) · [battles.md](battles.md) · [tournaments.md](tournaments.md)
- [ADR-E9-001](../adr/ADR-E9-001-cola-postgres-redis.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Tipos de trabajo | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts:26`; `apps/bot-manager/src/build-worker.ts:17` |
| Productores | CODE_VERIFIED | `apps/api/src/routes/battles.ts:441`; `routes/tournaments.ts:261,282`; `services/bot-manager.ts:51`; `tournament-worker/src/battle-runner.ts:281`; `results.ts:357-359`; `scheduler.ts:193` |
| Claim con `SKIP LOCKED` | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts:98-113`; `apps/bot-manager/src/build-worker.ts:52-75` |
| Backoff y `needs_review` | CODE_VERIFIED | `queue.ts:150-191` |
| Claves de Redis | CODE_VERIFIED | `apps/tournament-worker/src/redis-signal.ts:207-215,255` |
| `notify()` sin productor | CODE_VERIFIED | `grep -rn "notify(" apps packages`: sólo la definición y los tests |
| La API sin Redis | CODE_VERIFIED | sin `REDIS_URL` en `apps/api/src`; `apps/api/src/middleware/shared-rate-limit.ts:16-18` |
| Pausa con vencimiento | CODE_VERIFIED | `apps/tournament-worker/src/worker.ts:196-254` |
