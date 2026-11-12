# Replays y replay-service

## Resumen

Cada batalla terminada deja un **replay**: el JSONL del motor, comprimido, más un índice. Se guarda **en disco** (volumen de replays). No hay tabla de replays: la BD sólo guarda la referencia en `battles.replay_ref` y `battles.replay_hash`.

Lo escribe el `tournament-worker` usando la librería del replay-service. Desde la fase *Production Readiness* (2026-10, PR #158, incluida en el commit de producción RC5.5) lo sirve **un solo camino** hacia el navegador:

- la **API** (`/api/v1/replays`, `/api/v1/replays/{id}`, `/index`, `/segment`, `/verify` y `/api/v1/public/replays*`), que aplica la [política de acceso](#autorización-de-acceso-td-004) **antes** de abrir ningún fichero;
- el **replay-service** queda **interno**: el gateway responde 404 en `/replays*` y sólo lo alcanza la red `platform` (ingesta del worker con su secreto, diagnóstico de operador).

Antes ([TD-004](../roadmap/technical-debt.md#td-004)) el gateway hacía *proxy* de `/replays/*` al replay-service **sin autenticar**: cualquiera bajaba inventario, fichero, índice y segmentos, también de batallas privadas, aunque la API anunciara `enabled:false`. En la integración del cierre funcional (`integration/functional-closure`) la lista web ya no sufre la redirección 301 a `http://` ([TD-014](../roadmap/technical-debt.md#td-014)) y el reproductor web arranca y reproduce en navegador real ([TD-009](../roadmap/technical-debt.md#td-009)).

## Índice

- [Qué es](#qué-es)
- [Formato](#formato)
- [Almacenamiento e índice](#almacenamiento-e-índice)
- [Escritura (ingesta)](#escritura-ingesta)
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

- **JSONL** (`apps/arena-engine/src/replay.ts`): una línea por registro con `t ∈ header | cmd | evt | snap | hash | result`.
- **Compresión** (`apps/replay-service/src/format.ts`): zstd si el runtime lo trae (Node ≥ 22.15); si no, gzip. El índice registra el algoritmo usado.
- **Keyframes**: uno cada 30 snapshots (≈ cada 3 s a 10 Hz). Los snapshots son estado completo, así que basta con empezar en el anterior.

## Almacenamiento e índice

En `REPLAYS_DIR` (`/data/replays` por defecto, volumen compartido entre el worker y el replay-service):

- `<battleId>.replay`: el JSONL comprimido. Su ruta es la que va a `battles.replay_ref`.
- `<battleId>.replay.json`: `StoredReplayIndex`:
  - identidad e integridad: `formatVersion`, `battleId`, `algo`, `sha256` (del fichero **comprimido**) y `sizeBytes`;
  - retención: `official`, `createdAt` y `expiresAt` (`null` si es oficial);
  - contenido: `ticks`, `snapshotCount`, `versions`, `mapChecksum` y `keyframes[]`;
  - `result` con `winner`, `ticks`, `score` y `finalStateHash`;
  - `debugOpen`.

El volumen entra en la copia de seguridad que documenta C ([backup.md](../operations/backup.md)).

## Escritura (ingesta)

1. **Camino activo**: `finishBattle` del worker llama a `ingestReplay(replaysDir, replay, {official})`, que valida, comprime y escribe los dos ficheros. Después `battles.replay_ref` y `replay_hash` quedan en la misma transacción que el resultado ([battles.md](battles.md#battle_result-forma-de-battlesresult)).
2. **Por HTTP**: `POST /replays/{battleId}` en el replay-service, con cuerpo JSONL. Exige la cabecera `x-replay-ingest-auth` con el secreto interno (`REPLAY_INGEST_SECRET[_FILE]`). Sin secreto configurado, **toda escritura responde 401**. Lo usa el launcher del camino real (apagado).

El servicio arranca sólo si el directorio es escribible (`requireWritableDataDir`).

## Autorización de acceso (TD-004)

**Una sola autoridad**: `apps/api/src/replay-access.ts`. Toda ruta que entrega un replay (o sus metadatos) la llama **antes** de leer el disco. Puede leer el replay de la batalla *B*:

| Vía | Condición |
|---|---|
| Staff | rol ≥ `organizer` (`organizer`, `moderator`, `admin`) |
| Participante | dueño (`bots.owner_id`) de algún bot de `participants` de *B* |
| Equipo | miembro (`team_members`) del `bots.team_id` de algún bot participante con visibilidad `team` o `public` (un bot `private` no se comparte ni con su equipo; mismo criterio que [TD-005](../roadmap/technical-debt.md#td-005)) |
| Público | `S9_PUBLIC_REPLAYS_ENABLED` activada **y** *B* `finished` **y** *B* mostrable en público (ningún bot participante con visibilidad distinta de `public`, o *B* de un torneo con `broadcast`) |

Fuera de eso: **404 `not_found`** con el mensaje «Replay no encontrado», idéntico al de un id inexistente, un id mal formado o una batalla sin replay (sin enumeración por UUID). Las respuestas autorizadas llevan `Cache-Control: private, no-store`.

**`S9_PUBLIC_REPLAYS_ENABLED`** (`1`/`true`, apagada por defecto, `apps/api/src/public-replays.ts`): activarla **no** publica todos los ficheros. Sólo pasan a públicas las batallas finalizadas cuyos bots son todos públicos; el mismo predicado (`wherePublicReplay`) gobierna `/public/replays*`, el reproductor y el listado. Una batalla con un bot privado o de equipo sigue privada.

**Leer no es recibir el crudo.** La tabla anterior decide quién puede **leer** el replay de *B* (listado, índice, segmentos, verificación). Qué **representación** recibe lo decide [PRE-1](#replay-crudo-y-proyección-pública-pre-1): el fichero crudo sólo con autorización explícita; el resto, la proyección pública de competición.

**Radio en el replay: dato de administración frente a dato observable.** El fichero crudo graba los comandos de todos los vehículos, incluidos los `radio` (payload, `to` y slot) de **los dos bandos**. Es el dato de la batalla completa, para la verificación y las estadísticas en servidor, no lo que observó un bot: durante la batalla, la observación de un bot sólo trae la radio de su propio equipo ([equipment.md](equipment.md#radio-radio_a)). Desde PRE-1 esos comandos **no salen** de la API salvo a quien recibe el crudo (moderator/admin o el dueño de todos los bots de la batalla); ningún participante con rivales, miembro de equipo ni visitante los ve.

**Gateway**: `location = /replays` y `location /replays/` responden `404` JSON sin `Location`, para cualquier método y subruta (`infrastructure/gateway/nginx.conf` y `nginx-behind-proxy.conf`). Nginx normaliza la URI antes de elegir `location` (`//replays`, `/%72eplays`, `/api/v1/../../replays` caen ahí).

**Web**: `ReplayPage` pide `/api/v1/replays/<id>/index` y `/segment` con `api()` (Bearer + refresh); `ReplaysPage` usa `GET /api/v1/replays`. La ruta `#/replay/<id>` sigue siendo pública, pero espera a recuperar la sesión desde la cookie antes de pedir el replay (`apps/web/src/App.tsx`).

## Replay crudo y proyección pública (PRE-1)

Política: **replay público ⇒ proyección saneada de competición; replay crudo ⇒ restringido.** La aplica la API (`apps/api/src/replay-projection.ts`), nunca el navegador, y es la misma con `S9_PUBLIC_REPLAYS_ENABLED` activada o desactivada: la bandera amplía quién puede **leer**, nunca quién recibe el crudo.

**Quién recibe el crudo** (fichero, índice de almacén completo y segmentos sin proyectar), además de poder leer la batalla:

| Vía | Condición | Motivo |
|---|---|---|
| Rol interno | `moderator` o `admin` | supervisión de juego limpio e incidencias |
| Dueño | dueño de **todos** los bots participantes | el fichero sólo contiene datos suyos |

Nadie más: ni `organizer`, ni un participante con rivales, ni un miembro de equipo, ni un visitante. Un dueño con rivales recibe la proyección porque el fichero lleva también la semilla, los comandos (radio, minas, órdenes) y el loadout de los rivales, y no se puede recortar a «sólo lo suyo» sin dejar de ser el fichero verificable por hash. `GET /replays/{id}` responde a quien no tiene el crudo el **mismo 404** que a un replay inexistente.

**Qué lleva la proyección** (lista blanca: lo que el espectador en directo ya recibe):

- mundo (tamaño, muros, destructibles, bases) y nómina pública (vehículo, bot, bando, chasis, nombre de competición);
- snapshots públicos del motor (posiciones, rumbo, vida, módulos por ranura y estado, proyectiles, marcador, objetivos del modo);
- eventos públicos (marcador, destrucciones, minas que **explotan**, banderas, zonas, juggernaut, prórroga, límite técnico); un tipo de evento nuevo no sale hasta añadirlo a la lista a propósito;
- resultado deportivo (ganador, motivo de fin, ticks, marcador y hash final, que permite auditar con `verify`);
- para el reproductor: `ticks`, `snapshotCount`, `keyframes`, `official`, `createdAt` y `debugOpen: false`.

**Qué no lleva nunca**: semilla, ruleset completo, comandos de los bots (tampoco con `debugOpen`), carga de radio, despliegue de minas, `participants[].spec` (loadout), eventos privados de un bot (impactos recibidos, acciones rechazadas…), hashes por tick ni metadatos de almacén (sha, algoritmo, tamaño, caducidad, checksum del mapa, rutas). Sin semilla ni comandos la batalla **no se puede re-simular** con lo publicado.

| Recurso | Con crudo | Sin crudo (lector autorizado) |
|---|---|---|
| `GET /replays/{id}` | fichero comprimido | 404 uniforme |
| `GET /replays/{id}/index` | índice de almacén + mundo + nómina | índice proyectado (`projection: "s9.replay.public-competition.v2"`) |
| `GET /replays/{id}/segment` | segmento tal cual (comandos sólo con `debugOpen`) | segmento proyectado, sin comandos |
| `POST /replays/{id}/verify` | booleano y hashes | igual (no entrega contenido) |
| `GET /public/replays/{id}/download` | — (ruta pública) | documento JSON proyectado completo, para todos (admin incluido) |

El reproductor web consume sólo índice y segmentos y funciona igual con la proyección (lo comprueba `apps/api/src/pre1-replay-projection.test.ts` con el `ReplayPlayer` real).

## Lectura: API

`apps/api/src/routes/replays.ts` (salvo `/public/replays*`, en `routes/battles.ts`). Todas aplican la política de arriba.

| Ruta | Rol mínimo | Nota |
|---|---|---|
| `GET /api/v1/replays?limit=&cursor=` | `user` (anónimo ⇒ 401) | `{items:[{battleId, ticks, winner, official, createdAt, sizeBytes}], nextCursor}`: sólo lo que el usuario puede leer. Sale de `battles`, no del inventario de ficheros |
| `GET /api/v1/replays/{id}` | visitante (cuota anónima) | Fichero comprimido (`battles.replay_ref`), **sólo con acceso al crudo** ([PRE-1](#replay-crudo-y-proyección-pública-pre-1)) |
| `GET /api/v1/replays/{id}/index` | visitante (cuota anónima) | El índice (`<replay_ref>.json`) con acceso al crudo; si no, el índice proyectado |
| `GET /api/v1/replays/{id}/segment?fromTick&toTick` | visitante (cuota anónima) | Snapshots y eventos desde el keyframe anterior; con acceso al crudo, `commands` sólo con `debugOpen`; sin él, proyectado y sin comandos. Comprueba el sha256 del índice antes de decodificar; caché acotada (8 replays) por proceso |
| `POST /api/v1/replays/{id}/verify` | visitante (cuota propia) | Ver [abajo](#verificación-de-un-replay) |
| `GET /api/v1/public/replays`, `/{id}`, `/{id}/download` | visitante | Sólo con `S9_PUBLIC_REPLAYS_ENABLED` y el predicado público; con la bandera apagada, `{enabled:false, items:[]}` o 404. Proyección sin seed ni ruta interna; `/download` entrega el documento proyectado en JSON, nunca el fichero crudo |

La API monta el volumen de replays en sólo lectura (`arena_replays:/data/replays:ro`); no escribe replays.

## Lectura: replay-service (interno)

`apps/replay-service/src/server.ts`. **No es alcanzable desde el gateway** desde TD-004; sólo por la red interna `platform`. Las lecturas no llevan credencial (riesgo residual: cualquier servicio de `platform` puede leerlas). El cálculo de segmentos es la misma función que usa la API (`apps/replay-service/src/segment.ts`).

| Ruta | Respuesta |
|---|---|
| `GET /replays?limit=&order=` | Inventario completo leído de los índices |
| `GET /replays/{id}` | Fichero comprimido; admite `Range` (206/416); cabecera `X-Replay-Sha256` |
| `GET /replays/{id}/index` | El índice |
| `GET /replays/{id}/segment?fromTick&toTick` | Segmento |
| `POST /replays/{id}` | Ingesta (con credencial) |
| `POST /replays/{id}/verify` | Re-simulación (sin credencial) |
| `POST /retention/sweep` | Borrado de caducados (con credencial) |
| `GET /healthz` | Estado del servicio |

## Verificación de un replay

`verifyReplay` (API):

1. Compara el sha256 del fichero con `battles.replay_hash`; si no coincide, `checksum_mismatch`.
2. Descomprime y parsea; si falla, `corrupt_file`.
3. Re-simula (`verifyLoaded`).
4. Exige que `final_state_hash` de la BD coincida con el del fichero.

Responde `{matches, valid, officialHash, recomputedHash, reason, message, divergedAtTick}`. Un replay grabado con otra versión del motor da `valid=false`, `reason=engine_version_mismatch` y un `message` que lo explica: no se puede re-simular, pero **no** está manipulado ([ADR-019](../adr/ADR-019-perimetro-y-version-del-motor.md)). Exige poder leer el replay (misma política). Re-simular es caro: la API lo limita con cuota anónima; la ruta del replay-service ya no es alcanzable desde fuera.

## Retención

- Los replays no oficiales (práctica) se crean con `expiresAt = createdAt + 7 días`; los oficiales nunca caducan.
- `sweepRetention` borra los caducados, pero **ningún proceso del repositorio lo programa**. Sólo existen la ruta autenticada y la CLI (`apps/replay-service/src/cli.ts`). En la práctica no se borra nada.

## Gobernanza actual

- **Acceso** (PR #158, incluida en el commit de producción RC5.5): una autoridad (la API) y el gateway cerrado en `/replays*`; ver [Autorización de acceso](#autorización-de-acceso-td-004) y [TD-004](../roadmap/technical-debt.md#td-004) (cerrada).
- **Esquema**: ninguna respuesta de replay redirige; `absolute_redirect off` en cada `server` y `/replays` responde 404 sin `Location` ([TD-014](../roadmap/technical-debt.md#td-014)).
- **Escritura**: la ingesta y el barrido están autenticados. El cuerpo se lee entero (hasta 64 MB) antes del 401.

## Errores / limitaciones

- Un replay sin fila de batalla (por ejemplo, el de un arnés) ya no aparece en la lista web (sale de `battles`); sigue en el inventario interno del replay-service.
- La caché de segmentos de la API es por proceso y acotada (8 replays); la del replay-service interno no tiene límite.
- Las lecturas del replay-service no exigen credencial dentro de la red `platform`.
- No hay retención programada.

## Estado actual

- **FUNCIONA ACTUALMENTE**: generación e ingesta, índice, segmentos, descarga con `Range` y verificación por re-simulación (`matches:true` en la auditoría).
- **FUNCIONA ACTUALMENTE (integración `integration/functional-closure`, entorno aislado tras TLS)**: listar → abrir → cargar → canvas → ticks → pausa → fin en Chromium real.
- **FUNCIONA ACTUALMENTE (PR #158, incluida en el commit de producción RC5.5)**: autorización de replays (TD-004) probada a través del gateway real y en navegador real; con el replay-service parado los replays siguen leyéndose (la API lee el volumen).
- **PENDIENTE**: retención programada y apertura de `debugOpen` por el dueño (no hay pantalla).

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
| Ficheros `.replay` y `.replay.json`; sha256 del comprimido | CODE_VERIFIED | `apps/replay-service/src/store.ts:42-46,81-122`; `format.ts:65-90` |
| zstd o gzip; keyframe cada 30 | CODE_VERIFIED | `format.ts:30-38,94-100` |
| El worker ingiere y guarda `replay_ref` y `replay_hash` | CODE_VERIFIED | `apps/tournament-worker/src/battle-runner.ts:240-271` |
| Rutas del replay-service; escritura con secreto | CODE_VERIFIED | `apps/replay-service/src/server.ts`; `main.ts:27-45` |
| (TD-004) Política única de acceso | CODE_VERIFIED | `apps/api/src/replay-access.ts:40-118` |
| (TD-004) Rutas de lectura de la API y `no-store` | CODE_VERIFIED | `apps/api/src/routes/replays.ts:31,55,104,122,133,154`; contrato `apps/api/openapi.yaml` 0.9.0 |
| (TD-004) Predicado público en `/public/replays*` | CODE_VERIFIED | `apps/api/src/routes/battles.ts:159,292` |
| (TD-004) El gateway responde 404 en `/replays*` | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:124-132`; `nginx-behind-proxy.conf:103-111` |
| (TD-004) Matriz actor × batalla × recurso | TEST_VERIFIED | `apps/api/src/td004-replay-access.test.ts` (87/87, rc=0; mutaciones de política ⇒ rojo) |
| (TD-004) Anónimo 404 / participante 200 por nginx real | RUNTIME_VERIFIED (entorno aislado) | `infrastructure/gateway/tests/replay-gateway.test.ts` (11/11, rc=0; re-exponer el `proxy_pass` ⇒ 5 rojos, rc=1) |
| (TD-004) La web lee por la API con sesión | CODE_VERIFIED | `apps/web/src/pages/ReplayPage.tsx:33,50`; `ReplaysPage.tsx:30`; `App.tsx:206` |
| 7 días de TTL; barrido sin programar | CODE_VERIFIED | `store.ts:22,255-270`; búsqueda de `retention/sweep` (sólo ruta, CLI y comentario de compose) |
| Lecturas anónimas 200 en producción con `enabled:false` (antes de TD-004, en la medición del 2026-10-15; hoy cerrada por el PR #158) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 (GET anónimos) |
| 301 a http y bloqueo por contenido mixto (base) | RUNTIME_VERIFIED | Auditoría B pasada 2 §4 (navegador real) |
| Sin redirección en `/replays` (FC-D; desde TD-004, 404 sin `Location`) | RUNTIME_VERIFIED | `tests/browser/specs/replay.spec.ts`; `infrastructure/gateway/tests/replay-gateway.test.ts` (SEC-9) |
| Reproducción completa en navegador (FC-D) | RUNTIME_VERIFIED | `tests/browser/specs/replay.spec.ts` (fase1 rc=0) |
| Verificación con `matches:true` | RUNTIME_VERIFIED | Auditoría B pasada 1 §B9 (entorno aislado) |
| La web lista con `api("GET", "/replays")` (TD-004) | CODE_VERIFIED | `apps/web/src/pages/ReplaysPage.tsx:30,40` |
