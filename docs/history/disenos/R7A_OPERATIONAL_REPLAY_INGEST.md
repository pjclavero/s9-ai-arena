# R7-A · Ingesta operativa del replay + listado global

Cierra el paso operativo de R7: el replay real de una batalla containerizada pasa de
**fichero suelto** a **recurso gestionado** por el replay-service, **listado globalmente** y
abrible en el visor existente. Construye sobre la ingesta best-effort de #47.

## Ingesta endurecida (arnés `scripts/e2e-real-battle-smoke.ts`)

| Variable | Def. | Significado |
|---|---|---|
| `REPLAY_SERVICE_URL` | — | URL del replay-service. Activa la ingesta. |
| `REPLAY_INGEST_ENABLED` | `1` si hay URL | `0` desactiva la ingesta aunque haya URL. |
| `REPLAY_INGEST_REQUIRED` | `0` | `1` = modo estricto: si la ingesta (o la verificación) falla, el resultado operativo **falla** (excepción). `0` = best-effort. |
| `REPLAY_INGEST_RETRIES` | `2` | reintentos ante fallo transitorio (con backoff). |
| `REPLAY_INGEST_TIMEOUT_MS` | `10000` | timeout por intento (AbortController). |

Flujo: genera replay → **verifica localmente** (`verify()`; si no coincide el hash, NO
ingesta — evita meter datos falsos) → `POST /replays/:battleId` con reintentos → registra
`ingest.ok`/`attempts`/`verified`. En modo `REQUIRED=1`, un fallo aborta con error claro.

## Listado global (replay-service)

Nuevo endpoint en el **replay-service** (servido tras el gateway):

```
GET /replays?limit=100&order=desc  → { "items": [ { battleId, ticks, winner, official, createdAt, sizeBytes } ] }
```

Lee todos los índices `<battleId>.replay.json`, más recientes primero. Un índice corrupto se
ignora sin romper la lista. (Vive en el replay-service, no en la API `/api/v1`: por eso NO se
añade al OpenAPI de la API, que gestiona la conformidad de sus propias operaciones.)

## Visor / listado web

Página **`#/replays`** (`apps/web/src/pages/ReplaysPage.tsx`): consume `GET /replays`, muestra
battleId/resultado/ticks/oficial/fecha y enlaza a `#/viewer/:battleId` y `#/replay/:battleId`
(rutas existentes). Estados: cargando / vacío / servicio no disponible. Enlace en la nav.

## Cómo se prueba en local (sin Docker)

- `apps/replay-service/tests/list-replays.test.ts`: `listReplays` + `GET /replays`.
- `tests/e2e/e2e-real-battle-smoke.test.ts` (runner mock por WS): ingesta best-effort/required,
  reintentos, `REPLAY_INGEST_ENABLED=0`, y **`GET /replays` lista la batalla ingerida** end-to-end.
- `apps/web/tests/replays-page.test.tsx`: lista, vacío, error.

## Cómo validar en VM108 (gateado, NO en este PR)

1. Asegurar que el arnés alcanza el replay-service (red `platform` o exponer su puerto):
   `REPLAY_SERVICE_URL=http://<replay-service>:8083`.
2. Ejecutar el arnés real (ver `docs/ops/batalla-smoke-containerizada.md`) con
   `REPLAY_INGEST_REQUIRED=1` para exigir la ingesta.
3. Comprobar `GET /replays` (vía gateway) y abrir `#/replays` → `#/viewer/:battleId`.

## Estado / dictamen

Ingesta endurecida + listado + página **implementados y testados**. La **validación operativa
en VM108** (replay real ingerido desde una ejecución real y visible en el listado) queda
gateada. **Dictamen R7-B+** (implementado, pendiente validación operativa VM108); pasa a R7-A
cuando se valide en VM108.

## Riesgos residuales / pendientes

- El resumen del listado no incluye `verify_matches` (el índice no lo guarda): la verificación
  sigue disponible por replay vía `POST /replays/:battleId/verify`. Añadirlo al índice en la
  ingesta es una mejora incremental.
- Enrutado gateway de `GET /replays` (sin `battleId`): confirmar que el gateway enruta `/replays`
  al replay-service en VM108 (hoy enruta `/replays/`); ajuste de nginx documentado si hace falta.
