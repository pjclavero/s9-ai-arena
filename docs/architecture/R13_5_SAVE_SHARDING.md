# R13.5 · ADR de persistencia — Save/Sharding de la plataforma (BD + almacenamiento de objetos)

**Estado**: propuesto (DESIGN-GATE, sin implementación).
**Equipo**: Equipo 6.
**No confundir con**: `docs/R13_5_SAVE_SHARDING.md`, que es el diseño de save/restore
del **motor de físicas** (`apps/arena-engine/src/checkpoint.ts`, checkpoint por
resimulación) y de la partición **intra-batalla** (rechazada). Ese documento resuelve
"¿puede una batalla pausarse y reanudarse bit a bit?". Este documento resuelve algo
distinto: "¿cómo se guarda, versiona, respalda y —si hiciera falta— particiona el
estado persistente de toda la plataforma (BD PostgreSQL + volúmenes de objetos)?". Los
dos comparten número de bloque porque el roadmap los agrupó bajo el mismo epígrafe
("save/load, sharding"), pero son decisiones independientes.

## 0 · Método de auditoría

Todo lo que sigue está verificado leyendo el repositorio en `origin/main` (`4505a54`),
no inferido:

- Esquema real: `apps/api/src/db/migrations.ts` (709 líneas, 11 migraciones, Knex
  Migrate programático — `docs/decisiones/ADR-E7-001-migraciones-knex.md`).
- Conexión: `apps/api/src/db/connection.ts` (un único `DATABASE_URL`/`PGHOST`, sin
  ningún concepto de shard, réplica o routing).
- Almacenamiento de objetos: `apps/replay-service/src/store.ts`, `format.ts`
  (replays), `bot-manager.ts` (artefactos de build).
- Infraestructura real: `infrastructure/docker-compose.yml` (un servicio `postgres`
  único, perfil `nucleo/development/production`, imagen `postgres:16-alpine`, un
  volumen `postgres_data`; perfil `external-db` para apuntar a un Postgres externo,
  pero sigue siendo **uno**).
- Backup/recuperación ya implementados: `infrastructure/backup/backup.sh`,
  `restore.sh`, `docs/recuperacion.md`, `docs/decisiones/ADR-010-devops-ci-observabilidad-backup.md`.
- Concurrencia real: `apps/tournament-worker/src/queue.ts`, `apps/bot-manager/src/build-worker.ts`
  (`FOR UPDATE SKIP LOCKED` sobre la tabla `jobs`).

## 1 · Qué necesita persistencia (auditado tabla por tabla)

Fuente: las 11 migraciones de `apps/api/src/db/migrations.ts`. 36 tablas reales hoy.
Agrupadas por dominio pedido en el encargo:

| Dominio | Tablas | Fichero:línea |
|---|---|---|
| Identidad/sesión | `users`, `roles`, `user_roles`, `sessions`, `session_refresh_tokens`, `password_resets` | migrations.ts:38-79, 594-601 |
| Equipos | `teams`, `team_members` | migrations.ts:81-94 |
| Catálogo/contenido | `catalog_versions`, `module_definitions`, `rulesets` | migrations.ts:118-146 |
| Mapas | `maps`, `map_versions` | migrations.ts:148-169 |
| Bots/versiones/builds | `bots`, `bot_loadouts`, `loadout_modules`, `bot_versions`, `builds`, `artifacts` | migrations.ts:183-262 |
| Torneos | `tournaments`, `entries`, `matches` | migrations.ts:276-315, 534-545 |
| Batallas (índice, no eventos) | `battles`, `participants` | migrations.ts:319-353, 547-549, 658-665 |
| Resultados/ranking | `battle_stats`, `ratings`, `standings`, `achievements`, `rating_events` | migrations.ts:367-405, 551-567 |
| Operación | `jobs`, `audit_log`, `security_findings`, `api_usage` | migrations.ts:419-465, 483-518, 624-649 |

**Fuera de la BD por decisión explícita del esquema** ("Política 23.1", comentario en
migrations.ts:9-10 y migrations.ts:317-318): los eventos masivos de una batalla
(snapshots por tick, comandos, hashes intermedios) **no viven en PostgreSQL**. `battles`
guarda `replay_ref` (ruta), `replay_hash` y `final_state_hash`; el contenido real vive en
el volumen `arena_replays` como JSONL comprimido, gestionado por
`apps/replay-service/src/store.ts`. Es la decisión de diseño correcta: son datos
append-only, grandes por evento, ilegibles como filas relacionales, y ya tienen su propio
ciclo de vida (retención, verificación, servicio dedicado).

Igual patrón en `artifacts`: `storage_ref` es la referencia (`apps/api/src/services/bot-manager.ts:109`,
convención `artifacts/<bot>/<version>/<hash>`); `artifacts.bytes` (bytea) es un **escape
hatch documentado como MVP** (migrations.ts:635-639: "límite 200 MB por config del
pipeline; un almacén de objetos externo puede sustituirlo más adelante") — deuda ya
señalada en el propio esquema, no un hallazgo nuevo de este ADR.

### Qué debe poder reconstruirse (no necesita backup propio)

- `arena_build_cache` (volumen): caché de build de bots. Documentado explícitamente en
  `docs/recuperacion.md:107-108` como NO copiado — "se regenera". Ejecuta el
  `build-worker` sobre la fuente que sí está en `arena_bot_sources`.
- Replays **no oficiales** (`official: false` en `store.ts`): TTL de 7 días
  (`DEFAULT_TEMPORARY_TTL_MS`, store.ts:22) por política 23.1. Son de práctica, no
  se respaldan (`docs/recuperacion.md:106-107`), y su ausencia tras un desastre no
  pierde nada oficial.
- Índices derivados (`ratings`, `standings`): en teoría reconstruibles desde
  `rating_events`, que es el libro mayor append-only (migrations.ts:551-567,
  comentario "idempotencia, reversión y reconstrucción histórica"). **Pero no hay
  ningún job/script en el repo que haga esa reconstrucción hoy** — es una propiedad
  del modelo de datos, no una capacidad operativa implementada. Riesgo real si
  `ratings`/`standings` se corrompen sin tocar `rating_events`.

### Qué debe poder recuperarse (si se pierde, es pérdida real, no reconstrucción)

- Todo lo demás: identidad, catálogo congelado (`module_definitions` es inmutable por
  diseño, PK compuesta que nunca se sobrescribe), loadouts congelados en inscripciones
  (`entries` con `ON DELETE RESTRICT` hacia `bot_versions`/`bot_loadouts`), replays
  **oficiales**, artefactos firmados, `audit_log` (trigger de solo-inserción,
  migrations.ts:440-446 — es un registro legal/forense, perderlo no se puede
  "reconstruir").

### Qué es efímero por diseño (correcto, no es un hueco)

- `api_usage`: ventanas de rate-limit con `expires_at` e índice de expiración
  (migrations.ts:630-633). Vive y muere sin backup con sentido (es estado operativo de
  corta vida), y de hecho el propio `backup.sh` no lo excluye ni incluye
  explícitamente: va dentro del `pg_dump` completo, lo cual es inofensivo pero no
  aporta nada tras un restore (las ventanas ya habrán expirado).
- `jobs` en estado `done`: crecen sin límite (no hay `DELETE` ni partición por edad en
  ninguna migración ni en `queue.ts`/`build-worker.ts`). No es "efímero" realmente —
  es una tabla que hoy solo crece. Señalado en §8 (retención) como hueco real, no como
  algo ya resuelto.

## 2 · Qué YA está persistido y con qué garantías (auditado, no asumido)

| Mecanismo | Ya implementado | Evidencia |
|---|---|---|
| Motor de BD | PostgreSQL 16, ACID, un único proceso | `infrastructure/docker-compose.yml:493-504` |
| Migraciones versionadas | Sí, con up/down probado | `apps/api/src/db/migrations.ts`, `schema.test.ts` |
| Backup lógico diario | Sí, `pg_dump -Fc` + `restic` (dedup+cifrado) | `infrastructure/backup/backup.sh` |
| Retención de backups | `--keep-daily 14 --keep-weekly 8 --keep-monthly 12` | `backup.sh` línea del `restic forget` |
| Verificación de integridad | `restic check` + `manifest.sha256` de mapas/replays | `backup.sh`, `restore.sh --verify` |
| Runbook de restauración total | Sí, cronometrado por fases, objetivo <2h | `docs/recuperacion.md` |
| Alertado si el backup falla o envejece | Métrica `s9_backup_*` + alerta a 26h | `backup.sh` `write_metrics`, ADR-010 D10.3 |
| Idempotencia de escritura | `ON CONFLICT`, `UNIQUE`, dedupe_key en `jobs` | migrations.ts:102-105, 488, 565 |
| Concurrencia segura multi-worker | `FOR UPDATE SKIP LOCKED` | `queue.ts:117`, `build-worker.ts:72` |
| Inmutabilidad donde importa | `audit_log` (trigger), catálogo (PK versionada), loadouts congelados (FK RESTRICT) | migrations.ts:440-446, 127-136, 218-220 |

**Hallazgo central de esta auditoría, y es bueno**: la mayor parte de lo que un ADR de
"save" tendría que diseñar **ya existe y está bien construido** (ADR-010 lo decidió
explícitamente el 2026-07-16, con el operador ratificándolo). Este documento no repite
esas decisiones; las verifica, señala sus huecos reales, y responde a la pregunta que
ADR-010 dejó explícitamente abierta: *"pgBackRest… se reevaluará si la BD crece"*
(`ADR-010`, sección D10.4).

## 3 · Huecos reales encontrados (no en el diseño de save, sí operativos)

1. **El simulacro de restauración nunca se ha ejecutado.** `docs/recuperacion.md:9-11`:
   *"Estado del simulacro: PENDIENTE de entorno con Docker"*. La tabla de tiempos por
   fase está vacía. Esto es exactamente el patrón de "backups rancios" ya documentado
   en otros proyectos del homelab (memoria: `project_s9k_backups_rancios`) — un backup
   nunca restaurado es una hipótesis, no una garantía. **Es la recomendación operativa
   más importante de este ADR** (§10).
2. **`audit_log` y `jobs` (estado `done`) no tienen política de purga o partición.**
   Crecen sin límite. A tráfico homelab esto tarda años en doler (ver §5), pero no hay
   ni una migración ni un job que lo trate; hoy el `pg_dump` diario simplemente los
   copia enteros cada vez, más grandes cada vez.
3. **`ratings`/`standings` son proyecciones sin job de reconstrucción implementado**,
   pese a que `rating_events` fue diseñado para permitirlo (comentario explícito en
   migrations.ts:528-529). Si se corrompen por un bug, hoy no hay un comando para
   regenerarlos desde el libro mayor.
4. **`artifacts.bytes` es un límite MVP conocido** (200 MB, bytea en fila) —
   ya señalado por el propio equipo que lo escribió como algo a sustituir "más
   adelante" por almacén externo. No es un hallazgo nuevo; se hereda aquí como
   condición de disparo de trabajo futuro, no de sharding (ver §9).

Ninguno de estos cuatro requiere sharding para resolverse.

## 4 · Modelo de save (cómo se escribe)

No hay "el" save de la plataforma: hay escrituras transaccionales normales de la API
(Knex/`pg`) más el pipeline específico de ingesta de replay. Formalizando lo que el
código ya hace:

- **Frontera transaccional = la operación de negocio**, no la tabla. Ejemplos ya
  correctos en el esquema:
  - Crear una inscripción (`entries`) congela `version` + `loadout_revision` en la
    misma fila con FKs compuestas hacia `bot_versions`/`bot_loadouts`
    (migrations.ts:296-307): la congelación es atómica por construcción (si el FK no
    resuelve, el INSERT falla entero).
  - Puntuar una batalla: `rating_events` tiene `UNIQUE (battle_id, bot_id)`
    (migrations.ts:565) — la operación "puntuar" debe ser un solo `INSERT` transaccional
    que, si se reintenta, choca con la UNIQUE en vez de duplicar puntos. **Esto ya es
    el contrato correcto**; lo que este ADR fija es que cualquier código nuevo que
    toque `ratings`/`standings` a partir de `rating_events` debe hacerlo en la misma
    transacción que el INSERT del evento, no en dos pasos separables por un crash.
  - Ingesta de replay: es un **flujo de dos sistemas** (archivo + fila), no una
    transacción de BD. `store.ts` valida y persiste el archivo primero (con su hash);
    solo después alguien con conexión (API/worker) escribe `battles.replay_ref` +
    `replay_hash`. **Orden correcto** (nunca referencia un archivo que no existe
    todavía), pero el intervalo entre "archivo escrito" y "fila actualizada" es una
    ventana real de inconsistencia ante un crash. Mitigación ya existente:
    `replay_ref`/`replay_hash` son nullable, así que una `battle` sin ingesta
    completada es distinguible (`replay_ref IS NULL`) y reintentable — no corrompe
    nada, pero no hay hoy un job de reconciliación que la detecte y reintente sola.
- **Versionado de esquema**: Knex Migrate programático, ya resuelto y con test de
  round-trip up/down (`schema.test.ts`, ADR-E7-001). Este ADR no cambia la herramienta;
  fija la política a futuro: toda migración nueva debe seguir el patrón ya usado
  (SQL crudo vía `db.raw`, `up`/`down` simétricos, nombre `NNN_descripcion`).
- **Versionado de datos de dominio** (distinto del esquema): ya resuelto con dos
  patrones reales y correctos —
  - *Inmutable con historial*: `module_definitions` (PK `(catalog_version, module_id,
    module_version)`, nunca UPDATE), `bot_loadouts`/`bot_versions` (revisión numerada,
    nunca sobrescrita).
  - *Mutable con libro mayor*: `ratings` (mutable, snapshot actual) respaldado por
    `rating_events` (append-only, la fuente de verdad histórica).
  Cualquier tabla nueva que necesite versionado debe elegir uno de estos dos patrones
  explícitamente, no inventar un tercero.

## 5 · Modelo de load (cómo se lee) y volumen real esperado

**Cálculo, con las entradas mostradas — no una cifra inventada:**

- `TICK_HZ = 30` (`packages/game-rules/constants.ts:17`).
- El motor empuja un snapshot **cada tick** (`apps/arena-engine/src/sim/battle.ts:482`,
  incondicional dentro de `step()`), no muestreado.
- Duración de batalla: el límite duro es `maxTicksPerRound = 100000` por defecto
  (`apps/arena-engine/src/match.ts:36,116` — ~55 min a 30 Hz), pero es un tope de
  seguridad, no la duración típica; el repo no fija una duración típica medida
  (no hay telemetría de duración real en el código ni en `docs/`), así que uso un
  rango razonable de diseño de partida de deathmatch/CTF: **3–8 minutos** (5 400–14 400
  ticks). Esto es una asunción explícita, no un dato medido.
- Bytes por snapshot: medí `tests/golden/chase.json` (2 vehículos, formato *pretty*
  JSON de test, no el JSONL compacto de producción): ~21 bytes/vehículo en compacto
  estimado a partir de los campos reales (`id,x,y,h,hp`). Con 2–8 vehículos por batalla
  (deathmatch pequeño a team_deathmatch), el snapshot compacto por tick ronda
  **50–250 bytes**, más eventos y un hash de tick (~70 bytes) cada uno.
- **Replay sin comprimir**: `5 400–14 400 ticks × (120–320 bytes/tick) ≈ 0.65–4.6 MB`
  por batalla. Con compresión (zstd en producción con Node ≥22.15, gzip de reserva hoy
  — `apps/replay-service/src/format.ts:12-16`) sobre datos altamente repetitivos
  (posiciones correlacionadas tick a tick, JSON con claves repetidas), una razón de
  compresión conservadora de 5–10× da **65 KB–1 MB por batalla oficial almacenada**.

  **Esto es una estimación de orden de magnitud con las asunciones declaradas
  arriba, no una medición real.** El repo no contiene un replay de producción de
  tamaño real para medir directamente (los goldens son fixtures de test cortas). La
  recomendación operativa (§10) es medir el tamaño real de los primeros 20-30 replays
  oficiales en cuanto haya batallas reales corriendo, y sustituir esta estimación por
  un número medido antes de fijar ninguna cuota de disco.

- **Frecuencia de batallas que permite este homelab**: auditado en
  `infrastructure/docker-compose.yml` — `arena-engine` (el runner de batalla) tiene
  límite `cpus: 2.0` (migrations no aplica aquí; compose.yml en torno a la línea 189).
  El compose es un **stack único en una VM** (perfil `nucleo/development/production`),
  sin ningún mecanismo de horizontal scaling de runners de batalla en el repo (no hay
  Kubernetes, no hay autoscaler, no hay más de una réplica declarada de ningún
  servicio). El límite real de throughput es "cuántos contenedores de batalla caben a
  la vez en los cores de la VM", que no está documentado como cifra fija en ningún
  sitio del repo — sería inventar un número. Lo que sí es verificable: es un **único
  host**, así que incluso en el caso de mayor actividad razonable para un homelab
  (varios torneos con brackets corriendo batallas en paralelo, dosier de balance con
  "200 batallas por emparejamiento", `docs/Dosier_tareas_S9_AI_Arena.md:322`), estamos
  hablando de **cientos a pocos miles de batallas por día como máximo teórico**, no
  millones.

- **Proyección de disco resultante** (con la estimación de tamaño de arriba, explícita
  como estimación): a 500 batallas/día × 500 KB promedio ≈ 250 MB/día de replays
  oficiales nuevos ≈ ~90 GB/año sin retención. Las filas de `battles`/`participants`/
  `battle_stats`/`rating_events` por batalla son del orden de 1–5 KB en total (columnas
  jsonb pequeñas, sin blobs) — la BD relacional en sí crece órdenes de magnitud más
  lento que el almacén de replays. **Esto sigue estando muy por debajo de donde
  sharding aporta algo** (ver §9): un solo disco de un NAS/VM de homelab actual mueve
  esto sin esfuerzo durante años.

## 6 · Fronteras transaccionales, idempotencia, concurrencia — ya construidas, formalizadas aquí

Ya cubierto con evidencia en §4. Regla que este ADR fija como **contrato hacia
delante** para cualquier tabla/flujo nuevo:

- Toda escritura que combine "verdad histórica append-only" + "proyección mutable"
  (patrón `rating_events` → `ratings`/`standings`) debe: (a) tener una clave de
  idempotencia UNIQUE en la tabla append-only: (b) actualizar la proyección en la
  misma transacción que el INSERT del evento; (c) tener, o dejar explícitamente
  pendiente con un issue, un comando de reconstrucción de la proyección desde el
  libro mayor (hueco #3 de §3).
- Toda escritura que combine "archivo + fila" (patrón replay) debe dejar la fila en un
  estado distinguible mientras el archivo no esté confirmado (ya así: `replay_ref
  NULL`), y cualquier consumidor nuevo de ese patrón debe documentar cómo reconcilia
  archivos huérfanos o filas sin archivo — hoy el propio replay-service no tiene ese
  reconciliador (hueco relacionado con #2/§3, mismo tipo de deuda).
- Concurrencia de trabajos: seguir el patrón ya correcto de `jobs`
  (`FOR UPDATE SKIP LOCKED`, `dedupe_key`, `max_attempts`, `needs_review` como estado
  terminal en vez de reintento infinito — migrations.ts:479-482). No inventar un
  segundo mecanismo de cola.

## 7 · Consistencia y recuperación ante fallo

- **Dentro de PostgreSQL**: ACID nativo, ya correcto (FKs, CHECKs, transacciones).
- **Entre PostgreSQL y los volúmenes de objetos** (replays, artefactos, mapas): **no
  hay transacción distribuida ni se necesita una** — es deliberadamente eventual con
  orden fijo (archivo antes que fila, §4), lo cual es el patrón correcto para este
  tamaño de sistema. La alternativa (2PC, outbox pattern con reconciliador) sería
  sobre-ingeniería para un volumen que cabe en un backup diario de minutos.
- **Recuperación ante fallo total**: ya diseñada y documentada end-to-end en
  `docs/recuperacion.md` (7 fases cronometradas, objetivo <2h). **No auditado como
  "funciona"**, solo como "está bien diseñado sobre el papel" — ver hueco #1 (§3): el
  simulacro real está pendiente. Este ADR no puede certificar el RTO de 2h sin esa
  ejecución.
- **RPO** (pérdida de datos aceptable): backup diario ⇒ RPO de hasta 24h para la BD.
  No está en ningún ADR previo si esto es aceptable para el proyecto — vale la pena que
  el operador lo confirme explícitamente (no es una decisión técnica, es de producto/
  riesgo). Con el volumen actual (§5), pasar a backup cada 6h o WAL archiving continuo
  (PITR) sería barato de operar si el operador quiere RPO menor; no es necesario por
  volumen.

## 8 · Backup, retención, verificación de restauración

Ya implementado y auditado en detalle (§2). Recomendaciones de esta auditoría,
ninguna requiere sharding:

1. **Ejecutar el simulacro de `docs/recuperacion.md` en cuanto haya un entorno con
   Docker disponible**, y rellenar la tabla de tiempos. Sin esto, "tenemos backups"
   es una afirmación no verificada — exactamente el patrón de riesgo ya visto en otros
   proyectos del homelab.
2. **Añadir retención/purga explícita a `audit_log` y `jobs` (estado `done`)** antes de
   que el crecimiento sin límite se note en el tamaño del `pg_dump` diario. No es
   urgente al volumen actual (§5), pero es una migración pequeña y barata de escribir
   ahora que de arreglar bajo presión después.
3. **Implementar el comando de reconstrucción de `ratings`/`standings` desde
   `rating_events`** que el propio esquema ya anticipó (migrations.ts:528-529) pero
   que no existe como código ejecutable.
4. Nada de esto cambia `RESTIC_REPOSITORY`, la cadencia diaria, ni la política
   `--keep-daily 14 --keep-weekly 8 --keep-monthly 12` de ADR-010 — siguen siendo
   correctas para este volumen.

## 9 · Shard key, propiedad de shard, operaciones cross-shard, reescalado — evaluación honesta

**No existe sharding en el código, en la infraestructura ni en ningún ADR previo.**
`connection.ts` construye una única conexión (`DATABASE_URL` o `PGHOST` único);
`docker-compose.yml` declara un único servicio `postgres`; no hay librería de sharding,
router, ni partición declarativa de tabla en ninguna migración. Diseñar shard key/
propiedad/cross-shard/reescalado para algo que no existe y que el volumen no justifica
(§5: decenas de MB/día, GB/año, no TB) sería inventar complejidad operativa (más
superficie de fallo, más cosas que el simulacro de recuperación tendría que cubrir,
coordinación cross-shard para JOINs que hoy son FKs simples de una sola BD) a cambio de
nada medible.

**Si algún día hiciera falta**, la candidata natural de shard key —determinada por la
forma real del esquema, no elegida a priori— sería **`tournament_id`** o, para
`battles` sueltas fuera de torneo, un particionado temporal por `created_at`: son las
columnas por las que ya se filtra en el índice caliente (`battles_status_idx (status,
created_at DESC)`, migrations.ts:343) y las que menos cruzan FKs hacia el resto del
esquema (identidad, catálogo, bots) — esas seguirían necesitando ser globales o
replicadas, lo cual es precisamente la señal de que el "problema de sharding" real
aquí no es de batallas, sino de que identidad/catálogo/bots son datos de referencia
compartidos que **no se particionan bien por batalla o torneo**. Esto en sí mismo es
un argumento en contra de sharding prematuro: la primera pieza que tocaría particionar
correctamente exigiría o bien duplicar identidad/catálogo por shard (complejidad de
consistencia) o bien mantenerlos centralizados y solo particionar batallas (lo cual, a
este volumen, no resuelve ningún problema real: PostgreSQL en un solo nodo indexa sin
esfuerzo los cientos de miles de filas de `battles` que este homelab generaría en años).

**Condiciones que justificarían reabrir esto** (umbrales, no sensaciones):
- El volumen de `battles`/replays supera lo que un solo disco/NAS del homelab puede
  servir con latencia aceptable — del orden de **cientos de GB a bajos TB** de replays
  activos, es decir 100–1000× el volumen anual proyectado en §5.
  - `pg_dump` diario deja de completarse dentro de la ventana operativa (hoy sin
    medir, pero con el volumen de §5 son minutos, no horas).
  - Un único host de PostgreSQL satura CPU/IO de forma sostenida sirviendo consultas
    (hoy: cero evidencia de esto, cero contenedores de batalla concurrentes más allá
    de los límites de CPU ya declarados en compose.yml).
  - El proyecto pasa de "un homelab" a "múltiples despliegues/organizadores
    independientes" que necesiten aislamiento físico de datos — ahí el particionado
    natural sería por instalación/tenant, no por shard key dentro de una misma BD.

Ninguna de estas condiciones está presente hoy ni cerca de estarlo con los números de
§5.

## 10 · Observabilidad de persistencia

Ya cubierta en gran parte por ADR-010 D10.3 (Prometheus/Grafana/Loki) y por las
métricas de `backup.sh` (`s9_backup_last_exit_code`, `s9_backup_duration_seconds`,
`s9_backup_last_success_timestamp_seconds`, con alerta a 26h). Recomendación de este
ADR: añadir a ese mismo textfile-collector el tamaño del volumen `arena_replays` y el
tamaño del `pg_dump` generado (ambos ya calculables dentro de `backup.sh` sin
dependencias nuevas), para poder ver la curva de crecimiento real y decidir con datos
—no con la estimación de §5— cuándo (si alguna vez) las condiciones de §9 empiezan a
acercarse.

## 11 · Rollback

- **De esquema**: ya resuelto (`rollbackAll`, up/down simétrico probado en
  `schema.test.ts`, ADR-E7-001). Política a mantener: ninguna migración nueva se
  fusiona sin su `down`.
- **De datos** (deshacer una puntuación, una publicación de bot, etc.): resuelto caso
  a caso por el modelo de libro mayor donde existe (`rating_events.reverted`,
  migrations.ts:562) — el patrón correcto es marcar reversión, nunca borrar el evento
  histórico. Donde no existe ese patrón (p. ej. no hay libro mayor para cambios de
  `bot_versions.state`), el rollback de datos hoy es "restaurar desde el backup diario
  más cercano" (RPO de hasta 24h, §7) — aceptable al volumen y criticidad actuales,
  pero vale la pena que el operador lo sepa explícitamente en vez de asumirlo.
- **De un despliegue**: ya cubierto por el runbook de recuperación total y por el
  hecho de que las imágenes se versionan por commit/tag en GHCR (`docs/recuperacion.md`
  Fase 4) — un rollback de código es "recrear con el TAG anterior", ortogonal a este
  ADR.

## 12 · Veredicto

## **SAVE-A / SHARDING-DEFERRED**

- **SAVE-A**: la persistencia de la plataforma está bien modelada (política 23.1
  aplicada consistentemente: relacional para índice/metadatos, archivos para eventos
  masivos), con backup diario verificado por checksum, retención razonable y runbook
  de recuperación completo. La calificación "A" viene con **tres condiciones que no
  son opcionales**, no cosméticas:
  1. Ejecutar el simulacro de restauración real (`docs/recuperacion.md`) al menos una
     vez y registrar el resultado — hoy no ejecutado.
  2. Añadir purga/retención a `audit_log` y `jobs` completados.
  3. Implementar el comando de reconstrucción de `ratings`/`standings` desde
     `rating_events` que el esquema ya anticipa pero que no existe como código.

- **SHARDING-DEFERRED**: no existe sharding hoy (ni en código ni en infraestructura),
  y no hay ningún número medido o proyectado en este repositorio que lo justifique. Un
  solo PostgreSQL en una VM del homelab, con backup diario de minutos y un volumen
  proyectado de decenas de MB/día (§5), no tiene un problema que particionar
  resolvería. Diseñar shard key/propiedad/cross-shard ahora sería resolver un problema
  hipotético a costa de una superficie operativa real (más piezas que el simulacro de
  recuperación —hoy ni siquiera ejecutado una vez— tendría que cubrir). Se reabre solo
  si se cumple alguna de las condiciones cuantificadas en §9 (umbral de cientos de GB a
  TB de replays activos, saturación sostenida de un único host, o paso a múltiples
  despliegues/tenants independientes) — y en ese caso, la partición candidata más
  natural según la forma real del esquema es `tournament_id` / temporal por
  `created_at` sobre `battles` y sus dependientes, no un sharding genérico de toda la
  BD.
