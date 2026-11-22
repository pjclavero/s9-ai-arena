# tournament-worker (E9)

Worker de torneos (T9.1, cap. 8 + 9.4 + 19.2):

- **Cola durable**: la tabla `jobs` de PostgreSQL (E7) es la fuente de verdad;
  Redis (`redis-signal.ts`) es solo aviso de baja latencia + candado extra y su
  pérdida no pierde ningún trabajo (ADR-E9-001).
- **Bloqueo distribuido**: claim con `FOR UPDATE SKIP LOCKED`; dos workers nunca
  ejecutan la misma batalla. Trabajos huérfanos (worker muerto) se recuperan
  tras el lock timeout.
- **Clasificación de fallos (19.2)**: derrota deportiva (timeout/crash del bot:
  NO se reintenta) vs fallo de infraestructura (reintentos con límite y luego
  `needs_review`). Enumeración en `src/errors.ts`.
- **Formatos y flujo de torneo (T9.2)**, **ratings (T9.3)** y **justicia
  competitiva (T9.4)**: ver `src/`.

Ejecución de batallas: una batalla por hueco de worker; concurrencia 1 por defecto
(`TOURNAMENT_WORKER_CONCURRENCY`: entero 1..16 o `auto`, que usa los límites del cgroup;
ver `docs/operations/worker-concurrency.md`). Suspensiones/descalificaciones importadas del
bot-manager REAL de E6.
