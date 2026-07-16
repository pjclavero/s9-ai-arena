# ADR-E9-001 · Cola de torneos: PostgreSQL como verdad, Redis como despacho

**Estado:** aceptada (2026-07-16) · **Ámbito:** E9/T9.1 (cap. 8, 9.4, 19.2)

## Contexto

El dosier pide "Redis como cola" pero exige a la vez que los trabajos sean
idempotentes y estén "persistidos también en la tabla jobs (para sobrevivir a
Redis)". Además exige bloqueo distribuido (la misma batalla nunca dos veces) y
reintentos solo ante fallos de infraestructura.

## Decisión

1. **La tabla `jobs` de PostgreSQL (E7) es la FUENTE DE VERDAD** de todo el
   ciclo de vida (queued → running → done/needs_review). El claim es un
   `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`: bloqueo
   distribuido real a nivel de fila, sin dependencia de Redis.
2. **Redis es solo capa de despacho opcional** (`redis-signal.ts`): aviso
   LPUSH/BLPOP para despertar workers sin esperar al poll, y candado SET NX PX
   por batalla como cinturón EXTRA. Si Redis desaparece, el worker degrada a
   polling de la BD y no se pierde ningún trabajo.
3. **Idempotencia por `dedupe_key`** única (p. ej. `run_battle:<battleId>`).
4. **Workers muertos**: un trabajo `running` con `locked_at` más viejo que el
   lock timeout se considera huérfano (fallo `worker_died` del 19.2) y vuelve a
   ser reclamable contando el reintento.
5. **Reintentos**: solo `InfrastructureFailure`, con `max_attempts` y backoff;
   agotados → `needs_review` (revisión manual). Las derrotas deportivas
   (timeout/crash del bot) TERMINAN el trabajo: nunca se reintentan.

## Alternativas descartadas

- **Redis como única cola (BullMQ etc.)**: pierde trabajos si Redis pierde su
  AOF/RDB; el dosier exige explícitamente sobrevivir a Redis. Además el
  entorno de desarrollo no tiene Redis (sin docker/sudo), y la ruta PostgreSQL
  se prueba con el harness embebido REAL de E7.
- **Cola en memoria**: no sobrevive ni a un reinicio del worker.

## Consecuencias

- El cliente RESP mínimo (sin dependencias) queda probado contra un stub en
  proceso; la validación contra un Redis real es pendiente de entorno (E10).
- El throughput de claim por SKIP LOCKED es más que suficiente para la escala
  de torneos (batallas de minutos, no milisegundos).
