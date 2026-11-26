> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Auditoría de producto — Agente 2: Backend, API y datos

- Repo: pjclavero/s9-ai-arena · HEAD verificado (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`): `8f380eb700c3e984691649b3449d2c543038dfb1` (main, merge #298, motor 0.5.0)
- Fecha: 2026-11-19 · Fase 1 (estática, sólo lectura)
- Alcance: `apps/api`, `apps/tournament-worker`, `apps/bot-manager` (build-worker), migraciones 001-022, `scripts/portable`, issues abiertas.
- No se pudo mirar: producción, laboratorio, ejecución de tests (sólo conclusiones de CI de 8f380eb por run id), cargas, comportamiento real de Postgres/Redis/Docker.
- CI de 8f380eb citable: `ci` run 44383512640 = success; `E6 security` 44383512289 = success; `acceptance` 44537834319 = success; `nightly` 44519497401 = **failure** (causa no analizada aquí; ver TD-019). Estado de evidencia de esas suites: TEST_VERIFIED sólo para lo que cubren, no para lo que no tienen test.

## 2. Resumen y veredicto

**Veredicto: READY_WITH_CONDITIONS.**
1. El diseño de la cola y de los workers es sólido en el camino feliz y en los fallos de infraestructura clasificados: cola en Postgres con `FOR UPDATE SKIP LOCKED`, `dedupe_key`, reserva de batalla con lease, reintentos por clase, teardown y reaper (CODE_VERIFIED).
2. El timeout de batalla de 321 s está corregido en main: el guard pasa a `ceil(ticks×ms×1,25)+15 s` y el timeout con el motor jugando es `battle_timeout`, con un reintento (CODE_VERIFIED; PR #298 en main; la medición real sigue siendo evidencia de tercero).
3. Los torneos zombis `running` por batallas `failed` están corregidos por `settleFailedBattle` + `rescueStuckTournaments` (cada 5 min). **Queda un caso no cubierto**: torneo `closed` cuyo `generate_schedule` se agota (BE-01).
4. Contrato OpenAPI: 106 operaciones, rutas y roles derivados del contrato por construcción (`registry.ts`) y vigilados por `conformance.test.ts`; no hay deriva ruta↔contrato. La validación de entrada, en cambio, es manual y no se deriva del esquema (BE-05).
5. Migraciones: 22 migraciones, todas con `down`; el rollback por nombre está acotado a una lista cerrada (016-022). Sin hallazgos de corrupción; la reversibilidad no es totalmente sin pérdida (011, 018, 019 lo documentan).
6. Lo más débil para un tercero que opere: no hay forma operativa de ver/reintentar jobs `needs_review` (BE-02), `/healthz` no prueba nada de BD/migraciones (BE-03), no hay métricas de cola/worker (BE-04) y no hay retención de `jobs` (BE-10).
7. Errores 500 por carreras de unicidad (registro, bots) siguen abiertas (TD-013) y 35 sitios `.catch(() => null)` convierten errores de BD en 404 (BE-06).
8. Export/import portable (#300): bien diseñado (idempotente, reanudable), pero choca con un límite de 60 versiones/h por usuario sin `Retry-After` ni vía de operador (BE-07).
9. Las issues #287 y #288 siguen abiertas aunque el backend está en main (#290, cancelación); lo que falta es sobre todo web y la cancelación de torneos `closed`/`running` (BE-08).
10. Sin LICENSE ni cifras de capacidad medidas en este ámbito: no se declara nada de rendimiento.

## 3. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esf. | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Rutas vs contrato | 106 ops, conformes por construcción | `registry.ts`, `conformance.test.ts` (corre en CI `ci`), CODE_VERIFIED | `GET /metrics` y `/healthz`,`/version` fuera de contrato (documentados) | P4 | - | No |
| Validación de entrada | Manual por ruta, `req.body ?? {}` | `routes/*.ts`; Ajv sólo en `source-package.ts` | Validación por esquema, límites de longitud homogéneos | P2 | L | No |
| Formato de errores | `{error,message,correlationId}` homogéneo; 400/401/403/404/409/429/500 | `app.ts:213-236`, `errors.ts` | `Retry-After` en 429; unicidad→409 general | P2 | M | No |
| Paginación | Cursor opaco en 9 listados; 10 sin paginar | `openapi.yaml`; `listTournamentBattles` sin tope | Paginar batallas de torneo y matches | P2 | M | No |
| Versionado API | Prefijo `/api/v1`, `info.version` 0.25.0; sin política de deprecación | `openapi.yaml`, DOC_ONLY | Política de compatibilidad | P3 | S | No |
| Migraciones | 001-022 con `down`; tests por migración 016-022 | `db/migrations.ts`, `migration-0xx.test.ts` | Ver BE-09 | P3 | S | No |
| Cola `jobs` | Claim atómico, idempotente, reintento por clase | `queue.ts` | Retención, vista de `needs_review`, reintento manual | P1 | M | Parcial (operación) |
| Ejecución de batalla | Reserva+lease+renovación, cierre único | `battle-runner.ts:228-280`, `:640-667` | Reconciliador de batallas `running` huérfanas fuera de job | P2 | M | No |
| Torneos (ciclo de vida) | Cancelar sólo `draft`/`open`; mínimo 2; rescate de `running` | `tournaments.ts:41,853`, `results.ts:549` | `closed` sin salida (BE-01) | P1 | M | Sí (como condición) |
| Roles/permisos | 7 roles acumulativos por contrato; dueño o staff gestiona torneo | `openapi.ts`, `tournament-access.ts` | Guarda último admin; registro abierto = `developer` | P2 | S | No |
| Export/import portable | Idempotente, reanudable, verificado antes de escribir | `scripts/portable/*`, `docs/operations/portable-export.md` | Limite 60/h para operadores (BE-07) | P2 | M | No |
| Observabilidad | Logs JSON en worker/API; métricas HTTP opcionales | `metrics.ts`, `server.ts:52` | Métricas de cola/torneos, health real | P1 | M | No (sí para tercero) |
| Build worker | Cola `jobs`, lock 10 min sin renovación | `build-worker.ts:51` | Renovación de lock o tope de duración probado | P3 | S | No |

## 4. Fortalezas y debilidades

Fortalezas (con evidencia):
- Cola con claim `FOR UPDATE SKIP LOCKED`, `dedupe_key` única y fallo clasificado deportivo/infraestructura/no clasificado (`queue.ts:34-226`, `errors.ts`). CODE_VERIFIED.
- Doble cerrojo en batalla: lease de la batalla (45 s) por debajo del lock del job (60 s), renovados juntos; reserva condicionada al titular y a que el torneo no esté cancelado (`battle-runner.ts:173,228-280`). CODE_VERIFIED.
- Clasificación de errores de BD por origen real (fixtures capturados con pg/knex reales), topes por clase (8 `db_unavailable`, 2 `db_query_timeout`, 1 reintento `battle_timeout`) en `payload._failureCounts`. CODE_VERIFIED; tests en CI `ci`.
- Cierres de torneo con transacción y `FOR UPDATE` sobre la fila del torneo (`closeEntries`, `enterTournament`, `cancelTournament`), cancelación idempotente y auditada (`tournaments.ts:853-895`). CODE_VERIFIED.
- Rate limit compartido en BD (sobrevive a reinicios), `audit_log` de sólo inserción por trigger (`migrations.ts:006`). CODE_VERIFIED.
- Contrato OpenAPI como fuente de autorización (`x-min-role`), no la UI. CODE_VERIFIED.

Debilidades: ver hallazgos.

## 5. Hallazgos

### BE-01 · Torneo `closed` queda atascado si `generate_schedule` se agota
- Torneos / P1 · RIESGO (rama de código verificada; no reproducido) · Grupo B
- Descripción: al cerrar inscripciones se encola `generate_schedule`. Si el job agota reintentos o falla de forma no clasificada, `onExhausted` = `onBattleJobExhausted` sólo actúa en `run_battle`; el rescate sólo recorre torneos `running`; y `cancelTournament` rechaza `closed`. El torneo queda `closed` para siempre y sin salida de producto. Afecta a organizadores/jugadores inscritos (versiones ya congeladas).
- Evidencia: `battle-failure.ts:14-17` (retorna si `kind !== "run_battle"`), `results.ts:549-558` (`state: "running"`), `tournaments.ts:41` (`CANCELLABLE = draft|open`), `scheduler.ts:258` (exige `closed`), `queue.ts:218` (no clasificado → `needs_review`). CODE_VERIFIED.
- Causa probable: el arreglo de zombis (#298/B) cubrió sólo el estado `running`.
- Solución: rescate/estado de fallo para `closed` con job agotado (volver a `open` descongelando o `cancelled` administrativo) y mostrar el motivo.
- Esfuerzo M, incertidumbre media. Validación: test de integración con handler que lanza error y comprobar estado final.

### BE-02 · Jobs `needs_review` sin superficie operativa
- Observabilidad/Operación / P1 · FALTA · Grupo B
- Descripción: los jobs aparcados (`needs_review`) sólo se ven con SQL. No hay endpoint, métrica ni comando para listarlos, reintentarlos o descartarlos (`grep needs_review` fuera de worker/migraciones/docs: ninguno en `apps/api`). Un tercero no puede operar la cola.
- Evidencia: `grep -rn needs_review apps/api/src` sólo en `migrations.ts`; docs `workers.md`/`queue.md` describen el estado, no el procedimiento. CODE_VERIFIED.
- Solución: `GET /admin/jobs?status=` + acción de reencolar (auditada), o CLI en `db/cli.ts`; métrica `jobs_by_status`.
- Esfuerzo M, incertidumbre baja.

### BE-03 · `/healthz` de la API no comprueba nada
- Observabilidad / P2 (histórico TD-059 P2, se mantiene) · DEFECTO_CONFIRMADO · Grupo B
- Evidencia: `server.ts:31` responde `{status:"ok"}` fijo; no hay `/readyz`. CODE_VERIFIED. Además el heartbeat del worker es un `setInterval` independiente de los bucles (`main.ts:238`): el healthcheck puede estar verde con el worker parado (el propio código lo reconoce en `worker.ts` y lo mitiga sólo para Redis).
- Solución: readiness con `SELECT 1` + nivel de migraciones; heartbeat del worker ligado a la última vuelta de claim.
- Esfuerzo S-M.

### BE-04 · Sin métricas de cola, torneos ni workers
- Observabilidad / P2 · FALTA · Grupo C
- `metrics.ts` sólo expone `http_requests_total`, duración, `api_up` y gauges de streaming, y sólo con `S9_METRICS_ENABLED=1` (apagado por defecto). Sin profundidad de cola, edad del job más viejo, `needs_review`, batallas `running` caducadas, torneos `running` sin actividad. Los logs del worker no llevan correlación por batalla de forma uniforme (hay JSON estructurado, no verificado extremo a extremo). CODE_VERIFIED.
- Solución: gauges desde SQL cada N s en la API o en el worker + reglas en `infrastructure/observability`. Esfuerzo M.

### BE-05 · Validación de entrada manual y sin esquema
- API / P2 · DEUDA · Grupo C
- Las 106 operaciones tienen esquema en el contrato (38 `requestBody`), pero ningún middleware valida contra él; cada ruta hace `req.body ?? {}` y comprobaciones a mano (p. ej. `enterTournament` desestructura `botId`/`version` sin comprobar tipo). Riesgo de divergencia contrato↔código y de 500 por tipos inesperados. Ajv ya es dependencia. CODE_VERIFIED.
- Solución: validar con Ajv desde `openapi.yaml` en `defineOperation`. Esfuerzo L, incertidumbre media (hay muchos mensajes de error que los tests fijan).

### BE-06 · `.catch(() => null)` convierte fallos de BD en 404
- API / P2 · DEFECTO_CONFIRMADO · Grupo B
- 35 ocurrencias en la API (9 en `tournaments.ts`, 3 en `bots.ts`, etc.) pensadas para ids con formato inválido (`invalid input syntax for type uuid`), pero tragan cualquier error: una caída de BD o un timeout se responde 404 «no existe o no visible», sin log. Impide el diagnóstico y rompe el contrato de `db_unavailable` que el worker sí trata. Además `enterTournament` distingue 400 (bot inexistente) de 403 (bot ajeno): oráculo de existencia de bots privados (#247 abierta). CODE_VERIFIED (`tournaments.ts:340-345`).
- Solución: validar UUID antes (ya existe `UUID_RE`) y no capturar errores genéricos; unificar 404 en bot ajeno/inexistente. Esfuerzo M.

### BE-07 · Límite de 60 versiones/h bloquea la migración de un operador y no informa
- Export/import / P2 · RIESGO · Grupo B
- `bots.createVersion` y `submit`: 60/h por usuario, ventana fija alineada a la hora (`app.ts` buckets, `shared-rate-limit.ts`). Un operador con 120 versiones tarda más de 1 h y el cliente sondea cada 60 s hasta 65 min. El 429 no lleva `Retry-After` (`errors.ts` no lo emite). Es un problema de producto para operadores, no un fallo del import (que reanuda). El import está bien diseñado (idempotencia por dueño+nombre / contenido / sha256; verifica antes de escribir; `--dry-run`, informe de ids), DOC_ONLY+CODE_VERIFIED; el roundtrip lo cubre `portable-roundtrip.test.ts` (corre en CI; no verifiqué su rc).
- Solución: `Retry-After` real, límite configurable por rol/instalación o por variable de entorno, y exención auditada para el import de staff. Esfuerzo S-M.
- Validación: Fase 2 en laboratorio, importar 130 versiones y medir.

### BE-08 · Torneos: cancelación sólo en `draft`/`open`; #287/#288 abiertas con backend ya en main
- Torneos / P2 · DEUDA · Grupo C
- #290 (equipos multi-owner con consentimiento), #292/#291 (dueño o staff gestiona) y #289/#288 (cancelación) están en main. Un torneo `closed`/`running` no se puede cancelar a propósito (decisión documentada en `tournaments.ts:36-40`), de modo que un torneo roto (BE-01, o con bots que ya no existen) sólo se resuelve por SQL. Las issues #287/#288 quedan abiertas: su backend está hecho; revisar si lo que resta es sólo web.
- Prioridad anterior de TD-015: P1 PARCIAL; se mantiene PARCIAL, ver sección 6.

### BE-09 · Reversibilidad de migraciones: pérdida de datos y lista de rollback con acoplamiento
- Datos / P3 · DEUDA · Grupo C
- Todas tienen `down`. Pero 011 (`cpu_ms`) y 018 (marca de batalla revertida) pierden datos al bajar, y 019 reescribe la función compartida `s9_bot_version_guard` con la versión de la 012 (documentado; sale de `NAMED_ROLLBACK_ALLOWED` si otra migración la reescribe, regla sólo en un comentario, sin test que lo imponga que haya verificado). `rollbackAll` usa DROP … CASCADE. 6 migraciones (001-015) no tienen test de migración dedicado (sólo `schema.test.ts` + `migrations-order.test.ts`). 74 índices/referencias declaradas; no audité planes de consulta. CODE_VERIFIED / UNKNOWN para rendimiento.
- Esfuerzo S.

### BE-10 · Sin retención de `jobs` ni de `audit_log`
- Datos / P3 · DEUDA · Grupo C
- No hay borrado de `jobs` `done` (sólo se podan `api_usage`); `audit_log` es de sólo inserción por trigger sin política de archivado. Crecimiento ilimitado; el índice parcial `jobs_claim_idx` limita el impacto en el claim. CODE_VERIFIED (no `delete` sobre `jobs` fuera de tests).
- Esfuerzo S-M.

### BE-11 · Registro no atómico y carreras de unicidad dan 500
- API / P2 (histórico TD-013 P1 PARCIAL → P2 por impacto acotado) · DEFECTO_CONFIRMADO · Grupo B
- `register` comprueba existencia y luego inserta usuario y roles en dos sentencias sin transacción (`auth.ts:147-175`): un fallo entre ambas deja un usuario sin roles; el doble envío da 500. Cualquier registro obtiene `developer` (TD-012 abierta). `setUserRoles` permite a un admin quitarse el rol sin guarda de «último admin». CODE_VERIFIED.
- Solución: transacción + captura de 23505 → 409; guarda de último admin. Esfuerzo S.

### BE-12 · Listados sin paginar con N+1
- API/Rendimiento / P2 · RIESGO · Grupo C
- `listTournamentBattles` devuelve todas las batallas y ejecuta `loadParticipants` por batalla (`Promise.all`, `tournaments.ts:~305-318`); en un round-robin grande son miles de consultas. Igual `listTournamentMatches`. UNKNOWN el tamaño real. Solución: paginar y precargar participantes en una consulta. Esfuerzo M.

### BE-13 · Batalla `running` huérfana depende de que su job reaparezca
- Workers / P3 · HIPÓTESIS · Grupo C
- Si el lease de una batalla `running` caduca pero su job ya está `done`/`needs_review` por otra vía, nada la devuelve a `scheduled`; el rescate la ignora (`whereIn status scheduled|running` la cuenta como viva). `markBattleForReview` sólo corre al agotar el job. Caso estrecho; no se ha encontrado reproducción. Validar en Fase 2 matando el worker a mitad de batalla.

### BE-14 · Build worker: lock de 10 min sin renovación
- Workers / P3 · RIESGO · Grupo C
- `build-worker.ts:51` reclama `running` con `locked_at` > 10 min sin heartbeat; un build lento puede ejecutarse dos veces. Todo error se reintenta hasta `max_attempts` sin clasificar. CODE_VERIFIED; impacto UNKNOWN (duración real de builds).

### BE-15 · Rate limiter con coste por petición
- Rendimiento / P3 · DEUDA
- Cada `hit` ejecuta un DELETE de caducadas, un upsert y un `count(*)` de la ruta (`shared-rate-limit.ts`): 3 consultas por petición limitada, `count(*)` sobre hasta 100 000 filas. Sin medir. Esfuerzo S.

## 6. Deuda técnica (revalidación)

| ID | Anterior | Nueva | Motivo |
|---|---|---|---|
| TD-013 carreras/unicidad | P1 PARCIAL | P2 PARCIAL | Impacto sobre todo UX; confirmado que registro y bots siguen sin mapeo general 23505 (BE-11) |
| TD-015 torneos | P1 PARCIAL | P2 PARCIAL | `failed` ya no bloquea (rescate + `settleFailedBattle`), pool de mapas y guardas cableadas; resta BE-01 (caso `closed`) |
| TD-059 `/healthz` ciego | P2 ABIERTA | P2 ABIERTA | Confirmado en `server.ts:31` (BE-03) |
| TD-012 autenticación | P1 ABIERTA | P1 ABIERTA | Registro abierto con `developer` confirmado; recuperación sin transporte (no revalidado en profundidad) |
| TD-067/068 cursor, `listBots` | P3 | P3 | No revalidados; paginación con cursor confirmada |
| TD-026 canal Redis sin productor | P4 | P4 | La señal es opcional; el worker degrada a polling (`worker.ts` pausar) |
| TD-039 `/run` legado | P3 | P3 | Hace que #92 sea obsoleta en la práctica (ver abajo) |

Deuda nueva no registrada: BE-01, BE-02, BE-04, BE-06, BE-10, BE-12, BE-14, BE-15. Además: el API importa `leagueTable` desde `tournament-worker/src/results.ts` (`tournaments.ts:28`), acoplamiento entre apps (P3).

Issues abiertas con estado real:
- #287: backend en main (`enterTournamentTeam`, migración 022); resto sería web. Estado real: probablemente cerrable tras confirmar con web.
- #288: cancelación backend en main (`cancelTournament`); resto UI. Mismo caso.
- #92 (HELLO botId uuid): afecta al camino HTTP legado de la API; hoy ejecuta el worker con artefactos (TD-002 cerrada, TD-039 sin consumidor). Obsoleta como bloqueante; cerrar o redefinir. DOC_ONLY+CODE_VERIFIED parcial (el patrón `^bot_` sigue en `hello.schema.json`: confirmar en Fase 2 que el worker usa un handle y no el uuid).
- #9 (`cpuMs` null): el worker persiste `cpu_ms` (`battle-runner.ts:622-634`); `null` sólo si no se mide. Cerrable tras prueba E2E.
- #14 (CI/protección de rama): ya hay CI; cerrable según gate de producción (memoria: main protegida).
- #247: ver BE-06, vigente. #185 (RAM): fuera de mi área. #107 (`restore.sh --verify`): fuera de mi área (backup). #254, #94: tests, no backend.

## 7. Verificaciones para FASE 2

1. Zombis de torneo: en laboratorio aislado, forzar que `generate_schedule` lance un error en un torneo `closed`; esperar el reintento y el rescate (5 min) y comprobar estado y posibilidad de cancelar. Confirma/refuta BE-01.
2. Timeout de batalla: lanzar en laboratorio 10 batallas de 9000 ticks y registrar duración vs guard (397,5 s); ninguna debe acabar `battle_timeout`. Entorno: lab con carga normal, no el hipervisor de producción. Confirma que 321 s está resuelto.
3. Orfandad: matar el worker con `kill -9` en mitad de una batalla; observar que otra instancia la reclama tras el lease (≤45-60 s) y que no queda contenedor (reaper). Prueba BE-13.
4. Caída de BD: parar Postgres 30 s con el worker y la API vivos; comprobar `db_unavailable` en el worker y que la API responde 5xx y no 404 (BE-06).
5. Import portable: importar ≥130 versiones en laboratorio y medir esperas y 429; comprobar reanudación tras Ctrl-C (BE-07).
6. Carga: `listTournamentBattles` con un torneo de 64 bots round-robin; medir latencia y número de consultas (`pg_stat_statements`) (BE-12).
7. Migraciones: `migrate` completo + `rollback:name` de 022…016 sobre una BD con datos del laboratorio; comparar esquema antes/después.
8. Producción sólo lectura: `SELECT status,count(*) FROM jobs GROUP BY 1` y torneos en `closed`/`running` con edad > 1 h, para ver si hay zombis residuales. Confirma o refuta BE-01/BE-10 con datos reales.
9. Registro concurrente: 20 `POST /auth/register` simultáneos con el mismo email en laboratorio; esperado 1×201 y 19×409 (hoy previsiblemente 500).

## 8. Respuestas cortas

- ¿Es estable el backend? En el camino feliz, sí: diseño de concurrencia y recuperación coherente y con tests y mutantes. La estabilidad real en producción no la puedo afirmar sin Fase 2; el `nightly` de 8f380eb está en rojo (causa sin analizar).
- ¿Qué falla ante fallos parciales? Un torneo `closed` con `generate_schedule` agotado queda sin salida (BE-01); una caída de BD en la API se disfraza de 404 (BE-06); el registro deja usuarios sin roles si se corta a medias (BE-11); un healthcheck verde no prueba que el worker procese (BE-03).
- ¿Qué deuda real hay? Validación por esquema (BE-05), paginación y N+1 (BE-12), retención (BE-10), acoplamiento API↔worker, unicidad→409, reversibilidad parcial (BE-09).
- ¿Qué falta para que un tercero lo opere? Superficie de operación de jobs y torneos atascados (BE-02, BE-08), health/readiness reales y métricas de cola (BE-03/04), límites configurables para operadores (BE-07), y un procedimiento para cancelar/limpiar torneos `closed`/`running`.

