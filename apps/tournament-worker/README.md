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

## Estabilidad (V1-P0, fase 2)

- **Límite real de intentos**: `claimJob` no re-reclama un trabajo `running` con el lock vencido que ya
  agotó `max_attempts`: lo pasa a `needs_review` y cierra su batalla (`failed`, `failure_kind=infrastructure`)
  en una transacción idempotente, con rastro en `audit_log` (`worker.job_exhausted`,
  `worker.battle_failed_infrastructure`). Código: `queue.ts` (`parkExhaustedStaleJobs`).
- **Barrido de huérfanos** (`orphan-recovery.ts`, al arrancar y cada 60 s): batalla `running` con el lease
  vencido ⇒ con intentos, se reencola (`scheduled` + job `queued`; cada reentrega gasta un intento, como mucho `max_attempts - 1`); sin intentos, terminal. Si el
  lock del trabajo sigue fresco, no se toca (titular posiblemente vivo). Sin resultados deportivos inventados.
- **Contenedores**: el reaper retira también los de una batalla `running` con el lease vencido y, al arrancar
  el worker y antes de reclamar nada, los de cualquier batalla que no esté `running` con lease vigente.
- **Memoria**: `NODE_OPTIONS=--max-old-space-size=640` en el compose (límite del contenedor: 1 GiB; el test
  `v1-worker-stability.test.ts` exige heap ≤ 70 % del límite). Subir el heap NO resuelve la retención por
  batalla: **pendiente de la fase 3** (grabación de replays en streaming en lugar de acumular en memoria).
- **Métricas** (`worker-metrics.ts`, con `S9_METRICS_ENABLED=1`, `GET :8086/metrics`): `s9_worker_heap_used_bytes`,
  `s9_worker_heap_limit_bytes`, `s9_worker_rss_bytes`, `s9_worker_job_retries_total`, `s9_worker_jobs_parked_total`,
  `s9_worker_orphans_{requeued,failed}_total`, `s9_worker_orphan_containers_removed_total`,
  `s9_worker_jobs_needs_review`, `s9_worker_battles_lease_expired`. Alertas `Worker*` en
  `infrastructure/observability/prometheus/alerts.yml` (promtool: `alerts-worker.test.yml`).

### Preparado para administrar desde la web (D-OP-31)

Sin cambiar el alcance de V1-P0, las piezas quedan reutilizables por futuras rutas admin:

- **Transiciones terminales y recuperación** (funciones únicas, sin duplicar lógica): `parkExhaustedStaleJobs`
  (SQL único compartido con `claimJob`), `failBattleInfrastructure` (cierre terminal de una batalla con
  rastro en `audit_log`), `sweepExpiredBattles` (reencolar o terminal), `markBattleForReview`.
  Una ruta admin de «cancelar» o «reintentar» debe llamarlas, no reescribir los UPDATE.
- **Configuración**: hoy `lockTimeoutMs`, `defaultMaxAttempts`, `everyMs` y `maxAttempts` (de `enqueueJob`) son
  PARÁMETROS de esas funciones con el valor por defecto en código/env (`TOURNAMENT_WORKER_CONCURRENCY`). NO hay
  aún capa de configuración persistida ni recarga en caliente de la concurrencia: es el siguiente paso (leer los
  ajustes de runtime persistidos, como ya hace `runtime-settings-wiring.ts` con el espectador público) y se
  deja documentado, no implementado, para no agrandar este PR.
- **Métricas**: además de `GET :8086/metrics` (Prometheus), `GET :8086/metrics.json` devuelve el mismo
  `snapshot()` para que un endpoint interno/admin de la API lo consulte y la web lo muestre. El endpoint de la
  API NO está en este PR.

