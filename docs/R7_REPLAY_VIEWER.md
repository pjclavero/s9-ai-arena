# R7 · Replay real como recurso gestionado + visor

> Tras el **hito A** (batalla E2E real validada en VM108 con replay real verificado bit a
> bit), R7 convierte ese replay de **fichero suelto** en **recurso gestionado** por el
> replay-service, servible por la API y el visor existentes.

## Qué ya existía (E8) — no se reimplementa

- **replay-service** (`apps/replay-service`): almacenamiento JSONL+compresión con índice de
  keyframes. Endpoints: `POST /replays/:battleId` (ingesta), `GET /replays/:battleId`
  (descarga con rango), `/index`, `/segment`, `POST /replays/:battleId/verify`.
- **API** (`apps/api/openapi.yaml`): `GET /replays/{battleId}`, `POST /replays/{battleId}/verify`.
- **Visor web**: `ReplayPage.tsx` + `ViewerPage.tsx`, rutas `#/replay/<battleId>` y `#/viewer/<battleId>`.
- **Verificación**: `verify(replay)` re-simula y compara el hash final (usado en el hito A).

## Qué añade R7 (este cambio)

El **arnés real** (`scripts/e2e-real-battle-smoke.ts`) ahora, si se define
`REPLAY_SERVICE_URL`, **ingesta** el replay generado (`POST /replays/:battleId`, mismo JSONL
que escribe a disco). Así el replay real de una batalla containerizada pasa a ser un recurso
gestionado: recuperable por `GET /replays/{battleId}` y reproducible en `#/replay/<battleId>`.

- Ingesta **best-effort**: un fallo NO invalida la batalla; el CLI reporta `ingested`/`ingestStatus`.
- El servicio valida `header.battleId` y rechaza replays corruptos (400/422).

## Cómo se prueba localmente (sin Docker)

`tests/e2e/e2e-real-battle-smoke.test.ts` levanta un **replay-service real** en un puerto
libre, ejecuta el arnés (runner mock por WebSocket) con `REPLAY_SERVICE_URL`, y comprueba:
ingesta 201 con sha256, replay recuperable por `GET /replays/:battleId`, y rechazo de replay
corrupto. `npx vitest run tests/e2e/e2e-real-battle-smoke.test.ts`.

## Cómo se valida en VM108 (gateado, no en este PR)

`REPLAY_SERVICE_URL` alcanzable desde donde corre el arnés (el replay-service es un servicio
de la red `platform`). Tras la batalla real, `GET /replays/{battleId}` en la API devuelve el
replay y `#/replay/<battleId>` lo reproduce.

## Estado / dictamen

- Viewer + API + verify: **existen y funcionan con replay real** (hito A).
- Ingesta arnés→servicio: **añadida y testada**.
- **Pendiente (no bloqueante)**: exponer/alcanzar el replay-service desde el host en VM108
  para la ingesta operativa; endpoint de LISTA global de replays (`GET /replays`) y página
  `#/replays` de listado (hoy se accede por `battleId`) — mejora incremental.

**Dictamen R7: R7-B → cerca de R7-A.** El replay real ya es gestionable y visible; queda la
ingesta operativa en VM108 y el listado global como mejoras.
