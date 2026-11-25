# Replays y replay-service

## Resumen

Cada batalla terminada deja un **replay** en formato **S9R/1**: una **receta** (`<battleId>.<intento>.s9r`) y una **vista** (`<battleId>.<intento>.s9v`) en el volumen de replays. La BD guarda la referencia en `battles.replay_ref` / `battles.replay_hash` y el inventario en `replay_artifacts` (migración 024).

Lo publica **sólo** el `tournament-worker`, dentro de la transacción de cierre de la batalla (V1 REPLAYS). Ningún otro camino publica replays: el replay-service ya no ingiere (V1 REPLAYS PR-4b) y el lanzador HTTP de la API, apagado, no archiva nada ([battles.md](battles.md#publicación-del-replay-sólo-el-worker)). Desde la fase *Production Readiness* (2026-10, PR #158, incluida en el commit de producción RC5.5) lo sirve **un solo camino** hacia el navegador:

- la **API** (`/api/v1/replays`, `/api/v1/replays/{id}`, `/index`, `/segment`, `/verify` y `/api/v1/public/replays*`), que aplica la [política de acceso](#autorización-de-acceso-td-004) **antes** de abrir ningún fichero;
- el **replay-service** queda **interno** y sin rutas de replay (sólo `/healthz` y `/version`); el gateway responde 404 en `/replays*`.

Antes ([TD-004](../roadmap/technical-debt.md#td-004)) el gateway hacía *proxy* de `/replays/*` al replay-service **sin autenticar**: cualquiera bajaba inventario, fichero, índice y segmentos, también de batallas privadas, aunque la API anunciara `enabled:false`. En la integración del cierre funcional (`integration/functional-closure`) la lista web ya no sufre la redirección 301 a `http://` ([TD-014](../roadmap/technical-debt.md#td-014)) y el reproductor web arranca y reproduce en navegador real ([TD-009](../roadmap/technical-debt.md#td-009)).

## Índice

- [Qué es](#qué-es)
- [Formato](#formato)
- [Almacenamiento e índice](#almacenamiento-e-índice)
- [Escritura (publicación)](#escritura-publicación)
- [Autorización de acceso (TD-004)](#autorización-de-acceso-td-004)
- [Replay crudo y proyección pública (PRE-1)](#replay-crudo-y-proyección-pública-pre-1)
- [Lectura: API](#lectura-api)
- [Lectura: replay-service (interno)](#lectura-replay-service-interno)
- [Verificación](#verificación-de-un-replay)
- [Retención](#retención)
- [Gobernanza actual](#gobernanza-actual)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Un replay es la **receta** de la batalla, no un vídeo: cabecera (semilla, ruleset completo, mapa, participantes, versiones de motor/física/reglas/protocolo) y comandos grabados. Para que el visor no tenga que re-simular, lleva además los eventos públicos, los snapshots públicos (10 Hz), los hashes de estado y el resultado ([engine.md](engine.md#replay-snapshot-y-hash)).

## Formato

- **S9R/1** (`apps/replay-service/src/s9r/`): contenedor por **fragmentos** con índice y pie, verificable por partes (`verifyFile`).
  - **Receta** `.s9r`: cabecera (semilla, ruleset, mapa, participantes, versiones), comandos, hashes de estado y checkpoints. Es lo que permite re-simular (`RecipeCursor`, comandos fragmento a fragmento).
  - **Vista** `.s9v`: snapshots públicos, eventos y keyframes, que es lo que pinta el visor (`ViewReader`, lectura por rangos).
- El **JSONL v2** de fichero entero (`toJsonl`/`fromJsonl`) y la compresión zstd/gzip del almacén anterior están **retirados** (corte D-OP-30, V1 REPLAYS PR-4b). Una referencia que no es `.s9r` es «sin replay» (404 uniforme).
- **Keyframes**: en el resumen de la vista; un segmento arranca en el keyframe anterior al tick pedido.

El servicio arranca sólo si el directorio es escribible (`requireWritableDataDir`).

## Almacenamiento e índice

En `REPLAYS_DIR` (`/data/replays` por defecto; el worker lo monta en escritura y la API en sólo lectura):

- `<battleId>.<intento>.s9r` (receta) y `<battleId>.<intento>.s9v` (vista). La ruta de la receta va a `battles.replay_ref`; su sha256 a `battles.replay_hash`.
- `replay_artifacts` (BD): una fila por replay publicado con su estado (`published`), clase (`official` / `tournament` / `practice`), rutas y sha256 de receta y vista. La API sólo sirve una vista cuyo sha256 coincide con `view_sha256`.
- El índice que ve el visor se calcula al vuelo del resumen de la vista (`storeIndexOf` / `projectIndex`): `ticks`, `snapshotCount`, `keyframes`, `result`, `official`, `createdAt`. **Ya no lleva `debugOpen`** (capa retirada, V1 REPLAYS PR-4b).

El volumen entra en la copia de seguridad que documenta C ([backup.md](../operations/backup.md)).

## Límites de almacenamiento y fallo seguro (V1 REPLAYS PR-5)

El worker comprueba tres límites **antes de cada fragmento** (receta y vista juntas), no sólo al empezar ni al terminar. Son claves de `system_settings` (pantalla «Ajustes» de la administración web), con defecto en código, rango validado en servidor, **techo por variable de entorno**, y se releen por sondeo (≈ 5 s) **en caliente**; sin lectura válida de la BD valen los defectos (fail-closed).

| Clave | Defecto | Rango | Entorno (techo) | Qué limita |
|---|---|---|---|---|
| `replays.quota.max_bytes` | 20 GiB | 1 GiB – 16 TiB | `REPLAYS_QUOTA_MAX_BYTES` | Cuota lógica del volumen: publicados + papelera (`replay_artifacts`, caché 30 s) + parciales vivos |
| `replays.quota.min_free_bytes` | 5 GiB | 512 MiB – 1 TiB | `REPLAYS_MIN_FREE_BYTES` | Reserva mínima de espacio **físico** libre (`statfs`) |
| `replays.limits.max_bytes_per_battle` | 64 MiB (provisional, a calibrar con tamaños reales) | 4 MiB – 1 GiB | `REPLAYS_MAX_BYTES_PER_BATTLE` | Bytes de **un intento** (receta + vista, comprimidos). Un intento en curso conserva el valor con el que empezó |

**Dos clases de fallo (decisión D-PR3-3), con política distinta:**

| Clase | Causa | Qué pasa | Reintento |
|---|---|---|---|
| **A · el límite es de la batalla** | `max_bytes_per_battle` superado | El grabador deja de aceptar registros, cierra receta y vista como **truncadas** (`closeTruncated`) y se publican con `allowTruncated`. La batalla termina `finished` con `endReason: recording_limit`, `winner: null`, outcome NULL, sin Elo ni V-D-E. `replay_artifacts.truncated = true` y `stats_state = not_applicable` | **No** (determinista) |
| **B · el límite es del entorno** | Reserva de espacio libre, cuota del volumen, `ENOSPC`/`EIO`, cola llena o escritor atascado | Se **aborta** el grabador, se borran los parciales y el ejecutor lanza `storage_unavailable` | **Sí**, con la política de reintentos; agotada, `failed`/`infrastructure` (#329), nunca resultado deportivo |

Nunca se acumula en RAM como alternativa. El orden de comprobación es B (entorno) antes que A (batalla): si el volumen no admite escribir no se sella nada truncado en él.

**Compuerta previa.** Antes de leer nada y de lanzar ningún contenedor, el ejecutor exige hueco para una batalla de tamaño máximo más la reserva (`libre − max_bytes_per_battle ≥ min_free_bytes`) y que quepa en la cuota. Si no, la batalla no arranca: `storage_unavailable` (`recording_preflight`), reintentable.

El **cierre** (último fragmento de datos, resultado, índice y pie) no aplica reserva ni cuota (la reserva existe para poder cerrar); sí el tope por batalla, con un margen de emergencia de 64 KiB por flujo para resultado, índice y pie.

**Un replay truncado no se reproduce ni se verifica en V1:** el visor, `index`/`segment` y las estadísticas responden como «sin replay» (404 / `unavailable`) y `verify` devuelve `matches:false` (`corrupt_file: truncated`). Sigue íntegro y descargable por quien tenga acceso al crudo.

**Métricas** (`s9_worker_*`, con `S9_METRICS_ENABLED`): `replay_volume_used_bytes`, `replay_volume_free_bytes`, `replay_quota_max_bytes`, `replay_min_free_bytes`, `replay_max_bytes_per_battle` (gauges, sólo medidos) y los contadores `replay_aborts_battle_limit_total`, `replay_aborts_storage_total`, `replay_preflight_rejected_total`. Alertas: `ReplayQuotaNearFull` (>80 %), `ReplayQuotaCritical` (>90 %), `ReplayFreeSpaceLow` (libre < 1,5 × reserva), `ReplayStorageAbort`, `ReplayPreflightRejected` y `ReplayBattleLimitReached`.

## Escritura (publicación)

1. **Único camino**: el worker graba la batalla con `ReplayRecorder` (cola acotada) y, en `finishBattle`, como último paso de la transacción y sólo si su `UPDATE … WHERE claimed_by` casó, llama a `publishRecording` (`apps/replay-service/src/artifacts.ts`): fila `replay_artifacts`, `replay_ref`/`replay_hash` y `publishPair` con las pruebas de cierre del escritor (vista primero, receta al final, sin sobrescribir). Un fallo es `storage_unavailable` y hace rollback ([battles.md](battles.md#battle_result-forma-de-battlesresult)).
2. **Retirado (V1 REPLAYS PR-4b)**: `POST /replays/{battleId}` del replay-service (JSONL con `x-replay-ingest-auth`), `ingestReplay`, la credencial `REPLAY_INGEST_SECRET[_FILE]` y la CLI `ingest`. El lanzador HTTP de la API (apagado) conserva sus guardas pero nunca archiva (`ingested:false`; estricto ⇒ `failed`).
3. Herramientas y tests escriben replays con `apps/replay-service/src/s9r/replay-file.ts` (`writeS9rReplay` / `readS9rReplay`), que usa el mismo grabador y publicación que el worker.

## Autorización de acceso (TD-004)

**Una sola autoridad**: `apps/api/src/replay-access.ts`. Toda ruta que entrega un replay (o sus metadatos) la llama **antes** de leer el disco. Puede leer el replay de la batalla *B*:

| Vía | Condición |
|---|---|
| Staff | rol ≥ `moderator` (`moderator`, `admin`): cualquier batalla (`isReplayStaff`, `replay-access.ts:57-59`) |
| Organizador (#306, D-OP-7) | rol ≥ `organizer` **sólo** en las batallas de torneos que **él creó** (`tournaments.created_by`; `organizerCreatedTournament`, `whereReplayReadable`, `replay-access.ts:62-64,70-78,90-96`), en cualquier estado. No lee batallas de práctica ni de torneos ajenos |
| Participante | dueño (`bots.owner_id`) de algún bot de `participants` de *B* |
| Equipo | miembro (`team_members`) del `bots.team_id` de algún bot participante con visibilidad `team` o `public` (un bot `private` no se comparte ni con su equipo; mismo criterio que [TD-005](../roadmap/technical-debt.md#td-005)) |
| Público | acceso público a replays activado (ajuste de runtime, ver abajo) **y** *B* `finished` **y** *B* mostrable en público (ningún bot participante con visibilidad distinta de `public`, o *B* de un torneo con `broadcast`) |

Fuera de eso: **404 `not_found`** con el mensaje «Replay no encontrado», idéntico al de un id inexistente, un id mal formado o una batalla sin replay (sin enumeración por UUID). Las respuestas autorizadas llevan `Cache-Control: private, no-store`.

**Acceso público a replays** (ajuste de runtime «replays públicos»): lo gobierna la fila `app_runtime_settings` (migración 021), que se cambia en Administración → «Acceso público / Broadcast» (`PATCH /admin/settings/public-access`) y queda en `audit_log`. La variable `S9_PUBLIC_REPLAYS_ENABLED` (`1`/`true`, `apps/api/src/public-replays.ts`) sólo da el **valor inicial** (la primera API que arranca sin fila la crea con ese valor) (`apps/api/src/runtime-settings.ts:56-58,198-208`). Si la BD deja de responder más allá de la ventana de frescura (3 × `S9_RUNTIME_SETTINGS_REFRESH_MS`), el acceso público se **cierra** (fail-closed, `runtime-settings.ts:168-171`); no vuelve al valor de la variable. Activarlo **no** publica todos los ficheros. Sólo pasan a públicas las batallas finalizadas cuyos bots son todos públicos; el mismo predicado (`wherePublicReplay`) gobierna `/public/replays*`, el reproductor y el listado. Una batalla con un bot privado o de equipo sigue privada.

**Leer no es recibir el crudo.** La tabla anterior decide quién puede **leer** el replay de *B* (listado, índice, segmentos, verificación). Qué **representación** recibe lo decide [PRE-1](#replay-crudo-y-proyección-pública-pre-1): el fichero crudo sólo con autorización explícita; el resto, la proyección pública de competición.

**Radio en el replay: dato de administración frente a dato observable.** El fichero crudo graba los comandos de todos los vehículos, incluidos los `radio` (payload, `to` y slot) de **los dos bandos**. Es el dato de la batalla completa, para la verificación y las estadísticas en servidor, no lo que observó un bot: durante la batalla, la observación de un bot sólo trae la radio de su propio equipo ([equipment.md](equipment.md#radio-radio_a)). Desde PRE-1 esos comandos **no salen** de la API salvo a quien recibe el crudo (moderator/admin o el dueño de todos los bots de la batalla); ningún participante con rivales, miembro de equipo ni visitante los ve.

**Gateway**: `location = /replays` y `location /replays/` responden `404` JSON sin `Location`, para cualquier método y subruta (`infrastructure/gateway/nginx.conf` y `nginx-behind-proxy.conf`). Nginx normaliza la URI antes de elegir `location` (`//replays`, `/%72eplays`, `/api/v1/../../replays` caen ahí).

**Web**: `ReplayPage` pide `/api/v1/replays/<id>/index` y `/segment` con `api()` (Bearer + refresh); `ReplaysPage` usa `GET /api/v1/replays`. La ruta `#/replay/<id>` sigue siendo pública, pero espera a recuperar la sesión desde la cookie antes de pedir el replay (`apps/web/src/App.tsx`).

## Replay crudo y proyección pública (PRE-1)

Política: **replay público ⇒ proyección saneada de competición; replay crudo ⇒ restringido.** La aplica la API (`apps/api/src/replay-projection.ts`), nunca el navegador, y es la misma con el acceso público a replays activado o desactivado: el ajuste amplía quién puede **leer**, nunca quién recibe el crudo.

**Quién recibe el crudo** (fichero, índice de almacén completo y segmentos sin proyectar), además de poder leer la batalla:

| Vía | Condición | Motivo |
|---|---|---|
| Rol interno | `moderator` o `admin` | supervisión de juego limpio e incidencias |
| Dueño | dueño de **todos** los bots participantes | el fichero sólo contiene datos suyos |

Nadie más: ni `organizer` (aunque sea el creador del torneo: lee, pero recibe la proyección), ni un participante con rivales, ni un miembro de equipo, ni un visitante. Un dueño con rivales recibe la proyección porque el fichero lleva también la semilla, los comandos (radio, minas, órdenes) y el loadout de los rivales, y no se puede recortar a «sólo lo suyo» sin dejar de ser el fichero verificable por hash. `GET /replays/{id}` responde a quien no tiene el crudo el **mismo 404** que a un replay inexistente.

**Qué lleva la proyección** (lista blanca: lo que el espectador en directo ya recibe):

- mundo (tamaño, muros, destructibles, bases) y nómina pública (vehículo, bot, bando, chasis, nombre de competición);
- snapshots públicos del motor (posiciones, rumbo, vida, módulos por ranura y estado, proyectiles, marcador, objetivos del modo);
- eventos públicos (marcador, destrucciones, minas que **explotan**, banderas, zonas, juggernaut, prórroga, límite técnico); un tipo de evento nuevo no sale hasta añadirlo a la lista a propósito;
- resultado deportivo (ganador, motivo de fin, ticks, marcador y hash final, que permite auditar con `verify`);
- para el reproductor: `ticks`, `snapshotCount`, `keyframes`, `official` y `createdAt` (sin `debugOpen`: la capa de depuración se retiró en V1 REPLAYS PR-4b).

**Qué no lleva nunca**: semilla, ruleset completo, comandos de los bots, carga de radio, despliegue de minas, `participants[].spec` (loadout), eventos privados de un bot (impactos recibidos, acciones rechazadas…), hashes por tick ni metadatos de almacén (sha, algoritmo, tamaño, caducidad, checksum del mapa, rutas). Lo publicado **no permite re-simular** la batalla porque no contiene los **comandos** privados de los bots: sin ellos, ni siquiera conociendo la semilla se reproduce el resultado. La seguridad de la proyección no depende de ocultar la semilla (la vista de auditoría de batalla puede revelarla; ver #264).

| Recurso | Con crudo | Sin crudo (lector autorizado) |
|---|---|---|
| `GET /replays/{id}` | receta `.s9r` en streaming | 404 uniforme |
| `GET /replays/{id}/index` | índice de almacén + mundo + nómina | índice proyectado (`projection: "s9.replay.public-competition.v2"`) |
| `GET /replays/{id}/segment` | segmento de la vista tal cual (nunca comandos) | segmento proyectado, sin comandos |
| `POST /replays/{id}/verify` | booleano y hashes | igual (no entrega contenido) |
| `GET /public/replays/{id}/download` | — (ruta pública) | documento JSON proyectado completo, para todos (admin incluido) |

El reproductor web consume sólo índice y segmentos y funciona igual con la proyección (lo comprueba `apps/api/src/pre1-replay-projection.test.ts` con el `ReplayPlayer` real).

## Lectura: API

`apps/api/src/routes/replays.ts` (salvo `/public/replays*`, en `routes/battles.ts`). Todas aplican la política de arriba.

| Ruta | Rol mínimo | Nota |
|---|---|---|
| `GET /api/v1/replays?limit=&cursor=` | `user` (anónimo ⇒ 401) | `{items:[{battleId, ticks, winner, official, createdAt, sizeBytes}], nextCursor}`: sólo lo que el usuario puede leer. Sale de `battles`, no del inventario de ficheros |
| `GET /api/v1/replays/{id}` | visitante (cuota anónima) | Receta `.s9r` (`battles.replay_ref`) en streaming, **sólo con acceso al crudo** ([PRE-1](#replay-crudo-y-proyección-pública-pre-1)) |
| `GET /api/v1/replays/{id}/index` | visitante (cuota anónima) | Índice de almacén (del resumen de la vista) con acceso al crudo; si no, el índice proyectado. Sin `debugOpen` |
| `GET /api/v1/replays/{id}/segment?fromTick&toTick` | visitante (cuota anónima) | Snapshots y eventos desde el keyframe anterior, leídos sólo de los fragmentos que cubren el rango (máx. 1200 ticks; por defecto 600). Nunca comandos. Con acceso al crudo, tal cual; sin él, proyectado. La vista se abre sólo si su sha256 coincide con `replay_artifacts.view_sha256` |
| `POST /api/v1/replays/{id}/verify` | visitante (cuota propia) | Ver [abajo](#verificación-de-un-replay) |
| `GET /api/v1/public/replays`, `/{id}`, `/{id}/download` | visitante | Sólo con el acceso público a replays activado (ajuste de runtime; la variable es el valor inicial) y el predicado público; con la bandera apagada, `{enabled:false, items:[]}` o 404. Proyección sin seed ni ruta interna; `/download` entrega el documento proyectado en JSON, nunca el fichero crudo |

La API monta el volumen de replays en sólo lectura (`arena_replays:/data/replays:ro`); no escribe replays.

## Lectura: replay-service (interno)

Desde V1 REPLAYS PR-4 el replay-service **no sirve replays** y desde PR-4b su código de rutas antiguas está **retirado** (`server.ts`, `store.ts`, `segment.ts`, `auth.ts`). El proceso (`apps/replay-service/src/main.ts`) sólo expone:

| Ruta | Respuesta |
|---|---|
| `GET /healthz` | Estado del servicio |
| `GET /version` | Identidad de build |

Cualquier `/replays*` o `/retention/sweep` responde 404, con o sin credencial (`apps/replay-service/tests/service-bootstrap.test.ts`). La CLI conserva `verify` (receta S9R/1); `ingest`, `sweep` y `serve` ya no existen.

## Verificación de un replay

`verifyReplay` (API, `verifyRecipe` en `apps/api/src/replay-s9r.ts`):

1. Integridad completa de la receta contra `battles.replay_hash`, en una pasada en streaming; si no coincide, `checksum_mismatch`; si el contenedor es inválido, `corrupt_file`.
2. Re-simula con `RecipeCursor` (comandos por fragmentos) y compara hashes intermedios, checkpoints y resultado.
3. Exige que `final_state_hash` de la BD coincida con el de la receta.

Responde `{matches, valid, officialHash, recomputedHash, reason, message, divergedAtTick}`. Un replay grabado con otra versión del motor da `valid=false`, `reason=engine_version_mismatch` y un `message` que lo explica: no se puede re-simular, pero **no** está manipulado ([ADR-019](../adr/ADR-019-perimetro-y-version-del-motor.md)). Un formato anterior da `unsupported_format`. Exige poder leer el replay (misma política). Re-simular es caro: la API lo limita con cuota anónima.

## Retención

- La retención del almacén anterior (`expiresAt` de 7 días, `sweepRetention`, `POST /retention/sweep`) se **retiró** con él (V1 REPLAYS PR-4b). Nunca estuvo programada.
- La clase de cada replay queda en `replay_artifacts` (`official` / `tournament` / `practice`); el janitor que aplicará la retención sobre S9R/1 es trabajo de PR-6. Hoy no se borra nada.

## Gobernanza actual

- **Acceso** (PR #158, incluida en el commit de producción RC5.5): una autoridad (la API) y el gateway cerrado en `/replays*`; ver [Autorización de acceso](#autorización-de-acceso-td-004) y [TD-004](../roadmap/technical-debt.md#td-004) (cerrada).
- **Esquema**: ninguna respuesta de replay redirige; `absolute_redirect off` en cada `server` y `/replays` responde 404 sin `Location` ([TD-014](../roadmap/technical-debt.md#td-014)).
- **Escritura**: sólo el worker publica (dentro de la transacción de cierre, con prueba de cierre). No existe ninguna ruta HTTP de escritura de replays.

## Errores / limitaciones

- Un replay sin fila de batalla (por ejemplo, el del arnés de smoke) no aparece en la web: sólo se lista lo que está en `battles`.
- Las referencias de formato anterior (`.replay` JSONL) son «sin replay» (D-OP-30): no se sirven ni se verifican.
- No hay retención programada (PR-6).

## Estado actual

- **FUNCIONA ACTUALMENTE (V1 REPLAYS)**: publicación S9R/1 por el worker, índice, segmentos por fragmentos, descarga de la receta en streaming y verificación por re-simulación.
- **FUNCIONA ACTUALMENTE (integración `integration/functional-closure`, entorno aislado tras TLS)**: listar → abrir → cargar → canvas → ticks → pausa → fin en Chromium real.
- **FUNCIONA ACTUALMENTE (PR #158, incluida en el commit de producción RC5.5)**: autorización de replays (TD-004) probada a través del gateway real y en navegador real; con el replay-service parado los replays siguen leyéndose (la API lee el volumen).
- **RETIRADO (V1 REPLAYS PR-4b, decisión del operador)**: la capa de depuración del replay (`debugOpen`, comandos de los bots en el visor). Cambio de contrato registrado en [known-issues](../roadmap/known-issues.md).
- **PENDIENTE**: retención programada (janitor de PR-6).

## Documentación relacionada

- Usuario: [Replays](../user/replays.md), [Visor](../user/viewer.md)
- Técnica: [engine.md](engine.md), [battles.md](battles.md), [websocket.md](websocket.md), [frontend.md](frontend.md), [api.md](api.md)
- Arquitectura (A): [gateway.md](gateway.md), [security.md](security.md), [data-flow.md](data-flow.md)
- Operación (C): [backup.md](../operations/backup.md), [networking.md](../operations/networking.md)
- Histórico absorbido: R7 (visor de replays), R7-A (ingesta operativa), R11 (espectador público) y Carril J (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`; filas FC-D contra los carriles del cierre funcional, integrados en `integration/functional-closure` (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| Receta `.s9r` + vista `.s9v` S9R/1; fila `replay_artifacts` | CODE_VERIFIED | `apps/replay-service/src/s9r/`; `apps/replay-service/src/artifacts.ts` (`publishRecording`) |
| Sólo el worker publica, en la transacción de cierre | CODE_VERIFIED | `apps/tournament-worker/src/battle-runner.ts` (`finishBattle` → `publishRecording`) |
| El replay-service no tiene rutas de replay (404 con o sin credencial) | TEST_VERIFIED | `apps/replay-service/src/main.ts`; `apps/replay-service/tests/service-bootstrap.test.ts` |
| Sin capa de depuración (`debugOpen`) en índice ni reproductor | TEST_VERIFIED | `apps/api/src/pre1-replay-projection.test.ts`; `apps/web/tests/replay-player.test.ts` |
| (TD-004) Política única de acceso | CODE_VERIFIED | `apps/api/src/replay-access.ts:40-118` |
| (TD-004) Rutas de lectura de la API y `no-store` | CODE_VERIFIED | `apps/api/src/routes/replays.ts:31,55,104,122,133,154`; contrato `apps/api/openapi.yaml` 0.9.0 |
| (TD-004) Predicado público en `/public/replays*` | CODE_VERIFIED | `apps/api/src/routes/battles.ts:159,292` |
| (TD-004) El gateway responde 404 en `/replays*` | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:124-132`; `nginx-behind-proxy.conf:103-111` |
| (TD-004) Matriz actor × batalla × recurso | TEST_VERIFIED | `apps/api/src/td004-replay-access.test.ts` (87/87, rc=0; mutaciones de política ⇒ rojo) |
| (TD-004) Anónimo 404 / participante 200 por nginx real | RUNTIME_VERIFIED (entorno aislado) | `infrastructure/gateway/tests/replay-gateway.test.ts` (11/11, rc=0; re-exponer el `proxy_pass` ⇒ 5 rojos, rc=1) |
| (TD-004) La web lee por la API con sesión | CODE_VERIFIED | `apps/web/src/pages/ReplayPage.tsx:33,50`; `ReplaysPage.tsx:30`; `App.tsx:206` |
| Lecturas anónimas 200 en producción con `enabled:false` (antes de TD-004, en la medición del 2026-10-15; hoy cerrada por el PR #158) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 (GET anónimos) |
| 301 a http y bloqueo por contenido mixto (base) | RUNTIME_VERIFIED | Auditoría B pasada 2 §4 (navegador real) |
| Sin redirección en `/replays` (FC-D; desde TD-004, 404 sin `Location`) | RUNTIME_VERIFIED | `tests/browser/specs/replay.spec.ts`; `infrastructure/gateway/tests/replay-gateway.test.ts` (SEC-9) |
| Reproducción completa en navegador (FC-D) | RUNTIME_VERIFIED | `tests/browser/specs/replay.spec.ts` (fase1 rc=0) |
| Verificación con `matches:true` | RUNTIME_VERIFIED | Auditoría B pasada 1 §B9 (entorno aislado) |
| La web lista con `api("GET", "/replays")` (TD-004) | CODE_VERIFIED | `apps/web/src/pages/ReplaysPage.tsx:30,40` |
