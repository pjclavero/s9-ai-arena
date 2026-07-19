# R10 · Editor visual de mapas — Slice 1 (foundation, solo cliente)

Primer PR de la rama `feature/r10-map-editor-foundation`. Implementa la **base del editor**
como herramienta de autoría **solo en cliente**, sin tocar backend, OpenAPI, seguridad ni VM108.

## Qué entrega este slice

- **`apps/web/src/pages/MapEditorPage.tsx`**: editor con
  - modelo de mapa en **borrador local** (estado del componente) en el mismo **formato de autoría**
    que `maps/training-yard.json` (`{ schemaVersion, id, name, width, height, seed, walls[],
    obstacles[], spawns[] }`);
  - **lienzo SVG** a escala del mundo (sin deformar);
  - **CRUD de objetos**: añadir muro / obstáculo / spawn, seleccionar, editar (x, y, ancho, alto,
    equipo) y eliminar;
  - **export JSON** (produce el formato de autoría tal cual) e **import JSON** (roundtrip);
  - **validación en cliente** (límites del mapa, ids únicos, al menos un spawn) — ayuda de autoría,
    **no** sustituye al validador real de E4/map-service.
- **Ruta** `#/maps/editor` en `App.tsx` (antes del match general de `#/maps`).
- **Enlace de entrada** desde `MapsPage`.
- **Tests** (`apps/web/tests/map-editor.test.tsx`): roundtrip del modelo, formato de export,
  validación, y UI (añadir objeto, importar roundtrip, error de JSON inválido).

## Qué NO hace (deliberado)

- **No persiste en el servidor.** No existe endpoint para editar un draft: `importMap` crea desde
  fichero y `replaceMapVersion` responde 409 (inmutable). Persistir requiere un **endpoint nuevo**
  (p. ej. `PATCH /maps/{id}/versions/{v}` para draft, o `POST /maps` de draft vacío) + validación
  real vía map-service → **OpenAPI + conformance + tests**. Eso es el **slice 2**, y toca la matriz
  de ficheros; queda **fuera** de este PR a propósito.
- **No dispara batallas** ni ejecución real. **No expone secretos** ni `DOCKER_PROXY_URL`.
- **No renderiza geometría de un mapa del servidor**: `getMapVersion` sólo devuelve metadata
  (dims/estado/checksum), no el contenido de capas. Exponer el contenido para editar mapas
  existentes es también parte del slice 2.

## Slice 2 (propuesto, pendiente de revisar la matriz de ficheros)

1. Backend: endpoint de **draft editable** + persistencia + validación real (map-service).
2. Exponer el **contenido** del mapa en el contrato para cargar/editar versiones existentes.
3. Editor: cargar por `mapId`, guardar draft, validar contra el validador real, publicar.
4. Ficheros afectados (a confirmar): `apps/api/openapi.yaml`, `apps/api/src/routes/maps.ts`,
   `apps/api/src/conformance.test.ts` (conteo), `apps/map-service/*`, `MapEditorPage.tsx`.

**Dictamen del slice 1: R10-C parcial** — foundation del editor implementada, probada y aislada;
persistencia real pendiente (slice 2, gateado a revisión de la matriz de ficheros).
