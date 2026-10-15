# Replays y replay-service

## Resumen

Cada batalla terminada deja un **replay**: el JSONL del motor, comprimido, más un índice. Se guarda **en disco** (volumen de replays). No hay tabla de replays: la BD sólo guarda la referencia en `battles.replay_ref` y `battles.replay_hash`.

Lo escribe el `tournament-worker` usando la librería del replay-service. Lo sirven dos caminos:

- el **replay-service** por el gateway (`/replays/*`, **anónimo**);
- la **API** (`/api/v1/replays/{id}`, `/verify`, y `/api/v1/public/replays*` detrás de una bandera apagada).

**Gobernanza actual**: la API anuncia los replays públicos como apagados (`enabled:false`), pero el gateway sirve inventario y ficheros completos a cualquiera ([TD-004](../roadmap/technical-debt.md#td-004)). La lista web sufre una redirección 301 a `http://` ([TD-014](../roadmap/technical-debt.md#td-014)) y el reproductor web no arranca en navegador ([TD-009](../roadmap/technical-debt.md#td-009)).

## Índice

- [Qué es](#qué-es)
- [Formato](#formato)
- [Almacenamiento e índice](#almacenamiento-e-índice)
- [Escritura (ingesta)](#escritura-ingesta)
- [Lectura: replay-service](#lectura-replay-service)
- [Lectura: API](#lectura-api)
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

1. **Camino activo**: `finishBattle` del worker llama a `ingestReplay(replaysDir, replay, {official})`, que valida, comprime y escribe los dos ficheros. Después `battles.replay_ref` y `replay_hash` quedan en la misma transacción que el resultado ([battles.md](battles.md#7-resultado)).
2. **Por HTTP**: `POST /replays/{battleId}` en el replay-service, con cuerpo JSONL. Exige la cabecera `x-replay-ingest-auth` con el secreto interno (`REPLAY_INGEST_SECRET[_FILE]`). Sin secreto configurado, **toda escritura responde 401**. Lo usa el launcher del camino real (apagado).

El servicio arranca sólo si el directorio es escribible (`requireWritableDataDir`).

## Lectura: replay-service

`apps/replay-service/src/server.ts`. Tras el gateway, `location /replays/` hace *proxy* **sin reescribir ni autenticar**:

| Ruta | Respuesta |
|---|---|
| `GET /replays?limit=&order=` | `{items:[{battleId, official, winner, ticks, createdAt, sizeBytes…}]}`, el inventario completo leído de los índices |
| `GET /replays/{id}` | Fichero comprimido; admite `Range` (206/416); cabecera `X-Replay-Sha256` |
| `GET /replays/{id}/index` | El índice |
| `GET /replays/{id}/segment?fromTick&toTick` | Snapshots y eventos desde el keyframe anterior. Los `commands` sólo aparecen si el índice tiene `debugOpen` |
| `POST /replays/{id}/verify` | Re-simulación (sin credencial) |
| `POST /retention/sweep` | Borrado de caducados (con credencial) |
| `GET /healthz` | Estado del servicio |

## Lectura: API

| Ruta | Rol | Nota |
|---|---|---|
| `GET /api/v1/replays/{battleId}` | anónimo (cuota anónima) | Lee `battles.replay_ref` del disco. Sirve también replays de batallas privadas de práctica |
| `POST /api/v1/replays/{battleId}/verify` | anónimo (cuota propia) | Ver [abajo](#verificación-de-un-replay) |
| `GET /api/v1/public/replays`, `/{id}`, `/{id}/download` | anónimo | Sólo si `S9_PUBLIC_REPLAYS_ENABLED`; con la bandera apagada, `{enabled:false, items:[]}` o 404. Proyección sin seed ni ruta interna |

## Verificación de un replay

`verifyReplay` (API):

1. Compara el sha256 del fichero con `battles.replay_hash`; si no coincide, `checksum_mismatch`.
2. Descomprime y parsea; si falla, `corrupt_file`.
3. Re-simula (`verifyLoaded`).
4. Exige que `final_state_hash` de la BD coincida con el del fichero.

Responde `{matches, valid, officialHash, recomputedHash, reason, divergedAtTick}`. Re-simular es caro: el replay-service lo expone sin cuota y la API con cuota anónima.

## Retención

- Los replays no oficiales (práctica) se crean con `expiresAt = createdAt + 7 días`; los oficiales nunca caducan.
- `sweepRetention` borra los caducados, pero **ningún proceso del repositorio lo programa**. Sólo existen la ruta autenticada y la CLI (`apps/replay-service/src/cli.ts`). En la práctica no se borra nada.

## Gobernanza actual

Estado actual, no deseado:

- **Apertura anónima**: el gateway publica `/replays/` (inventario) y `/replays/{id}`, `/index` y `/segment` a cualquiera ([TD-004](../roadmap/technical-debt.md#td-004)). En producción se observó 200 anónimo mientras `GET /api/v1/public/replays` decía `enabled:false`.
- **Replays privados accesibles**: el replay de una batalla privada se descarga por id desde la API sin autenticación.
- **Dependencia del reproductor**: la web cuenta con esa apertura; `ReplayPage` no envía token.
- **Degradación de esquema**: `GET /replays` (sin barra) responde **301 a `http://…/replays/`**. Desde la página HTTPS es contenido mixto y el navegador lo bloquea, así que `#/replays` muestra «Servicio de replays no disponible» ([TD-014](../roadmap/technical-debt.md#td-014)).
- **Escritura**: la ingesta y el barrido sí están autenticados. El cuerpo se lee entero (hasta 64 MB) antes del 401.

## Errores / limitaciones

- Reproductor y visor rotos en navegador: `getScene("viewer")` devuelve `null` antes del arranque de Phaser ([TD-009](../roadmap/technical-debt.md#td-009), [frontend.md](frontend.md)).
- Un replay sin fila de batalla (por ejemplo, el de un arnés) aparece en el inventario. El enlace «visor» acaba en «sin conexión».
- La caché de segmentos es por proceso y no tiene límite de tamaño.
- No hay retención programada.

## Estado actual

- **FUNCIONA ACTUALMENTE**: generación e ingesta, índice, segmentos, descarga con `Range` y verificación por re-simulación (`matches:true` en la auditoría).
- **PARCIAL**: la cadena HTTP llega al navegador, pero el render no arranca. La lista web falla en producción por el 301.
- **PENDIENTE**: gobernanza de acceso coherente con la bandera pública, retención programada y apertura de `debugOpen` por el dueño (no hay pantalla).

## Documentación relacionada

- Usuario: [Replays](../user/replays.md), [Visor](../user/viewer.md)
- Técnica: [engine.md](engine.md), [battles.md](battles.md), [websocket.md](websocket.md), [frontend.md](frontend.md), [api.md](api.md)
- Arquitectura (A): [gateway.md](gateway.md), [security.md](security.md), [data-flow.md](data-flow.md)
- Operación (C): [backup.md](../operations/backup.md), [networking.md](../operations/networking.md)
- Histórico absorbido: R7 (visor de replays), R7-A (ingesta operativa), R11 (espectador público) y Carril J (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| Ficheros `.replay` y `.replay.json`; sha256 del comprimido | CODE_VERIFIED | `apps/replay-service/src/store.ts:42-46,81-122`; `format.ts:65-90` |
| zstd o gzip; keyframe cada 30 | CODE_VERIFIED | `format.ts:30-38,94-100` |
| El worker ingiere y guarda `replay_ref` y `replay_hash` | CODE_VERIFIED | `apps/tournament-worker/src/battle-runner.ts:240-271` |
| Rutas del replay-service; escritura con secreto | CODE_VERIFIED | `apps/replay-service/src/server.ts:92-254`; `main.ts:27-45` |
| El gateway hace *proxy* de `/replays/` sin autenticar | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf:90-93` |
| Rutas de la API y bandera pública | CODE_VERIFIED | `apps/api/src/routes/battles.ts:273-359,523-589` |
| 7 días de TTL; barrido sin programar | CODE_VERIFIED | `store.ts:22,255-270`; búsqueda de `retention/sweep` (sólo ruta, CLI y comentario de compose) |
| Lecturas anónimas 200 en producción con `enabled:false` | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 (GET anónimos) |
| 301 a http y bloqueo por contenido mixto | RUNTIME_VERIFIED | Auditoría B pasada 2 §4 (navegador real) |
| Verificación con `matches:true` | RUNTIME_VERIFIED | Auditoría B pasada 1 §B9 (entorno aislado) |
| La web lista con `fetch("/replays")` | CODE_VERIFIED | `apps/web/src/pages/ReplaysPage.tsx:28` |
